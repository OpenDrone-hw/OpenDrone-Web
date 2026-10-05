// First-person controller, pure module (SPEC.md section 3). No imports, no DOM, no PlayCanvas.
// Decisions where the spec is silent:
// - The controller starts at x 0, z 0, yaw 0, pitch 0; the shell places it with teleport().
// - cfg.reducedMotion (extra key, default false): when true, run is ignored so the view never moves
//   faster than walking pace. Smoothing, eye height and look behave as specified.
// - teleport() also sets yaw and pitch (pitch clamped); undefined yaw or pitch keeps the current value.

export const CONTROLLER_DEFAULTS = Object.freeze({
  eyeHeight: 0.46,
  radius: 0.065,
  walkSpeed: 0.41,
  runSpeed: 0.67,
  accelTau: 0.12,
  decelTau: 0.07,
  substep: 1 / 120,
  maxSubsteps: 16,
  pitchMin: -75,
  pitchMax: 60,
  turnRate: 90,
  mouseLook: 0.15,
  touchLook: 0.20,
  reducedMotion: false
});

const DEG = Math.PI / 180;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function yawPitchTo(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const yaw = Math.atan2(-dx, -dz) / DEG;
  const pitch = Math.atan2(dy, Math.hypot(dx, dz)) / DEG;
  // atan2(-0, -0) gives -180; a zero-length horizontal offset keeps yaw 0.
  return { yaw: dx === 0 && dz === 0 ? 0 : yaw + 0, pitch: pitch + 0 };
}

export function forwardOf(yaw, pitch) {
  const y = yaw * DEG;
  const p = pitch * DEG;
  return [-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}

export function createController(collision, cfg = {}) {
  const c = { ...CONTROLLER_DEFAULTS, ...cfg };
  let x = 0;
  let z = 0;
  let yaw = 0;
  let pitch = 0;
  let vx = 0;
  let vz = 0;
  let blocked = false;
  let frozen = false;

  const eyeY = () => collision.floorHeightAt(x, z) + c.eyeHeight;

  function wrapYaw(a) {
    // keep yaw bounded, (-180, 180]
    let w = ((a + 180) % 360 + 360) % 360 - 180;
    if (w === -180) w = 180;
    return w;
  }

  function applyLook(look) {
    if (!look) return;
    const dy = num(look[0]);
    const dp = num(look[1]);
    if (dy !== 0) yaw = wrapYaw(yaw + dy);
    pitch = clamp(pitch + dp, c.pitchMin, c.pitchMax);
  }

  function substepOnce(h, mx, mz, speed) {
    const s = Math.sin(yaw * DEG);
    const co = Math.cos(yaw * DEG);
    // right = [cos, 0, -sin], forwardH = [-sin, 0, -cos]
    const tx = (co * mx - s * mz) * speed;
    const tz = (-s * mx - co * mz) * speed;
    const hasTarget = tx !== 0 || tz !== 0;
    const tau = hasTarget ? c.accelTau : c.decelTau;
    const k = 1 - Math.exp(-h / tau);
    vx += (tx - vx) * k;
    vz += (tz - vz) * k;
    if (!hasTarget && Math.hypot(vx, vz) < 1e-6) { vx = 0; vz = 0; }
    if (vx === 0 && vz === 0) { blocked = false; return; }
    const r = collision.move({ x, z }, { x: vx * h, z: vz * h }, c.radius);
    x = r.x;
    z = r.z;
    blocked = !!r.blocked;
    if (r.normal) {
      const d = vx * r.normal[0] + vz * r.normal[1];
      if (d < 0) {
        vx -= r.normal[0] * d;
        vz -= r.normal[1] * d;
      }
    }
  }

  const api = {
    get state() {
      return { x, y: eyeY(), z, yaw, pitch, vx, vz, speed: Math.hypot(vx, vz), blocked };
    },
    get cfg() {
      return c;
    },
    step(intent = {}, dt = 0) {
      intent = intent || {};
      applyLook(intent.look);
      dt = num(dt);
      if (dt <= 0) return api.state;
      let mx = 0;
      let mz = 0;
      if (!frozen && intent.move) {
        mx = num(intent.move[0]);
        mz = num(intent.move[1]);
        const len = Math.hypot(mx, mz);
        if (len > 1) { mx /= len; mz /= len; }
      }
      const run = !frozen && !c.reducedMotion && !!intent.run;
      const speed = run ? c.runSpeed : c.walkSpeed;
      if (frozen) { vx = 0; vz = 0; blocked = false; return api.state; }
      let n = Math.ceil(dt / c.substep - 1e-9);
      let h = dt / n;
      if (n > c.maxSubsteps) { n = c.maxSubsteps; h = c.substep; }
      for (let i = 0; i < n; i++) substepOnce(h, mx, mz, speed);
      return api.state;
    },
    teleport(tx, tz, tyaw, tpitch) {
      const p = collision.nearestWalkable(tx, tz, c.radius, 1.0);
      let snapped = false;
      if (p) {
        snapped = Math.abs(p.x - tx) > 1e-12 || Math.abs(p.z - tz) > 1e-12;
        x = p.x;
        z = p.z;
      }
      if (typeof tyaw === 'number' && Number.isFinite(tyaw)) yaw = wrapYaw(tyaw);
      if (typeof tpitch === 'number' && Number.isFinite(tpitch)) pitch = clamp(tpitch, c.pitchMin, c.pitchMax);
      vx = 0;
      vz = 0;
      blocked = false;
      return { x, z, snapped };
    },
    lookAt(target) {
      const r = yawPitchTo([x, eyeY(), z], target);
      yaw = wrapYaw(r.yaw);
      pitch = clamp(r.pitch, c.pitchMin, c.pitchMax);
      return api.state;
    },
    setFrozen(v) {
      frozen = !!v;
      if (frozen) { vx = 0; vz = 0; blocked = false; }
    },
    forward() {
      return forwardOf(yaw, pitch);
    },
    setEyeHeight(u) {
      if (typeof u === 'number' && Number.isFinite(u)) c.eyeHeight = u;
    }
  };
  return api;
}
