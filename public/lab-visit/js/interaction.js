// Interaction selector (owner: interaction, SPEC.md section 4). Pure module: no imports, no DOM.
//
// Decisions where the spec leaves room (simplest option chosen):
// - The bearing yaw uses the same convention as controller.js yawPitchTo: yaw = atan2(-dx, -dz) in degrees.
//   It is reimplemented here because this module may not import anything.
// - When the horizontal distance to an anchor is below 1e-9 the gaze angle counts as 0.
// - A focus switch from item A directly to item B keeps the highlight amount and moves the highlight
//   position to B; only a change to or from "no focus" fades.
// - hold(id) with an unknown id behaves like hold(null). hold wins over update(..., { enabled: false }).
//   Releasing a hold keeps the held item as the current focus, then the normal rules apply.
// - FocusState.distance and angleDeg are null when there is no focus; while held they are measured
//   against the held item.

export const INTERACTION_DEFAULTS = {
  gazeHalfAngle: 40,
  exitFactor: 1.15,
  exitAngle: 50,
  switchMargin: 0.1,
  fadeS: 0.2,
  highlightAmount: 1.0
};

const DEG = 180 / Math.PI;
const NOWHERE = [0, -100, 0];
const DEFAULT_RADIUS = 0.14;

export function wrap180(a) {
  let r = (((a + 180) % 360) + 360) % 360 - 180; // [-180, 180)
  if (r === -180) r = 180;                        // (-180, 180]
  return r;
}

function measure(item, pose, cfg) {
  const dx = item.anchor[0] - pose.x;
  const dz = item.anchor[2] - pose.z;
  const distance = Math.hypot(dx, dz);
  let angleDeg = 0;
  if (distance >= 1e-9) {
    const bearing = Math.atan2(-dx, -dz) * DEG;
    angleDeg = Math.abs(wrap180(bearing - (pose.yaw || 0)));
  }
  const R = item.interactRadius;
  const inRange = distance <= R && angleDeg <= cfg.gazeHalfAngle;
  const score = distance / R + angleDeg / cfg.gazeHalfAngle;
  return { id: item.id, distance, angleDeg, score, inRange };
}

export function createSelector(items, cfg = {}) {
  const c = { ...INTERACTION_DEFAULTS, ...cfg };
  const list = (items || []).filter((it) => it && it.enabled === true);
  const byId = new Map(list.map((it) => [it.id, it]));

  let current = null;   // focused item object
  let held = null;      // held item object
  let lastId = null;    // id returned by the previous update
  let amount = 0;       // 0..1 before highlightAmount scaling
  let hiPos = NOWHERE.slice();
  let hiRadius = DEFAULT_RADIUS;

  function setHighlightItem(it) {
    hiPos = [it.anchor[0], it.anchor[1], it.anchor[2]];
    hiRadius = typeof it.highlightRadius === 'number' ? it.highlightRadius : DEFAULT_RADIUS;
  }

  function choose(pose) {
    let best = null;
    let curM = null;
    for (const it of list) {
      const m = measure(it, pose, c);
      if (current && it === current) curM = m;
      if (m.inRange && (!best || m.score < best.m.score)) best = { it, m };
    }
    if (current && curM) {
      const R = current.interactRadius;
      const keep = curM.distance <= R * c.exitFactor && curM.angleDeg <= c.exitAngle;
      if (keep && !(best && best.it !== current && best.m.score < curM.score - c.switchMargin)) {
        return { it: current, m: curM };
      }
    }
    return best;
  }

  function fade(target, dt) {
    const step = c.fadeS > 0 ? Math.max(0, dt) / c.fadeS : 1;
    if (amount < target) amount = Math.min(target, amount + step);
    else if (amount > target) amount = Math.max(target, amount - step);
    if (Math.abs(amount - target) < 1e-6) amount = target;
  }

  function state(m, changed) {
    return {
      id: current ? current.id : null,
      distance: m ? m.distance : null,
      angleDeg: m ? m.angleDeg : null,
      inRange: m ? m.inRange : false,
      changed,
      highlight: { pos: hiPos.slice(), radius: hiRadius, amount: amount * c.highlightAmount }
    };
  }

  return {
    update(pose, dt, { enabled = true } = {}) {
      let m = null;
      if (held) {
        current = held;
        m = measure(held, pose, c);
        amount = 1;
      } else if (!enabled) {
        current = null;
        fade(0, dt);
      } else {
        const pick = choose(pose);
        current = pick ? pick.it : null;
        m = pick ? pick.m : null;
        fade(current ? 1 : 0, dt);
      }
      if (current) setHighlightItem(current);
      const id = current ? current.id : null;
      const changed = id !== lastId;
      lastId = id;
      return state(m, changed);
    },

    candidates(pose) {
      return list
        .map((it) => measure(it, pose, c))
        .sort((a, b) => a.score - b.score) // Array.prototype.sort is stable: ties keep data order
        .map(({ id, distance, angleDeg, score, inRange }) => ({ id, distance, angleDeg, score, inRange }));
    },

    get focusedId() {
      return held ? held.id : current ? current.id : null;
    },

    hold(id) {
      const it = id == null ? null : byId.get(id) || null;
      if (it) {
        held = it;
        current = it;
        amount = 1;
        setHighlightItem(it);
      } else {
        held = null;
      }
    },

    reset() {
      current = null;
      held = null;
      lastId = null;
      amount = 0;
      hiPos = NOWHERE.slice();
      hiRadius = DEFAULT_RADIUS;
    }
  };
}
