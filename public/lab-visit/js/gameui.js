// Game UI: briefing, loading tips, objective tracker with direction pointer, discovery toast, hint pointer, controls
// strip, pause menu, completion screen and the centre dot. Uses the DOM, never imports PlayCanvas. Class prefix gm-.
// Every string comes from t(). main.js owns the logic (js/objectives.js) and calls these renderers; this module only
// draws and reports clicks through the callbacks.

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW = 'M12 3 L19 13 H14.5 V21 H9.5 V13 H5 Z';

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

function icon(d, size = 20, fill = true) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  if (fill) p.setAttribute('fill', 'currentColor');
  else {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2.4');
    p.setAttribute('stroke-linecap', 'round');
  }
  s.append(p);
  return s;
}

// [key label i18n key, action i18n key] per input device
// compact: the in-game strip leaves out Shift and M (the briefing and the pause menu show every row)
export function controlRows(isTouch, compact = false) {
  if (compact && !isTouch) {
    return [['help.lookKey', 'help.look'], ['help.walkKey', 'help.walk'],
      ['help.hintKey', 'help.hint'], ['help.pauseKey', 'help.pause']];
  }
  return isTouch
    ? [['help.touchWalkKey', 'help.walk'], ['help.touchLookKey', 'help.look'],
      ['help.touchHintKey', 'help.hint'], ['help.touchPauseKey', 'help.pauseTouch']]
    : [['help.lookKey', 'help.look'], ['help.walkKey', 'help.walk'], ['help.runKey', 'help.run'],
      ['help.hintKey', 'help.hint'], ['help.listKey', 'help.list'], ['help.pauseKey', 'help.pause']];
}

