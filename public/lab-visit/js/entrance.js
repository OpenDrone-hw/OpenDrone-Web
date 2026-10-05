// Entrance for launch mode: a short non-interactive scene while the scan downloads (founder playtest 2026-10-04:
// "opening the door shouldn't be an action done by the user and the door should fill the whole frame"; 2026-10-05:
// "immersive, like the first scene of a game"). The closed entrance door is a DOM overlay (#corridor, CSS and inline
// SVG, crisp at any DPR) that covers the view edge to edge at any aspect ratio: a white interior door seen up close,
// with a casing, recessed panels, a lever handle on an escutcheon and a HighTechLab sign plate. The loading progress
// is warm light leaking through the gaps around and under the leaf, growing with the progress, plus a short label.
// Idle life: the light flickers faintly and the view breathes very slowly (both off with reduced motion).
// When the scan is in, the door opens by itself: the lever turns, the leaf swings away on its hinge, the scene fades
// in behind it (canvas opacity 0 to 1 over the first 40 % of the swing) and the casing slides past as the camera moves
// from a pose just inside the doorway (0.12 u, about 0.4 m, where the scan is clean) to the spawn. Then main.js shows
// the briefing. A click or a key once the scan is in skips to the end. Reduced motion: a 0.4 s fade instead. A load
// error shows on the door (dim red light) with a Try again button. Class prefix en-.
//
// The door (data/machines.json spawn.door) is the white door with the exit sign on the 3D printer side, between the
// filament wall and the large TV: opening x 0.555 to 0.805, plane z 1.505, 0.59 u (2.0 m) high, measured on the
// scan. Seen from either side the handle is on the east (+x, right) side, the hinges on the west (left).
// While the door is closed or opening, the splat is cut (not drawn) in the doorway and beyond the door plane, so the
// scanned closed leaf and the floaters outside the room never show; the cut is lifted at done.

const OPEN_DELAY_MS = 350, HANDLE_MS = 250, SWING_MS = 1100, MOVE_MS = 1700, FADE_MS = 400;
const INSIDE = 0.12;               // u behind the door plane: the camera's first pose, inside the scanned room
const DOOR_W = 100, DOOR_H = 230;  // the drawn assembly in em: casing 0..100 x 0..224, floor 224..230
const easeInOut = (k) => { const x = Math.min(1, Math.max(0, k)); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; };
const easeOut = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
const clamp01 = (k) => Math.min(1, Math.max(0, k));
const wrap180 = (a) => { let r = ((a + 180) % 360 + 360) % 360 - 180; if (r === -180) r = 180; return r; };

// the lever and escutcheon (viewBox in em, placed on the leaf; rose centre at 24.5, 9)
const HANDLE_SVG = `<svg class="en-handle" viewBox="0 0 30 26" aria-hidden="true">
<defs>
<linearGradient id="en-steel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8d9195"/><stop offset=".35" stop-color="#eef0f1"/><stop offset=".6" stop-color="#b9bdc1"/><stop offset="1" stop-color="#6f7378"/></linearGradient>
<linearGradient id="en-lever" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f5f6"/><stop offset=".45" stop-color="#c3c7cb"/><stop offset=".55" stop-color="#9da2a7"/><stop offset="1" stop-color="#5d6166"/></linearGradient>
<radialGradient id="en-rose" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#c4c8cc"/><stop offset="1" stop-color="#686c71"/></radialGradient>
</defs>
<rect x="22.1" y="1.4" width="4.8" height="22" rx="2.4" fill="url(#en-steel)" stroke="#5c6065" stroke-width=".18"/>
<rect x="22.6" y="1.9" width="3.8" height="21" rx="1.9" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width=".15"/>
<rect x="23.85" y="16.2" width="1.3" height="3" rx=".65" fill="#2a2c2f"/><circle cx="24.5" cy="16.4" r=".9" fill="#2a2c2f"/>
<g class="en-lever">
<circle cx="24.5" cy="9" r="2.5" fill="url(#en-rose)" stroke="#5c6065" stroke-width=".15"/>
<path d="M25.4 7.7 L12.2 7.9 Q10.4 8 10.4 9.5 Q10.4 11.1 12.2 11.1 L25.4 10.4 Z" fill="url(#en-lever)" stroke="#55595e" stroke-width=".15"/>
<path d="M24.6 8.1 L12.4 8.35" stroke="#fff" stroke-opacity=".8" stroke-width=".22" stroke-linecap="round"/>
<circle cx="24.5" cy="9" r="1.2" fill="url(#en-rose)"/>
</g>
</svg>`;

