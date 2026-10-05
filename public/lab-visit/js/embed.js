// iframe bridge (owner: shell).
// Outbound: { source: 'lab-visit', v: 1, type, ...payload } to window.parent with target '*' (payloads carry
// ids and titles only). Inbound: { source: 'lab-visit-host', type, ... } accepted only from this page's own
// origin or an origin listed in config.json allowedOrigins; anything else is ignored silently.

export function createBridge({ allowedOrigins = [] } = {}) {
  const log = [];
  const handlers = new Map();
  const embedded = window.parent && window.parent !== window;

  function emit(type, payload = {}) {
    const msg = { source: 'lab-visit', v: 1, type, ...payload };
    log.push(msg);
    if (embedded) {
      try { window.parent.postMessage(msg, '*'); } catch (err) { /* parent gone */ }
    }
  }

  function on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  }

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || typeof d !== 'object' || d.source !== 'lab-visit-host' || typeof d.type !== 'string') return;
    if (event.origin !== location.origin && !allowedOrigins.includes(event.origin)) return;
    for (const fn of handlers.get(d.type) || []) fn(d);
  });

  return { emit, on, log };
}
