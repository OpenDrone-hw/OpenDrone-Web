// Input for the first-person controller (SPEC.md 3.4). Uses the DOM, never imports PlayCanvas.
// Decisions where the spec is silent:
// - Look, desktop: a click on the view (a press that moves less than CLICK_SLOP px) captures the mouse with Pointer
//   Lock, as in games; the mouse then turns the view without a button held (a click is read().click) and Escape
//   frees the mouse (the browser does that itself). Until the click, and wherever Pointer Lock is missing or refused
//   (pointerlockerror, an iframe sandbox without allow-pointer-lock), dragging with the left button looks around.
//   main.js allows the capture only while the visitor walks around (setLockAllowed), and frees the mouse when a card,
//   the list or another panel opens. When the visitor frees the mouse with Escape, read().lockLost is set once, so
//   main.js can open the pause menu (the usual game behaviour); a release by setLockAllowed(false) does not set it.
// - H asks for a hint (read().hint).
// - The touch stick floats: it re-centres under the thumb where the touch starts inside #stick-zone.
// - Movement keys use KeyboardEvent.code (W A S D by position, so AZERTY works); arrows use key.
// - Enter and M are ignored when they come from a button, link or text field, so activating a focused button
//   with Enter does not also trigger interact. E is ignored only in text fields: it activates no control.
// - Reduced motion (prefers-reduced-motion or cfg.reducedMotion) halves the keyboard turn and pitch rates.
// - R and Page Up look up, F and Page Down look down, at turnRate like the arrow turn keys, so a keyboard-only
//   visitor can look down at a machine (review finding: the anchors sit 30 to 54 deg below eye level).
// - read() also returns pitching: true while the visitor drags the view or holds a pitch key. main.js uses it to
//   stop the automatic tilt toward a focused machine as soon as the visitor aims the view themselves.
// - #stick-zone gets the class ct-zone and the canvas gets ct-look so controller.css can style them.
// - Touch (founder 2026-10-04: "make sure mobile experience is as good as desktop"): the stick has a dead zone of
//   STICK_DEAD of its travel and a linear response after it; touch look accelerates with the drag speed, up to
//   1 + TOUCH_ACCEL times the base rate at 1.5 px/ms and faster, so a slow drag aims finely and a flick turns around.
//   A look drag can start anywhere on the view outside the stick zone (the stick zone takes its own touches), so the
//   stick and the look drag work at the same time with two thumbs.

const MOVE_CODES = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l',
  KeyD: 'r',
  ArrowLeft: 'tl',
  ArrowRight: 'tr',
  KeyR: 'pu', PageUp: 'pu',
  KeyF: 'pd', PageDown: 'pd'
};
const PAGE_KEYS = new Set(['PageUp', 'PageDown']);
const STICK_MAX = 48;
const CLICK_SLOP = 6; // px: a press that moves less than this is a click, not a drag
const STICK_DEAD = 0.12; // fraction of the stick travel that does not move
const TOUCH_ACCEL = 0.8;

