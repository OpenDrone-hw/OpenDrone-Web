import {Canvas, useFrame, invalidate} from '@react-three/fiber';
import {useEffect, useReducer, useRef, useState} from 'react';
import * as THREE from 'three';
import {ModelLoader as GLTFLoader} from '~/lib/model-loader';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {useIsMobile, usePrefersReducedMotion} from '~/lib/use-media-query';
import {getActiveTheme} from '~/lib/theme';
import {SLICE_BUDGET_MS, yieldToMain} from '~/lib/scheduling';

// Wireframe stroke per theme. Gold-on-near-black reads fine in dark; on light's
// cream page that same gold is nearly invisible, so light uses a dark bronze at
// higher opacity. Applied at build and refreshed live on a theme toggle.
const FRAME_LINE = {
  dark: {color: 0xc8b27a, opacity: 0.55},
  light: {color: 0x5c4611, opacity: 0.92},
} as const;

// Memoise fetched GLB bytes by URL so a model that's been loaded once (e.g. the
// other tier, preloaded in the background) never hits the network again - the
// switch only pays the cheap parse, not the multi-MB download.
THREE.Cache.enabled = true;

export type FrameViewerProps = {
  /** Public path to the active GLB, e.g. /models/od3/frame.glb */
  src: string;
  /** `frame` (default) explodes a frame assembly; `motor` shows one motor of
   *  a drive assembly expanding along its shaft with the bell spinning. */
  kind?: ModelKind;
  /** All frame GLBs across tiers. Preloaded up front so switching the active
   *  `src` is instant (toggle visibility) instead of a fetch + parse. Defaults
   *  to `[src]`. */
  srcs?: string[];
  /** Optional "inspect" deep-dive link (kept for API parity; unused while
   *  the viewer renders as a decorative backdrop). */
  inspectUrl?: string;
};

/**
 * Exploded-assembly backdrop for the carbon frame and the motors - the CAD
 * analogue of {@link BoardArt}. The frame is a 3D Onshape assembly, so
 * instead of revealing flat PCB layers it pulls its parts apart as the user
 * scrolls: top plate lifts, bottom plates drop, arms and boots fan out,
 * screws back out of their holes. A motor expands along its shaft (bell up,
 * stator down) while the bell spins.
 *
 * Purely decorative and NON-interactive: a big over-bleeding layer of gold
 * vector outlines that flows over the neighbouring sections, behind the
 * teardown text. The explode amount is recomputed from the section's
 * viewport position every rendered frame, and a scroll listener invalidates
 * (frameloop="demand") - so it animates smoothly while scrolling and the GPU
 * idles otherwise; off-screen the canvas unmounts entirely.
 *
 * Parts are the Onshape occurrences of the full assembly export
 * (`public/models/od5/frame.glb`, `od5/drive.glb` and the od3 pair); see {@link prepareModel}.
 *
 * Tier switching (3" ⇄ 5") is instant: every tier's model is loaded once and
 * kept in the scene; changing `src` just toggles which one is visible. No
 * remount, no refetch.
 */

/** What the GLB holds: a frame assembly, or a drive assembly shown as one
 *  motor. Selects the explode rules and the camera rig. */
export type ModelKind = 'frame' | 'motor';

// Parts of the full Onshape assemblies that are not part of the product:
// the AirTag, the receiver antennas, the camera rear housing, the prop nuts
// (M5), and on the drive model the props and the stack softmounts. Matched
// against the normalised node name (see `partName`).
const EXCLUDE = /^airtag$|ufl|rear housing|nut m5|prop|softmount/;
// Frame roles. Plates and pads stack along the frame's vertical axis; fasteners
// also pull out along their own axis; every other part (arms, boots, standoffs,
// aluminium side plates, camera mounts) moves out radially.
const PLATE = /^(top|base|cross|anti-slip|airtagantenna|vtx)/;
const FASTENER = /screw|nut/;
const ROLE = {plate: 0, radial: 1, fastener: 2} as const;

