// Scene module (owner: shell). PlayCanvas setup, splat loading, the gsplatModifyVS chunk and camera helpers.
// Decisions where SPEC.md is silent:
// - worldToScreen projects with the camera basis and fov directly instead of camera.worldToScreen, so the
//   result is correct right after applyPose without waiting for the next rendered frame.
// - opts.quality ('low' | 'medium' | 'high') caps device.maxPixelRatio at 1, 1.5 or 2 (default 'high').
// - setViewRect(ctx, inset) renders the 3D view only into the part of the canvas an overlay (the info card) does
//   not cover, so the machine stays centred and visible next to or above its card. The fov rule (65 vertical, or
//   80 horizontal when the aspect is below 1) uses the aspect of that visible part.
// - setBackdrop draws six flat unlit faces on the scene box (floor at floorY) behind the splat, in colours sampled
//   from renders of the scan (data/backdrop.json, written by tools/backdrop_colors.mjs). Where the scan has no wall
//   or floor the visitor sees a matte wall or floor in the room's colours instead of empty space. The faces write no
//   depth and test no depth, so every splat draws over them wherever it is.
import * as pc from 'playcanvas';

export const SHADER_FRAME = 'world'; // switch to 'ply' only if A17 shows the highlight in the wrong place; then
                                    // uHiPos and uCam are sent as (-x, -y, z)

const GLSL = `
uniform vec3 uCam; uniform float uNear; uniform vec3 uHiPos; uniform float uHiR; uniform float uHiAmt; uniform vec3 uHiTint;
void modifySplatCenter(inout vec3 c) {}
void modifySplatRotationScale(vec3 oc, vec3 c, inout vec4 r, inout vec3 s) {
  s *= smoothstep(uNear * 0.5, uNear, distance(c, uCam));
}
void modifySplatColor(vec3 c, inout vec4 col) {
  float h = (1.0 - smoothstep(uHiR * 0.6, uHiR, distance(c, uHiPos))) * uHiAmt;
  col.rgb = mix(col.rgb, col.rgb * 1.25 + uHiTint * 0.2, h);
}
`;

const WGSL = `
uniform uCam: vec3f; uniform uNear: f32; uniform uHiPos: vec3f; uniform uHiR: f32; uniform uHiAmt: f32; uniform uHiTint: vec3f;
fn modifySplatCenter(center: ptr<function, vec3f>) {}
fn modifySplatRotationScale(oc: vec3f, c: vec3f, r: ptr<function, vec4f>, s: ptr<function, vec3f>) {
  *s = *s * smoothstep(uniform.uNear * 0.5, uniform.uNear, distance(c, uniform.uCam));
}
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
  let h = (1.0 - smoothstep(uniform.uHiR * 0.6, uniform.uHiR, distance(center, uniform.uHiPos))) * uniform.uHiAmt;
  let c = (*color).rgb;
  *color = vec4f(mix(c, c * 1.25 + uniform.uHiTint * 0.2, h), (*color).a);
}
`;

const toShader = (p) => (SHADER_FRAME === 'ply' ? [-p[0], -p[1], p[2]] : [p[0], p[1], p[2]]);

function codedError(code, cause) {
  const e = new Error(code + (cause ? ': ' + (cause.message || cause) : ''));
  e.code = code;
  return e;
}

// The scan is an unbundled SOG: scan/meta.json plus the webp textures it lists (the bundled index.sog is 35 MB, over
// the 25 MiB per-file limit of the host). fetchScan downloads the textures itself so the loading bar shows real bytes,
// and hands them to the PlayCanvas SOG parser (SogParser, selected for a .json url) through the asset's mapUrl option.
export const SCAN_URL = 'scan/meta.json';
export const DETAIL_URL = 'scan-detail/meta.json';
export function scanFiles(meta) {
  return ['means', 'quats', 'scales', 'sh0', 'shN'].flatMap((k) => (meta && meta[k] && meta[k].files) || []);
}

