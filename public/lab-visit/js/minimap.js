// Minimap HUD and full map (DOM, canvas; never imports PlayCanvas). Class prefix mm-, ids #minimap and #map.
// - The plan (data/minimap.png, baked by tools/bake_minimap.py) is coloured once into an offscreen canvas with the
//   theme palette. The fog of war (js/minimap-core.js) is a small canvas updated cell by cell; the revealed plan is
//   recomposed only inside the rectangle of newly revealed cells.
// - HUD: a circle that turns with the visitor (facing up), player arrow and view cone at the centre, north mark on the
//   rim, discovered machines in the accent colour, a "?" for undiscovered machines in revealed areas, a pulsing ring
//   on the current objective target and an arrow on the rim when it is off the minimap, and the hint route. Redrawn at
//   most 30 times a second. Clicking or tapping it opens the full map.
// - Full map (ui 'menu' in main.js, the only state of the three that pauses walking): the whole plan north up with fog,
//   legend, machine names, and the machine list beside it (below it, behind a tab, on narrow screens). A discovered
//   machine on the map, or any row of the list, offers "Show the way": main.js then shows the hint arrow and the route
//   toward it. It never teleports.
// - Placement: the HUD picks the first free slot among bottom left (desktop), under the HUD buttons, under the
//   objective tracker, and between them, sized so it overlaps neither the tracker, the HUD buttons, the touch stick
//   zone, nor the machine info panel (side panel above 700 px, bottom sheet below). With no
//   slot of at least MIN_SIZE it hides; the map stays reachable from M, Tab and the pause menu. The toast, the hint and
//   the controls strip then stack around it (js/gameui.js layoutTop counts #minimap as a HUD block).
import { createTransform, createFog, edgeArrow, rotateToView } from './minimap-core.js';

const VIEW_RADIUS_U = 0.85;   // the HUD circle shows 0.85 u (2.9 m) around the visitor
const REVEAL_RADIUS_U = 0.9;  // sight radius for the fog of war (3.1 m)
const REVEAL_MS = 100;
const HUD_MS = 33;            // at most 30 HUD redraws a second
const MIN_SIZE = 88, GUTTER = 16, GAP = 10;
const CONE_DEG = 40;          // half angle of the view cone
const ROUTE_MAX = 256;

const PALETTES = {
  dark: { unknown: '#101014', hatch: '#18181e', outside: '#0b0b0e', interior: [40, 40, 46], walk: [60, 60, 68],
    furn: [112, 109, 102], tall: [150, 146, 136], wall: [200, 197, 188], ring: 'rgba(255,255,255,0.14)',
    text: '#ecebe6', muted: '#9c9a93', unknownMark: '#8d8a83', player: '#ffffff', halo: 'rgba(10,10,12,0.85)' },
  light: { unknown: '#dddcd6', hatch: '#d2d1ca', outside: '#e7e6e1', interior: [236, 235, 230], walk: [250, 249, 246],
    furn: [182, 177, 167], tall: [138, 133, 123], wall: [70, 68, 62], ring: 'rgba(0,0,0,0.18)',
    text: '#1d1d1f', muted: '#5f5f5b', unknownMark: '#6f6c66', player: '#1d1d1f', halo: 'rgba(255,255,255,0.9)' }
};

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

// coloured plan: background, interior floor, walkable, walls (a band outside the interior), furniture, tall
function colourise(img, pal) {
  const w = img.width, h = img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const src = g.getImageData(0, 0, w, h);
  const s = src.data;
  // wall band: max filter (radius 3) of the interior alpha, separable
  const a = new Uint8Array(w * h), t = new Uint8Array(w * h), grown = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = s[i * 4 + 3];
  const R = 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = -R; k <= R; k++) { const xx = x + k; if (xx >= 0 && xx < w && a[y * w + xx] > m) m = a[y * w + xx]; }
    t[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = -R; k <= R; k++) { const yy = y + k; if (yy >= 0 && yy < h && t[yy * w + x] > m) m = t[yy * w + x]; }
    grown[y * w + x] = m;
  }
  const out = g.createImageData(w, h);
  const o = out.data;
  for (let i = 0; i < w * h; i++) {
    const wk = s[i * 4] / 255, fu = s[i * 4 + 1] / 255, ta = s[i * 4 + 2] / 255, inr = a[i] / 255;
    const wall = Math.max(0, grown[i] / 255 - inr);
    let r = 0, gg = 0, b = 0, al = 0;
    const lay = (col, k) => { if (k <= 0) return; r = r * (1 - k) + col[0] * k; gg = gg * (1 - k) + col[1] * k; b = b * (1 - k) + col[2] * k; al = al + (1 - al) * k; };
    lay(pal.wall, wall);
    lay(pal.interior, inr);
    lay(pal.walk, wk);
    lay(pal.furn, fu);
    lay(pal.tall, ta);
    // colours were blended onto transparent black: un-premultiply
    if (al > 0) { r /= al; gg /= al; b /= al; }
    o[i * 4] = r; o[i * 4 + 1] = gg; o[i * 4 + 2] = b; o[i * 4 + 3] = al * 255;
  }
  g.putImageData(out, 0, 0);
  // interior fog cells, for the "explored" share
  return { canvas: c, interiorAlpha: a };
}

