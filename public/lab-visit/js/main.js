// Boot, state machine and frame loop (owner: shell). No exports.
// Decisions where SPEC.md is silent:
// - Settings are URL parameters (README "URL parameters"); the pause menu adds the head-bob switch, kept in
//   localStorage 'lab-visit:v2:settings'.
// - Modes: standalone (gate skipped, loading, briefing, explore); ?embed=1 (download gate, then explore with no
//   briefing); ?launch=1 (the host's own "Enter the lab" click is the consent: no gate, a game loading screen with
//   tips, the briefing, dark theme unless ?theme=light). ?test=1 skips gate and briefing.
// - In test mode the loop still reads the edge keys (E, Enter, M, H, Escape) so real keys work (A12); movement and
//   look keys are ignored there, simulation only advances through __game.
// - error-retry reruns the loading step in place; a scene that already loaded is kept.
// - goto accepts enabled item ids only (the ids of the ready message); ?item= resolves enabled ids only.
// - A goto command that arrives before the visitor is in the lab is kept (the last one wins) and applied when the
//   visitor enters explore. A command that arrives while a goto fade runs is ignored.
// - Full screen (pause menu, not in launch mode where the host owns it) asks the browser for fullscreen on the page.
//   Where the Fullscreen API is missing (iPhone Safari) it posts { type: 'fullscreen-request' } to the parent page.
// - Launch mode loads in front of the lab's entrance door (js/entrance.js), a non-interactive scene in the PlayCanvas
//   app: the closed door fills the view with the progress on it; when the scan is in, the door opens by itself, the
//   camera moves through to the spawn, then the briefing. The app (createApp) and the data files and walk grid load
//   first; the splat entity and the backdrop stay disabled until the door opens (the backdrop until the camera is
//   inside). ui stays 'loading' until the briefing. Not in test mode, which enters explore at once.
// - The PlayCanvas frame loop (update, splat sort, render) stops while the canvas is outside the viewport or the
//   document is hidden, and restarts when it is back. Held keys, the stick and look drags are released on pause.
// - Auto-tilt: while an item is focused the view eases its pitch toward the focused anchor, clamped to [-35, 10];
//   when the focus ends it eases back. The visitor's own pitch input stops it until the next focus change. Real
//   frame loop only. Rate: exponential, tau 0.2 s, at most 120 deg/s (60 with reduced motion).
// - Game layer (js/objectives.js, js/gameui.js): a machine is discovered the first time it takes focus or its card
//   opens. The tracker shows the current objective of data/objectives.json, the count and a small arrow with the
//   walking distance toward the next objective; a toast marks each discovery and each finished objective; after all
//   machines the completion screen opens (once a card or panel in the way is closed). Progress is kept in
//   localStorage 'lab-visit:v2:progress' (every access in try/catch; works without storage).
// - Hints: H, the Hint button, or 30 s in explore without a discovery (then every 45 s) show a large arrow toward the
//   next objective for 10 s along the walk path, plus a ring on the machine when it is in view. No idle hints in test
//   mode.
// - Controls strip: on the first entry (not in test mode). Closed by its button, by Escape while the mouse is free,
//   by walking 1.5 u or by the first discovery; the ? button opens it again.
// - Pointer Lock (js/input.js) is allowed in explore and card. Only the modal screens (pause menu, machine list,
//   completion screen, briefing) free the mouse. Escape frees a captured mouse and opens the pause menu, as in games;
//   Escape with a free mouse opens it too. With the info panel open, Escape (or the mouse freed by it) keeps playing:
//   the first Escape frees the mouse so the panel's links can be clicked, the next one closes the panel.
// - Info panel (ui 'card', founder feedback 2026-10-04 "the gameplay gets interrupted when you interact with
//   things"): inspecting never stops play. The panel is a HUD side panel (desktop) or a compact bottom sheet (narrow
//   screens); walking, looking, focus, discovery and hints go on. E (or a click while captured) on another focused
//   machine switches the panel to it; E with nothing else focused closes it, as do the close button and walking out
//   of range (horizontal distance above interactRadius x exitFactor for CARD_LEAVE_S, with a fade). The mouse wheel
//   scrolls the panel while the mouse is captured (js/itemui.js).
// - Head bob: a vertical camera offset of at most 0.004 u (1.4 cm) at walking speed, two bobs per 0.44 u stride. Off
//   with reduced motion, in test mode, or from the pause menu.
// - Quality: ?quality fixes the render pixel cap (low 1, medium 1.5, high 2). Without it js/quality.js adapts the render
//   pixel ratio in the briefing and in explore: on desktop between 0.75 and 2 (starting at 2), on touch devices between
//   0.6 and 1.5 (starting at 1), each limited to the device pixel ratio. It steps down when frames are late or the GPU
//   time is over 90 % of 16.7 ms, and up only where the browser reports GPU time.
// - Detail tier (js/tier.js): the scan is a base layer (scan/) and a detail layer (scan-detail/). Tier full loads the
//   detail layer after the base; tier mobile only when the device shows headroom. ?tier=full|mobile fixes it.
import { createApp, loadRoom, setDetail, SCAN_URL, DETAIL_URL, scanFiles, applyPose, setHighlight, worldToScreen, cameraForward, setViewRect, setRunning, setBackdrop, setViewDebug, setPixelCap } from './scene.js';
import { loadStrings, pick } from './i18n.js';
import { createBridge } from './embed.js';
import { installTestHooks } from './testhooks.js';
import { loadCollision } from './collision.js';
import { createController, CONTROLLER_DEFAULTS, yawPitchTo } from './controller.js';
import { createInput } from './input.js';
import { createSelector, INTERACTION_DEFAULTS } from './interaction.js';
import { createItemUI } from './itemui.js';
import { createProgress, hintFor } from './objectives.js';
import { createGameUI } from './gameui.js';
import { createQualityGovernor } from './quality.js';
import { chooseTier, readSignals, TIER_WINDOWS } from './tier.js';
import { createEntrance } from './entrance.js';
import { createMinimap } from './minimap.js'; // minimap: HUD, fog of war and the full map (README "Minimap")