// Explode travel as a fraction of the assembly's largest dimension. These set
// the spread at e = 1 (the "fully exploded" hero look as chapter 2 arrives).
const PLATE_TRAVEL = 0.9;
const ARM_TRAVEL = 0.78;
const FASTENER_TRAVEL = 0.1;
// Motor: the lowest body (stator and base) drops, the rest (bell, shaft,
// bearings, clips) lift in even steps up to MOTOR_LIFT.
const MOTOR_DROP = 0.25;
const MOTOR_LIFT = 0.55;
// Edge segments above which a small part is drawn as clutter, not detail.
const DENSE_EDGES = 1500;
// Bell spin in radians per second.
const MOTOR_SPIN = 0.9;

// Per-kind rig: how far the explode may run with scroll, the model's size in
// scene units, and the fixed three-quarter view.
const KIND = {
  // e keeps growing past 1 as you scroll further, so the parts fly off screen.
  // At e = 1 arms are ~at the frame edge; ~e = 2.5-3 takes everything off.
  frame: {explodeMax: 3, size: 1.9, rot: {x: 0.42, y: -0.5}, lift: 0},
  // One motor stays in frame: it expands to about twice its height and holds.
  // The motor chapter is short, so on desktop the model sits above the
  // canvas centre, level with the part list.
  motor: {explodeMax: 1, size: 0.75, rot: {x: -1.2, y: 0}, lift: 0.85},
} as const;

type Part = {
  obj: THREE.Object3D;
  base: THREE.Vector3;
  /** Explode vector in `obj.parent`'s local frame. */
  explode: THREE.Vector3;
  /** Motor rotor bodies spin about their local Y (the shaft axis). */
  spin?: boolean;
};
type Model = {root: THREE.Object3D; parts: Part[]};

/** GLTFLoader sanitises node names ("occurrence of Top" arrives as
 *  "occurrence_of_Top", "Airtag/Antenna mount" as "AirtagAntenna_mount");
 *  undo the separators and drop the Onshape occurrence prefix. */
function partName(o: THREE.Object3D): string {
  return o.name
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^occurrence of /, '')
    .trim();
}

/** World-space vector to the linear frame of `obj.parent`. */
function toParentFrame(obj: THREE.Object3D, v: THREE.Vector3): THREE.Vector3 {
  if (!obj.parent) return v;
  const inv = new THREE.Matrix4().copy(obj.parent.matrixWorld).invert();
  return v.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(inv));
}

/**
 * Turn a freshly-loaded glTF scene into a render-ready model: drop the parts
 * that are not the product, compute each part's explode vector, replace solid
 * surfaces with gold edge outlines, and centre + normalise the scene to a
 * fixed size. The scene is mutated in place and returned alongside its part
 * list.
 *
 * Every direct child of the assembly root is one part (an Onshape occurrence).
 * Directions come from the geometry, not from per-part data: plates move along
 * the stack axis in proportion to their height, radial parts move out from the
 * stack centreline, and fasteners follow their host and pull out along their
 * own axis. A motor is exploded along its shaft instead.
 */
