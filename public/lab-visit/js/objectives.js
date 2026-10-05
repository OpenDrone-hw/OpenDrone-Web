// Objectives and discovery progress, pure module: no imports, no DOM. Runs in node for the unit tests.
// A machine is discovered the first time it takes focus (the visitor walked up to it and faced it) or its card opens.
// Objectives (data/objectives.json) run in order; a step is done when `need` of its items are discovered ("all": every
// item of the step, or every enabled item for items "all"). Steps already done are skipped, so the order in which the
// visitor finds things does not matter. Progress serializes to a plain object for localStorage.

export function createProgress({ items, steps }) {
  const enabledIds = items.filter((it) => it.enabled === true).map((it) => it.id);
  const enabledSet = new Set(enabledIds);
  const norm = (steps || []).map((s) => {
    const ids = s.items === 'all' ? enabledIds.slice() : (s.items || []).filter((id) => enabledSet.has(id));
    const need = s.need === 'all' ? ids.length : Math.max(1, Math.min(ids.length, Number(s.need) || 1));
    return { id: s.id, items: ids, need };
  }).filter((s) => s.items.length > 0);
  const found = [];
  let completed = false;

  const has = (id) => found.includes(id);
  const countIn = (s) => s.items.filter(has).length;
  const stepDone = (s) => countIn(s) >= s.need;
  const allDone = () => enabledIds.every(has);

  function current() {
    const i = norm.findIndex((s) => !stepDone(s));
    if (i < 0) return { index: norm.length, id: null, found: found.length, need: enabledIds.length, left: 0, done: true };
    const s = norm[i];
    return { index: i, id: s.id, found: countIn(s), need: s.need, left: s.need - countIn(s), done: false };
  }

  return {
    get total() { return enabledIds.length; },
    get count() { return found.length; },
    get completed() { return completed; },
    steps: () => norm.map((s) => ({ ...s, items: s.items.slice() })),
    found: () => found.slice(),
    has,
    current,
    // ids that would advance the current objective, in item order
    targets() {
      const c = current();
      if (c.done) return [];
      return norm[c.index].items.filter((id) => !has(id));
    },
    // returns the events this discovery causes, in order: found, step (one per objective it completes), all
    discover(id) {
      if (!enabledSet.has(id) || has(id)) return [];
      const before = norm.map(stepDone);
      found.push(id);
      const events = [{ type: 'found', id, count: found.length, total: enabledIds.length }];
      norm.forEach((s, i) => { if (!before[i] && stepDone(s)) events.push({ type: 'step', id: s.id }); });
      if (allDone() && !completed) { completed = true; events.push({ type: 'all' }); }
      return events;
    },
    serialize() { return { v: 1, found: found.slice(), completed }; },
    load(obj) {
      found.length = 0;
      if (obj && Array.isArray(obj.found)) for (const id of obj.found) if (enabledSet.has(id) && !has(id)) found.push(id);
      completed = allDone();
    },
    reset() { found.length = 0; completed = false; }
  };
}

const wrap180 = (a) => { let r = ((a + 180) % 360 + 360) % 360 - 180; if (r === -180) r = 180; return r; };

// Hint toward the next objective: among the undiscovered targets (or every undiscovered item when the current
// objective has none), the one with the shortest walk. The walk is collision.findPath from the visitor to the item's
// approach point; the arrow points at the first waypoint more than `lookAhead` u away, so it leads around tables
// instead of through them. Straight-line distance is the fallback when no path exists.
// pose: { x, z, yaw } (yaw in degrees, 0 looks toward -Z, positive turns left). Returns null when nothing is left.
// turn: degrees to turn, positive = left (the same sense as yaw). distance: walking distance in u.
export function hintFor({ progress, items, pose, collision, radius = 0.065, lookAhead = 0.12, maxPaths = 3 }) {
  const byId = new Map(items.map((it) => [it.id, it]));
  let ids = progress.targets();
  if (!ids.length) ids = items.filter((it) => it.enabled === true && !progress.has(it.id)).map((it) => it.id);
  // path searches cost a few ms each: only the maxPaths nearest targets in a straight line are walked
  const straight = (id) => { const a = byId.get(id).approach.pos; return Math.hypot(a[0] - pose.x, a[1] - pose.z); };
  ids = ids.filter((id) => byId.has(id)).sort((a, b) => straight(a) - straight(b)).slice(0, maxPaths);
  let best = null;
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) continue;
    const goal = { x: it.approach.pos[0], z: it.approach.pos[1] };
    let path = collision && collision.findPath ? collision.findPath({ x: pose.x, z: pose.z }, goal, radius) : null;
    let distance;
    if (path && path.length) {
      distance = 0;
      let px = pose.x, pz = pose.z;
      for (const p of path) { distance += Math.hypot(p.x - px, p.z - pz); px = p.x; pz = p.z; }
    } else {
      path = [goal];
      distance = Math.hypot(goal.x - pose.x, goal.z - pose.z);
    }
    if (!best || distance < best.distance) best = { id, path, distance };
  }
  if (!best) return null;
  const it = byId.get(best.id);
  let aim = null;
  for (const p of best.path) if (Math.hypot(p.x - pose.x, p.z - pose.z) > lookAhead) { aim = p; break; }
  if (!aim) aim = { x: it.anchor[0], z: it.anchor[2] };
  const bearing = Math.atan2(-(aim.x - pose.x), -(aim.z - pose.z)) * 180 / Math.PI;
  return { id: best.id, distance: best.distance, aim, turn: wrap180(bearing - pose.yaw), path: best.path };
}