function isEditable(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
function isActivatable(t) {
  if (!t || !t.tagName) return false;
  return t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY' || isEditable(t);
}

export function createInput({ canvas, stickZone, cfg }) {
  const win = globalThis.window;
  const doc = globalThis.document;
  const mq = (q) => { try { return win.matchMedia(q).matches; } catch { return false; } };
  const isTouch = mq('(pointer: coarse)') || 'ontouchstart' in win;
  const reducedMotion = !!cfg.reducedMotion || mq('(prefers-reduced-motion: reduce)');
  const turnRate = cfg.turnRate * (reducedMotion ? 0.5 : 1);

  const held = new Set();
  let shift = false;
  let edges = { interact: false, menu: false, back: false, hint: false, click: false, lockLost: false };
  let lookAcc = [0, 0];
  let enabled = { move: true, look: true, keys: true };
  let override = null;

  // drag look, one pointer at a time
  let lookPointer = null;
  let lastX = 0;
  let lastY = 0;
  let lookSens = cfg.mouseLook;
  let dragDist = 0;
  let lastMoveAt = 0;
  let lookedUpDown = false; // pointer-locked mouse moved vertically since the last read

  // pointer lock
  const lockApi = !isTouch && typeof canvas.requestPointerLock === 'function' && 'pointerLockElement' in doc;
  let lockAllowed = false;
  let lockFailed = false;
  let lockPending = false;
  let lockWorked = false;  // a capture succeeded once: later refusals (the browser's cool-down after Escape) are not fatal
  let selfRelease = false; // the mouse was freed by setLockAllowed(false), not by the visitor (Escape)
  const isLocked = () => lockApi && doc.pointerLockElement === canvas;

  // stick
  let stickPointer = null;
  let stickCx = 0;
  let stickCy = 0;
  let stickMove = [0, 0];
  let stickEl = null;
  let knobEl = null;

  canvas.classList.add('ct-look');
  if (stickZone) {
    stickZone.classList.add('ct-zone');
    stickEl = doc.createElement('div');
    stickEl.className = 'ct-stick';
    knobEl = doc.createElement('div');
    knobEl.className = 'ct-knob';
    stickEl.appendChild(knobEl);
    stickZone.replaceChildren(stickEl);
    if (isTouch) stickZone.classList.add('ct-on');
  }

  const listeners = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push(() => target.removeEventListener(type, fn, opts));
  };

  function clearKeys() {
    held.clear();
    shift = false;
  }
  function resetStick() {
    stickPointer = null;
    stickMove = [0, 0];
    if (knobEl) knobEl.style.transform = '';
    if (stickEl) {
      stickEl.style.left = '';
      stickEl.style.top = '';
      stickEl.classList.remove('ct-active');
    }
  }
  function endLook() {
    if (lookPointer !== null) {
      try { canvas.releasePointerCapture(lookPointer); } catch { /* already released */ }
    }
    lookPointer = null;
    canvas.classList.remove('ct-dragging');
  }

  // keyboard
  on(win, 'keydown', (e) => {
    if (!enabled.keys || isEditable(e.target)) return;
    if (e.key === 'Shift') shift = true;
    const k = MOVE_CODES[e.code] || MOVE_CODES[e.key];
    const active = doc.activeElement;
    const focusOk = !active || active === doc.body || active === canvas || active === doc.documentElement;
    if (k) {
      held.add(k);
      if (focusOk && (e.key.startsWith('Arrow') || PAGE_KEYS.has(e.key))) e.preventDefault();
    }
    if (e.code === 'Space' && focusOk) e.preventDefault();
    if (e.repeat) return;
    if (e.key === 'Escape') { edges.back = true; return; }
    if (e.code === 'KeyH') { edges.hint = true; return; }
    if (isActivatable(e.target)) return;
    if (e.key === 'Enter') edges.interact = true;
    else if (e.code === 'KeyM') edges.menu = true;
  }, { passive: false });
  on(win, 'keyup', (e) => {
    if (e.key === 'Shift') shift = false;
    const k = MOVE_CODES[e.code] || MOVE_CODES[e.key];
    if (k) held.delete(k);
  });
  on(win, 'blur', () => { clearKeys(); resetStick(); endLook(); });
  if (lockApi) {
    on(doc, 'pointerlockchange', () => {
      lockPending = false;
      canvas.classList.toggle('ct-locked', isLocked());
      if (isLocked()) { endLook(); lockWorked = true; }
      else if (!selfRelease) edges.lockLost = true; // Escape freed the mouse: main.js pauses
      selfRelease = false;
    });
    on(doc, 'pointerlockerror', () => { lockPending = false; if (!lockWorked) lockFailed = true; });
    on(doc, 'mousemove', (e) => {
      if (!isLocked() || !enabled.look) return;
      const dx = e.movementX || 0, dy = e.movementY || 0;
      lookAcc[0] -= dx * cfg.mouseLook;
      lookAcc[1] -= dy * cfg.mouseLook;
      if (dy) lookedUpDown = true;
    });
  }
  function requestLock() {
    if (!lockApi || lockFailed || lockPending || !lockAllowed || isLocked()) return;
    lockPending = true;
    try {
      const r = canvas.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => { lockPending = false; if (!lockWorked) lockFailed = true; });
    } catch (err) { lockPending = false; if (!lockWorked) lockFailed = true; }
  }
  on(doc, 'visibilitychange', () => { if (doc.hidden) { clearKeys(); resetStick(); endLook(); } });

  // look: mouse or pen primary-button drag anywhere on the canvas, touch drag on the right 60%
  on(canvas, 'pointerdown', (e) => {
    if (isLocked()) {
      // captured mouse: a left click is an edge, not a look drag
      if (e.button === 0) edges.click = true;
      return;
    }
    if (lookPointer !== null || !enabled.look) return;
    if (e.pointerType === 'touch') {
      lookSens = cfg.touchLook;
      lastMoveAt = e.timeStamp || 0;
    } else {
      if (e.button !== 0) return;
      lookSens = cfg.mouseLook;
    }
    lookPointer = e.pointerId;
    dragDist = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    canvas.classList.add('ct-dragging');
    if (e.pointerType !== 'touch') {
      try { canvas.focus({ preventScroll: true }); } catch { /* old browsers */ }
    }
  });
  on(canvas, 'pointermove', (e) => {
    if (e.pointerId !== lookPointer) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const d = Math.hypot(dx, dy);
    dragDist += d;
    if (!enabled.look) return;
    let gain = 1;
    if (e.pointerType === 'touch') {
      const ts = e.timeStamp || 0, dtm = Math.max(1, ts - lastMoveAt);
      lastMoveAt = ts;
      gain = 1 + TOUCH_ACCEL * Math.min(1, d / dtm / 1.5);
    }
    lookAcc[0] -= dx * lookSens * gain; // drag right turns right (yaw decreases)
    lookAcc[1] -= dy * lookSens * gain; // drag up looks up
  });
  const lookEnd = (e) => { if (e.pointerId === lookPointer) endLook(); };
  on(canvas, 'pointerup', (e) => {
    if (e.pointerId !== lookPointer) return;
    const click = e.pointerType !== 'touch' && dragDist < CLICK_SLOP;
    endLook();
    if (click) requestLock();
  });
  on(canvas, 'pointercancel', lookEnd);
  on(canvas, 'lostpointercapture', lookEnd);
  on(canvas, 'contextmenu', (e) => e.preventDefault());

  // stick
  if (stickZone && isTouch) {
    const setKnob = (dx, dy) => {
      const len = Math.hypot(dx, dy);
      const s = len > STICK_MAX ? STICK_MAX / len : 1;
      const kx = dx * s;
      const ky = dy * s;
      knobEl.style.transform = `translate(${kx}px, ${ky}px)`;
      const n = Math.hypot(kx, ky) / STICK_MAX;
      const k = n <= STICK_DEAD ? 0 : (n - STICK_DEAD) / (1 - STICK_DEAD) / n;
      stickMove = [(kx / STICK_MAX) * k, (-ky / STICK_MAX) * k];
    };
    on(stickZone, 'pointerdown', (e) => {
      if (stickPointer !== null) return;
      e.preventDefault();
      stickPointer = e.pointerId;
      const rect = stickZone.getBoundingClientRect();
      stickCx = e.clientX;
      stickCy = e.clientY;
      stickEl.style.left = `${e.clientX - rect.left}px`;
      stickEl.style.top = `${e.clientY - rect.top}px`;
      stickEl.classList.add('ct-active');
      try { stickZone.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      setKnob(0, 0);
    });
    on(stickZone, 'pointermove', (e) => {
      if (e.pointerId !== stickPointer) return;
      setKnob(e.clientX - stickCx, e.clientY - stickCy);
    });
    const stickEnd = (e) => { if (e.pointerId === stickPointer) resetStick(); };
    on(stickZone, 'pointerup', stickEnd);
    on(stickZone, 'pointercancel', stickEnd);
    on(stickZone, 'lostpointercapture', stickEnd);
  }

  function zero() {
    return { move: [0, 0], look: [0, 0], run: false, interact: false, menu: false, back: false, hint: false, click: false, lockLost: false, pitching: false };
  }

  return {
    isTouch,
    reducedMotion,
    lockSupported: lockApi,
    get locked() { return isLocked(); },
    get lockFailed() { return lockFailed; },
    // main.js: true while walking around; false frees a captured mouse and stops a click from capturing it
    setLockAllowed(v) {
      lockAllowed = !!v;
      if (!lockAllowed && isLocked()) {
        selfRelease = true;
        try { doc.exitPointerLock(); } catch (err) { selfRelease = false; }
      }
    },
    // capture the mouse now; call from a click handler (the Start button), the browser needs a user gesture
    requestLock() { requestLock(); },
    read(dt = 0) {
      const look = lookAcc;
      const ed = edges;
      const upDown = lookedUpDown;
      lookAcc = [0, 0];
      lookedUpDown = false;
      edges = { interact: false, menu: false, back: false, hint: false, click: false, lockLost: false };
      if (override) return { ...zero(), ...override };
      const out = zero();
      out.interact = ed.interact;
      out.menu = ed.menu;
      out.back = ed.back;
      out.hint = ed.hint;
      out.click = ed.click;
      out.lockLost = ed.lockLost;
      if (enabled.look) {
        let turn = 0;
        let tilt = 0;
        if (enabled.keys) {
          if (held.has('tl')) turn += 1;
          if (held.has('tr')) turn -= 1;
          if (held.has('pu')) tilt += 1;
          if (held.has('pd')) tilt -= 1;
        }
        out.look = [look[0] + turn * turnRate * dt, look[1] + tilt * turnRate * dt];
        out.pitching = lookPointer !== null || upDown || look[1] !== 0 || (enabled.keys && (held.has('pu') || held.has('pd')));
      }
      if (enabled.move) {
        let mx = stickMove[0];
        let mz = stickMove[1];
        if (enabled.keys) {
          if (held.has('f')) mz += 1;
          if (held.has('b')) mz -= 1;
          if (held.has('r')) mx += 1;
          if (held.has('l')) mx -= 1;
        }
        const len = Math.hypot(mx, mz);
        if (len > 1) { mx /= len; mz /= len; }
        out.move = [mx, mz];
        out.run = enabled.keys && shift;
      }
      return out;
    },
    setEnabled(opts = {}) {
      enabled = {
        move: opts.move !== false,
        look: opts.look !== false,
        keys: opts.keys !== false
      };
      if (!enabled.keys) clearKeys();
      if (!enabled.move) resetStick();
      if (!enabled.look) { endLook(); lookAcc = [0, 0]; }
    },
    releaseAll() {
      clearKeys();
      resetStick();
      endLook();
      lookAcc = [0, 0];
    },
    setOverride(partial) {
      override = partial ? { ...partial } : null;
    },
    dispose() {
      for (const off of listeners.splice(0)) off();
      endLook();
      resetStick();
      clearKeys();
      canvas.classList.remove('ct-look', 'ct-dragging', 'ct-locked');
      if (stickZone) {
        stickZone.replaceChildren();
        stickZone.classList.remove('ct-zone', 'ct-on');
      }
    }
  };
}