async function prepareModel(
  scene: THREE.Object3D,
  kind: ModelKind,
): Promise<Part[]> {
  scene.updateMatrixWorld(true);
  // glTF wraps the whole assembly under a single identity root node
  // ("OpenDrone-5", "Frame", "Assembly 1"). Its direct children are the
  // Onshape occurrences, one per part.
  const assemblyRoot = scene.children.length === 1 ? scene.children[0] : scene;
  for (const c of [...assemblyRoot.children]) {
    if (EXCLUDE.test(partName(c))) assemblyRoot.remove(c);
  }
  // Onshape exports Z-up; every assembly shares that frame.
  const up = new THREE.Vector3(0, 0, 1);
  const centreOf = (o: THREE.Object3D) =>
    new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());

  const found: Part[] = [];
  if (kind === 'motor') {
    // The drive model carries four motors; keep the first one. Its bodies
    // share one occurrence position.
    const key = (o: THREE.Object3D) =>
      `${Math.round(o.position.x * 1000)},${Math.round(o.position.y * 1000)}`;
    const first = assemblyRoot.children[0];
    const keep = first ? key(first) : '';
    for (const c of [...assemblyRoot.children]) {
      if (key(c) !== keep) assemblyRoot.remove(c);
    }
    scene.updateMatrixWorld(true);
    const unit =
      Math.max(
        ...new THREE.Box3()
          .setFromObject(scene)
          .getSize(new THREE.Vector3())
          .toArray(),
      ) || 1;
    // The body node under each occurrence carries no rotation of its own, so
    // its local Y is the shaft axis and spinning it turns the part in place.
    const bodies = assemblyRoot.children
      .map((c) => (c.children.length === 1 ? c.children[0] : c))
      .map((obj) => ({obj, h: centreOf(obj).dot(up)}))
      .sort((a, b) => a.h - b.h);
    const n = bodies.length;
    bodies.forEach(({obj}, rank) => {
      const travel =
        rank === 0 ? -MOTOR_DROP : (MOTOR_LIFT * rank) / Math.max(1, n - 1);
      found.push({
        obj,
        base: obj.position.clone(),
        explode: toParentFrame(obj, up.clone().multiplyScalar(travel * unit)),
        spin: rank > 0,
      });
    });
  } else {
    type Draft = {
      obj: THREE.Object3D;
      name: string;
      role: number;
      centre: THREE.Vector3;
    };
    const drafts: Draft[] = assemblyRoot.children.map((obj) => {
      const name = partName(obj);
      const role = PLATE.test(name)
        ? ROLE.plate
        : FASTENER.test(name)
          ? ROLE.fastener
          : ROLE.radial;
      return {obj, name, role, centre: centreOf(obj)};
    });
    const plates = drafts.filter((d) => d.role === ROLE.plate);
    const sceneBox = new THREE.Box3().setFromObject(scene);
    const unit =
      Math.max(...sceneBox.getSize(new THREE.Vector3()).toArray()) || 1;
    // The stack centreline: the mean plate centre horizontally, halfway
    // between the lowest and highest plate vertically. Arms are asymmetric,
    // so the bounding-box centre would bias every arm the same way.
    const axisPoint = plates.length
      ? plates
          .reduce((a, d) => a.add(d.centre), new THREE.Vector3())
          .divideScalar(plates.length)
      : sceneBox.getCenter(new THREE.Vector3());
    const heights = plates.map((d) => d.centre.dot(up));
    const midH = heights.length
      ? (Math.min(...heights) + Math.max(...heights)) / 2
      : axisPoint.dot(up);
    axisPoint.addScaledVector(up, midH - axisPoint.dot(up));
    const split = (d: Draft) => {
      const rel = d.centre.clone().sub(axisPoint);
      const v = rel.dot(up);
      return {v, h: rel.addScaledVector(up, -v)};
    };
    const plateSpan = Math.max(
      1e-6,
      ...plates.map((d) => Math.abs(split(d).v)),
    );
    const vGain = (PLATE_TRAVEL * unit) / plateSpan;
    const arms = drafts.filter((d) => d.name.startsWith('arm'));
    const armR = arms.length
      ? arms.reduce((s, d) => s + split(d).h.length(), 0) / arms.length
      : unit / 3;
    for (const d of drafts) {
      const {v, h} = split(d);
      const world = up.clone().multiplyScalar(v * vGain);
      if (d.role !== ROLE.plate) {
        const r = h.length();
        if (r > 1e-6) {
          world.addScaledVector(
            h.normalize(),
            ARM_TRAVEL * unit * Math.min(1, r / armR),
          );
        }
      }
      if (d.role === ROLE.fastener) {
        // A screw or nut is modelled along its local Z: pull it out along
        // that axis, away from the stack centre.
        const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(
          (d.obj.children[0] ?? d.obj).getWorldQuaternion(
            new THREE.Quaternion(),
          ),
        );
        const away = d.centre.clone().sub(axisPoint).dot(axis);
        world.addScaledVector(
          axis,
          (away < 0 ? -1 : 1) * FASTENER_TRAVEL * unit,
        );
      }
      found.push({
        obj: d.obj,
        base: d.obj.position.clone(),
        explode: toParentFrame(d.obj, world),
      });
    }
  }
  const sceneBox = new THREE.Box3().setFromObject(scene);
  const sz = sceneBox.getSize(new THREE.Vector3());
  const unit = Math.max(sz.x, sz.y, sz.z) || 1;

  // Vector edge outlines instead of solid fills - ONE merged LineSegments
  // per explode part (plus one for the static rest), not one per mesh.
  // The per-mesh version left hundreds of scene-graph nodes and draw calls
  // alive; three.js then spent 15-70ms of main thread PER FRAME on matrix
  // updates + draw submission while this decorative backdrop was on screen
  // (profiled at 4x CPU). Merging is pixel-identical: each mesh's edges are
  // baked into its owning part's local space, so the explode still moves
  // whole parts, and the source meshes are dropped from the graph entirely.
  const style = FRAME_LINE[getActiveTheme()];
  const lineMat = new THREE.LineBasicMaterial({
    color: style.color,
    transparent: true,
    opacity: style.opacity,
  });
  const allMeshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) allMeshes.push(m);
  });
  const partObjs = new Set(found.map((f) => f.obj));
  const ownerOf = (m: THREE.Mesh): THREE.Object3D => {
    let p: THREE.Object3D | null = m;
    while (p) {
      if (partObjs.has(p)) return p;
      p = p.parent;
    }
    return scene;
  };
  const byOwner = new Map<THREE.Object3D, THREE.Mesh[]>();
  for (const m of allMeshes) {
    const o = ownerOf(m);
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o)!.push(m);
  }
  const tmpMat = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  // EdgesGeometry is the expensive step (per-triangle edge extraction);
  // yield between meshes so it never blocks a frame for more than one
  // mesh's worth of work.
  // Fasteners repeat one geometry many times: extract each geometry's edges
  // once and copy them per instance.
  const edgeCache = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  let sliceStart = performance.now();
  for (const [owner, meshes] of byOwner) {
    inv.copy(owner.matrixWorld).invert();
    const edgeGeoms: THREE.BufferGeometry[] = [];
    for (const m of meshes) {
      let cached = edgeCache.get(m.geometry);
      if (!cached) {
        cached = new THREE.EdgesGeometry(m.geometry, 24);
        edgeCache.set(m.geometry, cached);
      }
      // A small part with modelled threads turns into a solid blot of
      // edges at this scale; leave it out of the drawing.
      if (
        cached.attributes.position.count / 2 > DENSE_EDGES &&
        new THREE.Box3()
          .setFromObject(m)
          .getSize(new THREE.Vector3())
          .length() <
          unit * 0.1
      ) {
        continue;
      }
      const eg = cached.clone();
      eg.applyMatrix4(tmpMat.copy(inv).multiply(m.matrixWorld));
      edgeGeoms.push(eg);
      if (performance.now() - sliceStart > SLICE_BUDGET_MS) {
        await yieldToMain();
        sliceStart = performance.now();
      }
    }
    if (!edgeGeoms.length) continue;
    const merged =
      edgeGeoms.length === 1 ? edgeGeoms[0] : mergeGeometries(edgeGeoms, false);
    if (edgeGeoms.length > 1) edgeGeoms.forEach((g) => g.dispose());
    if (merged) owner.add(new THREE.LineSegments(merged, lineMat));
  }
  // Drop the source meshes: their edges are baked into the merged outlines,
  // and keeping them (even material-hidden) is what kept the per-frame
  // graph traversal expensive. Exception: on the cascadio/OCCT export path a
  // part's move node IS the mesh itself (see the moveNode comment above) and
  // now carries its merged outline as a child - removing it would take the
  // outline with it, so those meshes stay in-graph with hidden materials
  // (the pre-PR treatment) and keep their geometry.
  const geoms = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  for (const m of allMeshes) {
    if (partObjs.has(m)) {
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => {
        if (mm) mm.visible = false;
      });
      continue;
    }
    m.parent?.remove(m);
    geoms.add(m.geometry);
    (Array.isArray(m.material) ? m.material : [m.material]).forEach(
      (mm) => mm && mats.add(mm),
    );
  }
  geoms.forEach((g) => g.dispose());
  mats.forEach((mm) => mm.dispose());
  edgeCache.forEach((g) => g.dispose());

  // Centre + normalise from the SOLID bounds captured before the meshes were
  // replaced by outlines: EdgesGeometry drops edges on faces smoother than
  // its threshold, so a box measured from the outlines alone could shrink on
  // models with smooth extremal surfaces and shift the centring/scale.
  // The scale applies before the translation, so the offset is scaled too.
  const scale = KIND[kind].size / (unit || 1);
  scene.scale.setScalar(scale);
  scene.position
    .copy(sceneBox.getCenter(new THREE.Vector3()))
    .multiplyScalar(-scale);
  return found;
}