export function createMinimap({
  hud,          // #minimap
  full,         // #map
  meta,         // data/minimap.json
  image,        // HTMLImageElement of data/minimap.png, loaded
  items,        // enabled machine items
  areas,        // machines.json areas
  t, lang = 'en', pick,
  isTouch = false,
  theme = 'dark',
  reducedMotion = false,
  avoid = {},   // { objective, hudButtons, stickZone, card, prompt } elements whose boxes the HUD must not cover
  on = {}       // open(), close(), showWay(id), isFound(id), fogChanged()
}) {
  const tx = (k, v) => (typeof t === 'function' ? t(k, v) : k);
  const call = (name, ...a) => (typeof on[name] === 'function' ? on[name](...a) : undefined);
  const isFound = (id) => (typeof on.isFound === 'function' ? !!on.isFound(id) : false); // no rest array: called per marker per frame
  const fonts = new Map();
  const fontOf = (px) => { let f = fonts.get(px); if (!f) { f = `700 ${px}px system-ui, sans-serif`; fonts.set(px, f); } return f; };
  const pal = PALETTES[theme === 'light' ? 'light' : 'dark'];
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--sh-accent') || '#d9a441').trim() || '#d9a441';
  const T = createTransform(meta);
  const fog = createFog(meta.fog);
  const W = meta.width, H = meta.height, PPU = T.ppu;
  const titleOf = (it) => (pick ? pick(it.title, lang) : it.title.en);
  const hudMs = isTouch ? 50 : HUD_MS; // phones: at most 20 HUD redraws a second, desktops 30

  // ---------- offscreen canvases ----------
  const plan = colourise(image, pal);
  const fogCanvas = document.createElement('canvas');
  fogCanvas.width = fog.w; fogCanvas.height = fog.h;
  const fogCtx = fogCanvas.getContext('2d');
  const fogImg = fogCtx.createImageData(fog.w, fog.h);
  const lit = document.createElement('canvas');
  lit.width = W; lit.height = H;
  const litCtx = lit.getContext('2d');
  // interior fog cells: the denominator of the explored share
  let interiorCells = 0;
  const interiorCell = new Uint8Array(fog.w * fog.h);
  for (let j = 0; j < fog.h; j++) for (let i = 0; i < fog.w; i++) {
    const px = Math.min(W - 1, Math.floor((i + 0.5) * fog.pxPerCell)), py = Math.min(H - 1, Math.floor((j + 0.5) * fog.pxPerCell));
    if (plan.interiorAlpha[py * W + px] >= 128) { interiorCell[j * fog.w + i] = 1; interiorCells++; }
  }
  const dirtyBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  function flushFog() {
    const d = fog.takeDirty(dirtyBox);
    if (!d) return false;
    const cells = fog.cells, data = fogImg.data;
    for (let j = d.y0; j <= d.y1; j++) for (let i = d.x0; i <= d.x1; i++) data[(j * fog.w + i) * 4 + 3] = cells[j * fog.w + i] ? 255 : 0;
    fogCtx.putImageData(fogImg, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
    // recompose the revealed plan inside the changed cells, one cell wider for the smooth fog edge
    const pc = fog.pxPerCell;
    const x = (d.x0 - 1) * pc, y = (d.y0 - 1) * pc, w = (d.x1 - d.x0 + 3) * pc, h = (d.y1 - d.y0 + 3) * pc;
    litCtx.save();
    litCtx.beginPath();
    litCtx.rect(x, y, w, h);
    litCtx.clip();
    litCtx.clearRect(x, y, w, h);
    litCtx.imageSmoothingEnabled = true;
    litCtx.drawImage(fogCanvas, 0, 0, fog.w * pc, fog.h * pc);
    litCtx.globalCompositeOperation = 'source-in';
    litCtx.drawImage(plan.canvas, 0, 0);
    litCtx.restore();
    return true;
  }

  // machine positions on the map
  const N = items.length;
  const mx = new Float64Array(N), my = new Float64Array(N);
  const tmp = { x: 0, y: 0, z: 0 };
  items.forEach((it, k) => { T.toMap(it.anchor[0], it.anchor[2], tmp); mx[k] = tmp.x; my[k] = tmp.y; });
  const indexOf = new Map(items.map((it, k) => [it.id, k]));

  // ---------- state ----------
  const st = {
    ui: null, x: 0, z: 0, yaw: 0, px: 0, py: 0, heading: 0, has: false,
    lastReveal: -Infinity, rx: NaN, rz: NaN, lastHud: -Infinity, lastFull: -Infinity, hudDirty: true,
    target: -1, routeN: 0, visible: false, fullOpen: false, selected: -1, tab: 'map',
    cost: { frames: 0, total: 0, max: 0, draws: 0, reveals: 0, last: 0, revealMs: 0, flushMs: 0, drawMs: 0 }
  };
  const costRing = new Float32Array(1024); // last per-frame costs, for the trimmed mean of debug()
  const routeX = new Float64Array(ROUTE_MAX), routeY = new Float64Array(ROUTE_MAX);
  const v = { x: 0, y: 0 }, arrow = { inside: true, x: 0, y: 0, angle: 0 };

  // ---------- HUD ----------
  hud.classList.add('mm-hud');
  const hudCanvas = el('canvas', { class: 'mm-canvas', 'aria-hidden': 'true' });
  const hudBtn = el('button', { type: 'button', class: 'mm-hud-btn', 'aria-label': tx('map.open'), title: tx('map.open'), 'aria-keyshortcuts': 'M Tab' }, [hudCanvas]);
  const badge = el('span', { class: 'mm-badge' + (isTouch ? ' mm-badge-touch' : ''), 'aria-hidden': 'true', text: isTouch ? tx('map.title') : tx('map.key') });
  hud.replaceChildren(hudBtn, badge);
  hudBtn.addEventListener('click', () => call('open'));
  const hctx = hudCanvas.getContext('2d');
  let size = 0, dpr = 1, hatch = null, cone = null;

  function makeHatch(ctx) {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const g = c.getContext('2d');
    g.fillStyle = pal.unknown; g.fillRect(0, 0, 8, 8);
    g.strokeStyle = pal.hatch; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.moveTo(-2, 2); g.lineTo(2, -2); g.stroke();
    return ctx.createPattern(c, 'repeat');
  }

  function setSize(s) {
    const cap = isTouch ? 1.5 : 2; // phones: fewer HUD pixels to draw
    if (s === size && dpr === Math.min(cap, window.devicePixelRatio || 1)) return;
    size = s;
    dpr = Math.min(cap, window.devicePixelRatio || 1);
    hudCanvas.width = Math.round(s * dpr);
    hudCanvas.height = Math.round(s * dpr);
    hud.style.width = s + 'px';
    hud.style.height = s + 'px';
    hatch = makeHatch(hctx);
    const r = s / 2;
    cone = hctx.createRadialGradient(r, r, 0, r, r, r * 0.62);
    cone.addColorStop(0, hexA(accent, 0.42));
    cone.addColorStop(1, hexA(accent, 0));
    st.hudDirty = true;
  }

  function hexA(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return `rgba(217,164,65,${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const accentSoft = hexA(accent, 0.75);

  // ---------- placement ----------
  function boxOf(node) {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  // safe-area insets (notch, home indicator) read from a probe styled with env() in css/minimap.css
  const safeProbe = el('div', { class: 'mm-safe', 'aria-hidden': 'true' });
  hud.parentElement.append(safeProbe);
  function insets() {
    const cs = getComputedStyle(safeProbe);
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  }
  function layout() {
    const host = hud.parentElement.getBoundingClientRect();
    const vw = host.width, vh = host.height;
    if (!vw || !vh) return;
    const ins = insets();
    const gL = GUTTER + ins.l, gR = GUTTER + ins.r, gT = GUTTER + ins.t, gB = GUTTER + ins.b;
    st.insets = ins;
    const hard = [];
    const off = (b) => (b ? { left: b.left - host.left, top: b.top - host.top, right: b.right - host.left, bottom: b.bottom - host.top } : null);
    const obj = off(boxOf(avoid.objective)), btns = off(boxOf(avoid.hudButtons));
    if (obj) hard.push(obj);
    if (btns) hard.push(btns);
    if (isTouch) {
      const sz = off(boxOf(avoid.stickZone));
      hard.push(sz || { left: 0, top: vh / 2, right: vw * 0.4, bottom: vh });
    }
    // the machine info panel: below 700 px its bottom sheet's place is kept free, so the minimap does not move when it
    // opens; the side panel above 700 px only counts while open (on landscape phones keeping its place free would leave
    // the minimap no room), and the minimap moves or shrinks then
    if (vw <= 700) hard.push({ left: 0, top: vh - Math.min(0.38 * vh, 340) - ins.b - 8, right: vw, bottom: vh });
    // layout box (offset*), not the transformed one: the panel slides in with a transform when it opens
    const cd = avoid.card;
    const card = cd && !cd.hidden && cd.offsetWidth ? { left: cd.offsetLeft, top: cd.offsetTop, right: cd.offsetLeft + cd.offsetWidth, bottom: cd.offsetTop + cd.offsetHeight } : null;
    if (card) hard.push(card);
    // phones get a larger share of the short side than desktops
    const pref = Math.round(Math.max(120, Math.min(isTouch ? 180 : 250, (isTouch ? 0.26 : 0.2) * Math.min(vw, vh) + 40)));
    const objB = obj ? obj.bottom : gT, objR = obj ? obj.right : gL;
    const btnB = btns ? btns.bottom : gT, btnL = btns ? btns.left : vw - gR;
    const slots = {
      bottomLeft: (s) => ({ left: gL, top: vh - gB - s }),
      underButtons: (s) => ({ left: vw - gR - s, top: btnB + GAP }),
      underTracker: (s) => ({ left: gL, top: objB + GAP }),
      between: (s) => ({ left: objR + 12, top: gT, maxRight: btnL - 12 })
    };
    const order = isTouch ? ['underButtons', 'underTracker', 'between', 'bottomLeft']
      : vw > 700 ? ['bottomLeft', 'underTracker', 'underButtons', 'between'] : ['underButtons', 'underTracker', 'bottomLeft', 'between'];
    const fits = (name, s) => {
      const p = slots[name](s);
      const b = { left: p.left, top: p.top, right: p.left + s, bottom: p.top + s };
      if (b.left < gL - 0.5 || b.top < gT - 0.5 || b.right > vw - gR + 0.5 || b.bottom > vh - gB + 0.5) return null;
      if (p.maxRight !== undefined && b.right > p.maxRight) return null;
      for (const r of hard) if (intersects(b, { left: r.left - 4, top: r.top - 4, right: r.right + 4, bottom: r.bottom + 4 })) return null;
      return b;
    };
    let best = null;
    for (const name of order) {
      for (let s = pref; s >= MIN_SIZE; s -= 4) {
        const b = fits(name, s);
        if (b) { if (!best || s > best.s + 24) best = { name, s, b }; break; }
      }
      if (best && best.s >= Math.min(pref, 112)) break;
    }
    st.slot = best ? best.name : null;
    st.box = best ? best.b : null;
    if (!best) { hud.dataset.slot = 'none'; applyVisible(); return; }
    hud.dataset.slot = best.name;
    hud.style.left = best.b.left + 'px';
    hud.style.top = best.b.top + 'px';
    setSize(best.s);
    applyVisible();
  }

  // ---------- drawing ----------
  function drawMarker(ctx, k, x, y, scale) {
    const found = isFound(items[k].id);
    if (found) {
      ctx.beginPath();
      ctx.arc(x, y, 5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeStyle = pal.halo;
      ctx.stroke();
      return true;
    }
    if (!fog.revealedAtMap(mx[k], my[k])) return false;
    ctx.beginPath();
    ctx.arc(x, y, 6 * scale, 0, Math.PI * 2);
    ctx.fillStyle = pal.halo;
    ctx.fill();
    ctx.lineWidth = 1.2 * scale;
    ctx.strokeStyle = pal.unknownMark;
    ctx.stroke();
    ctx.fillStyle = pal.unknownMark;
    ctx.font = fontOf(Math.round(9 * scale));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y + 0.5 * scale);
    return true;
  }

  function pulse(now) { return reducedMotion ? 0.5 : (now % 1400) / 1400; }

  function drawRing(ctx, x, y, now, scale) {
    const p = pulse(now);
    ctx.beginPath();
    ctx.arc(x, y, (8 + 7 * p) * scale, 0, Math.PI * 2);
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = hexAlphaCache(1 - 0.8 * p);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 8 * scale, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * scale;
    ctx.strokeStyle = accent;
    ctx.stroke();
  }
  // 21 pre-built accent colours with alpha 0..1, so the pulse does not build strings per frame
  const alphaSteps = Array.from({ length: 21 }, (_, i) => hexA(accent, i / 20));
  function hexAlphaCache(a) { return alphaSteps[Math.max(0, Math.min(20, Math.round(a * 20)))]; }

  function drawPlayer(ctx, x, y, angle, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -9 * s);
    ctx.lineTo(6.5 * s, 7 * s);
    ctx.lineTo(0, 3.5 * s);
    ctx.lineTo(-6.5 * s, 7 * s);
    ctx.closePath();
    ctx.fillStyle = pal.player;
    ctx.fill();
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = pal.halo;
    ctx.stroke();
    ctx.restore();
  }

  function drawRoute(ctx) {
    if (st.routeN < 2) return;
    ctx.beginPath();
    ctx.moveTo(st.px, st.py);
    for (let i = 0; i < st.routeN; i++) ctx.lineTo(routeX[i], routeY[i]);
  }

  function drawHud(now) {
    const s = size, r = s / 2, ctx = hctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = isTouch ? pal.unknown : (hatch || pal.unknown); // phones: a flat fill is cheaper
    ctx.fillRect(0, 0, s, s);
    // the map, turned so the facing direction is up
    const zoom = (r / (VIEW_RADIUS_U * PPU));
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(-st.heading);
    ctx.scale(zoom, zoom);
    ctx.translate(-st.px, -st.py);
    ctx.imageSmoothingEnabled = true;
    // only the part of the plan inside the turned circle (half diagonal of the view square)
    const R = Math.ceil(VIEW_RADIUS_U * PPU * 1.45);
    const sx = Math.max(0, Math.floor(st.px - R)), sy = Math.max(0, Math.floor(st.py - R));
    const sw = Math.min(W, Math.ceil(st.px + R)) - sx, sh = Math.min(H, Math.ceil(st.py + R)) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(lit, sx, sy, sw, sh, sx, sy, sw, sh);
    if (st.routeN >= 2) {
      drawRoute(ctx);
      ctx.lineWidth = 3 / zoom;
      ctx.setLineDash(DASH_HUD);
      ctx.lineDashOffset = 0;
      ctx.strokeStyle = accentSoft;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
    ctx.restore();
    // view cone and player
    ctx.beginPath();
    ctx.moveTo(r, r);
    ctx.arc(r, r, r * 0.62, -Math.PI / 2 - CONE_DEG * Math.PI / 180, -Math.PI / 2 + CONE_DEG * Math.PI / 180);
    ctx.closePath();
    ctx.fillStyle = cone;
    ctx.fill();
    // machines (upright markers), objective ring and edge arrow
    const sc = Math.max(isTouch ? 1 : 0.85, Math.min(1.2, s / 180));
    for (let k = 0; k < N; k++) {
      rotateToView((mx[k] - st.px) * zoom, (my[k] - st.py) * zoom, st.heading, v);
      if (Math.abs(v.x) > r + 8 || Math.abs(v.y) > r + 8) continue;
      drawMarker(ctx, k, r + v.x, r + v.y, sc);
    }
    if (st.target >= 0) {
      rotateToView((mx[st.target] - st.px) * zoom, (my[st.target] - st.py) * zoom, st.heading, v);
      edgeArrow(v.x, v.y, r, 12, arrow);
      if (arrow.inside) drawRing(ctx, r + v.x, r + v.y, now, sc);
      else {
        ctx.save();
        ctx.translate(r + arrow.x, r + arrow.y);
        ctx.rotate(arrow.angle);
        ctx.beginPath();
        ctx.moveTo(0, -8 * sc);
        ctx.lineTo(7 * sc, 5 * sc);
        ctx.lineTo(-7 * sc, 5 * sc);
        ctx.closePath();
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = pal.halo;
        ctx.stroke();
        ctx.restore();
      }
    }
    drawPlayer(ctx, r, r, 0, sc);
    ctx.restore();
    // rim and north mark
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = pal.ring;
    ctx.stroke();
    rotateToView(0, -(r - 11), st.heading, v);
    ctx.beginPath();
    ctx.arc(r + v.x, r + v.y, 8.5, 0, Math.PI * 2);
    ctx.fillStyle = pal.halo;
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(northLabel, r + v.x, r + v.y + 0.5);
    st.cost.draws++;
  }
  const DASH_HUD = [6, 7], NO_DASH = [];
  const northLabel = tx('map.north');

  // ---------- full map ----------
  full.classList.add('mm-full');
  full.setAttribute('role', 'dialog');
  full.setAttribute('aria-modal', 'true');
  full.setAttribute('aria-labelledby', 'mm-full-title');
  const fullCanvas = el('canvas', { class: 'mm-full-canvas', role: 'img', 'aria-label': tx('map.title') });
  const pop = el('div', { class: 'mm-pop', hidden: true });
  const explored = el('p', { class: 'mm-explored' });
  const closeBtn = el('button', { type: 'button', class: 'mm-btn mm-close', id: 'mm-close', text: tx('menu.close') });
  closeBtn.addEventListener('click', () => call('close'));
  const legendRow = (cls, key) => el('li', {}, [el('span', { class: 'mm-sw ' + cls, 'aria-hidden': 'true' }), el('span', { text: tx(key) })]);
  const legend = el('ul', { class: 'mm-legend' }, [
    legendRow('mm-sw-you', 'map.legend.you'), legendRow('mm-sw-found', 'map.legend.found'), legendRow('mm-sw-unknown', 'map.legend.unknown'),
    legendRow('mm-sw-target', 'map.legend.target'), legendRow('mm-sw-walk', 'map.legend.walk'), legendRow('mm-sw-furn', 'map.legend.furniture'),
    legendRow('mm-sw-tall', 'map.legend.tall'), legendRow('mm-sw-fog', 'map.legend.fog')
  ]);
  // zoom controls over the map (pinch, drag and the mouse wheel work on the map itself)
  const zoomBtn = (id, label, text) => el('button', { type: 'button', class: 'mm-zbtn', id, 'aria-label': tx(label), title: tx(label), text });
  const zIn = zoomBtn('mm-zoom-in', 'map.zoomIn', '+'), zOut = zoomBtn('mm-zoom-out', 'map.zoomOut', '\u2212'), zFit = zoomBtn('mm-zoom-fit', 'map.zoomFit', tx('map.fit'));
  const zoomBar = el('div', { class: 'mm-zoom' }, [zIn, zOut, zFit]);
  const mapPane = el('div', { class: 'mm-pane mm-pane-map', id: 'mm-pane-map', role: 'tabpanel' }, [el('div', { class: 'mm-stage' }, [fullCanvas, pop, zoomBar]), legend]);
  const list = el('div', { class: 'mm-list' });
  const listPane = el('div', { class: 'mm-pane mm-pane-list', id: 'mm-pane-list', role: 'tabpanel' }, [
    el('h3', { class: 'mm-list-title', text: tx('menu.title') }), list]);
  const tabMap = el('button', { type: 'button', class: 'mm-tab', role: 'tab', id: 'mm-tab-map', 'aria-controls': 'mm-pane-map', text: tx('map.tabMap') });
  const tabList = el('button', { type: 'button', class: 'mm-tab', role: 'tab', id: 'mm-tab-list', 'aria-controls': 'mm-pane-list', text: tx('map.tabList') });
  tabMap.addEventListener('click', () => setTab('map'));
  tabList.addEventListener('click', () => setTab('list'));
  const panel = el('div', { class: 'mm-panel' }, [
    el('div', { class: 'mm-head' }, [
      el('div', { class: 'mm-head-text' }, [el('p', { class: 'mm-kicker', text: tx('app.brand') }), el('h2', { id: 'mm-full-title', class: 'mm-title', text: tx('map.title') }), explored]),
      closeBtn
    ]),
    el('div', { class: 'mm-tabs', role: 'tablist' }, [tabMap, tabList]),
    el('div', { class: 'mm-body' }, [mapPane, listPane])
  ]);
  full.replaceChildren(panel);
  const fctx = fullCanvas.getContext('2d');
  // rot: on a tall stage (phone portrait) the plan is turned a quarter clockwise to fill it; the north mark says so
  // base: the fitted view; zoom (1 to ZOOM_MAX) and pan (CSS px) apply on top of it around the stage centre
  let fview = { s: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1, rot: false };
  let fbase = { s: 1, ox: 0, oy: 0 };
  const ZOOM_MAX = 5;
  const zp = { z: 1, x: 0, y: 0 };
  function applyView() {
    const cx = fview.w / 2, cy = fview.h / 2;
    // keep at least a third of the plan on the stage
    const bw = (fview.rot ? H : W) * fbase.s * zp.z, bh = (fview.rot ? W : H) * fbase.s * zp.z;
    const mxp = Math.max(0, (bw - fview.w) / 2 + fview.w / 3), myp = Math.max(0, (bh - fview.h) / 2 + fview.h / 3);
    zp.x = Math.max(-mxp, Math.min(mxp, zp.x));
    zp.y = Math.max(-myp, Math.min(myp, zp.y));
    fview.s = fbase.s * zp.z;
    fview.ox = cx + zp.z * (fbase.ox - cx) + zp.x;
    fview.oy = cy + zp.z * (fbase.oy - cy) + zp.y;
    st.lastFull = -Infinity;
    full.dataset.zoom = zp.z.toFixed(2);
  }
  // zoom to z keeping the stage point (sx, sy) over the same place of the plan
  function zoomAt(sx, sy, z) {
    z = Math.max(1, Math.min(ZOOM_MAX, z));
    const cx = fview.w / 2, cy = fview.h / 2;
    const bx = (sx - zp.x - cx) / zp.z + cx, by = (sy - zp.y - cy) / zp.z + cy;
    zp.x = sx - cx - z * (bx - cx);
    zp.y = sy - cy - z * (by - cy);
    zp.z = z;
    applyView();
  }
  // the buttons zoom about the visitor when they are on the stage, else about its centre
  const zoomBtnAt = (f) => {
    toFull(st.px, st.py, v);
    const on = st.has && v.x > 0 && v.y > 0 && v.x < fview.w && v.y < fview.h;
    zoomAt(on ? v.x : fview.w / 2, on ? v.y : fview.h / 2, zp.z * f);
  };
  zIn.addEventListener('click', () => zoomBtnAt(1.5));
  zOut.addEventListener('click', () => zoomBtnAt(1 / 1.5));
  zFit.addEventListener('click', () => { zp.z = 1; zp.x = 0; zp.y = 0; applyView(); });
  function toFull(px, py, out) {
    if (fview.rot) { out.x = fview.ox + (H - py) * fview.s; out.y = fview.oy + px * fview.s; }
    else { out.x = fview.ox + px * fview.s; out.y = fview.oy + py * fview.s; }
    return out;
  }

  function setTab(name) {
    st.tab = name;
    panel.dataset.tab = name;
    tabMap.setAttribute('aria-selected', name === 'map' ? 'true' : 'false');
    tabList.setAttribute('aria-selected', name === 'list' ? 'true' : 'false');
    if (name === 'map') requestAnimationFrame(sizeFull);
  }

  function renderList() {
    const groups = (areas || []).map((a) => ({ a, its: items.filter((it) => it.area === a.id) })).filter((g) => g.its.length);
    list.replaceChildren(...groups.map(({ a, its }) => el('section', { class: 'mm-group' }, [
      el('h4', { class: 'mm-group-title', text: pick ? pick(a.label, lang) : a.label.en }),
      el('ul', { class: 'mm-rows' }, its.map((it) => {
        const found = isFound(it.id);
        const go = el('button', { type: 'button', class: 'mm-btn mm-go', 'data-item-id': it.id, text: tx('map.showWay') });
        go.addEventListener('click', () => call('showWay', it.id));
        return el('li', { class: 'mm-row' + (found ? ' mm-found' : ''), 'data-item-id': it.id }, [
          el('span', { class: 'mm-dot', 'aria-hidden': 'true', text: found ? '' : '?' }),
          el('span', { class: 'mm-row-title', text: titleOf(it) }),
          el('span', { class: 'sh-visually-hidden', text: found ? tx('map.legend.found') : tx('map.legend.unknown') }),
          go
        ]);
      }))
    ])));
  }

  function sizeFull() {
    if (!st.fullOpen) return;
    const stage = fullCanvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.floor(stage.width)), h = Math.max(1, Math.floor(stage.height));
    const d = Math.min(2, window.devicePixelRatio || 1);
    if (fullCanvas.width !== Math.round(w * d) || fullCanvas.height !== Math.round(h * d)) {
      fullCanvas.width = Math.round(w * d);
      fullCanvas.height = Math.round(h * d);
    }
    const pad = 12;
    const s0 = Math.min((w - 2 * pad) / W, (h - 2 * pad) / H), s1 = Math.min((w - 2 * pad) / H, (h - 2 * pad) / W);
    const rot = s1 > s0 * 1.2;
    const s = rot ? s1 : s0, bw = (rot ? H : W) * s, bh = (rot ? W : H) * s;
    fbase = { s, ox: (w - bw) / 2, oy: (h - bh) / 2 };
    fview = { s, ox: fbase.ox, oy: fbase.oy, w, h, dpr: d, rot };
    full.dataset.rotated = rot ? '1' : '0';
    applyView();
  }

  function drawFull(now) {
    const { s, ox, oy, w, h, dpr: d, rot } = fview;
    const ctx = fctx;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    if (rot) { ctx.translate(H, 0); ctx.rotate(Math.PI / 2); }
    ctx.fillStyle = hatch || pal.unknown;
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lit, 0, 0);
    if (st.routeN >= 2) {
      drawRoute(ctx);
      ctx.lineWidth = 3 / s;
      ctx.setLineDash([6 / s, 7 / s]);
      ctx.strokeStyle = accentSoft;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
    ctx.restore();
    const sc = Math.max(isTouch ? 1.25 : 1, Math.min(1.5, s * 2));
    const P = toFull;
    // names of discovered machines, with a halo (drawMarker changes the font and alignment for its "?"); at least
    // 13 px on touch screens, 12 px elsewhere
    const labelFont = `600 ${Math.max(isTouch ? 13 : 12, Math.round(11 * sc))}px system-ui, sans-serif`;
    for (let k = 0; k < N; k++) {
      P(mx[k], my[k], v);
      if (!drawMarker(ctx, k, v.x, v.y, sc)) continue;
      if (k === st.selected) {
        ctx.beginPath(); ctx.arc(v.x, v.y, 11 * sc, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = pal.text; ctx.stroke();
      }
      if (isFound(items[k].id) && s * W > 300) {
        const label = labels[k];
        ctx.font = labelFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5; ctx.strokeStyle = pal.halo; ctx.strokeText(label, v.x + 9 * sc, v.y);
        ctx.fillStyle = pal.text; ctx.fillText(label, v.x + 9 * sc, v.y);
      }
    }
    if (st.target >= 0) { P(mx[st.target], my[st.target], v); drawRing(ctx, v.x, v.y, now, sc); }
    if (st.has) { P(st.px, st.py, v); drawPlayer(ctx, v.x, v.y, st.heading + (rot ? Math.PI / 2 : 0), sc * 1.1); }
    // north mark, top left of the stage
    ctx.fillStyle = pal.halo;
    ctx.beginPath(); ctx.arc(26, 22, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = accent;
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(northLabel + (rot ? '→' : '↑'), 26, 22);
    if (st.selected >= 0 && !pop.hidden) placePop(st.selected);
  }
  const labels = items.map(titleOf);

  function hitMachine(cx, cy) {
    let best = -1, bd = isTouch ? 26 : 18;
    for (let k = 0; k < N; k++) {
      if (!isFound(items[k].id)) continue;
      toFull(mx[k], my[k], v);
      const d = Math.hypot(v.x - cx, v.y - cy);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  function select(k) {
    st.selected = k;
    st.lastFull = -Infinity;
    list.querySelectorAll('.mm-row').forEach((r) => r.classList.toggle('mm-selected', k >= 0 && r.dataset.itemId === items[k].id));
    if (k < 0) { pop.hidden = true; return; }
    const go = el('button', { type: 'button', class: 'mm-btn mm-btn-accent', id: 'mm-pop-go', text: tx('map.showWay') });
    go.addEventListener('click', () => call('showWay', items[k].id));
    pop.replaceChildren(el('span', { class: 'mm-pop-title', text: labels[k] }), go);
    pop.hidden = false;
    placePop(k);
  }
  function placePop(k) {
    toFull(mx[k], my[k], v);
    const half = Math.min(fview.w / 2 - 4, pop.offsetWidth / 2);
    pop.style.left = Math.round(Math.min(fview.w - half - 4, Math.max(half + 4, v.x))) + 'px';
    pop.style.top = Math.round(Math.max(0, Math.min(fview.h, v.y))) + 'px';
    pop.classList.toggle('mm-pop-below', v.y < 90);
  }

  // touch and mouse on the map: one finger or the mouse drags, two fingers pinch, the wheel zooms, a tap or click
  // without moving selects a discovered machine. touch-action: none (css/minimap.css) keeps the page from zooming.
  const ptrs = new Map();
  let gesture = null; // { moved, d0, z0, mx0, my0, x0, y0, sx, sy }
  const localXY = (e) => { const r = fullCanvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function startGesture() {
    const pts = [...ptrs.values()];
    const mxp = pts.reduce((a, p) => a + p.x, 0) / pts.length, myp = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture = { moved: gesture ? gesture.moved : false, d0: d, z0: zp.z, mx0: mxp, my0: myp, x0: zp.x, y0: zp.y, sx: mxp, sy: myp, n: pts.length };
  }
  fullCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fullCanvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, localXY(e));
    if (ptrs.size === 1) gesture = null;
    startGesture();
    e.preventDefault();
  });
  fullCanvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !gesture) return;
    ptrs.set(e.pointerId, localXY(e));
    const pts = [...ptrs.values()];
    const mxp = pts.reduce((a, p) => a + p.x, 0) / pts.length, myp = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    if (Math.hypot(mxp - gesture.sx, myp - gesture.sy) > 8) gesture.moved = true;
    if (pts.length > 1 && gesture.d0 > 0) {
      gesture.moved = true;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      // zoom about the starting midpoint, then follow the midpoint
      zp.x = gesture.x0; zp.y = gesture.y0; zp.z = gesture.z0;
      zoomAt(gesture.mx0, gesture.my0, gesture.z0 * d / gesture.d0);
      zp.x += mxp - gesture.mx0; zp.y += myp - gesture.my0;
      applyView();
    } else if (gesture.moved) {
      zp.x = gesture.x0 + (mxp - gesture.mx0);
      zp.y = gesture.y0 + (myp - gesture.my0);
      applyView();
    }
  });
  const endPtr = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (ptrs.size === 0) {
      if (gesture && !gesture.moved && e.type === 'pointerup') select(hitMachine(p.x, p.y));
      gesture = null;
    } else startGesture();
  };
  fullCanvas.addEventListener('pointerup', endPtr);
  fullCanvas.addEventListener('pointercancel', endPtr);
  fullCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localXY(e);
    zoomAt(p.x, p.y, zp.z * Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015));
  }, { passive: false });
  // Safari's own pinch gesture events
  fullCanvas.addEventListener('gesturestart', (e) => e.preventDefault());

  // focus stays inside the dialog; M and Escape are handled by main.js through js/input.js
  full.addEventListener('keydown', (e) => {
    // M closes the map also while one of its buttons has focus (js/input.js ignores M on buttons)
    if (e.code === 'KeyM' && !e.repeat && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); call('close'); return; }
    if (e.key !== 'Tab') return;
    const f = [...full.querySelectorAll('button:not([hidden]), [href]')].filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    e.preventDefault();
    e.stopPropagation();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  });

  function openFull() {
    renderList();
    st.fullOpen = true;
    full.hidden = false;
    explored.textContent = tx('map.explored', { p: exploredPercent() });
    setTab(window.matchMedia && window.matchMedia('(max-width: 700px)').matches ? st.tab : 'map');
    zp.z = 1; zp.x = 0; zp.y = 0;
    sizeFull();
    select(-1);
    drawFull(performance.now());
    closeBtn.focus({ preventScroll: true });
  }
  function closeFull() {
    st.fullOpen = false;
    full.hidden = true;
    pop.hidden = true;
  }
  const exploredPercent = () => Math.min(100, Math.round((100 * countInterior()) / Math.max(1, interiorCells)));
  function countInterior() {
    let c = 0;
    const cells = fog.cells;
    for (let i = 0; i < cells.length; i++) if (cells[i] && interiorCell[i]) c++;
    return c;
  }

  // Tab opens the map from the game (M comes through js/input.js)
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || st.fullOpen) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.id !== 'c' && !hud.contains(a)) return; // Tab still moves between the panel's links
    // main.js opens the map only while playing (explore or card) and says so
    if (call('open') === true) e.preventDefault();
  });

  function applyVisible() {
    const want = (st.ui === 'explore' || st.ui === 'card') && !!st.box;
    if (want !== st.visible) { st.visible = want; hud.hidden = !want; st.hudDirty = true; }
  }

  // ---------- per frame ----------
  function frame(ui, x, z, yaw, now) {
    const t0 = performance.now();
    if (ui !== st.ui) { st.ui = ui; applyVisible(); }
    if (x !== st.x || z !== st.z || yaw !== st.yaw || !st.has) {
      st.x = x; st.z = z; st.yaw = yaw; st.has = true;
      T.toMap(x, z, tmp);
      st.px = tmp.x; st.py = tmp.y;
      st.heading = T.headingOnMap(yaw);
      st.hudDirty = true;
    }
    const c = st.cost;
    let t1 = t0;
    if ((ui === 'explore' || ui === 'card') && now - st.lastReveal >= REVEAL_MS && !(Math.abs(x - st.rx) < 0.01 && Math.abs(z - st.rz) < 0.01)) {
      revealAt(x, z);
      st.lastReveal = now;
      const t2 = performance.now(); c.revealMs += t2 - t1; t1 = t2;
    }
    if (flushFog()) { st.hudDirty = true; st.lastFull = -Infinity; const t2 = performance.now(); c.flushMs += t2 - t1; t1 = t2; }
    const animating = st.target >= 0 && !reducedMotion;
    if (st.visible && now - st.lastHud >= hudMs && (st.hudDirty || animating)) {
      drawHud(now);
      st.lastHud = now;
      st.hudDirty = false;
      c.drawMs += performance.now() - t1;
    }
    if (st.fullOpen && now - st.lastFull >= HUD_MS) { drawFull(now); st.lastFull = now; }
    const dt = performance.now() - t0;
    costRing[c.frames % costRing.length] = dt;
    c.frames++; c.total += dt; c.last = dt; if (dt > c.max) c.max = dt;
  }

  function revealAt(x, z) {
    T.toMap(x, z, tmp);
    st.rx = x; st.rz = z;
    st.cost.reveals++;
    if (fog.reveal(tmp.x, tmp.y, REVEAL_RADIUS_U * PPU) > 0) call('fogChanged');
  }

  window.addEventListener('resize', () => { layout(); sizeFull(); });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => layout());
    if (avoid.objective) ro.observe(avoid.objective);
    if (avoid.hudButtons) ro.observe(avoid.hudButtons);
    if (avoid.card) ro.observe(avoid.card);
    ro.observe(hud.parentElement);
    const fro = new ResizeObserver(() => sizeFull());
    fro.observe(fullCanvas.parentElement);
  }
  hud.hidden = true;
  full.hidden = true;
  setTab('map');
  layout();

  return {
    frame,
    layout,
    revealAt,
    setTarget(id) { const k = id == null ? -1 : (indexOf.has(id) ? indexOf.get(id) : -1); if (k !== st.target) { st.target = k; st.hudDirty = true; } },
    // path: [{x, z}, ...] in WORLD (collision.findPath), or null
    setRoute(path) {
      let n = 0;
      if (path) for (let i = 0; i < path.length && n < ROUTE_MAX; i++) { T.toMap(path[i].x, path[i].z, tmp); routeX[n] = tmp.x; routeY[n] = tmp.y; n++; }
      if (n !== st.routeN || n) st.hudDirty = true;
      st.routeN = n;
    },
    openFull, closeFull,
    isFullOpen: () => st.fullOpen,
    refreshList() { if (st.fullOpen) renderList(); },
    serializeFog: () => fog.serialize(),
    loadFog(b64) { const ok = fog.load(b64); flushFog(); st.hudDirty = true; return ok; },
    resetFog() { fog.reset(); flushFog(); st.rx = NaN; st.hudDirty = true; },
    exploredPercent,
    // test and debug view (window.__game.minimap())
    debug() {
      const box = hud.getBoundingClientRect();
      const c = st.cost;
      return {
        visible: st.visible && !hud.hidden, slot: st.slot, size, rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        heading: st.heading, map: [st.px, st.py], revealed: fog.count, explored: exploredPercent(), target: st.target >= 0 ? items[st.target].id : null,
        route: st.routeN, fullOpen: st.fullOpen, tab: st.tab, selected: st.selected >= 0 ? items[st.selected].id : null,
        zoom: { z: zp.z, x: zp.x, y: zp.y }, insets: st.insets || null,
        cost: { frames: c.frames, meanMs: c.frames ? c.total / c.frames : 0, maxMs: c.max, draws: c.draws, reveals: c.reveals,
          revealMs: c.revealMs, flushMs: c.flushMs, drawMs: c.drawMs,
          // mean without the slowest 2% of frames (scheduler stalls of the test machine), and the 95th percentile
          ...(() => { const a = Array.from(costRing.slice(0, Math.min(c.frames, costRing.length))).sort((p, q) => p - q);
            const k = Math.max(1, Math.floor(a.length * 0.98)); const tr = a.slice(0, k);
            return { trimmedMeanMs: tr.reduce((p, q) => p + q, 0) / Math.max(1, tr.length), p95Ms: a[Math.floor(a.length * 0.95)] || 0 }; })() }
      };
    },
    revealedAtWorld(p) { T.toMap(p[0], p[1], tmp); return fog.revealedAtMap(tmp.x, tmp.y); },
    resetCost() { st.cost = { frames: 0, total: 0, max: 0, draws: 0, reveals: 0, last: 0, revealMs: 0, flushMs: 0, drawMs: 0 }; },
    // screen position (CSS px, page) of a machine on the full map, for tests
    fullMapPoint(id) {
      const k = indexOf.get(id);
      if (k === undefined || !st.fullOpen) return null;
      const r = fullCanvas.getBoundingClientRect();
      toFull(mx[k], my[k], v);
      return { x: r.left + v.x, y: r.top + v.y, rotated: fview.rot };
    },
    // a machine's position on the HUD relative to its centre (view coordinates), for tests
    hudPoint(id) {
      const k = indexOf.get(id);
      if (k === undefined || !size) return null;
      const zoom = (size / 2) / (VIEW_RADIUS_U * PPU);
      rotateToView((mx[k] - st.px) * zoom, (my[k] - st.py) * zoom, st.heading, v);
      return { x: v.x, y: v.y, r: size / 2 };
    }
  };
}
