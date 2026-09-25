import {Canvas, useFrame, useThree, invalidate} from '@react-three/fiber';
import {EffectComposer, SMAA} from '@react-three/postprocessing';
import {useRef, useState, useEffect, useCallback} from 'react';
import {useNavigate} from 'react-router';
import type {Group} from 'three';
import * as THREE from 'three';
import {ModelLoader as GLTFLoader} from '~/lib/model-loader';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {HERO_AIRFRAME_KEYS, DEFAULT_HERO_SIZE} from '~/lib/hero-airframes';
import {SLICE_BUDGET_MS, forEachSliced, yieldToMain} from '~/lib/scheduling';
import {
  HERO_SLOTS,
  HERO_ANCHOR_SLOT,
  HERO_REVEAL_WINDOWS,
  heroModelUrl,
  heroSlotHandle,
  type HeroSlotId,
} from '~/lib/builder/registry';

// The hero GLBs use EXT_meshopt_compression (the Onshape assemblies are
// decimated to a few MB/size this way). MeshoptDecoder decodes on the main
// thread - unlike DRACOLoader, which spins up a blob: Web Worker that
// Hydrogen's CSP (worker-src) blocks, causing the loader to hang silently.
function getGLTFLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

// Two refs: `target` is the raw scroll position (updated on every scroll event,
// at the browser's coarse/irregular event cadence) and `smooth` is what the
// scene actually reads. <ScrollDamper> eases smooth → target each frame so the
// camera/explode interpolate fluidly between scroll events instead of snapping
// to each one in visible steps.
function useScrollProgress() {
  const targetRef = useRef(0);
  const smoothRef = useRef(0);
  useEffect(() => {
    // NOTE: no scrollTo(0,0) here - the route owns the first-visit scroll
    // reset (_index.tsx). The scene chunk can resolve seconds after the
    // splash lock releases on slow networks; resetting here teleported a
    // user who had already scrolled back to the top.
    const onScroll = () => {
      targetRef.current = Math.min(
        1,
        Math.max(0, window.scrollY / window.innerHeight),
      );
      invalidate();
    };
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return {targetRef, smoothRef};
}

// Frame-rate-independent exponential smoothing of the scroll progress, PLUS a
// max-velocity clamp. Runs as the first useFrame in the Canvas so downstream
// consumers (lights, camera, assembly) read the freshly-eased value the same
// frame. Keeps re-invalidating while catching up, then snaps exactly to target
// and goes quiet so the demand loop can idle.
//
// RATE (~1/RATE s time constant) governs the gentle ease for ordinary scrolling.
// MAX_RATE caps how fast the animation can advance in progress-units/second:
// when you fling the page hard, the raw scroll target leaps to the end, but the
// scene is not allowed to traverse the whole sequence in two frames - it glides
// at a watchable speed instead of teleporting. Normal slow scrolling never hits
// the cap (its per-frame step is well under it), so it stays directly coupled.
const SCROLL_RATE = 14;
const SCROLL_MAX_VEL = 1.3; // full 0→1 sweep can't play faster than ~0.77s
function ScrollDamper({
  targetRef,
  smoothRef,
}: {
  targetRef: React.RefObject<number>;
  smoothRef: React.RefObject<number>;
}) {
  useFrame((_, dt) => {
    const target = targetRef.current;
    const diff = target - smoothRef.current;
    if (Math.abs(diff) < 0.0002) {
      if (smoothRef.current !== target) {
        smoothRef.current = target;
        invalidate();
      }
      return;
    }
    // Clamp dt so a long stall (tab refocus, GC pause) can't snap the value.
    const cdt = Math.min(dt, 0.1);
    let step = diff * (1 - Math.exp(-cdt * SCROLL_RATE));
    // Velocity cap - bounds the per-frame jump so a momentum fling plays the
    // animation at a controlled rate rather than skipping through it.
    const maxStep = SCROLL_MAX_VEL * cdt;
    if (step > maxStep) step = maxStep;
    else if (step < -maxStep) step = -maxStep;
    smoothRef.current += step;
    invalidate();
  });
  return null;
}

function loadModel(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    getGLTFLoader().load(
      url,
      (gltf) => resolve(gltf.scene),
      (event) => {
        // Content-Length may be missing for cached responses or when the
        // server doesn't set it - `lengthComputable` is the canonical
        // signal. Caller treats unknown totals as a synthetic 0..1 ramp.
        if (event.lengthComputable) onProgress?.(event.loaded, event.total);
        else onProgress?.(event.loaded, 0);
      },
      reject,
    );
  });
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** How the build pipeline gives the main thread back between work slices. */
type YieldFn = () => Promise<void>;

// Cooperative time-slicing for the model build pipeline (shared primitives in
// app/lib/scheduling). The per-slot processing stages (material upgrade/
// dedupe, geometry bake + merge) used to run as single 100-600ms tasks; when
// the background size-preload's idle callback hit its timeout during a
// continuous scroll, one of those tasks landed mid-scroll and dropped frames
// wholesale. Slicing the same loops so no task exceeds ~SLICE_BUDGET_MS keeps
// every stage invisible to the frame loop - identical output, just spread
// across more, smaller tasks.

// Stage timing marks (hero:<stage>) - visible in DevTools Performance and to
// the perf-audit harness via performance.getEntriesByType('measure').
function heroMeasure(name: string, startTime: number) {
  try {
    performance.measure(`hero:${name}`, {start: startTime});
  } catch {
    /* measurement is best-effort */
  }
}

// Warm gold emissive for the selected part's glow (brand accent).
const GLOW_TINT = new THREE.Color(0xc79a32);

/**
 * KiCad/Blender GLB exports typically produce a fresh material instance
 * per mesh, even when many meshes share identical colour/map/PBR settings.
 * `mergeByMaterialRef` buckets by uuid so each of those duplicates becomes
 * its own draw call. Walk the scene first and collapse materials with
 * matching visual fingerprints into a single shared instance - buckets
 * then collapse with them, dropping the draw-call count substantially.
 */
async function dedupeMaterialsByFingerprint(
  scene: THREE.Group,
  yieldFn: YieldFn,
) {
  const pool = new Map<string, THREE.Material>();
  const fp = (m: any) => {
    const c = m.color?.getHexString?.() ?? '_';
    const e = m.emissive?.getHexString?.() ?? '_';
    const map = m.map?.uuid ?? '_';
    const norm = m.normalMap?.uuid ?? '_';
    const meta = (m.metalness ?? 0).toFixed(3);
    const rough = (m.roughness ?? 0).toFixed(3);
    const opa = (m.opacity ?? 1).toFixed(3);
    return `${m.type}|${c}|${e}|${map}|${norm}|${meta}|${rough}|${m.transparent ? 1 : 0}|${opa}|${m.side}`;
  };
  const swap = (m: THREE.Material | null | undefined) => {
    if (!m) return m;
    const key = fp(m);
    const existing = pool.get(key);
    if (existing && existing !== m) {
      m.dispose?.();
      return existing;
    }
    pool.set(key, m);
    return m;
  };
  const meshes: THREE.Mesh[] = [];
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
  });
  await forEachSliced(
    meshes,
    (mesh) => {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material
          .map((m) => swap(m)!)
          .filter(Boolean) as THREE.Material[];
      } else {
        const next = swap(mesh.material);
        if (next) mesh.material = next;
      }
    },
    yieldFn,
  );
}

/**
 * GLB exports from PCB tooling often ship as MeshBasicMaterial (unlit) so
 * the boards look the same under any lighting - bright, flat, no shading.
 * Replace any non-PBR material with a MeshStandardMaterial that preserves
 * the colour/map but actually responds to scene lights.
 */
async function upgradeNonPBRMaterials(scene: THREE.Group, yieldFn: YieldFn) {
  const replaced = new Map<string, THREE.MeshStandardMaterial>();
  const swap = (m: THREE.Material | null | undefined) => {
    if (!m) return m;
    const any = m as any;
    if (any.isMeshStandardMaterial || any.isMeshPhysicalMaterial) return m;
    const existing = replaced.get(m.uuid);
    if (existing) return existing;
    const upgraded = new THREE.MeshStandardMaterial({
      color: any.color?.clone?.() ?? new THREE.Color(0xffffff),
      map: any.map ?? null,
      normalMap: any.normalMap ?? null,
      roughness: 0.78,
      metalness: 0.0,
      transparent: !!any.transparent,
      opacity: any.opacity ?? 1,
      side: any.side ?? THREE.FrontSide,
    });
    replaced.set(m.uuid, upgraded);
    return upgraded;
  };
  const meshes: THREE.Mesh[] = [];
  scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
  });
  await forEachSliced(
    meshes,
    (mesh) => {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material
          .map((m) => swap(m))
          .filter(Boolean) as THREE.Material[];
      } else {
        const next = swap(mesh.material);
        if (next) mesh.material = next;
      }
    },
    yieldFn,
  );
}

/**
 * Collapses a THREE.Group full of small meshes into one merged mesh per
 * bucket key. The GLB exports coming out of our CAD tool have 1200+
 * individual meshes which becomes 1200+ draw calls per frame. Merging
 * them into a handful of buckets (one per material variant) drops draw
 * calls to single digits and is the single biggest GPU win for this
 * scene.
 *
 * `bucketFn` returns a string key per mesh; all meshes with the same key
 * are merged into one BufferGeometry and wrapped in a single Mesh with
 * the material returned by `materialFn`.
 */
