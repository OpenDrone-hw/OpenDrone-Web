/**
 * Scroll-driven hero built from the Onshape assembly.
 *
 * This is the studio's proven scene core (public/models/od3/_studio.html) minus
 * the tuning panel. It is deliberately vanilla three.js inside a ref container
 * rather than react-three-fiber: the studio version is the one that has been
 * tuned and debugged against the real assembly, and reimplementing it in r3f
 * would mean re-finding all of the same bugs.
 *
 * Tunables come from /models/<model>/studio.json, which is what the studio
 * writes. Structure (which parts form a beat, the teardown choreography) is
 * still in code here; see that file's _status field.
 */
import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {ModelLoader as GLTFLoader} from '~/lib/model-loader';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {heroCaption, whatIsThisHref} from '~/lib/product-content';
import {instanceHeroDraws, mergeHeroGeometry, updateHeroMatrices} from '~/lib/hero-geometry';
import {yieldToMain} from '~/lib/scheduling';

export type HeroBeat = {
  id: string;
  title: string;
  note: string;
  /** Beginner explainer shown under the note (studio-editable, studio.json). */
  caption?: string;
  /** One-line "connects to" hint below the caption. */
  hint?: string;
  /** Product page for this part, when we sell it. */
  href?: string;
  /** Mid-hold caption changes, in hold order. Only the fallback DOM renders
   *  these as a list; live, the reported beat IS the active stop's copy. */
  stops?: Array<{
    title: string;
    note: string;
    caption?: string;
    hint?: string;
    href?: string;
  }>;
};

/** One streamed piece of the assembly, as written by build-hero.mjs --split. */
type Chunk = {id: string; label: string; file: string; bytes: number};
type ChunkManifest = {chunks?: Chunk[]};

/** Progress of the model download, for the splash. */
export type HeroLoadState = {
  /** Human-readable name of the piece currently arriving. */
  label: string;
  /** 0..1 across the whole assembly, weighted by real byte counts. */
  frac: number;
  /** Chunk id, so a caller can react to a specific piece landing. */
  chunk: string;
  /** True on the event that fires once this chunk is in the scene. */
  done: boolean;
  /** Every piece in load order, so the splash can show the full manifest. */
  pieces: Array<{id: string; label: string}>;
};

/** The one design that is always present. */
const FALLBACK_MODEL = 'od3';

export type HeroDroneSceneProps = {
  /** Folder under /public/models holding drone.glb + studio.json. */
  model?: string;
  onModel?: (folder: string) => void;
  /** Fires as the reader moves through the sequence, 0..1. */
  onProgress?: (frac: number) => void;
  /** Fires when the presented beat changes; null while the drone rests whole. */
  onBeat?: (beat: HeroBeat | null, index: number) => void;
  /** The list of beats, once known. */
  onBeats?: (beats: HeroBeat[]) => void;
  /** Fires as the model streams in, for the splash progress. */
  onLoad?: (state: HeroLoadState) => void;
  /** Fires once the model is on screen. */
  onReady?: () => void;
  onBuilding?: (building: boolean) => void;
  /** Handed a jump function once ready, so the rail dots can seek. */
  onSeeker?: (goTo: (i: number) => void) => void;
  /** Reduced motion: start exploded, no travelling camera, no idle drift. */
  reduced?: boolean;
  /** Handed a collapse / explode control once ready (null on teardown). */
  onExplode?: (api: {toggle: () => void; set: (exploded: boolean) => void} | null) => void;
  /** Fires when the build is told to explode (true) or collapse (false). */
  onExploded?: (exploded: boolean) => void;
};

/* three.js mangles imported names three ways: it appends _1/_2 to duplicates,
 * turns spaces into underscores, and DELETES [ ] . : / entirely. Onshape also
 * wraps each part in occurrence_of_<name>. Undo all of it before matching, or
 * name-based rules silently miss most of the assembly. */
const tidy = (n?: string | null) =>
  (n ?? '')
    .replace(/_\d+$/, '')
    .replace(/_/g, ' ')
    .replace(/^occurrence of /i, '')
    .trim();

/* Onshape writes 8-bit sRGB into baseColorFactor, which glTF defines as linear.
 * Measured on this export: 183 of 183 components are exact n/255. Without this
 * every albedo renders overbright, worst on dark surfaces. */
const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

type MatProfile = {
  id: string;
  match: string | null;
  tint: string | null;
  metalness: number;
  roughness: number;
  env: number;
  sat: number;
};
type StudioConfig = {
  model?: string;
  yAxisUp?: boolean;
  motorMatch?: string;
  motorHardwareMatch?: string;
  propMatch?: string;
  lighting: any;
  spotlight: any;
  sequence: any;
  camera?: any;
  /** Dim of the rest on a selected part. */
  explode?: {selectFade?: number};
  scroll?: {
    springHz?: number;
    gain?: number;
    magnet?: number;
    commitAt?: number;
    minDwellS?: number;
    /** Seconds the whole drone holds at a rest stop mid-passage, so the
     *  reader sees where the last part flew home before the next pulls out. */
    restDwellS?: number;
    /** Pixels of wheel intent that commit a one-stop move. */
    stepPx?: number;
  };
  materials: MatProfile[];
  boards: Array<{id: string; title: string; note: string}>;
  boardExclude: string;
  videoModule: string;
  notFrame: string;
  beats: any[];
};

/** Pixel ratio cap: past this the extra pixels cost fill rate and no visible detail. */
const MAX_DPR = 1.75;

/** Critically damped smoothing (no overshoot, continuous velocity so a retarget mid-move
 *  continues from the current state). `vel` carries the velocity between frames. */
function smoothDamp(cur: number, goal: number, vel: {v: number}, smoothTime: number, dt: number) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - goal;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * e;
  return goal + (change + temp) * e;
}