const VERSION = '0.2.0';
const STEP = 1 / 120;
const $ = (id) => document.getElementById(id);
const show = (el, on) => { el.hidden = !on; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap180 = (a) => { let r = ((a + 180) % 360 + 360) % 360 - 180; if (r === -180) r = 180; return r; };
const now = () => performance.now();
const mq = (q) => { try { return window.matchMedia(q).matches; } catch (err) { return false; } };

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const EMBED = params.get('embed') === '1';
const LAUNCH = params.get('launch') === '1';
const AUTOLOAD = TEST || LAUNCH ? true : params.has('autoload') ? params.get('autoload') === '1' : !EMBED;
const RENDERER = ['auto', 'webgpu', 'webgl2'].includes(params.get('renderer')) ? params.get('renderer') : 'auto';
const QUALITY = ['low', 'medium', 'high'].includes(params.get('quality')) ? params.get('quality') : null;
// test mode only: ?gsplat=key:value,... sets PlayCanvas splat settings (app.scene.gsplat) for the benchmark
const GSPLAT = TEST && params.get('gsplat') ? Object.fromEntries(params.get('gsplat').split(',').map((kv) => {
  const [k, v] = kv.split(':');
  return [k, v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) ? Number(v) : v];
})) : null;
const SENS = Math.min(5, Math.max(0.2, Number(params.get('sens')) || 1));
const EYE = params.has('eye') && Number.isFinite(Number(params.get('eye'))) ? Number(params.get('eye')) : null;
const START_ITEM = params.get('item');
const OPEN_START = params.get('open') === '1';
// test mode opens the completion screen only with &autocomplete=1, so a test that visits every machine keeps walking
const AUTO_COMPLETE = !TEST || params.get('autocomplete') === '1';
const THEME = ['dark', 'light'].includes(params.get('theme')) ? params.get('theme') : LAUNCH ? 'dark' : 'light';
document.documentElement.dataset.theme = THEME;
const EMBEDDED = window.parent && window.parent !== window;
const TOUCH = mq('(pointer: coarse)') || 'ontouchstart' in window;
const TIER = chooseTier(readSignals(params.get('tier'), TOUCH));
const REDUCED_MOTION = mq('(prefers-reduced-motion: reduce)');
const CAPS = { low: 1, medium: 1.5, high: 2 };

const PROGRESS_KEY = 'lab-visit:v2:progress';
const SETTINGS_KEY = 'lab-visit:v2:settings';
const HINT_IDLE_MS = 30000, HINT_REPEAT_MS = 45000, HINT_SHOW_MS = 10000, HINT_PATH_MS = 250, DIR_MS = 500;
const TIP_MS = 4000;
const CARD_LEAVE_S = 1.0;  // s without focus before the info panel closes (its fade runs meanwhile)
const HELP_WALK = 1.5;      // u walked that closes the controls strip
const BOB_AMP = 0.004, BOB_STRIDE = 0.44;
const DEFAULT_VISIT_URL = 'https://maakleerplek.be/nl/agenda';
// loading tips per input device: a phone never reads about keys, a desktop never about thumbs
const TIP_KEYS = (touch) => [1, 2, 3, 4, 5].map((n) => `tip.${touch ? 'touch' : 'desktop'}.${n}`);

const hooks = { testMode: TEST, version: VERSION, events: [], messages: [], impl: null };
const G = installTestHooks(hooks);

const els = {
  app: $('app'), canvas: $('c'), corridor: $('corridor'), stickZone: $('stick-zone'), hud: $('hud'),
  objective: $('objective'), toast: $('toast'), hint: $('hint'), hintRing: $('hint-ring'), help: $('help'), pause: $('pause'),
  complete: $('complete'), lockHint: $('lock-hint'), hintButton: $('hint-button'), helpButton: $('help-button'), pauseButton: $('pause-button'),
  marker: $('marker'), card: $('card'), menu: $('menu'), announcer: $('announcer'),
  gate: $('gate'), gateHeading: $('gate-heading'), gateBody: $('gate-body'), gateStart: $('gate-start'), gateSize: $('gate-size'), gateControls: $('gate-controls'),
  loading: $('loading'), loadingTitle: $('loading-title'), loadingBar: $('loading-bar'), loadingText: $('loading-text'), loadingTip: $('loading-tip'),
  intro: $('intro'), introKicker: $('intro-kicker'), introHeading: $('intro-heading'), introBody: $('intro-body'),
  introObjectives: $('intro-objectives'), introControls: $('intro-controls'), introStart: $('intro-start'),
  error: $('error'), errorText: $('error-text'), errorRetry: $('error-retry'), fade: $('fade'),
  minimap: $('minimap'), map: $('map')
};

// ---- state shared by the boot, the loop and the hooks
let ui = 'boot';
let t, lang, config, bridge, input;
let sc = null;            // scene context
let machines, sceneData, walkpath, objectives, collision, controller, selector, itemUI, progress, gameUI;
let minimap = null, minimapData = null, fogSaveTimer = null; // minimap: null when data/minimap.json is missing
let itemsById = new Map();
let enabledItems = [];
let openId = null;
let lastFocus = null;     // last FocusState
let lastFocusId = null;   // last emitted focus id
let hiOverride = null;
let hiAmt = 0;
let pendingOpen = null;   // item id to open once in explore (?open=1)
let pendingGoto = null;   // { id, open } from the host, applied once in explore
let pendingComplete = false;
let gotoBusy = false;
let dismissedId = null;    // machine whose panel the visitor closed; it stays closed until they leave its range
let cardOut = 0;          // s the player has been out of range of the open card's machine
let bootCfg = null;       // controller config with ?sens applied
let afterGate = false;
let fullscreenApi = false;
let paused = false;       // frame loop stopped: canvas out of view or document hidden (setupPause)
let ticks = 0;            // frames run by the loop, for the pause test
let helpSeen = false;
let enteredOnce = false;
let walkedSinceHelp = 0;
let lastLockLostAt = -Infinity;
let hint = { until: 0, data: null, at: 0, auto: false };
let dir = { at: -Infinity, data: null };
let nextIdleHintAt = Infinity;
let settings = { bob: !REDUCED_MOTION };
let bob = { phase: 0, amp: 0 };
let detail = TIER.tier === 'full' ? 'pending' : 'off'; // detail layer: off, pending, loading, on, dropped, failed
let quality = { cap: QUALITY ? CAPS[QUALITY] : TOUCH ? 1 : 2, auto: !QUALITY, gov: null };
let visitUrl = DEFAULT_VISIT_URL;
let tipTimer = null;
let entrance = null;       // launch mode entrance door (js/entrance.js)
const CORRIDOR = LAUNCH && !TEST;
let appCtx = null;         // the PlayCanvas app (createApp); sc is the same object once the scan is in (loadRoom)
let prepared = false;      // prepare() ran (data, grid, UI)
let pauseFrom = 'explore'; // the state Resume returns to
let lastRoute = null;     // minimap: the hint whose route the minimap shows
const TILT_TAU = 0.2;
const TILT_RATE = 120;     // deg/s
const TILT_MIN = -35, TILT_MAX = 10;
let tilt = { id: null, off: false, restore: null }; // auto-tilt episode: focused id, stopped by the visitor, pitch to restore

// a short vibration on phones that support it (not iOS Safari); never throws
function haptic(ms = 12) {
  try { if (input && input.isTouch && typeof navigator.vibrate === 'function') navigator.vibrate(ms); } catch (err) { /* blocked */ }
}

function isEnabledId(id) {
  const it = typeof id === 'string' ? itemsById.get(id) : null;
  return !!it && it.enabled === true;
}

// localStorage can throw on access (blocked site data); null then, and the game keeps its state in memory
function safeStorage() {
  try { return window.localStorage; } catch (err) { return null; }
}
function readStore(key) {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (err) { return null; }
}
function writeStore(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* blocked or full: memory only */ }
}
function saveProgress() { writeStore(PROGRESS_KEY, { ...progress.serialize(), helpSeen, ...(minimap ? { fog: minimap.serializeFog() } : {}) }); }