async function mergeGroupByBucket(
  source: THREE.Group,
  bucketFn: (mesh: THREE.Mesh) => string,
  materialFn: (key: string) => THREE.Material,
  yieldFn: YieldFn,
): Promise<{group: THREE.Group; meshes: Record<string, THREE.Mesh>}> {
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  source.updateMatrixWorld(true);
  const sourceMeshes: THREE.Mesh[] = [];
  source.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) sourceMeshes.push(mesh);
  });
  // Clone + bake per mesh, time-sliced - with 1200+ meshes this loop was the
  // first half of the monolithic merge task.
  await forEachSliced(
    sourceMeshes,
    (mesh) => {
      const key = bucketFn(mesh);
      const geom = mesh.geometry.clone();
      // Bake mesh world transform into the cloned geometry so the merged
      // result sits where the originals did.
      geom.applyMatrix4(mesh.matrixWorld);
      // mergeGeometries is strict about matching attributes; strip anything
      // non-standard before bucketing.
      const allowed = new Set(['position', 'normal', 'uv']);
      for (const name of Object.keys(geom.attributes)) {
        if (!allowed.has(name)) geom.deleteAttribute(name);
      }
      if (!geom.attributes.normal) geom.computeVertexNormals();
      if (!geom.attributes.uv) {
        // No material samples UVs (frame is a flat colour; boards are untextured),
        // but mergeGeometries needs every primitive in a bucket to share the same
        // attribute set - give the UV-less ones zeroed coords.
        const count = geom.attributes.position.count;
        geom.setAttribute(
          'uv',
          new THREE.BufferAttribute(new Float32Array(count * 2), 2),
        );
      }
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(geom);
    },
    yieldFn,
  );

  // Merge each bucket bottom-up in chunks. Concatenation order is preserved,
  // so the final geometry is byte-identical to a single mergeGeometries call;
  // chunking just bounds each synchronous merge to ~CHUNK geometries so the
  // last big memcpy is the only tens-of-ms task left (vs one 100-600ms task
  // for the whole bucket).
  const MERGE_CHUNK = 64;
  const mergeSliced = async (
    geoms: THREE.BufferGeometry[],
  ): Promise<THREE.BufferGeometry | null> => {
    let level = geoms;
    let disposeLevel = false; // never dispose the caller's clones here
    let sliceStart = performance.now();
    do {
      const next: THREE.BufferGeometry[] = [];
      for (let i = 0; i < level.length; i += MERGE_CHUNK) {
        const chunk = level.slice(i, i + MERGE_CHUNK);
        // Always merge (even single-element chunks) so every level yields
        // freshly-allocated geometries - the caller's clones are never
        // returned and can be disposed unconditionally, same as before.
        const merged = mergeGeometries(chunk, false);
        if (disposeLevel) chunk.forEach((g) => g.dispose());
        if (!merged) {
          if (disposeLevel)
            level.slice(i + MERGE_CHUNK).forEach((g) => g.dispose());
          next.forEach((g) => g.dispose());
          return null;
        }
        next.push(merged);
        if (performance.now() - sliceStart > SLICE_BUDGET_MS) {
          await yieldFn();
          sliceStart = performance.now();
        }
      }
      level = next;
      disposeLevel = true; // intermediates are ours to free
    } while (level.length > 1);
    return level[0] ?? null;
  };

  const group = new THREE.Group();
  const meshes: Record<string, THREE.Mesh> = {};
  for (const [key, geoms] of buckets.entries()) {
    const merged = await mergeSliced(geoms);
    // dispose source clones regardless of merge success
    geoms.forEach((g) => g.dispose());
    if (!merged) continue;
    const material = materialFn(key);
    const mesh = new THREE.Mesh(merged, material);
    mesh.frustumCulled = true;
    group.add(mesh);
    meshes[key] = mesh;
  }

  // Dispose the source scene's original geometries and materials - we've
  // replaced them with the merged version.
  await forEachSliced(
    sourceMeshes,
    (mesh) => {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      mats.forEach((m) => m && (m as THREE.Material).dispose?.());
    },
    yieldFn,
  );

  return {group, meshes};
}

export type LabelRefs = Partial<
  Record<HeroSlotId, React.RefObject<HTMLDivElement | null>>
>;

// A fully-processed part ready to drop into the scene: the merged group and
// its material list (for hover/opacity animation).
type BuiltPart = {group: THREE.Group; mats: THREE.Material[]};
// A fully-processed airframe: one BuiltPart per hero slot (registry order -
// see HERO_SLOTS), keyed by slot id.
type BuiltModel = Map<HeroSlotId, BuiltPart>;

// Raycast no-op - see addProxyHitbox.
const NO_RAYCAST = () => {};

/**
 * Pointer hit-testing used to run against the merged megameshes: three.js
 * Mesh.raycast is a LINEAR per-triangle scan and the 5" trio carries ~1.27M
 * render vertices, so r3f's pointermove raycast walked ~700k triangles per
 * mouse movement over the full-viewport canvas - the main "sometimes laggy"
 * cause, paid even before the scene becomes interactive.
 *
 * Fix: null out raycast on every merged mesh and add ONE invisible box per
 * board, sized to the group's bounds, as the only raycast target. A
 * pointermove now tests 3 boxes (36 triangles) instead of ~700k. Hover/click
 * UX on a bounding box is indistinguishable here (boards are box-shaped and
 * the interactive state only exists fully exploded); the slightly larger hit
 * area is a usability win, not a loss.
 *
 * material.visible=false keeps the proxy out of the render lists entirely
 * (zero draw calls) while three's Raycaster still tests its geometry.
 */
function addProxyHitbox(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  group.traverse((obj: any) => {
    if (obj.isMesh) obj.raycast = NO_RAYCAST;
  });
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const proxyMat = new THREE.MeshBasicMaterial();
  proxyMat.visible = false;
  const proxy = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    proxyMat,
  );
  proxy.position.copy(center);
  proxy.frustumCulled = false;
  group.add(proxy);
}

function disposeBuiltModel(m: BuiltModel) {
  for (const {group: g} of m.values()) {
    g.parent?.remove(g);
    g.traverse((obj: any) => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material)
          ? obj.material
          : [obj.material];
        mats.forEach((mat: any) => mat?.dispose());
      }
    });
  }
}