export function HeroDroneScene({
  model = 'od3',
  onModel,
  onProgress,
  onBeat,
  onBeats,
  onLoad,
  onReady,
  onBuilding,
  onSeeker,
  reduced = false,
  onExplode,
  onExploded,
}: HeroDroneSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const snapshot = useRef<HTMLCanvasElement>(null);
  const snapshotFade = useRef<Animation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let capture: (() => void) | null = null;
    setError(null);
    onBuilding?.(true);
    const cleanup: Array<() => void> = [];
    const controller = new AbortController();
    cleanup.push(() => controller.abort());

    const TEST = typeof location !== 'undefined' && new URLSearchParams(location.search).has('herotest');
    // User Timing marks for load measurements (DevTools Performance panel or
    // performance.getEntriesByType('mark')): start, first part on screen, ready.
    const mark = (name: string) => {
      try {
        performance.mark(`hero:${name}`);
      } catch {
        /* no User Timing: nothing to record */
      }
    };
    mark('start');
    // /public is served with a one-year max-age and these files are not
    // content-hashed, so a returning visitor kept an old studio.json (no
    // handles, no captions) for a year after every deploy: the site said
    // one thing, their browser another (maintainer, 2026-08-15). Vite's base is
    // the per-deployment CDN path on Oxygen, so it is a free build id.
    const V = encodeURIComponent(
      (import.meta.env.BASE_URL || '/').replace(/[^a-z0-9]/gi, '').slice(-24) || 'dev',
    );
    const modelUrl = (folder: string, file: string) => `/models/${folder}/${file}?v=${V}`;

    (async () => {
      // Only some sizes have an assembly built. Fall back rather than 404ing,
      // so the size selector keeps working before the other models exist.
      // studio.json, explode.json and chunks.json go out together: they are
      // no-cache in production, so even a warm reload revalidates each one, and
      // chained they cost a round trip apiece before the first part can show.
      const metaFor = (f: string) => {
        const get = (file: string) => fetch(modelUrl(f, file), {signal: controller.signal});
        const meta = {studio: get('studio.json'), explode: get('explode.json'), chunks: get('chunks.json')};
        for (const pending of Object.values(meta)) void pending.catch(() => {});
        return meta;
      };
      let folder = model;
      let meta = metaFor(folder);
      // The carbon maps are shared by both sizes and tiny: out with the JSON,
      // not after it, so waiting for them never adds a round trip.
      const carbonImages = Promise.all(
        ['twill-albedo.png', 'twill-mr.png', 'twill-normal.png'].map((file) =>
          new THREE.TextureLoader().loadAsync(`/models/carbon/${file}?v=${V}`),
        ),
      );
      void carbonImages.catch(() => {});
      let res = await meta.studio;
      if (!res.ok && folder !== FALLBACK_MODEL) {
        console.warn(`[hero] no assembly for "${folder}", showing ${FALLBACK_MODEL}`);
        folder = FALLBACK_MODEL;
        meta = metaFor(folder);
        res = await meta.studio;
      }
      if (!res.ok) throw new Error(`studio.json ${res.status}`);
      const cfg = (await res.json()) as StudioConfig;

      if (disposed) return;
      onModel?.(folder);
      const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
      renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_DPR));
      renderer.toneMapping = cfg.lighting.toneMapping === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = cfg.lighting.exposure;
      el.append(renderer.domElement);
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.opacity = snapshot.current?.width ? '0' : '1';
      cleanup.push(() => {
        // dispose() alone does not release the WebGL context, and browsers cap
        // them at around 16 per page. Without forceContextLoss a few remounts
        // take out every canvas on the page.
        renderer.setAnimationLoop(null);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      });

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      const envRT = pmrem.fromScene(room, 0.04);
      room.dispose();
      scene.environment = envRT.texture;
      cleanup.push(() => {
        envRT.dispose();
        pmrem.dispose();
      });
      scene.environmentIntensity = cfg.lighting.environment;

      const camera = new THREE.PerspectiveCamera(34, 1, 0.002, 60);
      let needsResize = true;
      let lastDpr = 0;
      let sizedTo = '';
      const resizeIfNeeded = () => {
        const dpr = Math.min(devicePixelRatio, MAX_DPR);
        if (!needsResize && dpr === lastDpr) return;
        needsResize = false;
        lastDpr = dpr;
        const w = Math.round(el.clientWidth);
        const h = Math.round(el.clientHeight);
        if (!w || !h) return;
        const key = `${w}x${h}@${dpr}`;
        if (key === sizedTo) return;
        sizedTo = key;
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const resizeObserver = new ResizeObserver(() => { needsResize = true; });
      resizeObserver.observe(el);
      cleanup.push(() => resizeObserver.disconnect());

      const aim = (l: THREE.DirectionalLight, az: number, elv: number) => {
        const a = THREE.MathUtils.degToRad(az);
        const e = THREE.MathUtils.degToRad(elv);
        l.position.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
        l.target.position.set(0, 0, 0);
      };
      const L = cfg.lighting;
      const hemi = new THREE.HemisphereLight(0x94b8e8, 0x181410, L.ambient);
      const keyL = new THREE.DirectionalLight(L.key.colour, L.key.power);
      const fillL = new THREE.DirectionalLight(L.fill.colour, L.fill.power);
      const rimL = new THREE.DirectionalLight(L.rim.colour, L.rim.power);
      const bncL = new THREE.DirectionalLight(L.bounce.colour, L.bounce.power);
      bncL.position.set(0.05, -0.5, 0.15);
      scene.add(hemi, keyL, keyL.target, fillL, fillL.target, rimL, rimL.target, bncL, bncL.target);
      aim(keyL, L.key.azimuth, L.key.elevation);
      aim(fillL, L.fill.azimuth, L.fill.elevation);
      aim(rimL, L.rim.azimuth, L.rim.elevation);
      // One fixed studio rig in world space, set once: exposure, environment and
      // every light above keep these values from the first assembling frame to
      // the end of the walkthrough. Nothing below may change them per frame.
      // There used to be a focus spotlight placed relative to the camera (its
      // highlight slid across the part as the camera swept) and a 12% dip of
      // the whole rig on every focus: both read as the lighting never settling.
      // A focused part is now set apart only by dimming the rest (darkenRest).

      const S = cfg.spotlight;

      // Onshape is Z-up, three is Y-up. `pivot` scales the drone about its own
      // centre so the airframe can recede without dragging the shown part.
      const world = new THREE.Group();
      world.rotation.x = cfg.yAxisUp ? 0 : -Math.PI / 2;
      scene.add(world);
      const pivot = new THREE.Group();
      world.add(pivot);
      const rig = new THREE.Group();
      pivot.add(rig);

      /* ------------------------------------------------------- materials */
      const profiles = new Map<string, MatProfile>(cfg.materials.map((m) => [m.id, m]));
      const nameRules = cfg.materials.filter((m) => m.match);

      function classOf(raw0: string) {
        const raw = (raw0 || '').replace(/_\d+$/, '');
        if (/^(?:occurrence[_ ]of[_ ])?Open/i.test(raw)) {
          if (/_PCB\b/i.test(raw)) return 'fr4';
          if (/_pad\b/i.test(raw)) return 'padgold';
          if (/_silkscreen\b/i.test(raw)) return 'silk';
          if (/_soldermask\b/i.test(raw)) return 'mask';
        }
        const n = tidy(raw);
        for (const r of nameRules) if (new RegExp(r.match as string, 'i').test(n)) return r.id;
        return 'smd';
      }
      const hsl = {h: 0, s: 0, l: 0};
      function applyProfile(mat: THREE.MeshStandardMaterial, key: string) {
        const p = profiles.get(key);
        if (!p) return;
        const c = mat.color;
        c.setRGB(s2l(c.r), s2l(c.g), s2l(c.b));
        mat.metalness = p.metalness;
        mat.roughness = p.roughness;
        mat.envMapIntensity = p.env;
        if (key === 'silk') {
          // Ink sits almost on the soldermask. Bias depth, not its CAD pose,
          // so letters remain visible from both sides at grazing angles.
          mat.polygonOffset = true;
          mat.polygonOffsetFactor = -1;
          mat.polygonOffsetUnits = -1;
        }
        if (p.tint) mat.color.set(p.tint);
        if (p.sat !== 1) {
          mat.color.getHSL(hsl);
          mat.color.setHSL(hsl.h, Math.min(1, hsl.s * p.sat), hsl.l);
        }
      }

      /* ------------------------------------------------------------ load
       * The assembly ships as several GLBs (build-hero.mjs --split) so the
       * browser streams it instead of stalling on one 6 MB file, and the reader
       * watches the drone build up while it arrives. They are reassembled here
       * into exactly the tree a single-file load produced -- one root, one
       * assembly node, every occurrence under it -- so nothing below this point
       * knows or cares which file a part came from.
       */
      const manager = new THREE.LoadingManager();
      const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder as any);
      cleanup.push(() => manager.abort());
      const cache = new Map<string, THREE.MeshStandardMaterial>();
      const equivalentMaterials = new Map<string, THREE.MeshStandardMaterial>();
      const sourceMaterials = new Set<THREE.Material>();
      // Carbon twill maps (public/models/carbon, made by scripts/hero-assets/explode/
      // carbon_texture.py). Loaded here and not embedded in the GLB: the page's img-src
      // allows 'self' but not the blob: URLs GLTFLoader makes for embedded images.
      // Fetched up front and awaited before the first chunk is painted: a lazy
      // load left the carbon flat white until the maps landed, then it popped
      // to twill mid-assembly. If they fail, every carbon part stays plain.
      let carbonTex: {albedo: THREE.Texture; mr: THREE.Texture; normal: THREE.Texture} | null = null;
      const carbonReady = carbonImages.then(([albedo, mr, normal]) => {
        const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        for (const t of [albedo, mr, normal]) {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = aniso;
        }
        albedo.colorSpace = THREE.SRGBColorSpace;
        carbonTex = {albedo, mr, normal};
        cleanup.push(() => {
          albedo.dispose();
          mr.dispose();
          normal.dispose();
        });
      }).catch((err: unknown) => {
        console.warn('[hero] carbon maps did not load, carbon renders plain', err);
      });
      const paint = (sub: THREE.Object3D, root: THREE.Object3D) => {
        sub.traverse((o: any) => {
          if (!o.isMesh || o.userData.painted) return;
          o.userData.painted = true;
          o.frustumCulled = false;
          let name = '';
          let n: THREE.Object3D | null = o;
          while (n && n !== root) {
            if (n.name && !/^mesh/i.test(n.name)) {
              name = n.name;
              break;
            }
            n = n.parent;
          }
          // Assets from scripts/hero-assets/explode name each material
          // "<class>|<r,g,b>"; older exports are classified by part name.
          const matName: string = o.material.name || '';
          const key = matName.includes('|') ? matName.split('|')[0] : classOf(name || o.name || '');
          const ck = `${o.material.uuid}|${key}`;
          sourceMaterials.add(o.material);
          let m = cache.get(ck);
          if (!m) {
            m = o.material.clone();
            applyProfile(m as THREE.MeshStandardMaterial, key);
            if (key === 'carbon' && o.geometry.attributes.uv && carbonTex) {
              const tx = carbonTex;
              const sm = m as THREE.MeshStandardMaterial;
              sm.map = tx.albedo;
              sm.roughnessMap = tx.mr;
              sm.normalMap = tx.normal;
              sm.normalScale.set(0.12, 0.12);
              sm.color.setRGB(1, 1, 1);
              sm.needsUpdate = true;
            }
            const {uuid: _uuid, name: _name, ...properties} = m!.toJSON();
            const signature = JSON.stringify(properties);
            const shared = equivalentMaterials.get(signature);
            if (shared) {
              m!.dispose();
              m = shared;
            } else equivalentMaterials.set(signature, m!);
            cache.set(ck, m as THREE.MeshStandardMaterial);
          }
          o.material = m;
        });
      };

      const droneRoot = new THREE.Group();
      droneRoot.name = 'assembly-root';
      rig.add(droneRoot);
      cleanup.push(() => {
        for (const m of new Set([...cache.values(), ...sourceMaterials])) m.dispose();
        droneRoot.traverse((o: any) => {
          if (o.isMesh) o.geometry?.dispose?.();
        });
      });

      /* --------------------------------------------------- assembling view
       * The real loop cannot start until the rigging is done, and the rigging
       * cannot start until every chunk has landed. This minimal loop is the
       * loading screen: each chunk, as it lands, plays the CAD explode backwards
       * (explode.json, fetched up front), so the drone builds itself in the
       * order it is really put together. When the last part has seated, the
       * orbit eases onto the walkthrough's opening view and the main loop takes
       * the camera from exactly there: no cut.
       */
      type ExplodeMove = {v: [number, number, number]; t: number; dur: number};
      type ExplodeUnit = {id: string; label: string; kind: string; moves: ExplodeMove[]};
      const exPromise = meta.explode.then((r) => {
        if (!r.ok) throw new Error(`explode.json ${r.status}`);
        return r.json() as Promise<{units: ExplodeUnit[]; groups: Record<string, string[]>}>;
      });
      void exPromise.catch(() => {});
      const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
      // Smootherstep per move: each part eases off and settles with no kink at either end.
      const moveEase = (x: number) => x * x * x * (x * (6 * x - 15) + 10);
      const offsetAt = (moves: ExplodeMove[], p: number, out: THREE.Vector3) => {
        out.set(0, 0, 0);
        for (const m of moves) {
          const q = moveEase(clamp01((p - m.t) / m.dur));
          out.x += m.v[0] * q;
          out.y += m.v[1] * q;
          out.z += m.v[2] * q;
        }
        return out;
      };
      // One assembly per chunk: the chunk's parts run explode p from 1 to 0,
      // in build order, each starting as its own GLB lands. The pace depends on
      // how the bytes arrive (decided on the first chunk):
      //  - cold (network): a slow build with a gap between chunks, so the
      //    animation covers the download instead of the reader watching a
      //    half-built drone stand still; once the last chunk is in, whatever is
      //    still to play is squeezed into TAIL_S, so it never runs long past it.
      //  - warm (cache: the first chunk came back within WARM_MS): a short
      //    build-in, about 0.7 s for the whole drone. A cached reload never waits
      //    on a timeline.
      type Pace = {dur: number; gap: number};
      const COLD: Pace = {dur: 1.2, gap: 0.35};
      const WARM: Pace = {dur: 0.42, gap: 0.06};
      const WARM_MS = 120;
      const TAIL_S = 0.9;
      let pace: Pace = COLD;
      type Build = {
        parts: Array<{node: THREE.Object3D; base: THREE.Vector3; moves: ExplodeMove[]}>;
        start: number;
        dur: number;
        /** 0..1 along this chunk's build, advanced by frame time from `start`. */
        k: number;
      };
      const builds: Build[] = [];
      let nextBuildAt = 0;
      const tmpOff = new THREE.Vector3();
      const stepBuilds = (now: number, dt: number) => {
        let busy = false;
        for (const b of builds) {
          if (b.k < 1 && now >= b.start) b.k = reduced || !b.dur ? 1 : Math.min(1, b.k + Math.min(dt, now - b.start) / b.dur);
          // Ease the timeline itself too, so the build lands softly.
          const p = 1 - moveEase(b.k);
          for (const part of b.parts) part.node.position.copy(part.base).add(offsetAt(part.moves, p, tmpOff));
          if (b.k < 1) busy = true;
        }
        return busy;
      };
      const finishBuilds = () => {
        for (const b of builds) b.k = 1;
        stepBuilds(previewNow, 0);
      };
      // Everything is in: what has not played yet plays out within TAIL_S.
      const squeezeBuilds = () => {
        const deadline = previewNow + TAIL_S;
        let j = 0;
        for (const b of builds) {
          if (b.k >= 1) continue;
          if (b.start > previewNow) {
            b.start = Math.min(b.start, previewNow + j++ * 0.08);
            b.dur = Math.min(b.dur, Math.max(0.3, deadline - b.start));
          } else if (previewNow + (1 - b.k) * b.dur > deadline) {
            b.dur = (deadline - previewNow) / Math.max(1e-3, 1 - b.k);
          }
        }
      };
      let previewOn = true;
      let firstPartMarked = false;
      const previewClock = new THREE.Clock();
      let previewNow = 0;
      let previewAngle = 0.9;
      // Set once everything has seated: the orbit then eases onto this yaw.
      let previewGoal: number | null = null;
      const previewVel = {v: 0};
      const previewPitch = Math.atan(cfg.camera?.height ?? 0.5);
      // Framed on the seated parts, measured as each chunk lands (the airframe
      // comes first and already sets most of the size). The camera eases to
      // each new measure instead of jumping, so the view does not lurch as the
      // heavier chunks land.
      let previewRadius = 0;
      const previewCentre = new THREE.Vector3();
      let shownRadius = 0;
      const shownCentre = new THREE.Vector3();
      const shownVel = [0, 1, 2, 3].map(() => ({v: 0}));
      const previewFit = () => {
        const b = new THREE.Box3().setFromObject(rig);
        if (b.isEmpty()) return;
        b.getCenter(previewCentre);
        previewRadius = Math.max(previewRadius, b.getBoundingSphere(new THREE.Sphere()).radius);
        if (!shownRadius) {
          shownRadius = previewRadius;
          shownCentre.copy(previewCentre);
        }
        camera.near = previewRadius / 300;
        camera.far = previewRadius * 60;
        camera.updateProjectionMatrix();
      };
      const previewFrame = () => {
        if (!previewOn) return;
        if (document.hidden) return;
        resizeIfNeeded();
        const dt = Math.min(previewClock.getDelta(), 0.05);
        previewNow += dt;
        stepBuilds(previewNow, dt);
        if (builds.length && !firstPartMarked) {
          firstPartMarked = true;
          mark('first-part');
        }
        if (previewGoal === null) previewAngle += dt * 0.24;
        else previewAngle = smoothDamp(previewAngle, previewGoal, previewVel, 0.6, dt);
        if (shownRadius) {
          shownRadius = smoothDamp(shownRadius, previewRadius, shownVel[0], 0.5, dt);
          shownCentre.x = smoothDamp(shownCentre.x, previewCentre.x, shownVel[1], 0.5, dt);
          shownCentre.y = smoothDamp(shownCentre.y, previewCentre.y, shownVel[2], 0.5, dt);
          shownCentre.z = smoothDamp(shownCentre.z, previewCentre.z, shownVel[3], 0.5, dt);
        }
        const back = (shownRadius || 0.075) * (cfg.camera?.distance ?? 2.15);
        const off = new THREE.Vector3(
          Math.cos(previewPitch) * Math.cos(previewAngle) * back,
          Math.sin(previewPitch) * back,
          Math.cos(previewPitch) * Math.sin(previewAngle) * back,
        );
        camera.position.copy(shownCentre.clone().add(off));
        camera.lookAt(shownCentre);
        renderer.render(scene, camera);
      };
      renderer.setAnimationLoop(previewFrame);

      const manifest = await meta.chunks
        .then((r) => (r.ok ? (r.json() as Promise<ChunkManifest>) : null))
        .catch(() => null);
      if (disposed) return;
      // No manifest means an older single-file build. Still supported.
      // Build order, not size order: every download starts at once below, and
      // the chunks seat in the order a drone is put together, frame first.
      const buildRank = (c: Chunk) => {
        const id = c.id.toLowerCase();
        const order = ['frame', 'esc', 'fc', 'rx', 'video', 'drive'];
        const i = order.findIndex((k) => id === k || id.includes(`open${k}`) || id.endsWith(`-${k}`));
        return i < 0 ? order.length : i;
      };
      const chunks: Chunk[] = manifest?.chunks?.length
        ? [...manifest.chunks].sort((a, b) => buildRank(a) - buildRank(b))
        : [{id: 'drone', label: 'drone', file: cfg.model ?? 'drone.glb', bytes: 1}];
      const exDefs = await exPromise.catch(() => null);
      if (disposed) return;
      const exByIdEarly = new Map((exDefs?.units ?? []).map((u) => [u.id, u]));
      const totalBytes = chunks.reduce((s, c) => s + (c.bytes || 1), 0);
      const pieces = chunks.map((c) => ({id: c.id, label: c.label}));
      let bytesDone = 0;
      let asm: THREE.Group | null = null;
      let activeChunk = '';
      // Every GLB is fetched with fetch() so the first one in build order can
      // go out alone at high priority: on a shared link, six parallel
      // downloads all finish late, and the first part would only show once
      // nearly every byte had arrived. The rest follow, a few at a time, in
      // build order, so they keep the link busy while the first one seats.
      const LOOKAHEAD = 3;
      const fetchGlb = async (c: Chunk, priority: 'high' | 'low') => {
        const r = await fetch(modelUrl(folder, c.file), {signal: controller.signal, priority} as RequestInit);
        if (!r.ok) throw new Error(`${c.file} ${r.status}`);
        const total = Number(r.headers.get('content-length')) || 0;
        const reader = r.body?.getReader();
        if (!reader) return r.arrayBuffer();
        const parts: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          parts.push(value);
          loaded += value.length;
          if (total && !disposed && activeChunk === c.id) {
            const frac = (bytesDone + (c.bytes || 1) * Math.min(1, loaded / total)) / totalBytes;
            onLoad?.({label: c.label, frac, chunk: c.id, done: false, pieces});
          }
        }
        const out = new Uint8Array(loaded);
        let at = 0;
        for (const part of parts) {
          out.set(part, at);
          at += part.length;
        }
        return out.buffer;
      };
      const downloads = new Map<string, Promise<ArrayBuffer>>();
      const arrived = new Map<string, number>();
      let launched = 0;
      let inFlight = 0;
      const launch = () => {
        const c = chunks[launched];
        const pending = fetchGlb(c, launched === 0 ? 'high' : 'low');
        launched++;
        inFlight++;
        downloads.set(c.id, pending);
        void pending.then(() => arrived.set(c.id, performance.now()), () => {});
        // A look-ahead request can fail before its turn to be awaited.
        void pending.catch(() => {});
        // The first one alone; after it, keep LOOKAHEAD in flight.
        void pending
          .finally(() => {
            inFlight--;
            while (!disposed && launched < chunks.length && inFlight < LOOKAHEAD) launch();
          })
          .catch(() => {});
      };
      const fetchStarted = performance.now();
      launch();
      // Every chunk gets its final materials the moment it lands, carbon included.
      await carbonReady;
      if (disposed) return;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        activeChunk = c.id;
        onLoad?.({label: c.label, frac: bytesDone / totalBytes, chunk: c.id, done: false, pieces});
        while (!downloads.has(c.id)) {
          // Not launched yet: the look-ahead window launches it as earlier ones land.
          await new Promise((r) => setTimeout(r, 16));
          if (disposed) return;
        }
        const data = await downloads.get(c.id)!;
        if (i === 0 && !reduced) pace = (arrived.get(c.id) ?? performance.now()) - fetchStarted < WARM_MS ? WARM : COLD;
        if (disposed) return;
        const g = await loader.parseAsync(data, `/models/${folder}/`);
        if (disposed) {
          g.scene.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            object.geometry.dispose();
            for (const mat of Array.isArray(object.material) ? object.material : [object.material]) mat.dispose();
          });
          return;
        }
        const src = g.scene.children.length === 1 ? g.scene.children[0] : g.scene;
        if (!asm) {
          // Every chunk is a clone of one source document, so they all carry the
          // same assembly transform. Take it from the first, verify the rest.
          asm = new THREE.Group();
          asm.name = src.name || 'assembly';
          asm.position.copy(src.position);
          asm.quaternion.copy(src.quaternion);
          asm.scale.copy(src.scale);
          droneRoot.add(asm);
        } else if (!asm.position.equals(src.position) || !asm.quaternion.equals(src.quaternion)) {
          console.warn(`[hero] chunk "${c.id}" assembly transform differs from the first chunk`);
        }
        const landed = [...src.children];
        for (const child of landed) asm.add(child);
        paint(asm, droneRoot);
        // Framed on the seated parts, before they are pushed out to their
        // exploded start, so the camera never chases a flying part.
        previewFit();
        const parts: Build['parts'] = [];
        for (const node of landed) {
          const def = exByIdEarly.get(node.name) ?? exByIdEarly.get(node.userData?.unit);
          if (!def?.moves.length) continue;
          const base = node.position.clone();
          node.position.copy(base).add(offsetAt(def.moves, 1, tmpOff));
          parts.push({node, base, moves: def.moves});
        }
        const start = Math.max(previewNow, nextBuildAt);
        nextBuildAt = start + pace.gap;
        builds.push({parts, start, dur: pace.dur, k: 0});
        bytesDone += c.bytes || 1;
        onLoad?.({label: c.label, frac: bytesDone / totalBytes, chunk: c.id, done: true, pieces});
        // Hand the main thread back so the preview loop paints the part that
        // just landed. Without this the whole sequence of chunks decodes in one
        // unbroken task and the drone appears complete in a single jump.
        //
        // Raced against a timer on purpose: requestAnimationFrame does not fire
        // in a backgrounded tab, so awaiting it alone hangs the rest of the
        // download until the reader comes back to the page.
        await new Promise((r) => {
          const t = setTimeout(r, 50);
          requestAnimationFrame(() => {
            clearTimeout(t);
            r(undefined);
          });
        });
        if (disposed) return;
      }
      if (!asm) throw new Error('no geometry loaded');
      // Let every chunk finish seating before the rig reads base positions, then
      // swing the orbit onto the walkthrough's opening yaw (nearest turn).
      // A hidden tab runs no frames, so it skips the show and seats everything.
      squeezeBuilds();
      while (!reduced && !disposed && !document.hidden && builds.some((b) => b.k < 1)) {
        await new Promise((r) => setTimeout(r, 16));
      }
      finishBuilds();
      if (disposed) return;
      {
        const az = cfg.camera?.azimuth ?? 0.7;
        previewGoal = az + Math.ceil((previewAngle - az) / (Math.PI * 2)) * Math.PI * 2;
      }

      const occRoot: THREE.Object3D = asm;

      /* ------------------------------------------------------- explode model
       * explode.json (scripts/hero-assets/explode/) lists every part of the build
       * as a named node with a label and a few timed moves, derived from the CAD:
       * which parts a screw passes through, what sits on what, in which order the
       * build comes apart. This scene only plays it. */
      const EX = exDefs ?? (await exPromise);
      if (disposed) return;
      type Unit = ExplodeUnit & {node: THREE.Object3D; base: THREE.Vector3};
      const UNITS = new Map<string, Unit>();
      const exById = new Map(EX.units.map((u) => [u.id, u]));
      for (const node of occRoot.children) {
        const def = exById.get(node.name) ?? exById.get(node.userData?.unit);
        if (!def) {
          console.warn(`[hero] node "${node.name}" has no explode entry`);
          continue;
        }
        node.userData.unitId = def.id;
        UNITS.set(def.id, {...def, node, base: node.position.clone()});
      }
      const unitOf = (o: THREE.Object3D | null) => {
        for (let n = o; n; n = n.parent) {
          const id = n.userData?.unitId;
          if (id) return UNITS.get(id as string) ?? null;
        }
        return null;
      };
      function applyExplode(p: number) {
        for (const u of UNITS.values()) {
          let x = 0;
          let y = 0;
          let z = 0;
          for (const m of u.moves) {
            const q = moveEase(clamp01((p - m.t) / m.dur));
            x += m.v[0] * q;
            y += m.v[1] * q;
            z += m.v[2] * q;
          }
          u.node.position.set(u.base.x + x, u.base.y + y, u.base.z + z);
        }
      }

      /* --------------------------------------------------------- geometry */
      // Framing spheres for the assembled and the fully exploded drone; the camera
      // pulls back from one to the other as the parts fly out.
      const framing = (p: number) => {
        applyExplode(p);
        scene.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(rig);
        const sph = b.getBoundingSphere(new THREE.Sphere());
        return {centre: sph.center.clone(), radius: sph.radius, floor: b.min.y};
      };
      const F0 = framing(0);
      const F1 = framing(1);
      // A soft contact shadow under the drone: a radial gradient disc, no shadow maps.
      const blobCanvas = document.createElement('canvas');
      blobCanvas.width = blobCanvas.height = 128;
      {
        const g = blobCanvas.getContext('2d')!;
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, 'rgba(0,0,0,0.85)');
        grad.addColorStop(0.45, 'rgba(0,0,0,0.38)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
      }
      const blobTex = new THREE.CanvasTexture(blobCanvas);
      const blobMat = new THREE.MeshBasicMaterial({map: blobTex, transparent: true, depthWrite: false, opacity: cfg.lighting.groundShadow ?? 0.6});
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blobMat);
      blob.rotation.x = -Math.PI / 2;
      blob.renderOrder = -1;
      blob.frustumCulled = false;
      scene.add(blob);
      cleanup.push(() => {
        blob.geometry.dispose();
        blobMat.dispose();
        blobTex.dispose();
      });
      const droneCentre = F0.centre.clone();
      let droneRadius = F0.radius;

      /* ------------------------------------------------------------ beats */
      type Beat = {
        id: string;
        title: string;
        note: string;
        caption?: string;
        hint?: string;
        href?: string;
        fade?: number;
        /** Per-beat override of sequence.partSize: how much of the viewport
         *  height the focused parts fill. */
        partSize?: number;
        stops?: Array<{
          at: number;
          title: string;
          note: string;
          caption?: string;
          hint?: string;
          href?: string;
        }>;
        /** The parts this beat focuses, from explode.json `groups`. */
        nodes: Array<{node: THREE.Object3D}>;
        /** The parts the camera frames: the group's core body when the beat
         *  names `frameKinds`, else the whole group. A motor group carries its
         *  prop, boot and screws, an RX group its antenna; framed on all of
         *  them, the part itself ends up small in a loose shot. */
        frameNodes: THREE.Object3D[];
      };
      const BEATS: Beat[] = cfg.beats.map((b: any) => {
        const ids: string[] = b.select?.group ? EX.groups[b.select.group] ?? [] : [];
        const units = ids.map((id) => UNITS.get(id)).filter((u): u is Unit => Boolean(u));
        const nodes = units.map((u) => ({node: u.node}));
        if (!nodes.length && !b.select?.none) console.warn(`[hero] beat "${b.id}" resolved to 0 nodes`);
        const kinds: string[] | undefined = Array.isArray(b.frameKinds) ? b.frameKinds : undefined;
        const core = kinds ? units.filter((u) => kinds.includes(u.kind)).map((u) => u.node) : [];
        if (kinds && !core.length) console.warn(`[hero] beat "${b.id}" frameKinds matched no part, framing the whole group`);
        return {
          id: b.id,
          title: b.title,
          note: b.note,
          // A beat naming a product handle takes its caption from that
          // product's What-does-this-do content (whatIsThis.hero, else the
          // intro's opening), so the homepage and the PDP explain a part
          // with one voice (maintainer, 2026-08-15). Beats without a handle keep
          // their studio.json caption.
          caption: (b.handle && heroCaption(b.handle)) || b.caption,
          hint: b.hint,
          // Same rule for the pointer: a handle beat links to that chapter
          // on the product page, so the caption and its source stay one.
          href: (b.handle && whatIsThisHref(b.handle)) || b.href,
          fade: b.fade,
          partSize: b.partSize,
          stops: b.stops,
          nodes,
          frameNodes: core.length ? core : nodes.map((n) => n.node),
        };
      });
      // The reported copy payload. With a stop index, the stop's copy replaces
      // the beat's wholesale (a stop with no href gets no link), and the id is
      // suffixed so the copy panel re-animates on the mid-hold caption change.
      const toHeroBeat = (b: Beat, stopIdx = -1): HeroBeat => {
        const st = stopIdx >= 0 ? b.stops?.[stopIdx] : undefined;
        if (st)
          return {
            id: `${b.id}:${stopIdx}`,
            title: st.title,
            note: st.note,
            caption: st.caption,
            hint: st.hint,
            href: st.href,
          };
        return {
          id: b.id,
          title: b.title,
          note: b.note,
          caption: b.caption,
          hint: b.hint,
          href: b.href,
          stops: b.stops?.map((s) => ({
            title: s.title,
            note: s.note,
            caption: s.caption,
            hint: s.hint,
            href: s.href,
          })),
        };
      };
      onBeats?.(BEATS.map((b) => toHeroBeat(b)));
      await yieldToMain();
      if (disposed) return;

      const moving = new Set<THREE.Object3D>([pivot]);
      for (const u of UNITS.values()) moving.add(u.node);
      cleanup.push(mergeHeroGeometry(droneRoot, moving));
      for (const node of moving) node.matrixAutoUpdate = false;
      world.updateMatrix();
      rig.updateMatrix();
      world.matrixAutoUpdate = false;
      rig.matrixAutoUpdate = false;

      /* --------------------------------------------- dim everything else */
      const twin = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      const twinOf = (m: any) => {
        let t = twin.get(m);
        if (!t) {
          t = m.clone();
          (t as any).userData = {
            normal: m,
            baseColor: m.color.clone(),
            baseEnv: m.envMapIntensity ?? 1,
            baseMetal: m.metalness,
          };
          twin.set(m, t!);
          twin.set(t!, t!);
          dimMaterials.add(t!);
        }
        return t!;
      };
      let dimmed: any[] = [];
      const dimMaterials = new Set<THREE.MeshStandardMaterial>();
      cleanup.push(() => {
        for (const t of dimMaterials) t.dispose();
      });
      const dimCache = new Map<string, any[]>();
      let dimKey = '';
      // Everything outside `nodes` renders through the dimmed twin materials.
      function setDimFor(nodes: THREE.Object3D[], key: string) {
        if (key === dimKey) return;
        dimKey = key;
        for (const m of dimmed) if (m.material.userData?.normal) m.material = m.material.userData.normal;
        if (!nodes.length) {
          dimmed = [];
          return;
        }
        let list = dimCache.get(key);
        if (!list) {
          const keep = new Set<THREE.Object3D>();
          for (const n of nodes) n.traverse((o) => keep.add(o));
          list = [];
          droneRoot.traverse((o: any) => {
            if (o.isMesh && !keep.has(o)) list!.push(o);
          });
          dimCache.set(key, list);
        }
        dimmed = list;
        for (const m of dimmed) {
          m.material = twinOf(m.material);
          dimMaterials.add(m.material);
        }
      }
      const batches = instanceHeroDraws(scene, droneRoot, twinOf);
      cleanup.push(() => batches.dispose());

      /* ------------------------------------------------------- sequencing */
      const Q = cfg.sequence;
      const TRAVEL = Q.travel;
      const HOLD = Q.hold;
      const dur = () => TRAVEL * 2 + HOLD;
      const ease = (x: number) => x * x * (3 - 2 * x);
      const envelope = (l: number) =>
        l < TRAVEL ? ease(l / TRAVEL) : l < TRAVEL + HOLD ? 1 : 1 - ease(Math.min(1, (l - TRAVEL - HOLD) / TRAVEL));

      let beatIdx = 0;
      let t = 0;
      let camH = cfg.camera?.height ?? 0.5;
      // Scripted camera state, smoothed: the point it orbits, distance, height.
      // Starts where the assembling view left the camera; the damping below
      // carries it onto the first beat's framing.
      const camFocus = shownCentre.clone();
      let camBack = (shownRadius || previewRadius) * (cfg.camera?.distance ?? 2.15);
      let camReady = !reduced;
      let wasTravelling = false;
      // Canvas rect, cached: read on pointer events, never per frame.
      let rect = el.getBoundingClientRect();
      // Velocities for the damped camera: focus xyz, distance, height, swing.
      const camVel = [0, 1, 2, 3, 4, 5].map(() => ({v: 0}));
      let swing = 0;
      let selectedPrev: Unit | null = null;
      let selT = 1;
      let selDir = 1;
      const resizeRect = new ResizeObserver(() => {
        rect = el.getBoundingClientRect();
      });
      resizeRect.observe(el);
      cleanup.push(() => resizeRect.disconnect());

      /* ---------------------------------------------------- explode state
       * Scroll-linked: the first stop is the assembled drone, the next one (the
       * whole-drone beat) is fully exploded, and the spring-smoothed scroll
       * position drives p between them, so scrolling back up reassembles it. Every
       * part eases its own moves inside p, so the stagger is continuous. The
       * Collapse / Explode button overrides it until the reader scrolls again.
       * Reduced motion shows the exploded pose and cuts instead of travelling. */
      const MANUAL_S = 2.2;
      let explodeP = reduced ? 1 : 0;
      let manualP: number | null = null;
      let catchUp = false;
      let isExploded = reduced;
      applyExplode(explodeP);
      const stepToward = (v: number, goal: number, s: number) =>
        v < goal ? Math.min(goal, v + s) : Math.max(goal, v - s);
      const releaseManual = () => {
        if (manualP === null) return;
        manualP = null;
        catchUp = true;
      };
      const setExploded = (on: boolean) => {
        manualP = on ? 1 : 0;
        if (reduced) explodeP = manualP;
        wake();
      };

      /* ------------------------------------------------- hover, select */
      let hovered: Unit | null = null;
      let selected: Unit | null = null;
      const ptr = {x: 0, y: 0, inside: false, dirty: false, downX: 0, downY: 0};
      let lastRay = 0;
      const raycaster = new THREE.Raycaster();
      const pickRoots = [...UNITS.values()].map((u) => u.node);
      const tmpBox = new THREE.Box3();
      const tmpSph = new THREE.Sphere();
      const sphereOf = (nodes: THREE.Object3D[]) => {
        tmpBox.makeEmpty();
        for (const n of nodes) tmpBox.expandByObject(n);
        return tmpBox.getBoundingSphere(tmpSph);
      };
      const pickUnit = (): Unit | null => {
        if (!ptr.inside) return null;
        const r = rect;
        raycaster.setFromCamera(
          new THREE.Vector2(((ptr.x - r.left) / r.width) * 2 - 1, -((ptr.y - r.top) / r.height) * 2 + 1),
          camera,
        );
        const hit = raycaster.intersectObjects(pickRoots, true)[0];
        return hit ? unitOf(hit.object) : null;
      };
      // What the dim/spotlight/camera focus on right now, strongest source first.
      let focusAmt = 0;
      let focusFade = S.darkenRest;
      let focusNodes: THREE.Object3D[] = [];
      let focusKey = '';

      /* ----------------------------------------------------------- scroll
       * One confident wheel gesture commits a one-stop TARGET move; a
       * critically damped spring moves the position there. The timeline can
       * never reverse under someone mid-transition: a gesture commits once,
       * in its own direction, and further input inside the gesture is inert.
       *
       * Stops come in two kinds. A PART stop is the middle of a beat's hold,
       * part under the spotlight. Between two part stops sits a REST stop at
       * the beat boundary, where the envelope is exactly zero: the part has
       * flown home and the whole drone reads for a breath before the next
       * scroll pulls the next part out. Without these the sequence chains
       * spotlight into spotlight and the return-home never gets seen. */
      const stopForBeat = (i: number) => i * dur() + TRAVEL + HOLD * 0.5;
      type Stop = {pos: number; beat: number; part: boolean};
      // The first stop is the assembled drone; the first scroll step explodes it.
      // There are no rest stops any more: the camera goes straight from one beat's
      // group to the next instead of pulling back to the whole drone in between.
      const STOPS: Stop[] = [{pos: 0, beat: 0, part: false}];
      for (let i = 0; i < BEATS.length; i++) STOPS.push({pos: stopForBeat(i), beat: i, part: true});
      const stopPos = (si: number) => STOPS[si].pos;
      const explodedAt = () => Math.max(1e-6, stopPos(Math.min(1, STOPS.length - 1)));
      const desiredExplode = () => manualP ?? (reduced ? 1 : clamp01(pos / explodedAt()));
      const partStopIdx = (beat: number) => STOPS.findIndex((s) => s.part && s.beat === beat);
      // The next PART stop in a direction. One confident scroll is one item
      // of the walkthrough: the rest between two parts never costs its own
      // gesture. It is not skipped either: a wheel step ROUTES through it
      // (stepStop below) and holds for REST_DWELL_S, so the reader sees the
      // old part sitting in the assembled drone before the next pulls out
      // (maintainer, 2026-08-15). Keyboard stepping still visits rests one by one.
      const nextPartIdx = (from: number, dir: number) => {
        let i = from;
        do {
          i = Math.max(0, Math.min(STOPS.length - 1, i + dir));
        } while (!STOPS[i].part && i > 0 && i < STOPS.length - 1);
        return i;
      };
      // One stop over, rests included: the unit a wheel step actually moves.
      const stepStop = (from: number, dir: number) =>
        Math.max(0, Math.min(STOPS.length - 1, from + dir));
      const nearestIdx = (x: number) => {
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < STOPS.length; i++) {
          const d = Math.abs(STOPS[i].pos - x);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        return best;
      };
      // Start AT the first stop, not at zero. Zero is not a stop, so the
      // "absorb input until the current beat has been seen" guard could never
      // be satisfied and the hero ignored scrolling entirely.
      // Reduced motion starts on the exploded whole-drone stop.
      let target = stopPos(reduced ? 1 : 0);
      let pos = target;
      let vel = 0;
      let lastWheel = 0;
      let everScrolled = false;
      let gestureFrom = 0;
      let gestureDir = 0;
      let gestureAccum = 0;
      let gestureStepped = false;  // this gesture already emitted its one step
      let steppedAt = 0;           // when it did, for re-flick detection
      let lastAbsD = 0;            // previous event's |delta|, for re-flick detection
      let queuedStep: 0 | 1 | -1 = 0;  // direction banked while the beat plays
      // How many flicks are banked in queuedStep's direction. Every confident
      // flick counts as one part (maintainer, 2026-08-15: one flick, one subject),
      // so a burst of three plays three parts in turn instead of two. Capped
      // so a runaway scroll cannot queue the whole walkthrough; a flick the
      // other way empties the bank and turns around.
      let queuedCount = 0;
      const QUEUE_MAX = 3;
      // Continuation owed because a move parked at a rest mid-passage. Kept
      // apart from queuedStep so a scroll banked during the first half of a
      // passage is not swallowed by the passage's own onward move.
      let routeDir: 0 | 1 | -1 = 0;
      let committed: number | null = null;
      const GESTURE_GAP_MS = 220;
      const MIN_DWELL_S = cfg.scroll?.minDwellS ?? 1.4;    // seconds a part must be presented before you can move on
      const REST_DWELL_S = cfg.scroll?.restDwellS ?? 0.45; // a rest is a breath, not a chapter
      // A beat is unskippable. Once committed, input is absorbed until the part
      // has arrived AND its hold has run, so nobody can flick past a product
      // without its spotlight moment. This is the "plays at its own pace" rule:
      // scrolling chooses WHICH beat, the animation owns HOW it gets there.
      let settledAt = 0;       // stop index the sequence has finished playing
      let dwell = 0;           // seconds the current stop has been presented
      // Stops whose full dwell has run once. Revisiting one (scrolling back)
      // only needs the short rest dwell: the pacing rule exists so nobody
      // skips an unseen beat, not to slow down going back over seen ground.
      const seenStops = new Set<number>();
      // Only render, and only take keys, when the hero is actually on screen.
      let onScreen = true;
      let idlePaused = false;
      let lastInteraction = performance.now();
      let syncPlayback = () => {};
      const wake = () => {
        lastInteraction = performance.now();
        idlePaused = false;
        syncPlayback();
      };
      const io = new IntersectionObserver(
        (es) => {
          onScreen = es[0]?.isIntersecting ?? true;
          if (onScreen) wake();
          else syncPlayback();
        },
        {threshold: 0},
      );
      io.observe(el);
      cleanup.push(() => io.disconnect());

      const onWheel = (e: WheelEvent) => {
        // ctrl+wheel is pinch-zoom and browser zoom. Never swallow it.
        if (e.ctrlKey) return;
        // Mid-drag the page must not scroll under the hand nor step a beat.
        if (pressed) {
          e.preventDefault();
          return;
        }

        const now = performance.now();
        // Firefox reports lines, not pixels; Chrome reports pixels; some mice
        // report pages. Normalise before scaling or Firefox scrolls ~20x slower.
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        const d = e.deltaY * unit;

        // Gesture segmentation. A gesture normally opens after a silence, but
        // a detented mouse scrolled steadily never goes silent: its notches
        // arrive as isolated large deltas tens of ms apart, under the gap.
        // Treat such a notch as its own gesture, or steady mouse scrolling
        // counts as ONE gesture and can only ever advance one stop total.
        // Trackpads stream events every ~16 ms, so a finger push never
        // force-opens mid-stream, and a momentum tail (small decaying deltas,
        // no gaps) stays inside its gesture and stays inert.
        const sinceLast = now - lastWheel;
        // A trackpad flick's momentum tail streams small decaying deltas for
        // a second or more with no gap, so a second confident flick inside
        // that tail used to be inert: the reader had to wait for silence, and
        // the hero read as "scrolling barely works". A delta that jumps well
        // above the decaying tail, once this gesture's step is spent and has
        // had time to show, is a new gesture. A steady finger push never
        // trips it (its deltas do not jump), and momentum only decays.
        const reflick =
          gestureStepped &&
          now - steppedAt > 350 &&
          Math.abs(d) >= 40 &&
          lastAbsD < 20 &&
          Math.abs(d) > lastAbsD * 2;
        lastAbsD = Math.abs(d);
        if (
          sinceLast > GESTURE_GAP_MS ||
          (sinceLast >= 80 && Math.abs(d) >= 40) ||
          reflick
        ) {
          // Open the new gesture from the stop the timeline is HEADED TO,
          // not from wherever the spring happens to be mid-flight. Without
          // this, a wheel tick during a rail-dot or keyboard jump reopens
          // from the fly-over position and re-commits relative to it,
          // silently discarding the clicked destination.
          gestureFrom =
            committed !== null &&
            Math.abs(pos - stopPos(committed)) > dur() * 0.06
              ? committed
              : nearestIdx(pos);
          gestureDir = 0;
          gestureAccum = 0;
          gestureStepped = false;
        }

        // Release the page at the ends, with a margin. Keyed off which stop the
        // gesture began at rather than a raw position threshold, so the exit is
        // not sensitive to exactly where the spring settles.
        const first = 0;
        const last = STOPS.length - 1;
        const eps = dur() * 0.08;
        const atLast = gestureFrom >= last && pos >= stopPos(last) - eps && e.deltaY > 0;
        const atFirst = gestureFrom <= first && pos <= stopPos(first) + eps && e.deltaY < 0;
        if (atLast || atFirst) return;   // do not preventDefault: page scrolls on

        e.preventDefault();
        everScrolled = true;
        if (e.deltaY !== 0) gestureDir = Math.sign(e.deltaY);
        lastWheel = now;
        gestureAccum += d;

        // One confident gesture is one stop: crossing stepPx of intent emits
        // the gesture's single step, and the rest of the gesture (momentum
        // tail included) is spent. One wheel notch is ~100 px in Chrome and
        // ~48 px (3 lines) in Firefox, so 45 catches a single notch on both.
        const THRESH = cfg.scroll?.stepPx ?? 45;
        if (gestureStepped || Math.abs(gestureAccum) < THRESH) return;
        gestureStepped = true;
        steppedAt = now;
        selected = null;
        releaseManual();
        const dir = (Math.sign(gestureAccum) || 1) as 1 | -1;

        // Pacing: the beat on screen must be seen before the move happens (a
        // beat stays unskippable), but the intent is never thrown away. While
        // the sequence is still travelling or dwelling, the step is BANKED,
        // one at most, latest direction wins, and applied the moment the
        // current stop has been presented. The old model discarded that
        // input, which read as "scrolling does nothing" for the whole travel
        // + dwell of every stop, i.e. many scrolls per part.
        const cur = committed ?? nearestIdx(pos);
        if (settledAt !== cur) {
          if (queuedStep === dir) queuedCount = Math.min(QUEUE_MAX, queuedCount + 1);
          else {
            queuedStep = dir;
            queuedCount = 1;
          }
          return;
        }
        // Move ONE stop, rests included. Landing on a rest owes a
        // continuation (routeDir), so after the rest's short dwell the move
        // carries on to the part by itself: one scroll still reads as one
        // part, but the passage holds at the whole drone long enough to see
        // where the old part flew home.
        const next = stepStop(gestureFrom, dir);
        queuedStep = 0;
        queuedCount = 0;
        routeDir = STOPS[next].part ? 0 : dir;
        committed = next;
        target = stopPos(next);
      };
      el.addEventListener('wheel', onWheel, {passive: false});
      cleanup.push(() => el.removeEventListener('wheel', onWheel));

      /* ---------------------------------------------------- drag to rotate
       * Orbit around the current focus, damped, with the elevation clamped so the
       * view can never flip under the model. The drag is a user OFFSET on top of the
       * scripted view: while it is held the scripted camera (focus, distance) is
       * frozen, so nothing fights the hand; the offset persists after release (the
       * reader keeps their view) and eases back to the beat's framing when the
       * timeline next moves. Pointer capture keeps the drag alive outside the
       * canvas, touch-action lets vertical swipes scroll the page (a horizontal
       * one-finger drag orbits), and hover picking is off while pressed.
       */
      let pressed = false;
      let dragging = false;
      // The assembling orbit may still be swinging onto the opening yaw.
      let userYaw = previewGoal === null ? 0 : previewAngle - previewGoal;
      let userYawT = 0;
      let userPitch = 0;
      let userPitchT = 0;
      let lastPtr = {x: 0, y: 0};
      const TAU = Math.PI * 2;
      el.style.touchAction = 'pan-y';
      el.style.userSelect = 'none';
      const onPtrDown = (e: PointerEvent) => {
        // Left button / touch / pen only.
        if (e.button !== 0) return;
        pressed = true;
        dragging = false;
        lastPtr = {x: e.clientX, y: e.clientY};
        ptr.downX = e.clientX;
        ptr.downY = e.clientY;
        ptr.x = e.clientX;
        ptr.y = e.clientY;
        ptr.inside = true;
        rect = el.getBoundingClientRect();
        el.setPointerCapture?.(e.pointerId);
      };
      const onPtrMove = (e: PointerEvent) => {
        // Hover only counts over the canvas, not over the copy or the buy bubble.
        ptr.x = e.clientX;
        ptr.y = e.clientY;
        ptr.inside = pressed || el.contains(e.target as Node);
        if (!pressed) {
          rect = el.getBoundingClientRect();
          ptr.dirty = true;
          if (!ptr.inside) hovered = null;
          return;
        }
        if (!dragging) {
          // A press has to travel a few pixels before it is a drag, not a click.
          if (Math.hypot(e.clientX - ptr.downX, e.clientY - ptr.downY) < 4) return;
          dragging = true;
          hovered = null;
          lastPtr = {x: e.clientX, y: e.clientY};
          return;
        }
        const dx = e.clientX - lastPtr.x;
        const dy = e.clientY - lastPtr.y;
        lastPtr = {x: e.clientX, y: e.clientY};
        // Drag right pulls the face under the cursor right (the camera goes the
        // other way); drag down tips the view up.
        userYawT += dx * 0.0055;
        userPitchT = THREE.MathUtils.clamp(userPitchT + dy * 0.0045, -0.9, 0.8);
      };
      const endPress = (e: PointerEvent) => {
        const wasPressed = pressed;
        const wasDragging = dragging;
        pressed = false;
        dragging = false;
        if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
        // A press that did not travel is a click: select the part under it (again
        // to release it). Empty space releases too.
        if (wasPressed && !wasDragging && e.type === 'pointerup') {
          const u = pickUnit();
          selected = u && u !== selected ? u : null;
          hovered = u;
          wake();
        }
        ptr.dirty = true;
      };
      const onPtrLeave = () => {
        if (pressed) return;
        ptr.inside = false;
        hovered = null;
      };
      el.addEventListener('pointerdown', onPtrDown);
      el.addEventListener('pointerleave', onPtrLeave);
      window.addEventListener('pointermove', onPtrMove);
      window.addEventListener('pointerup', endPress);
      window.addEventListener('pointercancel', endPress);
      el.style.cursor = 'grab';
      cleanup.push(() => {
        el.removeEventListener('pointerdown', onPtrDown);
        el.removeEventListener('pointerleave', onPtrLeave);
        window.removeEventListener('pointermove', onPtrMove);
        window.removeEventListener('pointerup', endPress);
        window.removeEventListener('pointercancel', endPress);
      });

      // Keyboard: arrows, PageUp/Down, Home/End step between stops. Without
      // this a keyboard user simply scrolls past and never sees five of the six
      // beats. The rail dots call goTo with a BEAT index; the keyboard walks
      // the stop list itself so it gets the rests too.
      const goToStop = (si: number) => {
        releaseManual();
        wake();
        selected = null;
        const idx = Math.max(0, Math.min(STOPS.length - 1, si));
        gestureFrom = idx;
        gestureDir = 0;
        queuedStep = 0;   // an explicit jump supersedes a banked wheel step
        queuedCount = 0;
        routeDir = 0;
        committed = idx;
        everScrolled = true;
        lastWheel = performance.now() - 2000;
        target = stopPos(idx);
      };
      const goTo = (i: number) =>
        goToStop(partStopIdx(Math.max(0, Math.min(BEATS.length - 1, i))));
      // Deep link: /#esc (also fc, rx, frame, motors) opens the walkthrough
      // ON that part, so the PDP's "see how the whole drone works" lands on
      // the component in the assembly instead of the top of the sequence.
      // `motors` is the PDP chain's plural; the beat id is singular. The
      // position snaps (no cross-sequence flight), then dwell rules apply
      // as if the reader had arrived by scrolling.
      {
        const hash =
          typeof location !== 'undefined'
            ? location.hash.slice(1).toLowerCase()
            : '';
        const wantId = hash === 'motors' ? 'motor' : hash;
        const bi = wantId ? BEATS.findIndex((bb) => bb.id === wantId) : -1;
        if (bi >= 0) {
          goTo(bi);
          pos = target;
          vel = 0;
        }
      }
      const onKey = (e: KeyboardEvent) => {
        const cur = nearestIdx(target);
        let next: number | null = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') next = cur + 1;
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') next = cur - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = STOPS.length - 1;
        if (next === null) return;
        // At the ends, let the key do its normal thing and leave the hero.
        if (next < 0 || next > STOPS.length - 1) return;
        e.preventDefault();
        goToStop(next);
      };
      // Listen on the document, gated on the hero being on screen: the canvas
      // is not focusable, and a reader using the rail should still be able to
      // arrow between stops.
      const onDocKey = (e: KeyboardEvent) => {
        if (!onScreen) return;
        const t = e.target as HTMLElement | null;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if (e.key === 'Escape' && selected) {
          selected = null;
          wake();
          return;
        }
        onKey(e);
      };
      document.addEventListener('keydown', onDocKey);
      cleanup.push(() => document.removeEventListener('keydown', onDocKey));

      /* ------------------------------------------------------------- loop */
      // A GPU reset or a backgrounded mobile tab kills the context. Without
      // this the hero is permanently blank with no signal.
      const onLost = (ev: Event) => {
        ev.preventDefault();
        setError('graphics context lost, reloading the view');
      };
      const onRestored = () => setError(null);
      renderer.domElement.addEventListener('webglcontextlost', onLost);
      renderer.domElement.addEventListener('webglcontextrestored', onRestored);
      cleanup.push(() => {
        renderer.domElement.removeEventListener('webglcontextlost', onLost);
        renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
      });

      const clock = new THREE.Clock();
      let lastBeat = -1;

      camera.position.copy(droneCentre).add(new THREE.Vector3(1, 0.5, 1).normalize().multiplyScalar(droneRadius * 2.15));
      camera.near = droneRadius / 300;
      camera.far = droneRadius * 60;
      camera.updateProjectionMatrix();
      resizeIfNeeded();
      await yieldToMain();
      if (disposed) return;

      // Compile the shader variants before the first gesture.
      await renderer.compileAsync(scene, camera);
      if (disposed) return;

      let loopErrors = 0;
      let testDt: number | null = null;
      let lastProgress = -1;
      let lastBrightness = -1;
      let lastRenderedAt = 0;
      for (const event of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
        el.addEventListener(event, wake, {passive: true});
        cleanup.push(() => el.removeEventListener(event, wake));
      }
      window.addEventListener('resize', wake);
      cleanup.push(() => window.removeEventListener('resize', wake));
      // Keep the fully shaded image when settled. A gesture wakes the scene
      // immediately; an untouched tab does not keep orbiting at full GPU load.
      lastInteraction = performance.now();
      // The frame explicitly updates the rig before presentation, then only
      // the moved parts. Prevent a second full traversal inside render().
      scene.matrixAutoUpdate = false;
      scene.matrixWorldAutoUpdate = false;
      const frame = () => {
       try {
        if (!TEST && (!onScreen || document.hidden)) return;
        const now = performance.now();
        if (!TEST && !pressed && now - lastInteraction > 5000 &&
            Math.abs(target - pos) < dur() * 0.001 && Math.abs(vel) < dur() * 0.001 &&
            !pressed && !catchUp && Math.abs(explodeP - desiredExplode()) < 0.002) {
          idlePaused = true;
          syncPlayback();
          return;
        }
        // High-refresh displays must not double the animation's GPU budget.
        if (!TEST && now - lastRenderedAt < 1000 / 60 - 1) return;
        lastRenderedAt = now;
        resizeIfNeeded();
        const dt = testDt ?? Math.min(clock.getDelta(), 0.05);
        if (testDt !== null) clock.getDelta();   // keep the clock in step

        const idle = performance.now() - lastWheel;
        if (everScrolled && idle > 120) {
          if (committed === null) {
            const fromPos = stopPos(gestureFrom);
            const moved = (target - fromPos) * (gestureDir || 1);
            // Stops are no longer evenly spaced (rest-to-part is closer than
            // part-to-part), so the intent threshold is a fraction of THIS
            // gap, not of a beat length.
            const nextIdx = nextPartIdx(gestureFrom, gestureDir || 1);
            const gap = Math.abs(stopPos(nextIdx) - fromPos) || dur();
            const advance = moved > gap * (cfg.scroll?.commitAt ?? 0.28) || Math.abs(vel) > dur() * 0.6;
            committed = advance ? nextIdx : gestureFrom;
          }
          const snap = stopPos(committed);
          const settle = Math.min(1, (idle - 120) / 260);
          target += (snap - target) * (1 - (1 - (cfg.scroll?.magnet ?? 0.14) * settle) ** (dt * 60));
        }
        const omega = 2 * Math.PI * (reduced ? 30 : (cfg.scroll?.springHz ?? 0.55));
        const f = 1 + 2 * dt * omega;
        const oo = omega * omega;
        const hoo = dt * oo;
        const hhoo = dt * hoo;
        const det = 1 / (f + hhoo);
        const nx = (f * pos + dt * vel + hhoo * target) * det;
        const nv = (vel + hoo * (target - pos)) * det;
        pos = nx;
        vel = nv;

        beatIdx = Math.min(BEATS.length - 1, Math.max(0, Math.floor(pos / dur())));
        t = pos - beatIdx * dur();
        const b = BEATS[beatIdx];

        // Report progress across the STOPS, not the raw timeline: the first
        // stop sits at 8% and the last at 92% of the span, so pos/span never
        // reaches either end and the rail never lines up with its own dots.
        const p0 = stopPos(Math.min(1, STOPS.length - 1));
        const p1 = stopPos(STOPS.length - 1);
        const progress = THREE.MathUtils.clamp((pos - p0) / Math.max(p1 - p0, 1e-6), 0, 1);
        const progressPixel = Math.round(progress * 10000);
        if (progressPixel !== lastProgress) {
          lastProgress = progressPixel;
          onProgress?.(progress);
        }

        // The hold is "seen" once the part has arrived and its hold has run
        // long enough for the spotlight to strike and settle. A rest just has
        // to read as the whole drone for a moment.
        {
          const cur = committed ?? nearestIdx(pos);
          // 10% of a beat, not 6%: a critically damped spring spends its
          // last few percent crawling, and that crawl was ~0.3 s of dead
          // time per leg where the picture had visibly arrived but input
          // still could not apply. Retargeting from 10% out is seamless.
          const atStop = Math.abs(pos - stopPos(cur)) < dur() * 0.1;
          if (atStop) {
            dwell += dt;
            // A rest is a breath between two parts. When the reader has
            // already asked for the next part (a bank is waiting) the
            // breath is skipped: the flight home still plays, the hold at
            // the whole drone does not. An unseen part is never shortened.
            const need =
              STOPS[cur].part && !seenStops.has(cur)
                ? MIN_DWELL_S
                : !STOPS[cur].part && queuedStep
                  ? 0
                  : REST_DWELL_S;
            if (dwell > need) {
              settledAt = cur;
              seenStops.add(cur);
              // Fire the owed continuation and/or the banked step, one stop
              // at a time, the moment this stop has been presented. At a
              // rest the passage carries on by itself (routeDir); a bank in
              // the SAME direction rides along and fires at the next part,
              // a bank in the OPPOSITE direction turns the passage around.
              // At a part, a banked scroll starts the next passage.
              const contDir = !STOPS[cur].part ? routeDir : 0;
              let dirQ: 0 | 1 | -1 = 0;
              const takeBank = () => {
                dirQ = queuedStep;
                queuedCount = Math.max(0, queuedCount - 1);
                if (!queuedCount) queuedStep = 0;
              };
              if (contDir && queuedStep && queuedStep !== contDir) {
                takeBank();
              } else if (contDir) {
                dirQ = contDir;
              } else if (queuedStep) {
                takeBank();
              }
              routeDir = 0;
              if (dirQ) {
                const next = stepStop(cur, dirQ);
                if (next !== cur) {
                  committed = next;
                  target = stopPos(next);
                  if (!STOPS[next].part) routeDir = dirQ;
                }
              }
            }
          } else if (settledAt !== cur) {
            dwell = 0;
          }
        }

        const kRaw = envelope(t);
        const k = b.nodes.length ? kRaw : 0;

        // The copy panel follows the SPOTLIGHT, not the timeline: it shows a
        // part while that part is out (k high) and clears during travel and
        // rests, so a rest reads as the whole drone with no caption racing
        // ahead to the next part. A whole-drone beat shows its copy on the
        // same envelope when it carries a caption (the establishing hold is
        // where the beginner intro reads); without one it stays silent, since
        // the size tab already names what is on screen.
        {
          const display =
            (b.nodes.length || b.caption) && kRaw > 0.3 ? beatIdx : -1;
          // Which mid-hold stop is active, matching the studio's activeStop():
          // the last stop whose `at` the hold progress has passed. This is the
          // wiring that used to be missing: `stops` was parsed and ignored, so
          // a caption tuned in the studio never showed on the site.
          let stopIdx = -1;
          if (display >= 0 && b.stops?.length) {
            const holdT = THREE.MathUtils.clamp((t - TRAVEL) / Math.max(HOLD, 1e-3), 0, 1);
            for (let i = 0; i < b.stops.length; i++) if (holdT >= b.stops[i].at) stopIdx = i;
          }
          // One change key covers both beat and stop transitions.
          const shown = display < 0 ? -1 : display * 100 + stopIdx + 1;
          if (shown !== lastBeat) {
            lastBeat = shown;
            onBeat?.(display >= 0 ? toHeroBeat(b, stopIdx) : null, display);
          }
        }

        // Explode: the scroll position, spring-smoothed, is the progress.
        const desiredP = desiredExplode();
        if (manualP !== null) explodeP = reduced ? manualP : stepToward(explodeP, manualP, dt / MANUAL_S);
        else if (catchUp) {
          explodeP = reduced ? desiredP : stepToward(explodeP, desiredP, dt * 2.5);
          if (Math.abs(explodeP - desiredP) < 0.002) catchUp = false;
        } else explodeP = desiredP;
        const nowExploded = (manualP ?? desiredP) > 0.5;
        if (nowExploded !== isExploded) {
          isExploded = nowExploded;
          onExploded?.(isExploded);
        }
        applyExplode(explodeP);
        const ep = ease(clamp01(explodeP));
        // The camera frames the whole drone: the assembled size at first, easing
        // out to the exploded size as the parts fly apart.
        droneRadius = THREE.MathUtils.lerp(F0.radius, F1.radius, ep);
        const centreNow = F0.centre.clone().lerp(F1.centre, ep);
        blob.position.set(centreNow.x, THREE.MathUtils.lerp(F0.floor, F1.floor, ep) - droneRadius * 0.04, centreNow.z);
        blob.scale.setScalar(droneRadius * (1.05 + 0.2 * ep));
        updateHeroMatrices(moving);
        scene.updateMatrixWorld();

        // Hover (pointer ray, throttled, never while pressed), then what to focus:
        // the part under the pointer, else the selected part, else the walkthrough's.
        if (ptr.dirty && !pressed && now - lastRay > 45) {
          ptr.dirty = false;
          lastRay = now;
          hovered = pickUnit();
        }
        const wantUnit = hovered ?? selected;
        let nodes: THREE.Object3D[];
        let amtTarget: number;
        let fade: number;
        let key: string;
        if (wantUnit) {
          nodes = [wantUnit.node];
          amtTarget = 1;
          fade = hovered ? 0.55 : (cfg.explode?.selectFade ?? 0.7);
          key = wantUnit.id;
        } else if (b.nodes.length) {
          nodes = b.nodes.map((n) => n.node);
          amtTarget = k;
          fade = b.fade ?? S.darkenRest;
          key = `beat:${b.id}`;
        } else {
          nodes = [];
          amtTarget = 0;
          fade = 0;
          key = '';
        }
        // Crossfade, not a switch: the lit set fades out, the new set is swapped in
        // while it is dark, and fades in.
        let amtGoal = amtTarget;
        if (key !== focusKey) {
          amtGoal = 0;
          if (focusAmt < 0.1) {
            focusKey = key;
            focusNodes = nodes;
            setDimFor(nodes, key);
            focusFade = fade;
          }
        }
        focusAmt += (amtGoal - focusAmt) * (reduced ? 1 : 1 - 0.002 ** dt);
        if (!focusNodes.length) focusAmt = 0;

        const bright = THREE.MathUtils.lerp(1, 1 - focusFade, focusAmt);
        for (const m of dimMaterials) {
          if (bright === lastBrightness && m.userData.brightness === bright) continue;
          const u = (m as any).userData;
          if (!u?.baseColor) continue;
          m.color.copy(u.baseColor).multiplyScalar(bright);
          m.envMapIntensity = u.baseEnv * bright;
          // Albedo alone is not enough: a metal with a black base colour still
          // returns a full specular highlight, so a spotlit part blew the
          // backgrounded drone out to white. Fade metalness out with it.
          if (u.baseMetal === undefined) u.baseMetal = m.metalness;
          m.metalness = u.baseMetal * bright;
          u.brightness = bright;
        }
        lastBrightness = bright;

        /* ---- camera. The scripted view moves straight from one beat's framing to
         * the next (no pull-back to the overview between), eased and smoothed; the
         * reader's drag is an offset on top. */
        const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        const baseBack = droneRadius * (cfg.camera?.distance ?? 2.15);
        const overviewFocus = centreNow.clone();
        overviewFocus.y -= droneRadius * (cfg.camera?.lift ?? 0.1);
        const heightOv = cfg.camera?.height ?? 0.5;
        const heightPart = cfg.camera?.heightOnPart ?? 0.62;
        const camStateOf = (bi: number, size0: number) => {
          const bb = BEATS[bi];
          if (!bb.nodes.length) return {c: overviewFocus, back: baseBack, h: heightOv};
          const sp = sphereOf(bb.frameNodes);
          return {
            c: sp.center.clone(),
            back: THREE.MathUtils.clamp(sp.radius / ((bb.partSize ?? size0) * halfTan), droneRadius * 0.28, baseBack),
            h: heightPart,
          };
        };
        let want: {c: THREE.Vector3; back: number; h: number};
        const yawBase = (cfg.camera?.azimuth ?? 0.7) + userYaw;
        // Lateral axis of the current view, to tell which way a move goes.
        const rx = Math.sin(yawBase);
        const rz = -Math.cos(yawBase);
        let swingGoal = 0;
        if (selected !== selectedPrev) {
          selectedPrev = selected;
          selT = 0;
        }
        if (selected) {
          const sp = sphereOf([selected.node]);
          want = {
            c: sp.center.clone(),
            back: THREE.MathUtils.clamp(sp.radius / (0.34 * halfTan), droneRadius * 0.3, baseBack),
            h: heightPart,
          };
          if (selT === 0) selDir = Math.sign((want.c.x - camFocus.x) * rx + (want.c.z - camFocus.z) * rz) || 1;
        } else {
          const f = (pos - stopForBeat(0)) / dur();
          const i0 = THREE.MathUtils.clamp(Math.floor(f), 0, Math.max(0, BEATS.length - 2));
          const raw = f <= 0 || BEATS.length < 2 ? 0 : clamp01(f - i0);
          const u = ease(raw);
          const A = camStateOf(i0, Q.partSize);
          if (u === 0) want = A;
          else {
            const Bs = camStateOf(i0 + 1, Q.partSize);
            want = {c: A.c.clone().lerp(Bs.c, u), back: THREE.MathUtils.lerp(A.back, Bs.back, u), h: THREE.MathUtils.lerp(A.h, Bs.h, u)};
            // The camera sweeps round the model between two groups instead of cutting across.
            const dirB = Math.sign((Bs.c.x - A.c.x) * rx + (Bs.c.z - A.c.z) * rz) || 1;
            swingGoal = dirB * 0.42 * Math.sin(Math.PI * raw);
          }
        }
        if (selT < 1) {
          selT = Math.min(1, selT + dt);
          if (selected) swingGoal = selDir * 0.4 * Math.sin(Math.PI * selT);
        }
        // The copy panel owns the right of the stage: slide the subject left of it.
        const shift = want.back * halfTan * camera.aspect * (cfg.camera?.stageShift ?? 0.2) * Math.min(1, camera.aspect / 1.4);
        want.c.x += rx * shift;
        want.c.z += rz * shift;
        if (reduced || !camReady) {
          camFocus.copy(want.c);
          camBack = want.back;
          camH = want.h;
          swing = 0;
        } else if (!dragging) {
          // ~1 s ease in and out, interruptible: the velocity carries across retargets.
          camFocus.x = smoothDamp(camFocus.x, want.c.x, camVel[0], 0.45, dt);
          camFocus.y = smoothDamp(camFocus.y, want.c.y, camVel[1], 0.45, dt);
          camFocus.z = smoothDamp(camFocus.z, want.c.z, camVel[2], 0.45, dt);
          camBack = smoothDamp(camBack, want.back, camVel[3], 0.45, dt);
          camH = smoothDamp(camH, want.h, camVel[4], 0.45, dt);
          swing = smoothDamp(swing, swingGoal, camVel[5], 0.25, dt);
        }
        camReady = true;
        // The offset eases back to the beat's framing when the timeline moves.
        const travelling = Math.abs(target - pos) > dur() * 0.01 || Math.abs(vel) > dur() * 0.01;
        if (travelling && !wasTravelling && !dragging) {
          userYawT = Math.round(userYawT / TAU) * TAU;
          userPitchT = 0;
        }
        wasTravelling = travelling;
        const orbitK = reduced ? 1 : 1 - 1e-4 ** dt;
        userYaw += (userYawT - userYaw) * orbitK;
        userPitch += (userPitchT - userPitch) * orbitK;
        const pitch = THREE.MathUtils.clamp(Math.atan(camH) + userPitch, 0.12, 1.3);
        const yaw = (cfg.camera?.azimuth ?? 0.7) + userYaw + swing;
        camera.position.set(
          camFocus.x + Math.cos(pitch) * Math.cos(yaw) * camBack,
          camFocus.y + Math.sin(pitch) * camBack,
          camFocus.z + Math.cos(pitch) * Math.sin(yaw) * camBack,
        );
        camera.lookAt(camFocus);
        camera.updateMatrixWorld();
        const cursor = dragging ? 'grabbing' : hovered ? 'pointer' : 'grab';
        if (el.style.cursor !== cursor) el.style.cursor = cursor;

        batches?.update();

        renderer.render(scene, camera);
       } catch (err) {
        // One throw in here would otherwise repeat 60 times a second forever
        // with nothing visible to the reader.
        if (loopErrors++ < 3) console.error('[hero] render loop:', err);
        if (loopErrors === 3) {
          renderer.setAnimationLoop(null);
          setError('animation stopped');
        }
       }
      };
      previewOn = false;
      let playing: boolean | null = null;
      syncPlayback = () => {
        const play = TEST || (onScreen && !document.hidden && !idlePaused);
        if (play === playing) return;
        playing = play;
        clock.getDelta();
        renderer.setAnimationLoop(play ? frame : null);
      };
      document.addEventListener('visibilitychange', syncPlayback);
      cleanup.push(() => document.removeEventListener('visibilitychange', syncPlayback));
      syncPlayback();
      cleanup.push(() => renderer.setAnimationLoop(null));

      // requestAnimationFrame is suspended in a backgrounded tab, so an
      // automated check cannot integrate the scroll spring at all. In test mode
      // only, keep a timer ticking so the sequence is drivable headlessly.
      if (TEST) {
        const t = setInterval(() => {
          if (document.hidden) frame();
        }, 16);
        cleanup.push(() => clearInterval(t));
      }

      onSeeker?.(goTo);
      onExplode?.({toggle: () => setExploded(!isExploded), set: setExploded});
      cleanup.push(() => onExplode?.(null));
      onExploded?.(isExploded);
      if (TEST) {
        (window as Window & {__hero?: unknown}).__hero = {
          goTo,
          // Advance n frames at a fixed 16 ms, ignoring wall clock.
          step: (n = 60) => {
            for (let i = 0; i < n; i++) {
              testDt = 1 / 60;
              frame();
            }
            testDt = null;
          },
          state: () => ({
            pos,
            target,
            beat: beatIdx,
            committed,
            settledAt,
            stops: STOPS.map((s) => s.pos),
            partStops: STOPS.map((s) => s.part),
          }),
          // Freeze the build at an explode progress 0..1 (screenshots).
          setExplode: (p: number) => {
            manualP = explodeP = p;
          },
          wheel: (deltaY: number, deltaMode = 0) =>
            renderer.domElement.dispatchEvent(
              new WheelEvent('wheel', {deltaY, deltaMode, bubbles: true, cancelable: true}),
            ),
          scene,
          camera,
          THREE,
          beats: BEATS.map((b) => b.id),
          dur: dur(),
        };
      }
      // Capture one outgoing frame when changing size, then release its GPU
      // context. Only the incoming scene renders during the crossfade.
      frame();
      capture = () => {
        const still = snapshot.current;
        if (!still) return;
        snapshotFade.current?.cancel();
        renderer.render(scene, camera);
        still.width = renderer.domElement.width;
        still.height = renderer.domElement.height;
        still.getContext('2d')?.drawImage(renderer.domElement, 0, 0);
        still.style.display = 'block';
        still.style.opacity = '1';
      };
      if (snapshot.current?.width) {
        const still = snapshot.current;
        renderer.domElement.style.opacity = '1';
        renderer.domElement.animate([{opacity: 0}, {opacity: 1}], {duration: 500, easing: 'ease-in-out'});
        const fade = still.animate([{opacity: 1}, {opacity: 0}], {duration: 500, easing: 'ease-in-out', fill: 'forwards'});
        snapshotFade.current = fade;
        void fade.finished.then(() => {
          if (snapshotFade.current !== fade) return;
          still.style.display = 'none';
          still.width = 0;
          still.height = 0;
        }).catch(() => {});
      }
      onBuilding?.(false);
      mark('ready');
      onReady?.();
    })().catch((e: unknown) => {
      if (disposed) return;
      console.error('[hero]', e);
      setError(e instanceof Error ? e.message : String(e));
      onBuilding?.(false);
      // Always release the splash, or a 404 leaves the page reading LOADING
      // forever behind a dim layer.
      onReady?.();
    });

    return () => {
      capture?.();
      disposed = true;
      for (const fn of cleanup.reverse()) fn();
      // Belt and braces: if an in-flight instance still managed to append, do
      // not leave a dead canvas stacked over the live one.
      for (const c of Array.from(el.querySelectorAll('canvas'))) c.remove();
    };
  }, [model, reduced, onModel, onBeat, onBeats, onLoad, onProgress, onReady, onBuilding, onSeeker, onExplode, onExploded]);

  return (
    // Decorative: every beat's copy is in the DOM in .hp-fallback, and
    // keyboard control is the rail's real buttons, so the canvas itself carries
    // no semantics and is not a tab stop.
    <>
    <div ref={host} aria-hidden="true" style={{position: 'absolute', inset: 0}}>
      {error ? (
        <div style={{position: 'absolute', left: 16, bottom: 16, color: '#ff8574', font: '12px ui-monospace'}}>
          hero: {error}
        </div>
      ) : null}
    </div>
    <canvas ref={snapshot} data-hero-snapshot="" width={0} height={0} aria-hidden="true" style={{position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1, display: 'none'}} />
    </>
  );
}