export function createEntrance({
  t,
  reducedMotion = false,
  geometry,          // { door: { x0, x1, z, height }, spawn: { pos, yawDeg, pitchDeg }, floorY, eye }
  labelRoot,         // DOM parent for the door and the label (#corridor)
  fadeEl = null,     // #fade, for reduced motion
  tipEl = null,      // #loading-tip: the rotating tips of the visitor's device, under the label while loading
  onOpen = () => {}, // the door starts to open: main.js shows the splat
  onDone = () => {}, // the camera stands at the spawn: main.js shows the briefing
  onRetry = () => {}
}) {
  const d = geometry.door, floorY = geometry.floorY, eye = geometry.eye, H = d.height;
  const cx = (d.x0 + d.x1) / 2;
  const phases = [];
  let phase = null;
  const setPhase = (p) => { phase = p; if (labelRoot) labelRoot.dataset.phase = p; phases.push(p); };
  let ctx = null, canvas = null;
  let progress = 0, swing = 0, cutReady = false;
  let opening = null, readyAt = 0;
  // the first pose: just inside the doorway, eye height, looking into the room (-z)
  let pose = { x: cx, y: floorY + eye, z: d.z - INSIDE, yaw: 0, pitch: 0 };

  // ---------- DOM: the door and the label ----------
  const view = document.createElement('div');
  view.className = 'en-view';
  view.innerHTML = `<div class="en-door">
<div class="en-floor"></div>
<div class="en-casing"></div>
<div class="en-open"><div class="en-light"></div><div class="en-leaf">
<div class="en-panel en-panel-a"></div><div class="en-panel en-panel-b"></div>
<div class="en-sign"><span>HighTechLab</span></div>${HANDLE_SVG}<div class="en-sheen"></div>
</div></div>
<div class="en-glow"></div><div class="en-spill"></div>
</div><div class="en-vignette"></div>`;
  const door = view.querySelector('.en-door');
  const leaf = view.querySelector('.en-leaf');
  const lever = view.querySelector('.en-lever');
  const label = document.createElement('div');
  label.className = 'en-label';
  const text = document.createElement('div');
  text.className = 'en-text';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'en-retry';
  retry.textContent = t('error.retry');
  retry.hidden = true;
  retry.addEventListener('click', () => { if (phase === 'error') onRetry(); });
  label.append(text, retry);
  if (tipEl) label.append(tipEl);
  if (labelRoot) { labelRoot.classList.toggle('en-calm', reducedMotion); labelRoot.append(view, label); }

  // the door covers the view (cover, like CSS object-fit): 1 em = one door unit (about 1 cm). Nearly the whole door
  // fits (portrait): stand on the floor line. Landscape crops hard: keep the sign plate and the handle in view.
  let lastW = -1, lastH = -1;
  function layout() {
    const w = labelRoot ? labelRoot.clientWidth : 0, h = labelRoot ? labelRoot.clientHeight : 0;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    if (!w || !h) return;
    const u = Math.max(w / DOOR_W, h / DOOR_H);
    const total = DOOR_H * u, minTop = h - total;
    const top = -minTop < 0.15 * total ? minTop : Math.min(0, Math.max(minTop, h / 2 - 102 * u));
    door.style.fontSize = u + 'px';
    door.style.left = (w - DOOR_W * u) / 2 + 'px';
    door.style.top = top + 'px';
    door.style.transformOrigin = `${(DOOR_W * u) / 2}px ${h / 2 - top}px`;
  }

  // ---------- scene ----------
  function attach(c) {
    ctx = c;
    canvas = ctx.canvas || null;
    if (canvas) canvas.style.opacity = '0';
    layout();
    setProgress(progress);
    applyCam();
    ctx.app.on('update', tick);
  }

  // the splat cut (see the header): patches the gsplatModifyVS chunk of js/scene.js at runtime and leaves it alone if
  // the chunk is not the expected one
  function prepareCut() {
    if (!ctx || !ctx.material || cutReady) return;
    const mat = ctx.material;
    const glsl = !ctx.device.isWebGPU;
    const chunks = mat.getShaderChunks(glsl ? 'glsl' : 'wgsl');
    const src = chunks.get('gsplatModifyVS');
    if (typeof src !== 'string') return;
    const g0 = 's *= smoothstep(uNear * 0.5, uNear, distance(c, uCam));';
    const w0 = '*s = *s * smoothstep(uniform.uNear * 0.5, uniform.uNear, distance(c, uniform.uCam));';
    let out = null;
    if (glsl && src.includes(g0)) {
      out = 'uniform vec3 uCutMin; uniform vec3 uCutMax; uniform float uCutZ; uniform float uCutAmt;\n' + src.replace(g0,
        g0 + '\n  vec3 inB = step(uCutMin, c) * step(c, uCutMax);\n  s *= 1.0 - uCutAmt * max(inB.x * inB.y * inB.z, step(uCutZ, c.z));');
    } else if (!glsl && src.includes(w0)) {
      out = 'uniform uCutMin: vec3f; uniform uCutMax: vec3f; uniform uCutZ: f32; uniform uCutAmt: f32;\n' + src.replace(w0,
        w0 + '\n  let inB = step(uniform.uCutMin, c) * step(c, uniform.uCutMax);\n  *s = *s * (1.0 - uniform.uCutAmt * max(inB.x * inB.y * inB.z, step(uniform.uCutZ, c.z)));');
    }
    if (!out) return;
    chunks.set('gsplatModifyVS', out);
    mat.setParameter('uCutMin', [d.x0 - 0.004, floorY - 0.05, d.z - 0.06]);
    mat.setParameter('uCutMax', [d.x1 + 0.004, floorY + H + 0.01, d.z + 1.0]);
    mat.setParameter('uCutZ', d.z + 0.05);
    mat.setParameter('uCutAmt', 1);
    mat.update();
    cutReady = true;
  }

  function setProgress(percent) {
    progress = Math.max(0, Math.min(100, percent));
    // a little light from the start, so the gaps read as gaps; full light at 100 %
    view.style.setProperty('--p', (0.12 + 0.88 * (progress / 100)).toFixed(3));
    if (phase === 'loading') text.textContent = t('load.progress', { percent: progress });
  }

  function applyCam() {
    if (!ctx) return;
    ctx.camera.setPosition(pose.x, pose.y, pose.z);
    ctx.camera.setEulerAngles(pose.pitch, pose.yaw, 0);
    if (ctx.material) ctx.material.setParameter('uCam', [pose.x, pose.y, pose.z]);
  }

  // ---------- loop (the PlayCanvas update event) ----------
  function tick() {
    if (phase === 'done' || !ctx) return;
    const now = performance.now();
    if (opening) { stepOpening(now); applyCam(); return; }
    layout();
    if (phase === 'ready' && now - readyAt >= OPEN_DELAY_MS) startOpening();
    applyCam();
  }

  function startOpening() {
    setPhase('opening');
    onOpen();
    const sp = geometry.spawn;
    opening = { t0: performance.now(), from: { ...pose }, to: { x: sp.pos[0], y: floorY + eye, z: sp.pos[1], yaw: sp.yawDeg, pitch: sp.pitchDeg } };
    text.textContent = '';
    label.hidden = true;
    if (reducedMotion && fadeEl) {
      fadeEl.style.transitionDuration = FADE_MS + 'ms';
      fadeEl.hidden = false;
      void fadeEl.offsetWidth;
      fadeEl.classList.add('sh-fade-on');
    }
    window.addEventListener('keydown', skip, true);
    window.addEventListener('pointerdown', skip, true);
  }
  function skip(e) {
    if (!opening) return;
    if (e) { e.preventDefault(); e.stopPropagation(); }
    pose = { ...opening.to };
    finish();
  }

  function stepOpening(now) {
    const el = now - opening.t0;
    const a = opening.from, b = opening.to;
    if (reducedMotion) {
      if (el >= FADE_MS) {
        pose = { ...b };
        finish();
        if (fadeEl) { fadeEl.classList.remove('sh-fade-on'); setTimeout(() => { fadeEl.hidden = true; }, FADE_MS); }
      }
      return;
    }
    // the lever turns, then the leaf swings away to 100 deg
    const sw = (el - HANDLE_MS) / SWING_MS;
    const lv = el < HANDLE_MS + SWING_MS * 0.4 ? 35 * clamp01(el / HANDLE_MS) : 0;
    lever.setAttribute('transform', `rotate(${lv.toFixed(1)} 24.5 9)`);
    swing = 100 * easeOut(sw);
    leaf.style.transform = `rotateY(${swing.toFixed(2)}deg)`;
    // the scene fades in over the first 40 % of the swing; the door and casing slide past as the camera moves in
    if (canvas) canvas.style.opacity = clamp01(sw / 0.4).toFixed(3);
    const k = easeInOut((el - HANDLE_MS) / MOVE_MS);
    door.style.transform = `scale(${(1 + 1.6 * k * k).toFixed(4)})`;
    door.style.opacity = (1 - clamp01((k - 0.35) / 0.4)).toFixed(3);
    view.style.setProperty('--fadeout', clamp01(sw / 0.5).toFixed(3));
    pose.x = a.x + (b.x - a.x) * k; pose.y = a.y + (b.y - a.y) * k; pose.z = a.z + (b.z - a.z) * k;
    pose.yaw = wrap180(b.yaw) * k; pose.pitch = b.pitch * k;
    if (el >= HANDLE_MS + MOVE_MS) { pose = { ...b }; finish(); }
  }

  function finish() {
    if (phase === 'done') return;
    opening = null;
    window.removeEventListener('keydown', skip, true);
    window.removeEventListener('pointerdown', skip, true);
    setPhase('done');
    if (cutReady) ctx.material.setParameter('uCutAmt', 0);
    if (canvas) canvas.style.opacity = '';
    applyCam();
    if (ctx) ctx.app.off('update', tick);
    view.remove();
    label.remove();
    onDone();
  }

  // ---------- api ----------
  function begin() {
    setPhase('loading');
    label.hidden = false;
    retry.hidden = true;
    setProgress(0);
  }
  // the scan is in (hidden by main.js): full light, then the door opens by itself
  function ready() {
    if (phase !== 'loading' && phase !== 'error') return;
    prepareCut();
    setProgress(100);
    setPhase('ready');
    text.textContent = t('entrance.ready');
    readyAt = performance.now();
  }
  function showError(message) {
    setPhase('error');
    text.textContent = message;
    retry.hidden = false;
    label.hidden = false;
  }

  // true while the closed door covers the whole view (for the tests)
  function covers() {
    if (!ctx || !labelRoot || !['loading', 'ready', 'error'].includes(phase) || labelRoot.hidden) return false;
    const r = door.getBoundingClientRect(), v = labelRoot.getBoundingClientRect();
    return r.left <= v.left + 0.5 && r.top <= v.top + 0.5 && r.right >= v.right - 0.5 && r.bottom >= v.bottom - 0.5;
  }

  return {
    attach, begin, ready, showError, setProgress, skip: () => skip(null),
    phase: () => phase,
    phases: () => phases.slice(),
    pose: () => ({ ...pose }),
    swing: () => swing,
    cut: () => cutReady,
    covers
  };
}