// The deployment build fingerprints the hero chunks (`od5/frame.glb` ships as
// `od5/frame.<hash>.glb`, see scripts/compress-models.mjs) and rewrites the
// folder's chunks.json. Resolve a chunk path through that manifest; the dev
// server and any GLB outside a manifest keep their plain path.
const manifests = new Map<string, Promise<Record<string, string>>>();
function resolveModelUrl(src: string): Promise<string> {
  const m = src.match(/^(.*\/)([^/]+)\.glb$/);
  if (!m) return Promise.resolve(src);
  const [, folder, id] = m;
  let files = manifests.get(folder);
  if (!files) {
    files = fetch(`${folder}chunks.json`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{chunks?: Array<{id: string; file: string}>}>)
          : null,
      )
      .then((j) =>
        Object.fromEntries((j?.chunks ?? []).map((c) => [c.id, c.file])),
      )
      .catch(() => ({}));
    manifests.set(folder, files);
  }
  return files.then((f) => (f[id] ? `${folder}${f[id]}` : src));
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((o: any) => {
    if (o.isMesh || o.isLineSegments) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m: any) => m?.dispose());
    }
  });
}

function FrameModel({
  src,
  srcs,
  kind,
  containerRef,
}: {
  src: string;
  srcs: string[];
  kind: ModelKind;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  // Fixed three-quarter top view. On desktop it's shifted right in its own local
  // x so the model sits off to the right and the left arms fan into the text.
  // On mobile the viewer is a centred square above the copy, so the offset is
  // dropped and the model scaled up to fill it (otherwise it floats in a corner
  // of a black void - the desktop right-bias has nothing to fan into).
  const isMobile = useIsMobile();
  // Respect reduced-motion: the explode is a scroll-coupled animation, so for
  // visitors who opt out we hold the frame assembled (e = 0) - they get the
  // wireframe backdrop without parts flying as they scroll.
  const reducedMotion = usePrefersReducedMotion();
  const {rot, explodeMax, lift} = KIND[kind];
  const spinAngle = useRef(0);
  const offsetX = isMobile ? 0 : 1.0;
  const rigScale = isMobile ? 1.35 : 1;
  // All loaded models, keyed by src. Only the active one is `visible`.
  const models = useRef<Map<string, Model>>(new Map());
  // Escape hatch for the tier-switch effect below: kick an immediate load of
  // a src whose idle-deferred warm hasn't started yet.
  const loadRef = useRef<(s: string) => void>(() => {});
  // Current tier, readable from async load completions. The load effect's
  // closure captures the MOUNT-time `src` (its deps are srcs only); a model
  // landing after a tier switch must compare against the live value or it
  // gets added invisible and the backdrop blanks until the next toggle.
  const activeSrcRef = useRef(src);
  activeSrcRef.current = src;
  const [, bump] = useReducer((c: number) => c + 1, 0);
  // The chapter following the teardown ("Open for learning"). The explode is
  // scrubbed across the gap between the two chapters' centres, so we need its
  // box too. Resolved lazily and cached (re-resolved if it drops out of DOM).
  const nextChapter = useRef<HTMLElement | null>(null);

  // Load every tier's model once, active one first so it shows ASAP; the rest
  // warm in the background so switching tiers is instant. THREE.Cache keeps the
  // bytes, so re-mounting (scroll away/back) re-parses without re-downloading.
  useEffect(() => {
    let cancelled = false;
    const loader = new GLTFLoader();
    // OnShape exports the frame GLBs with EXT_meshopt_compression (+ mesh
    // quantization), so the loader needs the meshopt decoder or every load
    // throws "setMeshoptDecoder must be called before loading compressed files".
    loader.setMeshoptDecoder(MeshoptDecoder);
    const wanted = srcs.length ? srcs : [src];
    const load = (s: string) => {
      if (models.current.has(s)) return;
      // Reserve the slot synchronously so a re-render mid-load doesn't queue a
      // duplicate fetch for the same src.
      models.current.set(s, {root: new THREE.Group(), parts: []});
      void resolveModelUrl(s).then((url) =>
        loader.load(
          url,
          (gltf) => {
            if (cancelled || !groupRef.current) return;
            const scene = gltf.scene;
            void prepareModel(scene, kind).then((parts) => {
              if (cancelled || !groupRef.current) {
                disposeObject(scene);
                return;
              }
              scene.visible = s === activeSrcRef.current;
              models.current.set(s, {root: scene, parts});
              groupRef.current.add(scene);
              invalidate();
              bump();
            });
          },
          undefined,
          (err) => console.error('[FrameViewer] failed to load', url, err),
        ),
      );
    };
    loadRef.current = load;
    // Active tier immediately; the other tiers only once the thread idles
    // AND the visitor isn't mid-scroll (a GLB parse + edge extraction is an
    // atomic task that would land straight in the scroll). Loading them all
    // at once was a >1s task right as the teardown scrolled in. THREE.Cache
    // still dedupes bytes across mounts.
    load(src);
    const others = wanted.filter((s) => s !== src);
    let lastScrollTs = 0;
    const onScroll = () => {
      lastScrollTs = performance.now();
    };
    let warmTimer: number | undefined;
    if (others.length) {
      window.addEventListener('scroll', onScroll, {passive: true});
      const started = performance.now();
      const tryWarm = () => {
        const quiet = performance.now() - lastScrollTs > 300;
        const overdue = performance.now() - started > 15000;
        if (quiet || overdue) {
          for (const s of others) load(s);
        } else {
          warmTimer = window.setTimeout(tryWarm, 500);
        }
      };
      warmTimer = window.setTimeout(tryWarm, 2500);
    }
    return () => {
      cancelled = true;
      window.removeEventListener('scroll', onScroll);
      if (warmTimer != null) window.clearTimeout(warmTimer);
    };
    // srcs is a stable list for the product; src changes are handled by the
    // visibility effect below, not by reloading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcs.join('|')]);

  // Orient the rig once; rotation/offset apply to every model under it (only
  // one is visible at a time).
  useEffect(() => {
    if (!groupRef.current) return;
    groupRef.current.rotation.set(rot.x, rot.y, 0);
    groupRef.current.position.x = offsetX;
    groupRef.current.position.y = isMobile ? 0 : lift;
    groupRef.current.scale.setScalar(rigScale);
  }, [rot.x, rot.y, offsetX, lift, rigScale, isMobile]);

  // Instant tier switch: show the requested model, hide the rest. If the model
  // hasn't finished loading yet it simply becomes visible once it lands; if
  // its idle-deferred warm hasn't even started, start it now.
  useEffect(() => {
    if (!models.current.has(src)) loadRef.current(src);
    for (const [s, m] of models.current) m.root.visible = s === src;
    invalidate();
  }, [src]);

  // Recolour the wireframes live when the visitor toggles light/dark - the
  // baked-at-build gold is invisible on the light cream page. Watches the
  // <html> class (the single source of theme truth) and repaints every loaded
  // model's edge materials.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const apply = () => {
      const style = FRAME_LINE[getActiveTheme()];
      for (const m of models.current.values()) {
        m.root.traverse((o) => {
          const ls = o as THREE.LineSegments;
          if (!ls.isLineSegments) return;
          const mats = Array.isArray(ls.material) ? ls.material : [ls.material];
          for (const mat of mats) {
            const lm = mat as THREE.LineBasicMaterial;
            lm.color.setHex(style.color);
            lm.opacity = style.opacity;
            lm.needsUpdate = true;
          }
        });
      }
      invalidate();
    };
    const obs = new MutationObserver(apply);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => obs.disconnect();
  }, []);

  // Dispose everything on unmount (the IntersectionObserver unmounts the whole
  // canvas when the backdrop scrolls out of view).
  useEffect(() => {
    const loaded = models.current;
    const g = groupRef.current;
    return () => {
      for (const {root} of loaded.values()) {
        g?.remove(root);
        disposeObject(root);
      }
      loaded.clear();
    };
  }, []);

  // Drive the demand loop from scroll/resize: each event requests one frame so
  // the explode tracks the scroll position, then the GPU idles to zero once
  // scrolling stops. Without this the demand canvas would render once and the
  // explode would freeze (the old code used frameloop="always", which kept the
  // GPU at full tilt the entire time this backdrop was near the viewport).
  useEffect(() => {
    const onScroll = () => invalidate();
    window.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('resize', onScroll);
    invalidate();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  // Recompute the explode amount from scroll position each rendered frame.
  // The throw spans chapter 1 (teardown) → chapter 2: e = 0 when the teardown
  // chapter's centre sits at the viewport centre (assembled, in view), and
  // e = 1 once the next chapter's centre reaches the viewport centre (fully
  // exploded). Normalised by the centre-to-centre distance, so it's stable
  // regardless of section heights or the gap between them.
  //
  // The chapter centres are cached in DOCUMENT space - NOT read per frame.
  // During a scroll each rendered frame runs right after other main-thread
  // work has dirtied style/layout, so a per-frame getBoundingClientRect
  // forced a full synchronous reflow of the PDP every frame (measured
  // 50-70ms/frame at 4x CPU). The cache invalidates on window resize AND on
  // any document-height change (ResizeObserver on <body> - late images,
  // lazily built viewers, accordions all change the body's height, which is
  // exactly when positions above/around the chapters shift).
  const centersRef = useRef<{c1: number; c2: number | null} | null>(null);
  useEffect(() => {
    const invalidateCenters = () => {
      centersRef.current = null;
      invalidate();
    };
    window.addEventListener('resize', invalidateCenters);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(invalidateCenters);
      ro.observe(document.body);
    }
    return () => {
      window.removeEventListener('resize', invalidateCenters);
      ro?.disconnect();
    };
  }, []);
  useFrame((_, delta) => {
    const active = models.current.get(src);
    if (!active || !active.parts.length) return;
    // The bell spins continuously while the canvas is mounted (on screen);
    // reduced motion keeps it still. Clamp delta so a backgrounded tab does
    // not jump on return.
    const spinning = kind === 'motor' && !reducedMotion;
    if (spinning) spinAngle.current += Math.min(delta, 0.1) * MOTOR_SPIN;
    let e = 0;
    const el = containerRef.current;
    if (el && !reducedMotion) {
      if (!centersRef.current) {
        const section = (el.closest('.chapter') as HTMLElement | null) ?? el;
        let next = nextChapter.current;
        if (!next || !next.isConnected) {
          let n = section.nextElementSibling as HTMLElement | null;
          while (n && !n.classList.contains('chapter'))
            n = n.nextElementSibling as HTMLElement | null;
          nextChapter.current = next = n;
        }
        const r1 = section.getBoundingClientRect();
        const c1 = r1.top + r1.height / 2 + window.scrollY;
        let c2: number | null = null;
        if (next) {
          const r2 = next.getBoundingClientRect();
          c2 = r2.top + r2.height / 2 + window.scrollY;
        }
        centersRef.current = {c1, c2};
      }
      const vh = window.innerHeight || 1;
      const cached = centersRef.current;
      const c1 = cached.c1 - window.scrollY;
      if (cached.c2 != null) {
        const c2 = cached.c2 - window.scrollY;
        // Hold the frame assembled (e = 0) through chapter 1 - it only starts
        // coming apart once chapter 2 reaches the viewport centre. (vh/2 − c2)
        // is how far ch.2's centre has risen past the centre; normalise by the
        // ch.1→ch.2 centre distance so e ≈ 1 about one chapter later, then it
        // keeps climbing to the kind's explodeMax so the parts fly off as you scroll on.
        e = THREE.MathUtils.clamp(
          (vh / 2 - c2) / (c2 - c1 || vh),
          0,
          explodeMax,
        );
      } else {
        // No following chapter - fall back to a single-pass scrub.
        e = THREE.MathUtils.clamp(1 - c1 / vh, 0, 1);
      }
    }
    for (const p of active.parts) {
      p.obj.position.set(
        p.base.x + p.explode.x * e,
        p.base.y + p.explode.y * e,
        p.base.z + p.explode.z * e,
      );
      if (p.spin) p.obj.rotation.y = spinAngle.current;
    }
    if (spinning) invalidate();
  });

  return <group ref={groupRef} />;
}

export function FrameViewer({src, srcs, kind = 'frame'}: FrameViewerProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const allSrcs = srcs && srcs.length ? srcs : [src];

  useEffect(() => setMounted(true), []);

  // Mount the canvas while the over-bleeding backdrop is near the viewport.
  // The explode now spans chapter 1 → chapter 2, so observing the teardown
  // chapter alone would unmount the canvas mid-throw once that chapter scrolls
  // up out of view. The backdrop layer (.frame-viewer fills it, -6vh→-70vh)
  // covers both sections, so observing it keeps the canvas alive for exactly
  // as long as it's visible. While mounted the canvas runs frameloop="demand":
  // a scroll/resize listener (see FrameModel) invalidates so the explode tracks
  // scroll, and the GPU idles to zero between scrolls. Off-screen it unmounts.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const target = el;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setOnScreen(e.isIntersecting);
      },
      // 900px pre-mount: WebGL context creation + GLB parse cost ~100ms on
      // slow hardware; give it room to happen before the section is visible.
      {rootMargin: '900px 0px', threshold: 0},
    );
    io.observe(target);
    return () => io.disconnect();
  }, [mounted]);

  return (
    <div
      ref={wrapRef}
      className="frame-viewer"
      data-loaded={mounted}
      aria-hidden="true"
    >
      {mounted && onScreen ? (
        // DPR capped at 1.5 to match the hero - 1.75 rasterized ~40% more
        // fragments for a decorative wireframe backdrop.
        <Canvas
          camera={{position: [0, 0.3, 4.4], fov: 38}}
          style={{background: 'transparent'}}
          frameloop="demand"
          dpr={[1, 1.5]}
          gl={{antialias: true, alpha: true, powerPreference: 'default'}}
        >
          {/* Edge-outline parts are unlit - no lights or shadows needed. */}
          <FrameModel
            src={src}
            srcs={allSrcs}
            kind={kind}
            containerRef={wrapRef}
          />
        </Canvas>
      ) : null}
    </div>
  );
}

export default FrameViewer;