async function fetchScan(metaUrl, onProgress) {
  const base = new URL(metaUrl, window.location.href);
  const r = await fetch(base);
  if (!r.ok) throw new Error('fetch ' + metaUrl + ' ' + r.status);
  const meta = await r.json();
  const files = scanFiles(meta);
  const loaded = new Map(), totals = new Map();
  const report = () => {
    if (!onProgress) return;
    let l = 0, t = 0;
    loaded.forEach((v) => { l += v; });
    totals.forEach((v) => { t += v; });
    if (totals.size && totals.size < files.length) t = Math.ceil((t * files.length) / totals.size);
    onProgress(l, t);
  };
  const entries = await Promise.all(files.map(async (f) => {
    const res = await fetch(new URL(f, base));
    if (!res.ok) throw new Error('fetch ' + f + ' ' + res.status);
    const len = Number(res.headers.get('content-length')) || 0;
    if (len) totals.set(f, len);
    let blob;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.byteLength;
        loaded.set(f, n);
        report();
      }
      blob = new Blob(chunks, { type: 'image/webp' });
    } else {
      blob = await res.blob();
      loaded.set(f, blob.size);
      report();
    }
    return [f, URL.createObjectURL(blob)];
  }));
  return { meta, urls: new Map(entries) };
}

// createScene = createApp (device, app, camera; renders at once) + loadRoom (downloads the scan and adds the splat).
// The launch-mode corridor (js/entrance.js) draws in the app while loadRoom runs, and a failed loadRoom keeps the app
// so the corridor can retry it. createScene destroys the app on a failure, as before.
export async function createScene(canvas, { scanUrl = SCAN_URL, renderer = 'auto', onProgress, quality = 'high' } = {}) {
  const ctx = await createApp(canvas, { renderer, quality });
  try {
    return await loadRoom(ctx, { scanUrl, onProgress });
  } catch (err) {
    window.removeEventListener('resize', ctx.onResize);
    ctx.app.destroy();
    throw err;
  }
}

export async function createApp(canvas, { renderer = 'auto', quality = 'high', gsplat = null } = {}) {
  const deviceTypes = renderer === 'webgpu' ? ['webgpu'] : renderer === 'webgl2' ? ['webgl2'] : ['webgpu', 'webgl2'];
  let device;
  try {
    device = await pc.createGraphicsDevice(canvas, { deviceTypes, antialias: false });
  } catch (err) {
    throw codedError('no-gpu', err);
  }
  if (!device) throw codedError('no-gpu');
  const backend = device.isWebGPU ? 'webgpu' : 'webgl2';
  if (renderer !== 'auto' && backend !== renderer) throw codedError('no-gpu', 'requested ' + renderer + ', got ' + backend);

  const opts = new pc.AppOptions();
  opts.graphicsDevice = device;
  opts.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.GSplatComponentSystem];
  opts.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler, pc.GSplatHandler];
  const app = new pc.AppBase(canvas);
  app.init(opts);
  // engine splat settings (app.scene.gsplat) set before the splat exists; test mode passes them from ?gsplat=
  if (gsplat) for (const [k, v] of Object.entries(gsplat)) app.scene.gsplat[k] = v;
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  const cap = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
  device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, cap);

  const camera = new pc.Entity('camera');
  camera.addComponent('camera', {
    clearColor: new pc.Color(0.118, 0.118, 0.125),
    fov: 65,
    nearClip: 0.02,
    farClip: 50
  });
  app.root.addChild(camera);
  const fitFov = () => {
    const r = camera.camera.rect;
    const aspect = ((canvas.clientWidth || 1) * r.z) / ((canvas.clientHeight || 1) * r.w);
    camera.camera.horizontalFov = aspect < 1;
    camera.camera.fov = aspect < 1 ? 80 : 65;
  };
  fitFov();
  const onResize = () => { app.resizeCanvas(); fitFov(); };
  window.addEventListener('resize', onResize);
  app.start();
  return { app, device, camera, backend, canvas, fitFov, onResize, viewKey: '0,0,0,0' };
}

export async function loadRoom(ctx, { scanUrl = SCAN_URL, onProgress } = {}) {
  const { app, device, camera } = ctx;
  let room;
  try {
    room = await loadLayer(app, 'room', scanUrl, onProgress);
  } catch (err) {
    throw codedError('load-failed', err);
  }

  const material = room.gsplat.unified ? app.scene.gsplat.material : room.gsplat.material;
  material.getShaderChunks(device.isWebGPU ? 'wgsl' : 'glsl').set('gsplatModifyVS', device.isWebGPU ? WGSL : GLSL);
  material.update();
  material.setParameter('uNear', 0.055);
  material.setParameter('uHiTint', [1.0, 0.478, 0.184]);
  material.setParameter('uHiAmt', 0);
  material.setParameter('uHiPos', toShader([0, -100, 0]));
  material.setParameter('uHiR', 0.14);
  material.setParameter('uCam', toShader([0, 0, 0]));

  // clear the whole canvas, not only the view rect, so no stale pixels remain beside a narrowed view
  // (private engine field, guarded; without it WebGL2 leaves the area outside the rect undefined)
  try { camera.camera.camera._scissorRectClear = true; camera.camera.scissorRect = new pc.Vec4(0, 0, 1, 1); } catch (err) { /* keep defaults */ }

  ctx.room = room;
  ctx.material = material;
  ctx.detail = null;
  return ctx;
}