function setUi(next) {
  if (next === ui) return;
  const from = ui;
  ui = next;
  hooks.events.push({ t: now(), from, to: next });
  show(els.gate, ui === 'gate');
  show(els.loading, ui === 'loading' && !CORRIDOR);
  show(els.intro, ui === 'intro');
  show(els.error, ui === 'error' && !(entrance && entrance.phase() !== 'done'));
  const playing = ui === 'explore' || ui === 'card';
  show(els.hud, playing);
  if (gameUI) {
    if (ui !== 'pause' && gameUI.isPauseOpen()) gameUI.closePause();
    if (ui !== 'complete' && gameUI.isCompleteOpen()) gameUI.hideComplete();
    if (!playing) gameUI.setHint(null, null);
  }
  if (input) input.setLockAllowed(playing);
  if (controller) controller.setFrozen(!playing);
  if (ui !== 'loading' && tipTimer) { clearInterval(tipTimer); tipTimer = null; }
  if (bridge) bridge.emit('state', { ui, focusId: selector ? selector.focusedId : null, openId });
  if (ui === 'explore') onEnterExplore();
}

function onEnterExplore() {
  if (!enteredOnce) {
    enteredOnce = true;
    nextIdleHintAt = now() + HINT_IDLE_MS;
    if (!helpSeen && !TEST) gameUI.openHelp();
  }
  if (pendingGoto) {
    const g = pendingGoto;
    pendingGoto = null;
    pendingOpen = null;
    goto(g.id, { open: g.open });
  } else if (pendingOpen) {
    const id = pendingOpen;
    pendingOpen = null;
    openCard(id);
  } else if (pendingComplete) {
    pendingComplete = false;
    showComplete();
  }
}