function DroneAssembly({
  scrollRef,
  onReady,
  onProgress,
  labelRefs,
  loadDelayMs,
  size: airframeSize,
  scrubRef,
  spotlightRef,
  onNavigate,
  onBuildingChange,
}: {
  scrollRef: React.RefObject<number>;
  onReady?: () => void;
  onProgress?: (progress: number) => void;
  labelRefs?: LabelRefs;
  /** Live drag fraction (0→1) from the hero size slider, or null when not
   *  scrubbing. A ref (not state) so dragging it doesn't re-render the page;
   *  the render loop reads it each frame. When non-null it drives the
   *  cross-slide directly so the airframe tracks the thumb 1:1. */
  scrubRef?: React.RefObject<number | null>;
  /** Which board the visitor is hovering on the right-side product cards, or
   *  null. A ref (not state) so hovering doesn't re-render the page; the render
   *  loop reads it each frame and pins that board's spotlight to full. */
  spotlightRef?: React.RefObject<HeroSlotId | null>;
  /** Client-side navigate, threaded from HeroScene (outside the r3f Canvas,
   *  where Router context is available). Used by the part hotspots so a click
   *  is an instant SPA transition into the prefetched PDP rather than a full
   *  document reload. */
  onNavigate?: (url: string) => void;
  /** Delay the network fetch + parse + post-processing of the GLBs by this
   *  many ms so the homepage's CSS wireframe animation gets a clean main
   *  thread for its first frames. Cached visits already see ms-scale loads
   *  so the delay there is invisible. */
  loadDelayMs?: number;
  /** Which airframe to show - a HERO_AIRFRAMES key (e.g. '5' / '3'). Each maps
   *  to a size-specific GLB trio (frame{key}/fc{key}/esc{key}). Changing it
   *  reloads. */
  size: string;
  /** True while a size TOGGLE is waiting on an uncached model build (fetch +
   *  decode + merge). The initial load reports through onProgress/onReady
   *  instead; this feeds the size slider's busy cue so a toggle that has to
   *  build never looks dead. */
  onBuildingChange?: (building: boolean) => void;
}) {
  const {camera, gl, scene, size} = useThree();
  const tmpVec = useRef(new THREE.Vector3()).current;
  const bboxVec = useRef(new THREE.Vector3()).current;
  const bbox = useRef(new THREE.Box3()).current;
  // Reused temporaries for the "lift the focused board toward the camera" math.
  const camLocalVec = useRef(new THREE.Vector3()).current;
  const tmpQuat = useRef(new THREE.Quaternion()).current;
  const wrapperRef = useRef<Group>(null);
  // One <group> per hero slot (registry-driven), replacing the old fixed
  // frame/esc/fc ref trio. Populated by stable per-slot ref callbacks so the
  // slot list can grow without touching this component's structure.
  const slotGroupsRef = useRef(new Map<HeroSlotId, Group | null>());
  const slotRefCallbacksRef = useRef(
    new Map<HeroSlotId, (g: Group | null) => void>(),
  );
  const slotRefFor = (id: HeroSlotId) => {
    let cb = slotRefCallbacksRef.current.get(id);
    if (!cb) {
      cb = (g: Group | null) => {
        slotGroupsRef.current.set(id, g);
      };
      slotRefCallbacksRef.current.set(id, cb);
    }
    return cb;
  };

  const rotRef = useRef(0);
  const dragRef = useRef({x: 0, y: 0});
  const dragging = useRef(false);
  const dragMoved = useRef(false);
  const lastPtr = useRef({x: 0, y: 0});
  const dampedP = useRef(0);
  const focusedRef = useRef(true);
  // Per-slot spotlight weights (smoothed value + target), keyed by slot id.
  // Materials themselves live on the displayed BuiltModel (prevModelRef).
  const zeroPerSlot = () =>
    Object.fromEntries(HERO_SLOTS.map((s) => [s.id, 0])) as Record<
      HeroSlotId,
      number
    >;
  const hoverState = useRef<Record<HeroSlotId, number>>(zeroPerSlot());
  const hoverTarget = useRef<Record<HeroSlotId, number>>(zeroPerSlot());
  // Preallocated per-frame scratch (reveal + focus per slot) - the render loop
  // must not allocate.
  const revealsRef = useRef<number[]>(new Array(HERO_SLOTS.length).fill(0));
  const focusScratchRef = useRef<number[]>(
    new Array(HERO_SLOTS.length).fill(0),
  );
  // Seconds parked on the frame stop - used to hold the frame's spotlight for a
  // beat after it reveals, then fade it out so the very end settles unlit.
  const frameHoldRef = useRef(0);
  // Latched scroll direction. While scrolling BACK (up) the per-part highlight
  // choreography is skipped - only the camera zoom eases smoothly back in.
  const reverseRef = useRef(false);
  // Smoothed pitch/roll so the board-view tilt eases back to rest on scroll-back
  // instead of snapping when the focus is suppressed.
  const tiltXRef = useRef(0.45);
  const tiltZRef = useRef(0.05);
  // Which size is currently shown, and the direction of the active swap along
  // the size row (+1 = moving toward a later item → incoming slides in from
  // the right; −1 = toward an earlier item → in from the left). Lets the
  // cross-slide follow the slider's direction instead of always-from-right.
  const displayedSizeRef = useRef<string>(airframeSize);
  const slideDirRef = useRef(1);
  // Per-size processed models, kept alive across toggles so switching back is
  // instant (no re-fetch / re-decode / re-merge). The inactive size is built
  // lazily on idle AFTER the active one is shown, so it never slows first load.
  const modelCacheRef = useRef<Map<string, BuiltModel>>(new Map());
  // Cross-slide transition progress for the most recent swap (0→1). Starts at 1
  // (settled) so the very first model doesn't animate in. On a toggle the new
  // assembly slides in from the right while the previous one slides out to the
  // left in `outWrapperRef`.
  const transitionRef = useRef(1);
  const hasDisplayedRef = useRef(false);
  const outWrapperRef = useRef<Group>(null);
  const prevModelRef = useRef<BuiltModel | null>(null); // currently displayed
  const outgoingRef = useRef<BuiltModel | null>(null); // sliding out (in outWrapper)
  const outBaseXRef = useRef(0);
  const outBaseScaleRef = useRef(7);
  // Flipped false on unmount so a background preload that finishes afterwards
  // disposes its model instead of leaking it into a torn-down cache.
  const aliveRef = useRef(true);
  // Last scroll event timestamp, read by the background builds' idle gate.
  // Component-lifetime (not per-build-effect) because a background build
  // outlives the effect run that started it.
  const lastScrollTsRef = useRef(0);
  useEffect(() => {
    const onScroll = () => {
      lastScrollTsRef.current = performance.now();
    };
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  // Light vs dark site theme (the `light` class on <html>). The frame is
  // transparent in both, but on the light page it needs to be a touch darker +
  // more solid so it reads instead of the pale page bleeding through.
  const lightRef = useRef(false);
  useEffect(() => {
    const read = () => {
      lightRef.current = document.documentElement.classList.contains('light');
      invalidate();
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => obs.disconnect();
  }, []);

  // Detach the outgoing model's groups from the slide-out wrapper (they return
  // to the cache for reuse - never disposed here).
  const finishOutgoing = useCallback(() => {
    const og = outgoingRef.current;
    if (og && outWrapperRef.current) {
      for (const {group} of og.values()) outWrapperRef.current.remove(group);
    }
    outgoingRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Idle-gated yield for background builds: each work slice waits for a
    // real idle slot instead of racing the user's first scroll. rIC's timeout
    // alone isn't enough - during a long continuous scroll the 1s timeout
    // fired anyway and dropped work (worst: an atomic ~50-150ms GLB parse)
    // right into the animation. So after each idle slot, if a scroll event
    // happened in the last 150ms, keep waiting - bounded at ~5s so a
    // scroll-happy visitor still gets the preload eventually (150ms gaps
    // between wheel gestures are common, so in practice it runs far sooner).
    // The timestamp lives in a component-lifetime ref (listener installed in
    // the mount effect below): a size toggle re-runs THIS effect while a
    // background build keeps going, and an effect-scoped listener would be
    // removed from under it, silently disabling the quiet gate.
    const ricOnce = () =>
      new Promise<void>((resolve) => {
        const ric = (window as any).requestIdleCallback;
        if (typeof ric === 'function') ric(() => resolve(), {timeout: 1000});
        else setTimeout(resolve, 50);
      });
    const yieldToIdle = async () => {
      const start = performance.now();
      await ricOnce();
      while (
        performance.now() - lastScrollTsRef.current < 150 &&
        performance.now() - start < 5000
      ) {
        await ricOnce();
      }
    };

    // Load + fully process one size's GLB trio into a BuiltModel. It never
    // touches the scene/refs, so the result can be cached and dropped in later,
    // or built ahead of time for the inactive size. Returns null if cancelled
    // or on error (freeing any partial GPU resources first).
    async function buildModel(
      sz: string,
      opts: {
        onProg?: (p: number) => void;
        delayMs?: number;
        shouldCancel: () => boolean;
        /** Background build: gate every stage on requestIdleCallback so the
         *  merge/upgrade work never competes with an active scroll. */
        idleYields?: boolean;
      },
    ): Promise<BuiltModel | null> {
      const {onProg, delayMs = 0, shouldCancel} = opts;
      const stageYield = opts.idleYields ? yieldToIdle : yieldToMain;
      const packs: Array<{group: THREE.Group}> = [];
      const bail = (): null => {
        for (const p of packs)
          p.group.traverse((o: any) => {
            if (o.isMesh) {
              o.geometry?.dispose();
              (Array.isArray(o.material) ? o.material : [o.material]).forEach(
                (m: any) => m?.dispose(),
              );
            }
          });
        return null;
      };
      try {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
          if (shouldCancel()) return null;
        }

        // One GLB per hero slot (registry manifest), fetched in parallel.
        const slots = HERO_SLOTS;
        const loaded = new Array<number>(slots.length).fill(0);
        const total = new Array<number>(slots.length).fill(0);
        const reportProgress = () => {
          if (!onProg) return;
          let l = 0,
            t = 0,
            known = 0;
          for (let i = 0; i < slots.length; i++)
            if (total[i] > 0) {
              l += loaded[i];
              t += total[i];
              known += 1;
            }
          onProg(known === 0 ? -1 : Math.min(1, l / t));
        };
        const tFetch = performance.now();
        let loadedScenes: THREE.Group[];
        if (opts.idleYields) {
          // Background build: load the GLBs one at a time with an idle gate
          // between them. GLTFLoader's parse (incl. meshopt decode) is one
          // atomic ~50-150ms task per file; three of them landing together
          // during the user's first scroll was the last big jank source.
          loadedScenes = [];
          for (let i = 0; i < slots.length; i++) {
            await stageYield();
            if (shouldCancel()) return null;
            loadedScenes.push(
              await loadModel(heroModelUrl(slots[i].id, sz), (l, t) => {
                loaded[i] = l;
                total[i] = t;
                reportProgress();
              }),
            );
          }
        } else {
          // Foreground (splash / uncached toggle): parallel - latency wins.
          loadedScenes = await Promise.all(
            slots.map((slot, i) =>
              loadModel(heroModelUrl(slot.id, sz), (l, t) => {
                loaded[i] = l;
                total[i] = t;
                reportProgress();
              }),
            ),
          );
        }
        heroMeasure(`${sz}:fetch+parse`, tFetch);
        if (shouldCancel()) return null;
        const sceneOf = new Map<HeroSlotId, THREE.Group>(
          slots.map((slot, i) => [slot.id, loadedScenes[i]]),
        );

        // Raw Onshape geometry (metres). Fit to a ~0.124-unit frame with ONE
        // uniform scale across all parts - display only; proportions/positions
        // stay exactly as exported. The anchor slot (the frame) defines the
        // airframe's bounds for both the fit and the centering.
        const anchorScene = sceneOf.get(HERO_ANCHOR_SLOT.id)!;
        const FIT_FRAME_SIZE = 0.124;
        const fbox = new THREE.Box3().setFromObject(anchorScene);
        const fsize = fbox.getSize(new THREE.Vector3());
        const fit = FIT_FRAME_SIZE / Math.max(fsize.x, fsize.y, fsize.z, 1e-6);
        for (const s of loadedScenes) s.scale.setScalar(fit);
        for (const s of loadedScenes) s.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(anchorScene);
        const c = box.getCenter(new THREE.Vector3());
        for (const s of loadedScenes) s.position.sub(c);
        for (const s of loadedScenes) s.updateMatrixWorld(true);

        // PCB-finish slots get their materials upgraded to PBR + deduped; the
        // carbon-finish frame keeps a single scene-owned material (below), so
        // its export materials are never touched.
        const pcbSlots = slots.filter((s) => s.finish === 'pcb');
        await stageYield();
        if (shouldCancel()) return null;
        const tMats = performance.now();
        for (const slot of pcbSlots) {
          await upgradeNonPBRMaterials(sceneOf.get(slot.id)!, stageYield);
          if (shouldCancel()) return null;
        }
        for (const slot of pcbSlots) {
          await dedupeMaterialsByFingerprint(sceneOf.get(slot.id)!, stageYield);
          if (shouldCancel()) return null;
        }
        heroMeasure(`${sz}:materials`, tMats);

        // Boards: keep original materials, merge meshes sharing a material.
        const mergeByMaterialRef = (scene: THREE.Group) => {
          const materialsByKey = new Map<string, THREE.Material>();
          return mergeGroupByBucket(
            scene,
            (mesh) => {
              const mat = Array.isArray(mesh.material)
                ? mesh.material[0]
                : mesh.material;
              if (!mat) return 'default';
              const key = mat.uuid;
              if (!materialsByKey.has(key)) materialsByKey.set(key, mat);
              return key;
            },
            (key) =>
              materialsByKey.get(key) ||
              new THREE.MeshStandardMaterial({color: 0x999999}),
            stageYield,
          );
        };

        const setShadowFlags = (
          g: THREE.Group,
          cast: boolean,
          receive: boolean,
        ) => {
          g.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = cast;
            mesh.receiveShadow = receive;
          });
        };

        const built: BuiltModel = new Map();
        for (const slot of slots) {
          const tSlot = performance.now();
          const scene = sceneOf.get(slot.id)!;
          let pack: {group: THREE.Group};
          let mats: THREE.Material[];
          if (slot.finish === 'carbon') {
            // Plain dark frame material - flat carbon colour, no woven texture.
            // Stays partly transparent so the boards read through it; the
            // colour is animated per-frame (see the carbon block in useFrame).
            const frameMat = new THREE.MeshStandardMaterial({
              // Matte, near-non-metallic so the warm key light doesn't bloom
              // the frame into a tan/grey plastic look - it should read as
              // dark carbon.
              color: 0xf2f2f2,
              metalness: 0.0,
              roughness: 0.82,
              transparent: true,
              opacity: 0.62,
              depthWrite: true,
              // polygonOffset pushes the transparent frame's depth back so the
              // near-coplanar plates/boards don't z-fight (keeps see-through
              // frame).
              polygonOffset: true,
              polygonOffsetFactor: 2,
              polygonOffsetUnits: 2,
            });
            pack = await mergeGroupByBucket(
              scene,
              () => 'body',
              () => frameMat,
              stageYield,
            );
            mats = [frameMat];
            // Frame: receives only (it's transparent, so it never casts cleanly).
            setShadowFlags(pack.group, false, true);
          } else {
            pack = await mergeByMaterialRef(scene);
            mats = Array.from(
              new Set(
                pack.group.children.map((m) => (m as THREE.Mesh).material),
              ),
            ).filter(Boolean) as THREE.Material[];
            for (const m of mats) {
              if (!m) continue;
              // Force-zero board emissive so they only show the spotlight, not
              // self-lit.
              if ('emissive' in m) {
                (m as any).emissive.setHex(0x000000);
                (m as any).emissiveIntensity = 0;
              }
              // Onshape exports every board material DOUBLE-SIDED. PCBs are
              // solid, so the inside/back faces never should show - and
              // double-siding makes near-coplanar pad/board faces flicker
              // through one another as the model rotates. Render front-only:
              // correct for a solid and it removes the back-face z-fighting
              // that drove the gold-pad shimmer.
              (m as any).side = THREE.FrontSide;
              (m as any).needsUpdate = true;
            }
            // Boards: OUT of shadows entirely. They used to self-shadow
            // (cast+receive), which on the down-scaled 5" board produced
            // crawling shadow-acne across the fine pad geometry - a fixed
            // world-space bias + fixed shadow-map texel size can't resolve
            // features that small, so the depth comparison flips per-texel as
            // the view rotates. Dropping board self-shadow kills it (and is a
            // small perf win); the look is unchanged at hero distance.
            setShadowFlags(pack.group, false, false);
          }
          packs.push(pack);
          // Swap per-triangle raycasting for invisible bounding-box proxies -
          // pointer moves stop scanning ~700k triangles (see addProxyHitbox).
          addProxyHitbox(pack.group);
          built.set(slot.id, {group: pack.group, mats});
          heroMeasure(`${sz}:merge:${slot.id}`, tSlot);
          await stageYield();
          if (shouldCancel()) return bail();
        }

        return built;
      } catch (err) {
        console.error('Failed to load drone models:', err);
        return bail();
      }
    }

    // Drop a built model into the scene. On a toggle, hand the previous parts
    // to the slide-out wrapper (cached, NOT disposed) so they can exit left
    // while the new ones slide in from the right. Models are never disposed
    // here.
    const display = async (model: BuiltModel) => {
      const prev = prevModelRef.current;
      const isToggle = hasDisplayedRef.current && !!prev && prev !== model;

      if (isToggle) {
        // Direction along the registry's size row: moving to a later index
        // slides in from the right (+1), to an earlier one from the left (−1).
        const order = HERO_AIRFRAME_KEYS;
        const d =
          order.indexOf(airframeSize) - order.indexOf(displayedSizeRef.current);
        slideDirRef.current = d < 0 ? -1 : 1;
      }
      displayedSizeRef.current = airframeSize;

      if (isToggle && outWrapperRef.current && wrapperRef.current) {
        finishOutgoing(); // clear any still-in-flight slide-out first
        // Reparent the previous parts into the slide-out wrapper, frozen at
        // the main wrapper's current transform, then it just translates left.
        for (const {group} of prev.values()) outWrapperRef.current.add(group);
        outWrapperRef.current.position.copy(wrapperRef.current.position);
        outWrapperRef.current.quaternion.copy(wrapperRef.current.quaternion);
        outWrapperRef.current.scale.copy(wrapperRef.current.scale);
        outBaseXRef.current = wrapperRef.current.position.x;
        outBaseScaleRef.current = wrapperRef.current.scale.x;
        outgoingRef.current = prev;
      }

      // Main wrapper now holds only the incoming parts - one per slot group.
      for (const slot of HERO_SLOTS) {
        const holder = slotGroupsRef.current.get(slot.id);
        while (holder && holder.children.length) {
          holder.remove(holder.children[0]);
        }
      }
      for (const {group} of model.values()) group.parent?.remove(group);
      for (const slot of HERO_SLOTS) {
        const part = model.get(slot.id);
        if (part) slotGroupsRef.current.get(slot.id)?.add(part.group);
      }
      if (isToggle) transitionRef.current = 0;
      hasDisplayedRef.current = true;
      prevModelRef.current = model;
      // Force shader compilation NOW rather than lazily during the scroll.
      // three.js builds a GLSL program per material × light × shadow variant on
      // first render; doing that mid-animation is what made the scene choppy
      // until it "warmed up", and made the first scroll right after a size
      // toggle lag hard. compileAsync uses KHR_parallel_shader_compile where
      // available, so the GPU links programs off the main thread instead of
      // the old synchronous gl.compile stalling an active scroll.
      try {
        await gl.compileAsync(scene, camera);
      } catch {
        /* compile is best-effort */
      }
      invalidate();
    };

    (async () => {
      let toggleBuild = false;
      try {
        let model: BuiltModel | null | undefined =
          modelCacheRef.current.get(airframeSize);
        // Cache miss on a size TOGGLE (initial load reports via the splash):
        // surface a busy cue so the slider doesn't look dead while the trio
        // fetches + builds. Cleared structurally by the finally below (and by
        // the effect cleanup if this run is cancelled by another toggle), so
        // no future early return can strand the spinner.
        toggleBuild = !model && hasDisplayedRef.current;
        if (toggleBuild) onBuildingChange?.(true);
        if (!model) {
          model = await buildModel(airframeSize, {
            onProg: onProgress,
            delayMs: loadDelayMs ?? 0,
            shouldCancel: () => cancelled,
          });
          if (!model) {
            onReady?.(); // release the splash even on failure / cancel
            return;
          }
          // A background preload of this same size can have finished while we
          // built (its window is now seconds long under the idle+scroll gates).
          // Never overwrite an existing cache entry: the displayed model must
          // BE the cached one or the unmount disposal leaks it.
          const raced = modelCacheRef.current.get(airframeSize);
          if (raced && raced !== model) {
            disposeBuiltModel(model);
            model = raced;
          } else {
            modelCacheRef.current.set(airframeSize, model);
          }
        }
        if (cancelled) return;
        await display(model);
        onReady?.();

        // Build the OTHER size(s) lazily, only once the thread is idle -
        // scheduled AFTER the active model is shown so it never delays the
        // initial load. With >2 registry sizes each remaining one is built in
        // turn; the chained idle callbacks keep them off the first scroll.
        const others = HERO_AIRFRAME_KEYS.filter((k) => k !== airframeSize);
        const preloadSize = (sz: string) => {
          if (!aliveRef.current || modelCacheRef.current.has(sz)) return;
          void buildModel(sz, {
            shouldCancel: () => !aliveRef.current,
            // Every build stage waits for an idle slot - the background build
            // used to chain setTimeout(0) and its 50–200ms merge stages landed
            // exactly during the user's first scroll-through.
            idleYields: true,
          }).then(async (m) => {
            if (!m) return;
            if (!aliveRef.current) {
              disposeBuiltModel(m);
              return;
            }
            // Warm the size's shaders offscreen too, so the eventual toggle (and
            // the scroll right after it) is smooth instead of stalling on a
            // first-render compile. Parent it into the (idle) slide-out wrapper
            // while the programs link. compileAsync yields to the frame loop, so
            // park the wrapper far outside the frustum for the duration - an
            // on-screen parent would let interleaved frames draw a ghost second
            // drone mid-warm.
            const holder = outWrapperRef.current;
            if (holder) {
              const prevX = holder.position.x;
              holder.position.x = 1e6;
              for (const {group} of m.values()) holder.add(group);
              try {
                await gl.compileAsync(scene, camera);
              } catch {
                /* best-effort */
              }
              for (const {group} of m.values()) holder.remove(group);
              // A size toggle can claim the wrapper for a real slide-out while
              // we awaited; only restore the parking offset if it didn't.
              if (!outgoingRef.current) holder.position.x = prevX;
            }
            // A foreground toggle build for this size can have landed while we
            // warmed shaders; its model is displayed AND cached. Keep that one
            // canonical and drop ours - overwriting would orphan the displayed
            // model from the cache and leak it at unmount.
            if (!aliveRef.current || modelCacheRef.current.has(sz)) {
              disposeBuiltModel(m);
              return;
            }
            modelCacheRef.current.set(sz, m);
          });
        };
        for (const sz of others) {
          if (modelCacheRef.current.has(sz)) continue;
          const schedule = () => preloadSize(sz);
          const ric = (window as any).requestIdleCallback;
          if (typeof ric === 'function') ric(schedule, {timeout: 10000});
          else setTimeout(schedule, 3000);
        }
      } finally {
        if (toggleBuild) onBuildingChange?.(false);
      }
    })().catch((err: unknown) => {
      // buildModel catches its own load errors, but a registry/data bug
      // (heroModelUrl throwing) or a display() failure would otherwise be an
      // unhandled rejection that strands the splash dim-layer - release it.
      console.error('HeroScene: hero model build/display failed:', err);
      onReady?.();
    });

    return () => {
      // Cancel only the in-flight build for THIS size change. Displayed models
      // stay in the cache (and on screen) - they're disposed on unmount below.
      // The next effect run owns the busy cue from here; drop this run's.
      cancelled = true;
      onBuildingChange?.(false);
    };
  }, [airframeSize]);

  // Dispose every cached model (both sizes) on unmount, and stop any in-flight
  // background preload from repopulating the cache afterwards.
  useEffect(() => {
    const cache = modelCacheRef.current;
    return () => {
      aliveRef.current = false;
      for (const m of cache.values()) disposeBuiltModel(m);
      cache.clear();
    };
  }, []);

  const onDown = useCallback((e: any) => {
    dragging.current = true;
    dragMoved.current = false;
    lastPtr.current = {x: e.clientX, y: e.clientY};
  }, []);

  useEffect(() => {
    const onUp = () => {
      dragging.current = false;
      invalidate();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastPtr.current.x;
      const dy = e.clientY - lastPtr.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.current = true;
      dragRef.current.y += dx * 0.004;
      dragRef.current.x += dy * 0.004;
      lastPtr.current = {x: e.clientX, y: e.clientY};
      invalidate();
    };
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  // Pause the perpetual auto-rotate when the window loses focus. The Canvas-level
  // visibilitychange handler only catches a fully hidden tab (switched away /
  // minimised); it does NOT fire when the tab stays "visible" but the window is
  // unfocused - another app on top, a second monitor, another window in front.
  // In that gap RAF keeps running at full rate and the showcase rotation pegs the
  // GPU for nothing. Gate the auto-rotate's invalidate() on focus so the
  // frameloop="demand" loop halts to zero cost while blurred, and kick one frame
  // on refocus to resume. We don't unmount on blur - that would replay the load.
  useEffect(() => {
    focusedRef.current = document.hasFocus();
    const onFocus = () => {
      focusedRef.current = true;
      invalidate();
    };
    const onBlur = () => {
      focusedRef.current = false;
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useFrame((_, dt) => {
    if (!wrapperRef.current) return;
    for (const slot of HERO_SLOTS) {
      if (!slotGroupsRef.current.get(slot.id)) return;
    }

    const prevP = dampedP.current;
    const p = scrollRef.current;
    dampedP.current = p;

    // The drone no longer explodes on scroll - it stays assembled and turning
    // the whole time. Scroll instead pops the product cards out of the Shop
    // bubble on the right (see _index.tsx) and, in here, (a) spotlights the
    // matching board as each card reveals and (b) pulls the camera back a touch
    // once the frame - the LAST card - appears, so the whole airframe reads.
    // The reveal windows are the registry-generated HERO_REVEAL_WINDOWS -
    // the SAME array the route uses to pop the cards, so the glow and the
    // card can no longer fall out of sync. They're spread out with dwell gaps
    // between them so each card is a deliberate, separate scroll beat rather
    // than a continuous sweep, and each reveal plays out within one snap-step
    // gap (HERO_SCROLL_STOPS - see the step controller in _index.tsx), so
    // each board's card is fully shown by the time the scroll settles on its
    // stop. (For 3 slots: [0.08,0.3] / [0.4,0.62] / [0.72,0.94].)
    const reveals = revealsRef.current;
    for (let i = 0; i < HERO_SLOTS.length; i++) {
      reveals[i] = smoothstep(
        HERO_REVEAL_WINDOWS[i][0],
        HERO_REVEAL_WINDOWS[i][1],
        p,
      );
    }
    const lastIdx = HERO_SLOTS.length - 1;
    const lastReveal = reveals[lastIdx];

    // Latch scroll direction. Scrolling back (p decreasing) suppresses the
    // per-part highlight choreography so it doesn't replay in reverse - the
    // camera zoom still eases smoothly because CameraRig reads p directly, not
    // this gate.
    if (p < prevP - 0.0008) reverseRef.current = true;
    else if (p > prevP + 0.0008) reverseRef.current = false;
    const playing = reverseRef.current ? 0 : 1;

    // Per-board focus weights - which centre board the spotlight is on. Each
    // non-final slot's focus peaks at its own stop and hands off as the next
    // slot reveals; boardFocus is 1 while any of them is held, 0 at the top
    // and once the final slot (the frame) reveals. Gated by `playing` so the
    // highlights only run on the way down.
    const focus = focusScratchRef.current;
    let boardFocus = 0;
    for (let i = 0; i < HERO_SLOTS.length; i++) {
      focus[i] = i < lastIdx ? reveals[i] * (1 - reveals[i + 1]) * playing : 0;
      boardFocus += focus[i];
    }

    // Frame highlight with a timed hold: once parked on the frame stop the frame
    // stays highlighted for ~1.5s and then fades, so it gets a real beat in the
    // spotlight before the end settles unlit (a pure scroll-position fade would
    // be over in a frame since the stop sits at p≈1).
    if (lastReveal > 0.98) frameHoldRef.current += dt;
    else frameHoldRef.current = 0;
    const FRAME_HOLD = 1.5;
    const FRAME_FADE = 0.6;
    const frameHi =
      lastReveal *
      (1 -
        smoothstep(FRAME_HOLD, FRAME_HOLD + FRAME_FADE, frameHoldRef.current)) *
      playing;

    // Halt the auto-rotate while scrolling through the FC/ESC reveals so the
    // board being inspected holds still. Spin runs at the very top (the idle
    // hero) and resumes once the frame is revealed (zoomed out) at the end.
    const rotateAmt = Math.max(1 - smoothstep(0, 0.06, p), lastReveal);
    if (!dragging.current && focusedRef.current) {
      rotRef.current += dt * 0.12 * rotateAmt;
    }

    // Always decay drag after release - absorb into rotRef to avoid unwinding
    if (!dragging.current) {
      const decayRate = Math.min(1, 3 * dt);
      const absorbY = dragRef.current.y * decayRate;
      const absorbX = dragRef.current.x * decayRate;
      rotRef.current += absorbY;
      dragRef.current.y -= absorbY;
      dragRef.current.x -= absorbX;
      // Snap to zero when close enough
      if (Math.abs(dragRef.current.y) < 0.0005) dragRef.current.y = 0;
      if (Math.abs(dragRef.current.x) < 0.0005) dragRef.current.x = 0;
    }

    // Rotation - assembled pose, perpetual spin + drag. No explode-driven
    // settling anymore, so the model tracks autoRot/drag directly.
    // Y azimuth: free spin (+ drag) normally; while a centre board is held, ease
    // to a slight 3/4 angle off front (not dead-on) so the board reads with some
    // depth instead of flat-on.
    const FOCUS_AZIMUTH = 0.4; // ~23° off front
    // Ease the spin accumulator ITSELF toward the nearest front-facing 3/4 angle
    // as a board takes focus - rather than overriding the display on top of a
    // frozen spin value. That way, releasing focus on the way back leaves the
    // drone AT this front view and the spin simply resumes from here; it no
    // longer snaps back to whatever angle it was at before you scrolled in.
    const frontTarget =
      Math.round(rotRef.current / (Math.PI * 2)) * (Math.PI * 2) +
      FOCUS_AZIMUTH;
    rotRef.current = THREE.MathUtils.lerp(
      rotRef.current,
      frontTarget,
      Math.min(1, boardFocus * 6 * dt),
    );
    wrapperRef.current.rotation.y = rotRef.current + dragRef.current.y;
    // X tilt: resting 3/4 view normally. Each focusable board carries its own
    // viewing angle in the registry (SlotDef.focusTiltX - FC reads from a
    // slight downward front angle; the ESC sits beneath it so it gets a
    // steeper look-down that clears the FC), weighted by its own focus.
    let targetTiltX = (1 - boardFocus) * 0.45;
    for (let i = 0; i < lastIdx; i++) {
      targetTiltX += focus[i] * (HERO_SLOTS[i].focusTiltX ?? 0);
    }
    const targetTiltZ = (1 - boardFocus) * 0.05;
    // Ease pitch/roll toward target so that when focus is suppressed on the way
    // back, the tilt settles to rest smoothly instead of snapping.
    const tiltEase = Math.min(1, 6 * dt);
    tiltXRef.current += (targetTiltX - tiltXRef.current) * tiltEase;
    tiltZRef.current += (targetTiltZ - tiltZRef.current) * tiltEase;
    wrapperRef.current.rotation.x = tiltXRef.current + dragRef.current.x;
    wrapperRef.current.rotation.z = tiltZRef.current;

    // Scale + lift are constant - the assembled drone keeps a fixed size; the
    // end-of-scroll zoom-out is done by pulling the CAMERA back (CameraRig),
    // not by shrinking the model.
    wrapperRef.current.scale.setScalar(7);
    wrapperRef.current.position.y = 0.07;

    // Cross-slide - on a size toggle the incoming assembly slides in from the
    // right while the outgoing one (frozen in outWrapperRef) slides out to the
    // left. To keep it from feeling dizzying both assemblies also pull back
    // (zoom out) toward the middle of the swap, and the horizontal motion uses
    // an ease-in-out so it starts and stops gently. Applied on top of the
    // scroll transforms (absolute each frame), so x/scale just reset when idle.
    // Scale the slide distance with how far the camera has pulled back. At the
    // frame reveal the camera zooms all the way out, so the frustum is ~2× wider
    // at the model plane; a fixed 1.3-unit slide no longer carried the outgoing
    // trio past the edge, so it was still on screen when finishOutgoing detached
    // it - reading as the old model "just disappearing". Scaling by the camera
    // distance (0.72 = the zoomed-in baseline) keeps the outgoing fully off
    // screen before removal at any zoom level.
    const SLIDE = 1.3 * Math.max(1, camera.position.length() / 0.72);
    const TRANS_DUR = 0.85;
    // easeInOutCubic - gentle acceleration then deceleration.
    const easeSwap = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    // Apply the cross-slide transform for a given progress t (0→1): the
    // incoming trio slides in from the right, the frozen outgoing one slides
    // out left, both dipping back (zoom-out) toward the middle of the swap.
    const applyCrossSlide = (t: number) => {
      const e = easeSwap(t);
      const zoom = 1 - 0.18 * Math.sin(Math.PI * t);
      // d follows the swipe direction: +1 → incoming from the right, −1 → from
      // the left, so the airframe travels the same way the slider thumb does.
      const d = slideDirRef.current || 1;
      wrapperRef.current!.position.x = d * SLIDE * (1 - e);
      wrapperRef.current!.scale.multiplyScalar(zoom);
      if (outgoingRef.current && outWrapperRef.current) {
        outWrapperRef.current.position.x = outBaseXRef.current - d * SLIDE * e;
        outWrapperRef.current.scale.setScalar(outBaseScaleRef.current * zoom);
      }
    };

    const scrubVal = scrubRef?.current ?? null;
    if (scrubVal != null && outgoingRef.current) {
      // Slider scrub - the airframe tracks the thumb 1:1 instead of the timer.
      // Gated on an outgoing trio existing so a scrub that arrives before the
      // swap is set up (or with the other size still building) just holds.
      transitionRef.current = THREE.MathUtils.clamp(scrubVal, 0, 1);
      applyCrossSlide(transitionRef.current);
      invalidate();
    } else if (transitionRef.current < 1) {
      transitionRef.current = Math.min(
        1,
        transitionRef.current + dt / TRANS_DUR,
      );
      applyCrossSlide(transitionRef.current);
      if (transitionRef.current >= 1) {
        wrapperRef.current.position.x = 0;
        finishOutgoing();
      }
      invalidate();
    } else {
      wrapperRef.current.position.x = 0;
      // A scrub released exactly at 1 never enters the timer branch, so clear
      // any still-parented outgoing trio here. finishOutgoing is idempotent.
      if (outgoingRef.current) finishOutgoing();
    }

    // Highlight focus - smoothed per-part target (scroll reveal + hover
    // override). The frame's hold (frameHi) gives it a beat before settling.
    const hovered = spotlightRef?.current ?? null;
    if (hovered) {
      // Hovering a product card selects ONLY that part and overrides the scroll
      // focus entirely - otherwise the hovered part AND the scroll-focused part
      // were both "selected" at once (both lifted toward the camera and glowed),
      // which collided into a broken-looking double state.
      for (const slot of HERO_SLOTS) {
        hoverTarget.current[slot.id] = hovered === slot.id ? 1 : 0;
      }
    } else {
      for (let i = 0; i < HERO_SLOTS.length; i++) {
        // Non-final slots follow their scroll focus; the final slot (the
        // frame) follows its timed hold.
        hoverTarget.current[HERO_SLOTS[i].id] =
          i < lastIdx ? focus[i] : frameHi;
      }
    }
    let glowAnimating = false;
    let anyFocus = 0;
    for (const slot of HERO_SLOTS) {
      const key = slot.id;
      const target = hoverTarget.current[key];
      const prev = hoverState.current[key];
      hoverState.current[key] += (target - prev) * Math.min(1, 8 * dt);
      if (Math.abs(hoverState.current[key] - target) > 0.01)
        glowAnimating = true;
      if (hoverState.current[key] > anyFocus)
        anyFocus = hoverState.current[key];
    }

    // Spotlight ONE component at a time. Two cheap, robust moves (NO transparency
    // - that sorted badly and jumbled the overlapping boards):
    //  1. Lift the focused board toward the camera so it pops clear of the stack
    //     instead of hiding behind the board above it.
    //  2. Darken everything that isn't focused (multiply its base colour down) so
    //     the lit component stands alone. Opaque throughout → no sort artifacts.
    const LIFT = 0.02;
    camLocalVec
      .copy(camera.position)
      .normalize()
      .applyQuaternion(tmpQuat.copy(wrapperRef.current.quaternion).invert());
    for (const slot of HERO_SLOTS) {
      const g = slotGroupsRef.current.get(slot.id)!;
      if (slot.fitAnchor) {
        // The anchor (frame) never lifts - it IS the airframe.
        g.position.set(0, 0, 0);
        g.scale.setScalar(1);
      } else {
        g.position
          .copy(camLocalVec)
          .multiplyScalar(LIFT * hoverState.current[slot.id]);
      }
    }

    const DIM = 0.82; // how hard non-focused parts darken
    const GLOW = 0.06; // gold emissive strength on the selected part (subtle)
    const brightOf = (f: number) => Math.max(0.2, 1 - (anyFocus - f) * DIM);
    // Darken non-focused parts (colour) AND glow the focused one (gold emissive
    // scaled by its own focus, so it lights up as it's selected and fades out
    // again as focus moves on). Materials live on the displayed BuiltModel.
    const displayed = prevModelRef.current;
    const applyPart = (mats: THREE.Material[] | undefined, focus: number) => {
      if (!mats) return;
      const bright = brightOf(focus);
      for (const m of mats as any[]) {
        if (!m || !m.color) continue;
        if (!m.userData.baseColor) m.userData.baseColor = m.color.clone();
        m.color.copy(m.userData.baseColor).multiplyScalar(bright);
        if (m.emissive) {
          m.emissive.copy(GLOW_TINT);
          m.emissiveIntensity = focus * GLOW;
        }
      }
    };
    for (const slot of HERO_SLOTS) {
      if (slot.finish === 'carbon') continue; // scene-owned material, below
      applyPart(displayed?.get(slot.id)?.mats, hoverState.current[slot.id]);
    }

    // Carbon frame - fixed (less-transparent) opacity that firms up while it's
    // the focused product; its grey darkens when a board holds the focus, and
    // it glows gold while the frame itself is selected.
    for (const slot of HERO_SLOTS) {
      if (slot.finish !== 'carbon') continue;
      const frameFocus = hoverState.current[slot.id];
      const frameBright = brightOf(frameFocus);
      const fb = ((lightRef.current ? 0x6e : 0x14) / 255) * frameBright;
      const frameBase = lightRef.current ? 0.58 : 0.6;
      const frameHiOp = lightRef.current ? 0.82 : 0.92;
      for (const m of (displayed?.get(slot.id)?.mats ?? []) as any[]) {
        if (!m) continue;
        m.opacity = THREE.MathUtils.lerp(frameBase, frameHiOp, frameFocus);
        if (m.color) m.color.setRGB(fb, fb, fb);
        if (m.emissive) {
          m.emissive.copy(GLOW_TINT);
          m.emissiveIntensity = frameFocus * GLOW * 0.6;
        }
      }
    }

    // Project model world positions to screen coords and update the
    // label overlay divs imperatively - keeps labels glued under each
    // board as the assembly rotates/moves, without triggering React
    // re-renders every frame.
    //
    // Only while the labels are actually on screen. They fade in at p≈0.72
    // (linearstep(0.72, 0.84) in the route), so below ~0.66 this whole block -
    // a forced full-subtree updateMatrixWorld plus 3× Box3.setFromObject, all
    // on the main thread - was running every frame through the explode for
    // labels nobody can see. That was a big chunk of the fast-scroll jank.
    if (labelRefs && p >= 0.66) {
      wrapperRef.current.updateMatrixWorld(true);
      const project = (
        target: React.RefObject<HTMLDivElement | null>,
        group: Group | null,
      ) => {
        const el = target.current;
        if (!el || !group) return;
        bbox.setFromObject(group);
        if (bbox.isEmpty()) {
          el.style.opacity = '0';
          return;
        }
        bbox.getCenter(bboxVec);
        tmpVec.set(bboxVec.x, bbox.min.y, bboxVec.z).project(camera);
        if (tmpVec.z > 1) {
          el.style.opacity = '0';
          return;
        }
        const x = (tmpVec.x * 0.5 + 0.5) * size.width;
        const y = (-tmpVec.y * 0.5 + 0.5) * size.height;
        el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, 0)`;
        el.style.opacity = '';
      };
      for (const slot of HERO_SLOTS) {
        const target = labelRefs[slot.id];
        if (target) project(target, slotGroupsRef.current.get(slot.id) ?? null);
      }
    }

    // Keep rendering whenever anything is moving. Now that draw calls
    // are in the single digits the scene is cheap enough to let the
    // browser's RAF drive it at display rate.
    const scrollChanged = Math.abs(p - prevP) > 0.0001;
    // Auto-rotate keeps the loop alive only while focused - a blurred window
    // (still "visible", so visibilitychange never fired) otherwise burns the GPU
    // at full rate on a rotation no one is watching.
    const isAutoRotating = focusedRef.current; // perpetual spin while focused
    const hasDragMomentum =
      Math.abs(dragRef.current.x) > 0.0005 ||
      Math.abs(dragRef.current.y) > 0.0005;
    if (
      scrollChanged ||
      dragging.current ||
      hasDragMomentum ||
      glowAnimating ||
      isAutoRotating
    ) {
      invalidate();
    }
  });

  // The drone is always assembled now, so the three boards overlap spatially and
  // there's no unambiguous part to click/hover. Disable per-part interaction -
  // the spotlight is driven by scroll reveal, and clicking the stack should do
  // nothing rather than navigate to a guessed PDP. Drag-to-rotate still works.
  const isInteractive = useCallback(() => false, []);

  const handleClick = useCallback(
    (url: string) => {
      if (!dragMoved.current && isInteractive()) {
        // Client-side nav into the prefetched PDP - instant. Falls back to a
        // hard load only if no navigate was threaded in.
        if (onNavigate) onNavigate(url);
        else window.location.href = url;
      }
    },
    [isInteractive, onNavigate],
  );

  const hover = useCallback(
    (key: HeroSlotId, value: boolean) => {
      if (!isInteractive()) return;
      hoverTarget.current[key] = value ? 1 : 0;
      document.body.style.cursor = value ? 'pointer' : '';
      invalidate();
    },
    [isInteractive],
  );

  return (
    <>
      <group
        ref={wrapperRef}
        scale={7}
        rotation={[0.6, 0, 0.05]}
        onPointerDown={onDown}
      >
        {/* One hit-target group per hero slot, registry order. The PDP url
            comes from the slot's product handle (registry commerce data). */}
        {HERO_SLOTS.map((slot) => (
          <group
            key={slot.id}
            ref={slotRefFor(slot.id)}
            onPointerOver={() => hover(slot.id, true)}
            onPointerOut={() => hover(slot.id, false)}
            onClick={() => handleClick(`/products/${heroSlotHandle(slot.id)}`)}
          />
        ))}
      </group>
      {/* Holds the previous assembly while it slides out on a size toggle. */}
      <group ref={outWrapperRef} />
    </>
  );
}

type PerfSample = {
  fps: number;
  renderMs: number;
  // Sticky over a 3s window so a fast scroll's damage survives long enough to
  // screenshot AFTER you stop moving.
  worstMs: number; // slowest single frame in the window
  jank: number; // # frames slower than 20ms (a dropped frame at 120/60Hz)
  drawCalls: number; // true total per frame (autoReset off; counts composer passes)
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  dpr: number;
  width: number;
  height: number;
};

const PERF_WINDOW_MS = 3000;
const PERF_JANK_MS = 20;

function PerfProbe({onSample}: {onSample: (s: PerfSample) => void}) {
  const {gl, size, viewport} = useThree();
  const frames = useRef(0);
  const lastT = useRef(performance.now());
  const intervalAccum = useRef(0);
  const prevFrameT = useRef(0);
  // Ring of recent frame timings {t, dt} for the sticky worst/jank window.
  const ring = useRef<Array<{t: number; dt: number}>>([]);
  // Real per-frame draw totals - three resets info per gl.render() call, and
  // EffectComposer renders several passes per frame, so the default counter
  // only ever shows the last (SMAA) pass = 1. Turn autoReset off and reset once
  // per frame ourselves so calls/triangles accumulate across all passes.
  const lastDraw = useRef(0);
  const lastTris = useRef(0);
  useEffect(() => {
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);

  useFrame(() => {
    // At the top of the frame, info holds the PREVIOUS frame's full render
    // (all composer passes, since autoReset is off). Capture, then reset so
    // this frame accumulates cleanly.
    lastDraw.current = gl.info.render.calls;
    lastTris.current = gl.info.render.triangles;
    gl.info.reset();

    const now = performance.now();
    if (prevFrameT.current) {
      const dt = now - prevFrameT.current;
      intervalAccum.current += dt;
      ring.current.push({t: now, dt});
    }
    prevFrameT.current = now;
    frames.current += 1;

    if (now - lastT.current >= 500) {
      const elapsed = now - lastT.current;
      const avgInterval =
        frames.current > 1 ? intervalAccum.current / (frames.current - 1) : 0;
      // Prune ring to the sticky window, then derive worst/jank from it.
      const cutoff = now - PERF_WINDOW_MS;
      ring.current = ring.current.filter((e) => e.t >= cutoff);
      let worst = 0;
      let jank = 0;
      for (const e of ring.current) {
        if (e.dt > worst) worst = e.dt;
        if (e.dt > PERF_JANK_MS) jank += 1;
      }
      onSample({
        fps: Math.round((frames.current * 1000) / elapsed),
        renderMs: +avgInterval.toFixed(2),
        worstMs: +worst.toFixed(1),
        jank,
        drawCalls: lastDraw.current,
        triangles: lastTris.current,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        programs: gl.info.programs?.length ?? 0,
        dpr: viewport.dpr,
        width: Math.round(size.width),
        height: Math.round(size.height),
      });
      frames.current = 0;
      intervalAccum.current = 0;
      lastT.current = now;
    }
  });
  return null;
}

/**
 * Adaptive render resolution. The old fixed dpr cap of 1.25 was one quality
 * point for every GPU: Apple Silicon left sharpness on the table (blurry on
 * 2× Retina) while weak iGPUs still janked when the exploded boards filled
 * the screen. This drifts the dpr between 1.0 and min(devicePixelRatio, 1.5)
 * from measured frame times:
 *  - a window of consistently fast frames (<9 ms worst) steps UP one notch;
 *  - sustained jank (≥8 frames >24 ms in a window) steps DOWN and LATCHES -
 *    a GPU that janked once never gets re-raised, avoiding oscillation and
 *    repeated render-target reallocations (each setDpr realloc has a cost).
 * Demand-loop aware: only deltas from continuous rendering bursts count;
 * multi-second idle gaps between frames are skipped.
 */
const DPR_STEPS = [1, 1.25, 1.5];
function AdaptiveDpr() {
  const setDpr = useThree((s) => s.setDpr);
  const idxRef = useRef(1); // start at 1.25 - the previous fixed cap
  const maxIdxRef = useRef(1);
  const samplesRef = useRef<number[]>([]);
  const latchedDownRef = useRef(false);

  useEffect(() => {
    const native = window.devicePixelRatio || 1;
    let maxIdx = 0;
    for (let i = 0; i < DPR_STEPS.length; i++) {
      if (DPR_STEPS[i] <= Math.min(native, 1.5)) maxIdx = i;
    }
    maxIdxRef.current = maxIdx;
    if (idxRef.current > maxIdx) {
      idxRef.current = maxIdx;
      setDpr(DPR_STEPS[maxIdx]);
    }
  }, [setDpr]);

  useFrame((_, dt) => {
    // Demand loop: dt spans idle gaps when nothing invalidated. Only frames
    // from an active burst (≤100ms apart) say anything about render cost.
    if (dt <= 0 || dt > 0.1) return;
    const samples = samplesRef.current;
    samples.push(dt * 1000);
    if (samples.length < 60) return;

    let worst = 0;
    let jank = 0;
    for (const ms of samples) {
      if (ms > worst) worst = ms;
      if (ms > 24) jank += 1;
    }
    samples.length = 0;

    const idx = idxRef.current;
    if (jank >= 8 && idx > 0) {
      idxRef.current = idx - 1;
      latchedDownRef.current = true;
      setDpr(DPR_STEPS[idxRef.current]);
      invalidate();
    } else if (
      !latchedDownRef.current &&
      worst < 9 &&
      idx < maxIdxRef.current
    ) {
      idxRef.current = idx + 1;
      setDpr(DPR_STEPS[idxRef.current]);
      invalidate();
    }
  });
  return null;
}

/**
 * Hemi ramps down with scroll to preserve the harsh top-down gradient
 * in the rotating hero state (0.72 top sky color vs 0.18 ground in hemi
 * creates a strong vertical lift across the stacked boards) while
 * dropping it at the end so the directional key dominates and its cast
 * shadows read clearly. Key and rim stay constant - that earlier
 * dimming was what caused the dark→light→dark feel.
 */
function SceneLights() {
  // Constant lighting - highlighting is done per-object (fading the
  // non-focused parts' opacity in DroneAssembly), not by touching the lights,
  // so a single board can be isolated instead of the whole scene reacting.
  return (
    <>
      <hemisphereLight args={['#cfdaeb', '#1a1d22', 0.72]} />
      {/* Warm key light. No casts - nothing receives a real shadow. */}
      <spotLight
        position={[0, 2.4, 0.9]}
        angle={0.58}
        penumbra={0.7}
        decay={1.6}
        distance={7}
        intensity={32}
        color="#ffe8cc"
      />
      {/* Cool fill / rim from behind-left. */}
      <directionalLight
        position={[-1.4, 0.35, -0.7]}
        intensity={0.8}
        color="#7891b6"
      />
    </>
  );
}

function CameraRig({scrollRef}: {scrollRef: React.RefObject<number>}) {
  const {camera} = useThree();

  useFrame(() => {
    const p = scrollRef.current;

    // Hold the tight assembled view through the board reveals, then pull the
    // camera back ONLY once it reaches the frame (the last card) so the whole
    // airframe clears the edges. Opens with the LAST registry reveal window
    // (0.72 for the current 3 slots) - the same one DroneAssembly reads.
    const pull = smoothstep(
      HERO_REVEAL_WINDOWS[HERO_REVEAL_WINDOWS.length - 1][0],
      1.0,
      p,
    );

    camera.position.set(
      0,
      THREE.MathUtils.lerp(0.15, 0.3, pull),
      THREE.MathUtils.lerp(0.7, 1.5, pull),
    );
    camera.lookAt(0, 0, 0);
  });
  return null;
}

const PERF_HUD = false;

export function HeroScene({
  onReady,
  onProgress,
  labelRefs,
  loadDelayMs,
  size = DEFAULT_HERO_SIZE,
  scrubRef,
  spotlightRef,
  onBuildingChange,
}: {
  onReady?: () => void;
  onProgress?: (progress: number) => void;
  labelRefs?: LabelRefs;
  loadDelayMs?: number;
  size?: string;
  scrubRef?: React.RefObject<number | null>;
  spotlightRef?: React.RefObject<HeroSlotId | null>;
  onBuildingChange?: (building: boolean) => void;
} = {}) {
  const [mounted, setMounted] = useState(false);
  const [perf, setPerf] = useState<PerfSample | null>(null);
  const navigate = useNavigate();
  const {targetRef, smoothRef} = useScrollProgress();
  useEffect(() => {
    setMounted(true);
  }, []);

  // NOTE: the Canvas is deliberately NOT unmounted when the hero scrolls
  // off-screen or the tab hides. The old unmount-at-200vh "pause" disposed
  // the whole per-size model cache, so crossing back above the threshold
  // mid-scroll replayed fetch → meshopt decode → merge → shader compile on a
  // fresh WebGL context: a multi-hundred-ms hitch and a visibly missing
  // drone - and the threshold didn't even match the real 220vh spacer.
  // With frameloop="demand" a static scene idles at zero cost (the
  // auto-rotate is already gated on scroll phase + window focus, and a
  // hidden tab gets no RAF at all), so keeping it mounted is effectively
  // free and scrolling back up is instant.

  if (!mounted)
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-16 h-16 border border-[var(--color-border)] rounded-full flex items-center justify-center">
          <div className="w-8 h-8 border-t border-[var(--color-gold)] rounded-full animate-spin" />
        </div>
      </div>
    );

  return (
    <div
      className="absolute inset-0"
      role="img"
      aria-label="3D interactive drone assembly viewer"
    >
      <Canvas
        // near/far kept tight around the drone (~0.7–1.5 units away, ~1 unit
        // across). The three.js default far of 2000 wastes almost all depth
        // precision on empty space, which makes near-coplanar surfaces - the
        // gold FC pads on the board - z-fight when you rotate the model. A
        // 200:1 range fixes it. (Worst on 5": its tighter fit-scale puts the
        // pad/board gap right at the precision limit.)
        camera={{position: [0, 0.15, 0.7], fov: 40, near: 0.1, far: 20}}
        style={{background: 'transparent'}}
        // No `shadows` - nothing in the scene sets castShadow (frame + boards
        // are all cast=false), so the shadow map was rendering empty every
        // frame: a render-target bind/clear + extra depth-material programs for
        // zero visible shadow. Dropping it is a free per-frame win.
        frameloop="demand"
        // Initial pixel ratio 1.25 - fragment (fill) cost scales with dpr²,
        // and this scene is fill-bound once the boards explode full-screen.
        // From here <AdaptiveDpr> drifts the live value between 1.0 and 1.5
        // off measured frame times: fast GPUs earn back full Retina
        // sharpness, weak ones shed load before they jank.
        dpr={[1, 1.25]}
        gl={{
          // MSAA off - replaced by an SMAA postprocess pass below. MSAA
          // at DPR 1.5 on Retina was rasterising 4 samples × 2.25× the
          // pixel count; SMAA is a fixed per-pixel cost decoupled from
          // scene complexity and looks ≈ 4×MSAA for this material set.
          antialias: false,
          alpha: true,
          // 'default' lets macOS pick an efficient GPU schedule.
          // 'high-performance' previously forced the GPU into its
          // always-on max-perf mode even for a slow showcase rotation,
          // burning power without any visual benefit.
          powerPreference: 'default',
        }}
        onCreated={({camera, gl}) => {
          camera.lookAt(0, 0, 0);
          // Tighten the depth range HERE - r3f bakes the `camera` prop's
          // near/far at creation and doesn't reliably re-apply them, so set
          // them on the live camera. The drone sits ~0.7–1.5 units away and is
          // ~1 unit across; a 200:1 range (vs the default 20000:1) restores the
          // depth precision the near-coplanar FC gold pads need to stop z-fighting.
          const cam = camera as THREE.PerspectiveCamera;
          cam.near = 0.1;
          cam.far = 20;
          cam.updateProjectionMatrix();
          // Exposure pulled down so the spotlight key doesn't push the
          // pastel-green PCB albedo into pure white.
          gl.toneMappingExposure = 0.78;
          invalidate();
        }}
      >
        {/* First useFrame in the tree - eases smoothRef toward the raw scroll
            target so every consumer below reads the damped value this frame. */}
        <ScrollDamper targetRef={targetRef} smoothRef={smoothRef} />
        <AdaptiveDpr />
        <SceneLights />
        <CameraRig scrollRef={smoothRef} />
        <DroneAssembly
          scrollRef={smoothRef}
          onReady={onReady}
          onProgress={onProgress}
          labelRefs={labelRefs}
          loadDelayMs={loadDelayMs}
          size={size}
          scrubRef={scrubRef}
          spotlightRef={spotlightRef}
          onNavigate={(url) => void navigate(url)}
          onBuildingChange={onBuildingChange}
        />
        <EffectComposer multisampling={0} enableNormalPass={false}>
          <SMAA />
        </EffectComposer>
        {PERF_HUD ? <PerfProbe onSample={setPerf} /> : null}
      </Canvas>
      {PERF_HUD && perf ? (
        <div
          style={{
            position: 'absolute',
            top: 70,
            left: 16,
            padding: '8px 12px',
            background: 'rgba(0,0,0,0.65)',
            border: '1px solid rgba(184,146,46,0.4)',
            borderRadius: 6,
            color: '#e5e5e5',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            lineHeight: 1.5,
            pointerEvents: 'none',
            zIndex: 100,
            whiteSpace: 'pre',
          }}
        >
          {`FPS        ${perf.fps}
FRAME MS   ${perf.renderMs}
WORST 3s   ${perf.worstMs}ms
JANK 3s    ${perf.jank} frames >${PERF_JANK_MS}ms
DRAW       ${perf.drawCalls}
TRIS       ${perf.triangles}
GEOMS      ${perf.geometries}
TEX        ${perf.textures}
PROGS      ${perf.programs}
DPR        ${perf.dpr}
SIZE       ${perf.width}x${perf.height}`}
        </div>
      ) : null}
    </div>
  );
}