export function createGameUI({
  els, // objective toast hint hintRing help pause complete lockHint hintButton helpButton pauseButton
  t,
  isTouch = false,
  titleOf, // (id) -> localized title
  unitMeters = 3.4,
  visitUrl = null,
  canExit = false,
  canFullscreen = false,
  reducedMotion = false,
  on = {} // helpDismiss resume machines restart exit bob fullscreen visit keep
}) {
  const tx = (k, v) => (typeof t === 'function' ? t(k, v) : k);
  const call = (name, ...a) => { if (typeof on[name] === 'function') on[name](...a); };
  const keyTable = (compact = false) => el('dl', { class: 'gm-keys' }, controlRows(isTouch, compact).flatMap(([k, label]) => [
    el('dt', {}, [el('kbd', { class: 'gm-kbd', text: tx(k) })]),
    el('dd', { text: tx(label) })
  ]));

  // ---------- objective tracker, with a direction pointer toward the next objective ----------
  els.objective.classList.add('gm-objective');
  const objTitle = el('span', { class: 'gm-obj-title', text: tx('objective.title') });
  const objCount = el('span', { class: 'gm-obj-count' });
  const objText = el('span', { class: 'gm-obj-text', 'aria-live': 'polite' });
  const objArrow = el('span', { class: 'gm-obj-arrow' }, [icon(ARROW, 14)]);
  const objDist = el('span', { class: 'gm-obj-dist' });
  const objDir = el('span', { class: 'gm-obj-dir', 'aria-hidden': 'true', hidden: true }, [objArrow, objDist]);
  const objBar = el('span', { class: 'gm-obj-bar' }, [el('span', { class: 'gm-obj-fill' })]);
  els.objective.replaceChildren(el('span', { class: 'gm-obj-head' }, [objTitle, objCount]),
    el('span', { class: 'gm-obj-line' }, [objText, objDir]), objBar);
  let lastObjKey = null;

  function renderObjective(progress) {
    const c = progress.current();
    const key = `${progress.count}|${c.id}|${c.left}`;
    if (key === lastObjKey) return;
    const changed = lastObjKey !== null && lastObjKey.split('|')[1] !== String(c.id);
    lastObjKey = key;
    objCount.textContent = tx('objective.count', { n: progress.count, total: progress.total });
    objText.textContent = c.done ? tx('objective.done') : tx('objective.' + c.id, { left: c.left });
    objBar.firstChild.style.width = `${(100 * progress.count) / Math.max(1, progress.total)}%`;
    els.objective.dataset.step = c.id || 'done';
    if (changed && !reducedMotion) {
      els.objective.classList.remove('gm-flash');
      void els.objective.offsetWidth;
      els.objective.classList.add('gm-flash');
    }
  }
  // h: hintFor() result or null
  // called every frame: writes the DOM only when the shown value changes
  let dirRot = null, dirM = null;
  function setDirection(h) {
    if (!h) { if (!objDir.hidden) objDir.hidden = true; return; }
    if (objDir.hidden) objDir.hidden = false;
    const rot = (-h.turn).toFixed(0);
    if (rot !== dirRot) { dirRot = rot; objArrow.style.transform = `rotate(${rot}deg)`; }
    const m = Math.max(1, Math.round(h.distance * unitMeters));
    if (m !== dirM) { dirM = m; objDist.textContent = tx('hint.meters', { m }); }
  }

  // ---------- toast ----------
  els.toast.classList.add('gm-toast');
  els.toast.setAttribute('role', 'status');
  let toastTimer = null;
  let toastShownAt = 0;
  const toastQueue = [];
  // a toast shows at least TOAST_MIN ms before the next one replaces it (the door's "Objective complete" is not
  // replaced at once by a discovery right inside the door)
  const TOAST_MIN = 1400;
  function toast(lines, ms = 2600) {
    const age = performance.now() - toastShownAt;
    if (!els.toast.hidden && age < TOAST_MIN) {
      if (!toastQueue.length) setTimeout(() => { const n = toastQueue.shift(); if (n) showToast(n[0], n[1]); }, TOAST_MIN - age);
      toastQueue.length = 0;
      toastQueue.push([lines, ms]);
      return;
    }
    showToast(lines, ms);
  }
  function showToast(lines, ms) {
    toastShownAt = performance.now();
    els.toast.replaceChildren(...lines.map((l, i) => el('span', { class: i === 0 ? 'gm-toast-main' : 'gm-toast-sub', text: l })));
    els.toast.hidden = false;
    els.toast.classList.remove('gm-toast-in');
    void els.toast.offsetWidth;
    els.toast.classList.add('gm-toast-in');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  // ---------- hint pointer ----------
  els.hint.classList.add('gm-hint');
  els.hint.setAttribute('aria-hidden', 'true');
  const arrow = el('span', { class: 'gm-hint-arrow' }, [icon(ARROW, 26)]);
  const hintText = el('span', { class: 'gm-hint-text' });
  els.hint.replaceChildren(arrow, hintText);
  els.hintRing.classList.add('gm-ring');
  els.hintRing.setAttribute('aria-hidden', 'true');
  els.hintRing.replaceChildren(el('span', { class: 'gm-ring-label' }));
  let hintKey = null;

  // h: hintFor() result or null; screen: worldToScreen of the target anchor or null
  function setHint(h, screen) {
    if (!h) {
      if (!els.hint.hidden) els.hint.hidden = true;
      if (!els.hintRing.hidden) els.hintRing.hidden = true;
      hintKey = null;
      return;
    }
    const m = Math.max(1, Math.round(h.distance * unitMeters));
    const key = `${h.id}|${m}`;
    if (key !== hintKey) {
      hintKey = key;
      hintText.textContent = tx('hint.label', { title: titleOf(h.id), m });
      els.hintRing.firstChild.textContent = titleOf(h.id);
    }
    // CSS rotation is clockwise; turn is positive to the left
    arrow.style.transform = `rotate(${(-h.turn).toFixed(1)}deg)`;
    els.hint.dataset.target = h.id;
    if (els.hint.hidden) els.hint.hidden = false;
    if (screen && screen.onScreen) {
      els.hintRing.style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px)`;
      if (els.hintRing.hidden) els.hintRing.hidden = false;
    } else if (!els.hintRing.hidden) {
      els.hintRing.hidden = true;
    }
  }

  // ---------- controls strip (first visit), not modal ----------
  els.help.classList.add('gm-help');
  els.help.setAttribute('role', 'region');
  els.help.setAttribute('aria-labelledby', 'gm-help-title');
  const dismiss = el('button', { type: 'button', class: 'gm-btn gm-btn-accent gm-help-ok', text: tx('help.dismiss') });
  dismiss.addEventListener('click', () => call('helpDismiss'));
  els.help.replaceChildren(el('h2', { id: 'gm-help-title', class: 'gm-help-title', text: tx('help.title') }), keyTable(true), dismiss);
  const openHelp = () => { els.help.hidden = false; };
  const closeHelp = () => { els.help.hidden = true; };

  // ---------- HUD buttons ----------
  els.hintButton.textContent = tx('hint.button');
  els.hintButton.setAttribute('aria-keyshortcuts', 'H');
  els.helpButton.replaceChildren(el('span', { 'aria-hidden': 'true', text: '?' }));
  els.helpButton.setAttribute('aria-label', tx('help.title'));
  els.helpButton.setAttribute('title', tx('help.title'));
  els.pauseButton.replaceChildren(icon('M7 5 H10.5 V19 H7 Z M13.5 5 H17 V19 H13.5 Z', 18));
  els.pauseButton.setAttribute('aria-label', tx('pause.title'));
  els.pauseButton.setAttribute('title', tx('pause.title'));

  // ---------- pause menu ----------
  els.pause.classList.add('gm-pause');
  els.pause.setAttribute('role', 'dialog');
  els.pause.setAttribute('aria-modal', 'true');
  els.pause.setAttribute('aria-labelledby', 'gm-pause-title');
  const btn = (key, cls, fn, id) => {
    const b = el('button', { type: 'button', class: 'gm-btn ' + (cls || ''), id, text: tx(key) });
    b.addEventListener('click', fn);
    return b;
  };
  const resume = btn('pause.resume', 'gm-btn-accent', () => call('resume'), 'gm-resume');
  const bobBtn = el('button', { type: 'button', class: 'gm-btn gm-toggle', id: 'gm-bob', 'aria-pressed': 'false' });
  bobBtn.addEventListener('click', () => call('bob'));
  const mainList = el('div', { class: 'gm-pause-list' }, [
    resume,
    btn('pause.machines', '', () => call('machines'), 'gm-machines'),
    btn('pause.controls', '', () => showControls(true), 'gm-controls'),
    bobBtn,
    canFullscreen ? btn('fullscreen.enter', '', () => call('fullscreen'), 'gm-fullscreen') : null,
    btn('pause.restart', '', () => showConfirm(true), 'gm-restart'),
    canExit ? btn('pause.exit', 'gm-btn-quiet', () => call('exit'), 'gm-exit') : null
  ]);
  const back = btn('pause.back', 'gm-btn-accent', () => showControls(false), 'gm-pause-back');
  const controlsBox = el('div', { class: 'gm-pause-controls', hidden: true }, [keyTable(), back]);
  // Restart asks first: one click must not wipe the visitor's progress (QA 2026-10-04)
  const confirmBody = el('p', { class: 'gm-confirm-body' });
  const confirmNo = btn('pause.confirmNo', 'gm-btn-accent', () => showConfirm(false), 'gm-restart-no');
  const confirmYes = btn('pause.confirmYes', '', () => { showConfirm(false); call('restart'); }, 'gm-restart-yes');
  const confirmBox = el('div', { class: 'gm-pause-confirm', hidden: true, role: 'alertdialog', 'aria-labelledby': 'gm-confirm-title' }, [
    el('h3', { id: 'gm-confirm-title', class: 'gm-confirm-title', text: tx('pause.confirmTitle') }), confirmBody, confirmNo, confirmYes
  ]);
  let foundCount = () => 0;
  els.pause.replaceChildren(el('div', { class: 'gm-panel gm-pause-panel' }, [
    el('p', { class: 'gm-kicker', text: tx('app.brand') }),
    el('h2', { id: 'gm-pause-title', class: 'gm-panel-title', text: tx('pause.title') }),
    mainList, controlsBox, confirmBox
  ]));
  function showControls(onOff) {
    confirmBox.hidden = true;
    controlsBox.hidden = !onOff;
    mainList.hidden = onOff;
    (onOff ? back : resume).focus({ preventScroll: true });
  }
  function showConfirm(onOff) {
    controlsBox.hidden = true;
    confirmBody.textContent = tx('pause.confirmBody', { n: foundCount() });
    confirmBox.hidden = !onOff;
    mainList.hidden = onOff;
    // the safe choice has the focus, so Enter or Space cancels
    (onOff ? confirmNo : els.pause.querySelector('#gm-restart')).focus({ preventScroll: true });
  }
  // Escape inside the pause menu: leaves the confirm step or the controls first (true when it did)
  function pauseBack() {
    if (!confirmBox.hidden) { showConfirm(false); return true; }
    if (!controlsBox.hidden) { showControls(false); return true; }
    return false;
  }
  function setBob(onOff) {
    bobBtn.textContent = tx(onOff ? 'pause.bobOn' : 'pause.bobOff');
    bobBtn.setAttribute('aria-pressed', onOff ? 'true' : 'false');
  }
  function setFullscreenLabel(isFull) {
    const b = els.pause.querySelector('#gm-fullscreen');
    if (b) b.textContent = tx(isFull ? 'fullscreen.exit' : 'fullscreen.enter');
  }
  // machinesEnabled false: during the launch entrance the machine list (and its Go there) waits for the door
  function openPause(machinesEnabled = true) {
    const m = els.pause.querySelector('#gm-machines');
    if (m) m.disabled = !machinesEnabled;
    showControls(false); els.pause.hidden = false; resume.focus({ preventScroll: true });
  }
  function closePause() { els.pause.hidden = true; }

  // ---------- completion screen ----------
  els.complete.classList.add('gm-complete');
  els.complete.setAttribute('role', 'dialog');
  els.complete.setAttribute('aria-modal', 'true');
  els.complete.setAttribute('aria-labelledby', 'gm-complete-title');
  const visit = el('a', { class: 'gm-btn gm-btn-accent', id: 'gm-visit', href: visitUrl || '#', target: '_blank', rel: 'noopener', text: tx('complete.visit') });
  visit.addEventListener('click', (e) => call('visit', e));
  els.complete.replaceChildren(el('div', { class: 'gm-panel gm-complete-panel' }, [
    el('p', { class: 'gm-kicker', text: tx('app.brand') }),
    el('h2', { id: 'gm-complete-title', class: 'gm-panel-title', text: tx('complete.heading') }),
    el('p', { class: 'gm-complete-body', text: tx('complete.body') }),
    el('p', { class: 'gm-complete-hours', text: tx('complete.hours') }),
    el('div', { class: 'gm-complete-actions' }, [
      visit,
      btn('complete.keep', '', () => call('keep'), 'gm-keep'),
      canExit ? btn('pause.exit', 'gm-btn-quiet', () => call('exit'), 'gm-complete-exit') : null
    ])
  ]));
  function showComplete() { els.toast.hidden = true; els.complete.hidden = false; visit.focus({ preventScroll: true }); }
  function hideComplete() { els.complete.hidden = true; }

  // ---------- top stack: toast, hint and controls strip never overlap the HUD (QA 2026-10-04: on a 390 x 844 phone
  // the toast covered the objective tracker). Each element that sits at the top is placed at the first height,
  // from the top gutter down, where it overlaps neither the tracker, the HUD buttons, the side panel of the card nor
  // an element placed before it, centred in the width the card leaves free. An element that would reach the bottom
  // sheet of the card waits, hidden, until there is room (on short landscape phones the
  // hint waits for the toast to go). Returns the bottom of the stack (px from the top of #app).
  const GAP = 8;
  const hudButtons = els.hintButton ? els.hintButton.parentElement : null;
  function layoutTop() {
    const host = els.toast.parentElement;
    const hr = host.getBoundingClientRect();
    const rel = (r) => ({ left: r.left - hr.left, right: r.right - hr.left, top: r.top - hr.top, bottom: r.bottom - hr.top });
    const visible = (e) => e && !e.hidden && e.offsetParent !== null;
    const blocks = [];
    if (visible(els.objective)) blocks.push(rel(els.objective.getBoundingClientRect()));
    if (visible(hudButtons)) blocks.push(rel(hudButtons.getBoundingClientRect()));
    const minimapEl = document.getElementById('minimap'); // minimap: a HUD block too (js/minimap.js places it first)
    if (visible(minimapEl)) blocks.push(rel(minimapEl.getBoundingClientRect()));
    let bandL = 16, bandR = hr.width - 16;
    if (visible(els.card)) {
      const c = rel(els.card.getBoundingClientRect());
      if (c.right - c.left < 0.8 * hr.width) { blocks.push(c); bandR = Math.min(bandR, c.left - GAP); }
    }
    let bottomLimit = hr.height;
    if (visible(els.card)) {
      const c = rel(els.card.getBoundingClientRect());
      if (c.right - c.left >= 0.8 * hr.width) bottomLimit = Math.min(bottomLimit, c.top);
    }
    const safeTop = blocks.length ? Math.min(...blocks.map((b) => b.top)) : 16;
    let stackBottom = blocks.reduce((m, b) => Math.max(m, b.bottom), 0);
    for (const e of [els.toast, els.hint, els.help]) {
      const alignLeft = e === els.help; // the controls strip sits under the tracker, the others in the centre
      if (!visible(e)) continue;
      // the stylesheet decides whether the element sits at the top (toast always; hint and controls strip on narrow
      // or touch screens): read its own place first
      e.style.top = e.style.left = e.style.maxWidth = '';
      e.style.visibility = '';
      const own = e.getBoundingClientRect();
      if (own.top - hr.top > hr.height / 2) continue;
      const w = Math.min(e.offsetWidth, bandR - bandL), h = e.offsetHeight;
      const cx = alignLeft ? bandL + w / 2 : (bandL + bandR) / 2;
      const box = { left: cx - w / 2, right: cx + w / 2 };
      let top = safeTop;
      for (let guard = 0; guard < 8; guard++) {
        const hit = blocks.find((b) => b.left < box.right && b.right > box.left && b.top < top + h && b.bottom > top);
        if (!hit) break;
        top = hit.bottom + GAP;
      }
      e.style.top = Math.round(top) + 'px';
      e.style.left = Math.round(alignLeft ? cx - w / 2 : cx) + 'px';
      e.style.maxWidth = Math.floor(bandR - bandL) + 'px';
      if (top + h > bottomLimit - GAP) { e.style.visibility = 'hidden'; continue; }
      blocks.push({ ...box, top, bottom: top + h });
      stackBottom = Math.max(stackBottom, top + h);
    }
    return stackBottom;
  }

  // ---------- centre dot (desktop), with the release text while the mouse is captured ----------
  els.lockHint.classList.add('gm-lock');
  els.lockHint.setAttribute('aria-hidden', 'true');
  els.lockHint.replaceChildren(el('span', { class: 'gm-crosshair' }), el('span', { class: 'gm-lock-text', text: tx('lock.release') }));
  let lockShownAt = 0;
  let wasLocked = false;
  function setCrosshair(show, locked) {
    if (locked && !wasLocked) { lockShownAt = performance.now(); els.lockHint.classList.remove('gm-lock-quiet'); }
    wasLocked = locked;
    els.lockHint.classList.toggle('gm-locked', !!locked);
    if (els.lockHint.hidden === !!show) els.lockHint.hidden = !show;
    // the release text fades after a few seconds; the dot stays
    if (locked && performance.now() - lockShownAt > 4000) els.lockHint.classList.add('gm-lock-quiet');
  }

  return {
    renderObjective, setDirection, toast, setHint, openHelp, closeHelp,
    isHelpOpen: () => !els.help.hidden,
    openPause, closePause, isPauseOpen: () => !els.pause.hidden, setBob, setFullscreenLabel, pauseBack,
    isConfirmOpen: () => !els.pause.hidden && !confirmBox.hidden,
    setFoundCount: (fn) => { foundCount = fn; },
    showComplete, hideComplete,
    isCompleteOpen: () => !els.complete.hidden,
    setCrosshair,
    layoutTop,
    keyTable
  };
}