// ---- boot
async function boot() {
  try {
    config = await fetch('config.json').then((r) => (r.ok ? r.json() : {}));
  } catch (err) { config = {}; }
  if (typeof config.visitUrl === 'string' && /^https:\/\//.test(config.visitUrl)) visitUrl = config.visitUrl;
  const langs = ['en', 'nl'];
  lang = langs.includes(params.get('lang')) ? params.get('lang') : langs.includes(config.defaultLang) ? config.defaultLang : 'en';
  document.documentElement.lang = lang;
  bridge = createBridge({ allowedOrigins: Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [] });
  hooks.messages = bridge.log;
  bridge.on('goto', (d) => {
    if (typeof d.id !== 'string') return;
    const open = d.open !== false;
    // before the content has loaded the id cannot be checked yet; goto() checks it when it runs
    if (['boot', 'gate', 'loading', 'intro'].includes(ui)) { pendingGoto = { id: d.id, open }; return; }
    if (!['explore', 'card', 'menu', 'pause'].includes(ui) || !isEnabledId(d.id)) return;
    goto(d.id, { open });
  });
  bridge.on('close', () => {
    if (ui === 'card') closeCard();
    else if (ui === 'menu') closeMenu();
  });
  const stored = readStore(SETTINGS_KEY);
  if (stored && typeof stored.bob === 'boolean') settings.bob = stored.bob;
  try {
    t = await loadStrings(lang);
  } catch (err) {
    t = (k) => k;
    fail('load-failed', err);
    return;
  }
  document.title = t('app.title');
  els.canvas.setAttribute('aria-label', t('a11y.canvas'));
  els.gateHeading.textContent = t('app.brand');
  els.gateBody.textContent = t('gate.body');
  els.gateStart.textContent = t('gate.start');
  els.loadingTitle.textContent = t('app.brand');
  els.introKicker.textContent = t('intro.kicker');
  els.introHeading.textContent = t('app.brand');
  els.introStart.textContent = t('intro.start');
  els.errorRetry.textContent = t('error.retry');
  const ctlCfg = { ...CONTROLLER_DEFAULTS, mouseLook: CONTROLLER_DEFAULTS.mouseLook * SENS, touchLook: CONTROLLER_DEFAULTS.touchLook * SENS };
  input = createInput({ canvas: els.canvas, stickZone: els.stickZone, cfg: ctlCfg });
  // the embed flow skips the briefing after the gate, so the gate carries the controls text
  els.gateControls.textContent = t(input.isTouch ? 'intro.controlsTouch' : 'intro.controlsDesktop');
  const root = document.documentElement;
  fullscreenApi = !!(root.requestFullscreen || root.webkitRequestFullscreen) &&
    (document.fullscreenEnabled === true || document.webkitFullscreenEnabled === true);

  els.gateStart.addEventListener('click', () => { if (ui === 'gate') load(true); });
  els.errorRetry.addEventListener('click', () => { if (ui === 'error') load(afterGate); });
  els.introStart.addEventListener('click', () => {
    if (ui !== 'intro') return;
    setUi('explore');
    els.canvas.focus({ preventScroll: true });
    if (!input.isTouch) input.requestLock(); // the Start click is the gesture the browser needs
  });
  els.hintButton.addEventListener('click', () => {
    if (ui === 'explore' || ui === 'card') showHint(false);
  });
  els.helpButton.addEventListener('click', () => {
    if (ui !== 'explore' && ui !== 'card') return;
    if (gameUI.isHelpOpen()) dismissHelp(); else gameUI.openHelp();
  });
  // the HUD buttons work with the info panel open too (it does not stop play)
  els.pauseButton.addEventListener('click', () => { if (ui === 'explore' || ui === 'card') openPause(); });

  bootCfg = ctlCfg;
  if (AUTOLOAD) load(false);
  else {
    setUi('gate');
    try {
      // the scan is scan/meta.json (15 kB, fetched here) plus the textures it lists, sized with HEAD requests
      const layers = TIER.tier === 'full' ? [SCAN_URL, DETAIL_URL] : [SCAN_URL];
      const sizes = (await Promise.all(layers.map(async (u) => {
        const meta = await fetch(u).then((r) => (r.ok ? r.json() : null));
        return Promise.all(scanFiles(meta).map((f) => fetch(new URL(f, new URL(u, location.href)), { method: 'HEAD' })
          .then((r) => (r.ok ? Number(r.headers.get('content-length')) || 0 : 0))));
      }))).flat();
      const len = sizes.length && sizes.every((n) => n > 0) ? sizes.reduce((a, b) => a + b, 0) : 0;
      if (len > 0) els.gateSize.textContent = t('gate.size', { mb: Math.round(len / 1e6) });
    } catch (err) { /* size omitted */ }
  }
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function toggleFullscreen() {
  const root = document.documentElement;
  if (!fullscreenApi) { bridge.emit('fullscreen-request'); return; }
  if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else {
    const r = (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    if (r && r.catch) r.catch(() => bridge.emit('fullscreen-request'));
  }
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch ' + url + ' ' + r.status);
  return r.json();
}

function fail(code, err) {
  console.warn('lab-visit: ' + code, err);
  els.errorText.textContent = t(code === 'no-gpu' ? 'error.noGpu' : 'error.load');
  if (bridge) bridge.emit('error', { code });
  // during the entrance the error shows on the door with Try again; the door stays closed
  if (entrance && entrance.phase() !== 'done') { entrance.showError(els.errorText.textContent); return; }
  setUi('error');
}

function startTips() {
  const keys = TIP_KEYS(input ? input.isTouch : TOUCH);
  let i = Math.floor(Math.random() * keys.length);
  const next = () => { els.loadingTip.textContent = t(keys[i % keys.length]); i++; };
  next();
  if (tipTimer) clearInterval(tipTimer);
  tipTimer = setInterval(next, TIP_MS);
}

async function load(fromGate) {
  afterGate = fromGate;
  const corridor = CORRIDOR && !afterGate;
  if (!corridor || !prepared) setUi('loading');
  startTips();
  const setProgress = (loaded, total) => {
    const percent = total > 0 ? Math.min(100, Math.round((100 * loaded) / total)) : 0;
    els.loadingBar.style.setProperty('--sh-progress', percent + '%');
    els.loadingText.textContent = t('load.progress', { percent });
    if (corridor && entrance) entrance.setProgress(percent);
  };
  setProgress(0, 1);
  try {
    if (!appCtx) {
      appCtx = await createApp(els.canvas, { renderer: RENDERER, quality: QUALITY || (TOUCH ? 'low' : 'high'), gsplat: GSPLAT });
      setupPause();
    }
    if (!prepared) {
      [machines, sceneData, walkpath, objectives] = await Promise.all([fetchJson('data/machines.json'), fetchJson('data/scene.json'), fetchJson('data/walkpath.json'), fetchJson('data/objectives.json')]);
      // minimap: optional, the game runs without it
      minimapData = await loadMinimapData();
      collision = await loadCollision({ navUrl: config.navUrl === null ? null : typeof config.navUrl === 'string' ? config.navUrl : 'data/nav.json', scene: sceneData, machines, walkpath });
      prepare();
      if (corridor) enterCorridor();
    } else if (corridor && entrance) entrance.begin();
    if (!sc) {
      // the base layer of the scan (17 MB) streams while the visitor is in the corridor
      const ctx = await loadRoom(appCtx, { scanUrl: SCAN_URL, onProgress: setProgress });
      if (corridor) ctx.room.enabled = false;
      // optional: without data/backdrop.json the clear colour shows where the scan has no wall
      const backdrop = await fetchJson('data/backdrop.json').catch(() => null);
      if (backdrop && backdrop.colors) {
        setBackdrop(ctx, { boxMin: sceneData.boxMin, boxMax: sceneData.boxMax, floorY: sceneData.floorY }, backdrop.colors);
        if (corridor) ctx.backdrop.enabled = false;
      }
      sc = ctx;
    }
    // the detail layer streams in behind the visit; test mode waits for it so every view is deterministic
    if (detail === 'pending') {
      const p = loadDetail();
      if (TEST) await p;
    }
  } catch (err) {
    fail(err && err.code === 'no-gpu' ? 'no-gpu' : 'load-failed', err);
    return;
  }
  setProgress(1, 1);
  finish(corridor);
}

async function loadMinimapData() {
  try {
    const meta = await fetchJson('data/minimap.json');
    const image = new Image();
    image.src = meta.image || 'data/minimap.png';
    await image.decode();
    return { meta, image };
  } catch (err) {
    console.warn('minimap: not loaded', err);
    return null;
  }
}

function titleOf(id) {
  const it = itemsById.get(id);
  return it ? pick(it.title, lang) : id;
}

function renderBriefing() {
  els.introBody.textContent = t('intro.body', { total: progress.total });
  els.introObjectives.replaceChildren(...progress.steps().map((s) => {
    const li = document.createElement('li');
    li.textContent = t('objective.' + s.id, { left: s.need });
    return li;
  }));
  const dl = gameUI.keyTable();
  els.introControls.replaceChildren(dl);
}

// everything that needs only the data files and the walk grid: controller, selector, progress, UI
function prepare() {
  prepared = true;
  const eyeHeight = typeof machines.eyeHeight === 'number' ? machines.eyeHeight : CONTROLLER_DEFAULTS.eyeHeight;
  controller = createController(collision, { ...bootCfg, eyeHeight });
  if (EYE !== null) controller.setEyeHeight(EYE);
  itemsById = new Map(machines.items.map((it) => [it.id, it]));
  enabledItems = machines.items.filter((it) => it.enabled);
  selector = createSelector(machines.items);
  progress = createProgress({ items: machines.items, steps: objectives.steps });
  const saved = TEST ? null : readStore(PROGRESS_KEY);
  progress.load(saved);
  helpSeen = !!(saved && saved.helpSeen);
  if (TEST) settings.bob = false;
  itemUI = createItemUI({
    els: { marker: els.marker, card: els.card, menu: els.menu, visits: null, announcer: els.announcer },
    t, lang, data: machines, isTouch: input.isTouch, visitUrl,
    isFound: (id) => progress.has(id),
    onClose: () => dismissCard(),
    onGoto: (id) => { goto(id, { open: true }); },
    onMenuClose: () => closeMenu(),
    storage: TEST ? null : safeStorage()
  });
  gameUI = createGameUI({
    els, t, isTouch: input.isTouch, titleOf, visitUrl, reducedMotion: REDUCED_MOTION,
    unitMeters: typeof machines.unitMeters === 'number' ? machines.unitMeters : 3.4,
    canExit: EMBEDDED, canFullscreen: !LAUNCH && (fullscreenApi || EMBEDDED),
    on: {
      helpDismiss: dismissHelp,
      resume: () => resume(true),
      machines: () => { if (ui === 'pause') openMenu(); },
      restart: restart,
      exit: () => bridge.emit('exit'),
      bob: () => { settings.bob = !settings.bob; gameUI.setBob(settings.bob); writeStore(SETTINGS_KEY, settings); },
      fullscreen: toggleFullscreen,
      visit: () => bridge.emit('complete', { href: visitUrl }),
      keep: () => { if (ui === 'complete') setUi('explore'); }
    }
  });
  gameUI.setBob(settings.bob);
  gameUI.setFoundCount(() => progress.count);
  if (minimapData) {
    minimap = createMinimap({
      hud: els.minimap, full: els.map, meta: minimapData.meta, image: minimapData.image, items: enabledItems, areas: machines.areas,
      t, lang, pick, isTouch: input.isTouch, theme: THEME, reducedMotion: REDUCED_MOTION,
      avoid: { objective: els.objective, hudButtons: $('hud-buttons'), stickZone: els.stickZone, card: els.card },
      on: {
        open: () => { if (ui !== 'explore' && ui !== 'card') return false; if (ui === 'card') closeCard(); openMenu(); return ui === 'menu'; },
        close: () => closeMenu(),
        showWay: (id) => showWay(id),
        isFound: (id) => progress.has(id),
        // the fog is saved with the progress, at most every 2 s
        fogChanged: () => { if (!fogSaveTimer) fogSaveTimer = setTimeout(() => { fogSaveTimer = null; saveProgress(); }, 2000); }
      }
    });
    if (saved && saved.fog) minimap.loadFog(saved.fog);
  }
  const fsLabel = () => gameUI.setFullscreenLabel(!!fullscreenElement());
  document.addEventListener('fullscreenchange', fsLabel);
  document.addEventListener('webkitfullscreenchange', fsLabel);
  gameUI.renderObjective(progress);
  renderBriefing();

  if (isEnabledId(START_ITEM)) {
    teleportToItem(START_ITEM);
    if (OPEN_START) pendingOpen = START_ITEM;
  } else {
    const s = machines.spawn;
    controller.teleport(s.pos[0], s.pos[1], s.yawDeg, s.pitchDeg);
  }
  controller.setFrozen(true);
  hooks.impl = impl;
}

// the scan is ready: the frame loop, then the briefing, explore, or (corridor) a green light on the door
function finish(corridor) {
  if (!corridor) applyPose(sc, controller.state);
  sc.app.on('update', frame);
  if (corridor) entrance.ready();
  else setUi(TEST || afterGate ? 'explore' : 'intro');
  G.ready = true;
  bridge.emit('ready', { items: enabledItems.map((it) => ({ id: it.id, title: pick(it.title, lang) })), found: progress.count, total: progress.total });
}

// ---- entrance door (js/entrance.js)
function enterCorridor() {
  const sp = machines.spawn, d = sp.door;
  entrance = createEntrance({
    t, reducedMotion: REDUCED_MOTION, labelRoot: els.corridor, fadeEl: els.fade, tipEl: els.loadingTip,
    geometry: {
      door: { x0: d.opening.x0, x1: d.opening.x1, z: d.opening.z, height: d.opening.height },
      spawn: { pos: [controller.state.x, controller.state.z], yawDeg: controller.state.yaw, pitchDeg: controller.state.pitch },
      floorY: collision.floorY, eye: controller.cfg.eyeHeight
    },
    onOpen: () => { if (sc && sc.room) sc.room.enabled = true; },
    onDone: leaveCorridor,
    onRetry: () => { if (entrance.phase() === 'error') load(afterGate); }
  });
  els.corridor.hidden = false;
  entrance.attach(appCtx);
  entrance.begin();
}

// the camera stands at the spawn inside: the briefing
function leaveCorridor() {
  els.corridor.hidden = true;
  if (sc && sc.backdrop) sc.backdrop.enabled = true;
  applyPose(sc, controller.state);
  if (ui === 'loading') setUi('intro');
}

function applyRunning() {
  if (appCtx) setRunning(appCtx, !paused);
}

// ---- game layer
function discover(id) {
  const currentBefore = progress.current().id;
  const events = progress.discover(id);
  if (!events.length) return;
  saveProgress();
  haptic(15);
  nextIdleHintAt = now() + HINT_IDLE_MS;
  if (gameUI.isHelpOpen()) dismissHelp();
  // "objective complete" only for the objective on screen; an objective done out of order is skipped silently
  const step = events.find((e) => e.type === 'step' && e.id === currentBefore);
  const all = events.some((e) => e.type === 'all');
  const lines = [t('toast.found', { title: titleOf(id) })];
  if (all) lines.push(t('toast.all', { total: progress.total }));
  else if (step) lines.push(t('toast.objective'));
  else lines.push(t('objective.count', { n: progress.count, total: progress.total }));
  gameUI.toast(lines);
  gameUI.renderObjective(progress);
  dir.at = -Infinity;
  if (hint.data && hint.data.id === id) hint.until = 0;
  bridge.emit('progress', { id, found: progress.count, total: progress.total, objective: progress.current().id });
  if (all && AUTO_COMPLETE) setTimeout(() => { if (ui === 'explore' || ui === 'card') showComplete(); else pendingComplete = true; }, TEST ? 0 : 1600);
}

function showComplete() {
  if (ui === 'card') closeCard();
  if (ui !== 'explore') { pendingComplete = true; return; }
  itemUI.setMarker(null);
  setUi('complete');
  gameUI.showComplete();
}

function dismissHelp() {
  gameUI.closeHelp();
  if (!helpSeen) { helpSeen = true; saveProgress(); }
}

function showHint(auto) {
  if ((ui !== 'explore' && ui !== 'card') || progress.current().done) return null;
  hint = { until: now() + HINT_SHOW_MS, data: null, at: -Infinity, auto, wayTo: null };
  updateHint(true);
  return hint.data;
}

function updateHint(force) {
  if ((ui !== 'explore' && ui !== 'card') || hint.until <= now()) {
    // hint.at reset: back in play within HINT_PATH_MS the path is recomputed instead of read from null data
    if (hint.data) { hint.data = null; hint.at = -Infinity; gameUI.setHint(null, null); }
    return;
  }
  const s = controller.state;
  if (force || now() - hint.at > HINT_PATH_MS) {
    hint.at = now();
    // minimap: "Show the way" (hint.wayTo) aims at one chosen machine, discovered or not
    const prog = hint.wayTo ? { targets: () => [hint.wayTo], has: () => false } : progress;
    hint.data = hintFor({ progress: prog, items: machines.items, pose: { x: s.x, z: s.z, yaw: s.yaw }, collision, radius: controller.cfg.radius });
    if (!hint.data) { hint.until = 0; gameUI.setHint(null, null); return; }
    if (hint.wayTo && selector.focusedId === hint.wayTo) { hint.until = 0; hint.data = null; gameUI.setHint(null, null); return; }
  } else if (hint.data) {
    // the path is recomputed 4 times a second; between, only the turn follows the view
    const p = hint.data.aim;
    const bearing = Math.atan2(-(p.x - s.x), -(p.z - s.z)) * 180 / Math.PI;
    hint.data = { ...hint.data, turn: wrap180(bearing - s.yaw) };
  }
  const item = itemsById.get(hint.data.id);
  gameUI.setHint(hint.data, worldToScreen(sc, item.anchor));
}

// minimap: "Show the way" from the full map. Closes the map and guides along the walk path, like a hint, until the
// machine takes focus (at most WAY_MS). It never teleports.
const WAY_MS = 60000;
function showWay(id) {
  if (!isEnabledId(id)) return null;
  if (ui === 'menu') closeMenu();
  if (ui !== 'explore') return null;
  if (!input.isTouch) input.requestLock();
  hint = { until: now() + WAY_MS, data: null, at: -Infinity, auto: false, wayTo: id };
  updateHint(true);
  return hint.data;
}

function updateDirection() {
  if (ui !== 'explore' && ui !== 'card') return;
  const s = controller.state;
  if (now() - dir.at > DIR_MS) {
    dir.at = now();
    dir.data = progress.current().done ? null
      : hintFor({ progress, items: machines.items, pose: { x: s.x, z: s.z, yaw: s.yaw }, collision, radius: controller.cfg.radius });
  } else if (dir.data) {
    const p = dir.data.aim;
    dir.data = { ...dir.data, turn: wrap180(Math.atan2(-(p.x - s.x), -(p.z - s.z)) * 180 / Math.PI - s.yaw) };
  }
  gameUI.setDirection(dir.data);
}

function openPause() {
  if (ui === 'card') closeCard();
  if (ui !== 'explore') return;
  pauseFrom = ui;
  itemUI.setMarker(null);
  setUi('pause');
  gameUI.openPause();
}

function resume(capture) {
  if (ui !== 'pause') return;
  setUi('explore');
  els.canvas.focus({ preventScroll: true });
  if (capture && !input.isTouch) input.requestLock();
}

function restart() {
  dropCard();
  dismissedId = null;
  progress.reset();
  saveProgress();
  pendingComplete = false;
  hint.until = 0;
  dir.at = -Infinity;
  selector.reset();
  lastFocus = null;
  const s = machines.spawn;
  tilt = { id: null, off: false, restore: null };
  controller.teleport(s.pos[0], s.pos[1], s.yawDeg, s.pitchDeg);
  gameUI.renderObjective(progress);
  if (minimap) { minimap.resetFog(); saveProgress(); }
  if (ui === 'pause') resume(true);
  else if (ui === 'complete') setUi('explore');
  nextIdleHintAt = now() + HINT_IDLE_MS;
}

// ---- actions
function pose() {
  const s = controller.state;
  return { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
}

// opens from explore, switches from card (another machine), or straight from the menu (goto); never pauses play
function openCard(id) {
  const item = itemsById.get(id);
  if (!item || !item.enabled || !['explore', 'menu', 'card'].includes(ui)) return false;
  if (openId === id && ui === 'card') return true;
  if (openId && openId !== id) bridge.emit('close', { id: openId });
  openId = id;
  cardOut = 0;
  itemUI.openCard(item);
  haptic(10);
  bridge.emit('open', { id });
  if (ui === 'card') bridge.emit('state', { ui, focusId: selector.focusedId, openId });
  setUi('card');
  discover(id);
  return true;
}

// removes the info panel without a state change (the caller sets the state)
function dropCard() {
  if (!openId) return;
  const id = openId;
  itemUI.closeCard();
  openId = null;
  cardOut = 0;
  bridge.emit('close', { id });
}

// the visitor closed the panel (close button, Escape): it stays closed for this machine until they walk away
function dismissCard() {
  if (ui !== 'card') return;
  dismissedId = openId;
  closeCard();
}

function closeCard() {
  if (ui !== 'card') return;
  dropCard();
  setUi('explore');
}

// the panel closes once its machine has lost focus (walked away or turned away) for CARD_LEAVE_S, fading meanwhile
function checkCardRange(dt) {
  if (ui !== 'card' || !openId) return;
  const out = selector.focusedId !== openId;
  cardOut = out ? cardOut + dt : 0;
  itemUI.setCardLeaving(out);
  if (cardOut >= CARD_LEAVE_S) closeCard();
}

// minimap: the machine list lives in the full map; without data/minimap.json the old list (js/itemui.js) opens
function openMenu() {
  if (ui === 'card') closeCard();
  if (ui !== 'explore' && ui !== 'pause') return;
  itemUI.setMarker(null);
  if (minimap) minimap.openFull(); else itemUI.openMenu();
  setUi('menu');
}

function closeMenu() {
  if (ui !== 'menu') return;
  if (minimap) minimap.closeFull(); else itemUI.closeMenu();
  setUi('explore');
}

async function fadeTo(on, ms) {
  els.fade.style.transitionDuration = ms + 'ms';
  if (on) {
    els.fade.hidden = false;
    void els.fade.offsetWidth;
    els.fade.classList.add('sh-fade-on');
  } else {
    els.fade.classList.remove('sh-fade-on');
  }
  await sleep(ms);
  if (!on) els.fade.hidden = true;
}

async function goto(id, { open = true } = {}) {
  const target = itemsById.get(id);
  if (!target || !target.enabled || gotoBusy) return impl.state();
  gotoBusy = true;
  try {
    if (ui === 'menu') { if (minimap) minimap.closeFull(); else itemUI.closeMenu(); }
    if (ui === 'pause') gameUI.closePause();
    dropCard();
    await fadeTo(true, 200);
    teleportToItem(id);
    await fadeTo(false, 250);
    if (ui === 'complete') setUi('explore');
    // the frame loop may already have opened the target's panel by itself during the fade (it is in focus)
    if (open) { if (!openCard(id) && ui !== 'card') setUi('explore'); } else if (ui !== 'card') setUi('explore');
  } finally {
    gotoBusy = false;
  }
  return impl.state();
}

function teleportToItem(id) {
  const item = itemsById.get(id);
  if (!item) throw new Error('unknown item ' + id);
  // the teleport already faces the anchor; leaving the item later eases back to the spawn pitch, not to this one
  tilt = { id: item.enabled ? id : null, off: false, restore: typeof machines.spawn.pitchDeg === 'number' ? machines.spawn.pitchDeg : 0 };
  const a = item.approach;
  const r = controller.teleport(a.pos[0], a.pos[1], a.yawDeg, a.pitchDeg);
  const eyeY = controller.state.y;
  const yp = yawPitchTo([r.x, eyeY, r.z], item.anchor);
  controller.teleport(r.x, r.z, yp.yaw, Math.max(-35, Math.min(10, yp.pitch)));
  if (sc) applyPose(sc, controller.state); // ?item= places the visitor before the scan is in
  return impl.state();
}

function emitFocus(id) {
  if (id === lastFocusId) return;
  lastFocusId = id;
  bridge.emit('focus', { id });
}

// discovery on focus, after every selector update (frame loop and __game.sim)
// A machine that takes focus (in range and faced) opens its info panel by itself, which also discovers it (founder
// 2026-10-04: "no need to press E either"). A panel closed with its close button or Escape stays closed for that
// machine until the visitor leaves its range (dismissedId).
function afterSelect() {
  const id = selector.focusedId;
  if (dismissedId && dismissedId !== id) {
    const it = itemsById.get(dismissedId), s = controller.state;
    if (Math.hypot(it.anchor[0] - s.x, it.anchor[2] - s.z) > it.interactRadius * INTERACTION_DEFAULTS.exitFactor) dismissedId = null;
  }
  if (id && id !== openId && id !== dismissedId && (ui === 'explore' || ui === 'card')) openCard(id);
  else if (id && (ui === 'explore' || ui === 'card') && !progress.has(id)) discover(id);
  emitFocus(id);
}

function currentHighlight() {
  const h = lastFocus ? lastFocus.highlight : { pos: [0, -100, 0], radius: 0.14, amount: 0 };
  return hiOverride === null ? h : { pos: h.pos, radius: h.radius, amount: hiOverride };
}

// The info panel lies over the full-size view: narrowing the view while the visitor keeps walking would shift the
// centre dot and the scene each time the panel opens or closes.
function renderOverlay() {
  setViewRect(sc, null);
  const s = controller.state;
  applyPose(sc, bob.amp ? { ...s, y: s.y + bob.amp * Math.sin(bob.phase * 2 * Math.PI) } : s);
  const h = currentHighlight();
  hiAmt = h.amount;
  setHighlight(sc, h);
  gameUI.layoutTop();
  // no prompt: a machine in focus opens its panel by itself; the marker shows on the open machine
  const open = ui === 'card' && openId ? itemsById.get(openId) : null;
  itemUI.setMarker(open, open ? worldToScreen(sc, open.anchor) : null);
  updateHint(false);
  updateDirection();
  if (minimap) {
    // minimap: target ring on the hint target, else the tracker target; the route of the hint
    const h = hint.data && hint.until > now() ? hint.data : null;
    minimap.setTarget(h ? h.id : dir.data ? dir.data.id : null);
    if (h !== lastRoute) { lastRoute = h; minimap.setRoute(h ? h.path : null); }
    minimap.frame(ui, s.x, s.z, s.yaw, now());
  }
  gameUI.setCrosshair((ui === 'explore' || ui === 'card') && !input.isTouch, input.locked);
}

// ---- frame loop
function setupPause() {
  let inView = true;
  const apply = () => {
    const want = !inView || document.hidden;
    if (want === paused) return;
    paused = want;
    if (paused && input) input.releaseAll();
    applyRunning();
  };
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      apply();
    }).observe(els.canvas);
  }
  document.addEventListener('visibilitychange', apply);
}

// Pitch change (degrees) the auto-tilt adds this frame; see the header note.
function autoTiltDelta(intent, dt) {
  if (dt <= 0 || (ui !== 'explore' && ui !== 'card')) return 0;
  const s = controller.state;
  const id = selector.focusedId;
  if (intent.pitching) { tilt.off = true; tilt.restore = null; }
  if (id !== tilt.id) {
    if (id && tilt.restore === null) tilt.restore = s.pitch;
    tilt.id = id;
    tilt.off = !!intent.pitching;
  }
  if (tilt.off) return 0;
  let target;
  if (id) {
    const p = yawPitchTo([s.x, s.y, s.z], itemsById.get(id).anchor).pitch;
    target = Math.max(TILT_MIN, Math.min(TILT_MAX, p));
  } else if (tilt.restore !== null) {
    target = tilt.restore;
  } else {
    return 0;
  }
  const diff = target - s.pitch;
  if (Math.abs(diff) < 0.05) {
    if (!id) tilt.restore = null;
    return diff;
  }
  const cap = TILT_RATE * (input.reducedMotion ? 0.5 : 1) * dt;
  return Math.max(-cap, Math.min(cap, diff * (1 - Math.exp(-dt / TILT_TAU))));
}

function handleEdges(intent) {
  const t0 = now();
  if (ui === 'explore') {
    if (intent.lockLost) { lastLockLostAt = t0; openPause(); return; }
    if (intent.back && t0 - lastLockLostAt > 400) {
      if (gameUI.isHelpOpen()) dismissHelp(); else openPause();
      return;
    }
    if (intent.menu) openMenu();
    if (intent.hint) showHint(false);
  } else if (ui === 'card') {
    // the browser freed the mouse (Escape): keep playing with the panel open, so its links can be clicked
    if (intent.lockLost) { lastLockLostAt = t0; return; }
    if (intent.back && t0 - lastLockLostAt > 400) { dismissCard(); return; }
    if (intent.menu) openMenu();
    else if (intent.hint) showHint(false);
  } else if (ui === 'menu') {
    if (intent.back || intent.menu) closeMenu();
  } else if (ui === 'pause') {
    if (intent.back && t0 - lastLockLostAt > 400) { if (!gameUI.pauseBack()) resume(false); }
    else if (intent.menu) openMenu();
  } else if (ui === 'complete') {
    if (intent.back) setUi('explore');
  }
}

// Adds the detail layer of the scan (js/tier.js). A failed download leaves the base layer, which is the whole lab.
function loadDetail() {
  detail = 'loading';
  return setDetail(sc, true).then(() => { if (detail === 'loading') detail = 'on'; }, () => { detail = 'failed'; });
}

// feeds the frame time and the GPU time to the resolution governor in the briefing and explore (see the header note)
function adaptQuality(dt) {
  if (!quality.auto || !sc || (ui !== 'explore' && ui !== 'intro')) return;
  if (!quality.gov) {
    const dpr = window.devicePixelRatio || 1;
    const max = Math.min(dpr, TOUCH ? 1.5 : 2);
    const prof = sc.device.gpuProfiler;
    if (prof) prof.enabled = true; // GPU time per frame where timestamp or timer queries exist
    quality.gov = createQualityGovernor({ min: Math.min(max, TOUCH ? 0.6 : 0.75), max, start: Math.min(max, TOUCH ? 1 : 2) });
    quality.cap = setPixelCap(sc, quality.gov.ratio);
    return;
  }
  const prof = sc.device.gpuProfiler;
  const r = quality.gov.sample(dt * 1000, prof ? prof.frameTime : undefined);
  if (r !== null) quality.cap = setPixelCap(sc, r);
  // still late at the lowest resolution: drop the detail layer; plenty of headroom at the highest: add it
  if (detail === 'on' && quality.gov.slowAtMin >= TIER_WINDOWS.drop) { setDetail(sc, false); detail = 'dropped'; }
  else if (detail === 'off' && quality.gov.easyAtMax >= TIER_WINDOWS.add && !readSignals(null, TOUCH).saveData) loadDetail();
}

function frame(dtRaw) {
  ticks++;
  const dt = Math.min(0.1, Math.max(0, dtRaw || 0));
  // while the entrance door shows, js/entrance.js moves the camera
  if (entrance && entrance.phase() !== 'done') return;
  const intent = input.read(dt);
  if (gotoBusy) { renderOverlay(); return; }
  handleEdges(intent);
  if (!TEST) {
    const look = ui === 'explore' || ui === 'card' ? [intent.look[0], intent.look[1] + autoTiltDelta(intent, dt)] : [0, 0];
    const before = controller.state;
    controller.step({ move: intent.move, look, run: intent.run }, dt);
    const after = controller.state;
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    if (gameUI.isHelpOpen() && enteredOnce) { walkedSinceHelp += moved; if (walkedSinceHelp > HELP_WALK) dismissHelp(); }
    // head bob follows the distance walked; its amplitude follows the speed, so it settles when the visitor stops
    bob.phase = (bob.phase + moved / BOB_STRIDE) % 1;
    const target = settings.bob && ui === 'explore' ? BOB_AMP * Math.min(1, after.speed / controller.cfg.walkSpeed) : 0;
    bob.amp += (target - bob.amp) * (1 - Math.exp(-dt / 0.15));
    if (bob.amp < 1e-5) bob.amp = 0;
    lastFocus = selector.update(pose(), dt, { enabled: ui === 'explore' || ui === 'card' });
    afterSelect();
    checkCardRange(dt);
    if ((ui === 'explore' || ui === 'card') && now() > nextIdleHintAt) { nextIdleHintAt = now() + HINT_REPEAT_MS; showHint(true); }
    adaptQuality(dtRaw);
  }
  renderOverlay();
}

// ---- hooks implementation (SPEC.md 8)
function fullState() {
  const s = controller.state;
  return {
    ui,
    pos: [s.x, s.y, s.z],
    yaw: s.yaw,
    pitch: s.pitch,
    speed: s.speed,
    blocked: s.blocked,
    focusId: selector.focusedId,
    openId,
    walkable: collision.isWalkable(s.x, s.z, controller.cfg.radius),
    clearance: collision.clearance(s.x, s.z),
    eyeY: s.y,
    floorY: collision.floorY,
    camForward: sc ? cameraForward(sc) : null,
    ctrlForward: controller.forward(),
    collisionSource: collision.source,
    backend: sc ? sc.backend : null,
    lang,
    theme: THEME,
    launch: LAUNCH,
    visited: progress.found(),
    found: progress.found(),
    objective: progress.current(),
    hint: hint.data && hint.until > now() ? { id: hint.data.id, turn: hint.data.turn, distance: hint.data.distance, auto: hint.auto } : null,
    helpOpen: gameUI.isHelpOpen(),
    bob: settings.bob,
    locked: input.locked,
    lockSupported: input.lockSupported,
    qualityCap: quality.cap,
    qualityLog: quality.gov ? quality.gov.history : [],
    tier: TIER.tier,
    tierReasons: TIER.reasons,
    detail,
    hiAmt,
    paused,
    ticks,
    entrance: entrance ? { phase: entrance.phase(), phases: entrance.phases(), pose: entrance.pose(), swing: entrance.swing(), cut: entrance.cut(), covers: entrance.covers(), roomShown: !!(sc && sc.room && sc.room.enabled) } : null
  };
}

function simSteps(n, intent) {
  const radius = controller.cfg.radius;
  let minClearance = Infinity, nonWalkableSteps = 0, maxStepMove = 0;
  for (let i = 0; i < n; i++) {
    const a = controller.state;
    controller.step(intent, STEP);
    const b = controller.state;
    lastFocus = selector.update({ x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch }, STEP, { enabled: ui === 'explore' || ui === 'card' });
    const c = collision.clearance(b.x, b.z);
    if (c < minClearance) minClearance = c;
    if (!collision.isWalkable(b.x, b.z, radius)) nonWalkableSteps++;
    const mv = Math.hypot(b.x - a.x, b.z - a.z);
    if (mv > maxStepMove) maxStepMove = mv;
    checkCardRange(STEP);
    if (minimap && i % 12 === 11) minimap.revealAt(b.x, b.z); // minimap: the fog follows simulated walks too
  }
  afterSelect();
  return { minClearance, nonWalkableSteps, maxStepMove };
}

const impl = {
  state: fullState,
  config: () => ({ controller: { ...controller.cfg }, interaction: { ...INTERACTION_DEFAULTS }, radius: controller.cfg.radius, eyeHeight: controller.cfg.eyeHeight, unitMeters: machines.unitMeters }),
  items: () => enabledItems.slice(),
  teleport(x, z, yaw = 0, pitch = 0) {
    tilt = { id: null, off: false, restore: null };
    controller.teleport(x, z, yaw, pitch);
    applyPose(sc, controller.state);
    return fullState();
  },
  teleportToItem,
  lookAt(p) {
    controller.lookAt(p);
    applyPose(sc, controller.state);
    return fullState();
  },
  setInput(intent) { input.setOverride(intent || null); },
  tilt: () => ({ ...tilt }),
  sim(seconds, intent = {}) {
    const n = Math.max(1, Math.round(seconds / STEP));
    const r = simSteps(n, intent || {});
    renderOverlay();
    return { state: fullState(), ...r };
  },
  async walkTo(x, z, { run = false, maxSeconds = 60 } = {}) {
    const radius = controller.cfg.radius;
    const s0 = controller.state;
    const path = collision.findPath({ x: s0.x, z: s0.z }, { x, z }, radius);
    if (!path) return { reached: false, pos: [s0.x, s0.z], seconds: 0, pathLength: 0, nonWalkableSteps: 0 };
    let pathLength = 0;
    for (let i = 1; i < path.length; i++) pathLength += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    const goal = path[path.length - 1];
    let wi = Math.min(1, path.length - 1);
    let steps = 0, nonWalkableSteps = 0, reached = false;
    const maxSteps = Math.round(maxSeconds / STEP);
    while (steps < maxSteps) {
      const s = controller.state;
      if (Math.hypot(goal.x - s.x, goal.z - s.z) <= 0.04) { reached = true; break; }
      while (wi < path.length - 1 && Math.hypot(path[wi].x - s.x, path[wi].z - s.z) <= 0.03) wi++;
      const w = path[wi];
      const yp = yawPitchTo([s.x, 0, s.z], [w.x, 0, w.z]);
      const r = simSteps(1, { move: [0, 1], run, look: [wrap180(yp.yaw - s.yaw), -s.pitch] });
      nonWalkableSteps += r.nonWalkableSteps;
      steps++;
      if (steps % 600 === 0) { renderOverlay(); await sleep(0); }
    }
    controller.step({ look: [0, 0] }, 0);
    renderOverlay();
    const e = controller.state;
    return { reached, pos: [e.x, e.z], seconds: steps * STEP, pathLength, nonWalkableSteps };
  },
  nearestItem() {
    const c = selector.candidates(pose());
    return c.length ? c[0] : null;
  },
  candidates: () => selector.candidates(pose()),
  interact() {
    if ((ui !== 'explore' && ui !== 'card') || !selector.focusedId) return false;
    return openCard(selector.focusedId);
  },
  closeCard() { dismissCard(); return fullState(); },
  openMenu() { openMenu(); return fullState(); },
  closeMenu() { closeMenu(); return fullState(); },
  goto: (id, opts) => goto(id, opts),
  screenOf(id) {
    const item = itemsById.get(id);
    if (!item) return null;
    applyPose(sc, controller.state);
    return worldToScreen(sc, item.anchor);
  },
  setHighlightOverride(amount) {
    hiOverride = amount === null || amount === undefined ? null : Number(amount);
    renderOverlay();
    return fullState();
  },
  viewDebug(opts) {
    setViewDebug(sc, opts || {});
    return { backdrop: !!(sc.backdrop && sc.backdrop.enabled) };
  },
  collisionCall(name, args) {
    return collision[name](...args);
  },
  // game layer
  progress: () => ({ found: progress.found(), count: progress.count, total: progress.total, objective: progress.current(), completed: progress.completed, targets: progress.targets() }),
  showHint() { const h = showHint(false); renderOverlay(); return h; },
  discover(id) { discover(id); renderOverlay(); return fullState(); },
  resetProgress() { restart(); return fullState(); },
  pause() { openPause(); return fullState(); },
  resume() { resume(false); return fullState(); },
  closeComplete() { if (ui === 'complete') setUi('explore'); return fullState(); },
  openHelp() { gameUI.openHelp(); return fullState(); },
  dismissHelp() { dismissHelp(); return fullState(); },
  // the launch entrance: skip the door opening (a click or a key does the same)
  entranceSkip() { if (entrance) entrance.skip(); return fullState(); },
  // minimap
  minimap: () => (minimap ? minimap.debug() : null),
  minimapCall(name, args) { return minimap ? minimap[name](...args) : null; },
  showWay(id) { const h = showWay(id); renderOverlay(); return h; }
};

boot().catch((err) => { console.error(err); });
