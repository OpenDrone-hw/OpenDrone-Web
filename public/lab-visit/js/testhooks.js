// window.__game test hooks (owner: shell, SPEC.md section 8).
// ctx is filled by main.js: { testMode, version, events, messages (bridge.log), impl }. impl holds the
// functions once the game has loaded; calling a function before that throws Error('not ready').
// sim and walkTo throw Error('test mode only') without ?test=1.

export function installTestHooks(ctx) {
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error || 'error')));
  window.addEventListener('unhandledrejection', (e) => errors.push(String((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));

  const call = (name, testOnly) => (...args) => {
    if (testOnly && !ctx.testMode) throw new Error('test mode only');
    if (!ctx.impl) throw new Error('not ready');
    return ctx.impl[name](...args);
  };

  const g = {
    ready: false,
    version: ctx.version,
    errors,
    get messages() { return ctx.messages; },
    get events() { return ctx.events; },
    state: call('state'),
    config: call('config'),
    items: call('items'),
    teleport: call('teleport'),
    teleportToItem: call('teleportToItem'),
    lookAt: call('lookAt'),
    setInput: call('setInput'),
    sim: call('sim', true),
    walkTo: call('walkTo', true),
    nearestItem: call('nearestItem'),
    candidates: call('candidates'),
    interact: call('interact'),
    closeCard: call('closeCard'),
    openMenu: call('openMenu'),
    closeMenu: call('closeMenu'),
    goto: call('goto'),
    screenOf: call('screenOf'),
    setHighlightOverride: call('setHighlightOverride'),
    viewDebug: call('viewDebug', true),
    tilt: call('tilt'),
    progress: call('progress'),
    showHint: call('showHint'),
    discover: call('discover', true),
    resetProgress: call('resetProgress'),
    pause: call('pause'),
    resume: call('resume'),
    closeComplete: call('closeComplete'),
    openHelp: call('openHelp'),
    dismissHelp: call('dismissHelp'),
    entranceSkip: call('entranceSkip'),
    minimap: call('minimap'),              // minimap: debug state of the HUD and the full map, null without it
    minimapCall: (name, ...a) => call('minimapCall')(name, a),
    showWay: call('showWay'),
    collision: {
      isWalkable: (...a) => call('collisionCall')('isWalkable', a),
      clearance: (...a) => call('collisionCall')('clearance', a),
      findPath: (...a) => call('collisionCall')('findPath', a),
      nearestWalkable: (...a) => call('collisionCall')('nearestWalkable', a),
      stats: (...a) => call('collisionCall')('stats', a)
    },
    frameTimes(seconds = 5) {
      return new Promise((resolve) => {
        const deltas = [];
        let last = null;
        const end = performance.now() + seconds * 1000;
        const tick = (now) => {
          if (last !== null) deltas.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else {
            const s = deltas.slice().sort((a, b) => a - b);
            const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
            const p95 = s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : 0;
            resolve({ mean, p95, frames: s.length });
          }
        };
        requestAnimationFrame(tick);
      });
    }
  };
  window.__game = g;
  return g;
}