// Downloads one layer of the scan (an unbundled SOG) and adds it as a gsplat entity. The splat is stored in the PLY
// frame; a 180 degree roll about Z puts it in WORLD. Layers render together: PlayCanvas sorts the Gaussians of every
// gsplat entity as one set (unified rendering), and the gsplatModifyVS chunk of the shared material applies to all.
async function loadLayer(app, name, metaUrl, onProgress, parent = null) {
  let urls = new Map();
  let asset;
  try {
    ({ urls } = await fetchScan(metaUrl, onProgress));
    asset = new pc.Asset(name, 'gsplat', { url: metaUrl }, null, { mapUrl: (f) => urls.get(f) });
    app.assets.add(asset);
    await new Promise((resolve, reject) => {
      asset.ready(resolve);
      asset.on('error', (err) => reject(err));
      app.assets.load(asset);
    });
  } catch (err) {
    if (asset) app.assets.remove(asset);
    throw err;
  } finally {
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
  const e = new pc.Entity(name);
  e.addComponent('gsplat', { asset });
  if (parent) parent.addChild(e); // in the parent's frame, shown and hidden with it
  else { e.setLocalEulerAngles(0, 0, 180); app.root.addChild(e); }
  return e;
}

// The detail layer of the scan (js/tier.js), a child of the room entity so it shows and hides with the room (the
// launch corridor hides the room). Loads it once; later calls only show or hide it.
export async function setDetail(ctx, on, onProgress) {
  if (!on) { if (ctx.detail) ctx.detail.enabled = false; return false; }
  if (ctx.detail) { ctx.detail.enabled = true; return true; }
  if (ctx.detailLoading) return ctx.detailLoading;
  ctx.detailLoading = loadLayer(ctx.app, 'room-detail', DETAIL_URL, onProgress, ctx.room).then((e) => {
    ctx.detail = e;
    ctx.detailLoading = null;
    return true;
  }, (err) => {
    ctx.detailLoading = null;
    throw err;
  });
  return ctx.detailLoading;
}

// inset: fractions of the canvas covered by an overlay on each side, { left, top, right, bottom }; null for none.
// Stops (on = false) or restarts the PlayCanvas frame loop: update, splat sort and render all stop while it is off.
export function setRunning(ctx, on) {
  const app = ctx.app;
  if (!app || !app.graphicsDevice) return;
  if (!on) pc.AppBase.cancelTick(app);
  else if (!app.frameRequestId) app.requestAnimationFrame();
}

// Render resolution cap in device pixels per CSS pixel (1, 1.5 or 2); main.js lowers it when frames are slow.
export function setPixelCap(ctx, cap) {
  const dev = ctx.device;
  const want = Math.min(window.devicePixelRatio || 1, cap);
  if (Math.abs(dev.maxPixelRatio - want) < 1e-6) return want;
  dev.maxPixelRatio = want;
  ctx.app.resizeCanvas();
  ctx.fitFov();
  return want;
}

export function setViewRect(ctx, inset) {
  const { left = 0, top = 0, right = 0, bottom = 0 } = inset || {};
  const q = (v) => Math.round(Math.min(0.9, Math.max(0, v)) * 1000) / 1000;
  const l = q(left), t = q(top), r = q(right), b = q(bottom);
  const key = [l, t, r, b].join(',');
  if (key === ctx.viewKey) return;
  ctx.viewKey = key;
  ctx.camera.camera.rect = new pc.Vec4(l, b, Math.max(0.1, 1 - l - r), Math.max(0.1, 1 - t - b));
  ctx.fitFov();
}

// box: { boxMin: [x,y,z], boxMax: [x,y,z], floorY }; colors: { floor, wall, ceiling } as sRGB [r, g, b] in 0..1.
// Replaces an earlier backdrop. Returns the backdrop entity.
export function setBackdrop(ctx, box, colors) {
  if (ctx.backdrop) { ctx.backdrop.destroy(); ctx.backdrop = null; }
  const [x0, , z0] = box.boxMin;
  const [x1, y1, z1] = box.boxMax;
  const yf = box.floorY;
  const root = new pc.Entity('backdrop');
  const face = (name, rgb, pos, euler, scale) => {
    const m = new pc.StandardMaterial();
    m.useLighting = false;
    m.useSkybox = false;
    m.useFog = false;
    m.diffuse = new pc.Color(0, 0, 0);
    m.emissive = new pc.Color(rgb[0], rgb[1], rgb[2]);
    m.cull = pc.CULLFACE_NONE;
    m.depthWrite = false;
    m.depthTest = false;
    m.update();
    const e = new pc.Entity(name);
    e.addComponent('render', { type: 'plane', material: m, castShadows: false, receiveShadows: false });
    e.setLocalPosition(pos[0], pos[1], pos[2]);
    e.setLocalEulerAngles(euler[0], euler[1], euler[2]);
    e.setLocalScale(scale[0], scale[1], scale[2]);
    root.addChild(e);
  };
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, cy = (yf + y1) / 2;
  const sx = x1 - x0, sz = z1 - z0, sy = y1 - yf;
  face('floor', colors.floor, [cx, yf, cz], [0, 0, 0], [sx, 1, sz]);
  face('ceiling', colors.ceiling, [cx, y1, cz], [0, 0, 0], [sx, 1, sz]);
  // a plane is in XZ; 90 deg about X stands it up facing +-Z, 90 about Z facing +-X
  face('wall-z0', colors.wall, [cx, cy, z0], [90, 0, 0], [sx, 1, sy]);
  face('wall-z1', colors.wall, [cx, cy, z1], [90, 0, 0], [sx, 1, sy]);
  face('wall-x0', colors.wall, [x0, cy, cz], [0, 0, 90], [sy, 1, sz]);
  face('wall-x1', colors.wall, [x1, cy, cz], [0, 0, 90], [sy, 1, sz]);
  ctx.app.root.insertChild(root, 0);
  ctx.backdrop = root;
  return root;
}

// Test views: shows or hides the backdrop and sets the clear colour (sRGB 0..1); omitted fields stay as they are.
export function setViewDebug(ctx, { backdrop, clear } = {}) {
  if (typeof backdrop === 'boolean' && ctx.backdrop) ctx.backdrop.enabled = backdrop;
  if (Array.isArray(clear)) ctx.camera.camera.clearColor = new pc.Color(clear[0], clear[1], clear[2]);
}

export function applyPose(ctx, { x, y, z, yaw, pitch }) {
  ctx.camera.setPosition(x, y, z);
  ctx.camera.setEulerAngles(pitch, yaw, 0);
  ctx.material.setParameter('uCam', toShader([x, y, z]));
}

export function setHighlight(ctx, { pos, radius, amount }) {
  ctx.material.setParameter('uHiPos', toShader(pos));
  ctx.material.setParameter('uHiR', radius);
  ctx.material.setParameter('uHiAmt', amount);
}

export function worldToScreen(ctx, [x, y, z]) {
  const cam = ctx.camera;
  const p = cam.getPosition();
  const f = cam.forward, r = cam.right, u = cam.up;
  const vx = x - p.x, vy = y - p.y, vz = z - p.z;
  const zc = vx * f.x + vy * f.y + vz * f.z;
  const xc = vx * r.x + vy * r.y + vz * r.z;
  const yc = vx * u.x + vy * u.y + vz * u.z;
  const cw = ctx.canvas.clientWidth || 1, ch = ctx.canvas.clientHeight || 1;
  const rect = cam.camera.rect;
  const aspect = (cw * rect.z) / (ch * rect.w);
  const t = Math.tan((cam.camera.fov * Math.PI) / 360);
  let ndcX, ndcY;
  if (cam.camera.horizontalFov) { ndcX = xc / (zc * t); ndcY = (yc * aspect) / (zc * t); }
  else { ndcX = xc / (zc * t * aspect); ndcY = yc / (zc * t); }
  const sx = (rect.x + (ndcX + 1) * 0.5 * rect.z) * cw;
  const sy = (1 - (rect.y + (ndcY + 1) * 0.5 * rect.w)) * ch;
  const onScreen = zc > 0 && sx >= 0 && sx <= cw && sy >= 0 && sy <= ch;
  return { x: sx, y: sy, onScreen };
}

export function cameraForward(ctx) {
  const f = ctx.camera.forward;
  return [f.x, f.y, f.z];
}
