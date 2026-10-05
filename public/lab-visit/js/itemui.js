// Item UI (owner: interaction, SPEC.md 4.3 and 4.4). Uses the DOM, never imports PlayCanvas.
//
// Decisions where the spec leaves room (simplest option chosen):
// - Per frame only the marker position is updated.
// - An announcement suppressed by the 1.5 s limit is kept pending and spoken on a later setMarker call
//   once the limit has passed, if the same panel is still open.
// - Source numbering: the summary source first, then fact sources in order; identical URLs share a number.
//   Each [n] link is named t('card.sourceRef', {n, title}) for screen readers.
// - The proximity announcement reads the machine's title (its card opens by itself, js/main.js afterSelect).
// - The links block has no heading (section 6 defines no key for one).
// - The menu lists enabled items only, grouped by data.areas order. The visited mark is a disabled,
//   checked checkbox labelled by the item title, so screen readers report it without a new string.
// - The menu is a modal dialog: Tab is kept inside, Escape is left to main.js. The card is a non-modal info panel
//   (role region): it never takes keyboard focus, so walking and looking go on while it is open. Enter and Space
//   keydowns on buttons and links inside card and menu stop propagating so that activating a control does
//   not also fire the interact key.
// - Mouse wheel anywhere outside the card (the captured mouse sends it to the canvas) scrolls the open card, so a
//   long card never needs the mouse freed. setCardLeaving(true) fades the card while the visitor walks away.
// - closeCard and closeMenu return focus to the canvas #c.
// - The "At this lab" rows show only the fields the lab has filled; an empty field is left out, and with no field
//   filled the block is left out. The card ends with a link to the lab's opening hours and agenda (visitUrl).
// - The menu ticks the machines the visitor has discovered (isFound, from js/objectives.js through main.js). The
//   discovered count lives in the objective panel (js/gameui.js); #visits is optional.

const STORAGE_KEY = 'lab-visit:v1:visited';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ANNOUNCE_GAP_MS = 1500;

function pick(field, lang) {
  if (field == null) return null;
  if (typeof field === 'string') return field;
  const v = field[lang];
  return v != null ? v : field.en != null ? field.en : null;
}

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

function closeIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', 'M6 6 L18 18 M18 6 L6 18');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2.2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('fill', 'none');
  svg.append(p);
  return svg;
}

function isHttps(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url);
}

function canvasEl() {
  return document.getElementById('c');
}

function focusables(root) {
  return [...root.querySelectorAll('button, a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.offsetParent !== null);
}

function trapTab(root) {
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = focusables(root);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

function shieldActivationKeys(root) {
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (t && t.closest && t.closest('button, a[href]')) e.stopPropagation();
  });
}

export function createItemUI({
  els,
  t,
  lang = 'en',
  data,
  isTouch = false,
  onClose = () => {},
  onGoto = () => {},
  onMenuClose = () => {},
  isFound = null,
  visitUrl = null,
  storage = null
}) {
  const { marker, card, menu, visits, announcer } = els;
  const items = (data && data.items) || [];
  const enabled = items.filter((it) => it.enabled === true);
  const areas = (data && data.areas) || [];
  const tx = (key, vars) => (typeof t === 'function' ? t(key, vars) : key);

  marker.classList.add('it-marker');
  card.classList.add('it-card');
  menu.classList.add('it-menu');
  if (visits) visits.classList.add('it-visits');
  marker.setAttribute('aria-hidden', 'true');
  card.setAttribute('role', 'region');
  card.setAttribute('aria-labelledby', 'it-card-title');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'true');
  menu.setAttribute('aria-labelledby', 'it-menu-title');
  trapTab(menu);
  // --it-sheet-h on the card's parent: the height of the bottom sheet (narrow screens), 0 for the side panel; the
  // stick zone sits above it (css/controller.css, css/interaction.css)
  const host = card.parentElement;
  const syncSheet = () => {
    if (!host) return;
    const r = card.hidden ? null : card.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const sheet = r && r.width >= 0.8 * hr.width && r.height > 0;
    host.style.setProperty('--it-sheet-h', sheet ? Math.ceil(hr.bottom - r.top) + 'px' : '0px');
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(syncSheet).observe(card);
  window.addEventListener('resize', syncSheet);
  // wheel outside the card scrolls it (inside, the browser scrolls it natively)
  window.addEventListener('wheel', (e) => {
    if (card.hidden || card.contains(e.target)) return;
    const body = card.querySelector('.it-card-body');
    if (!body) return;
    body.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    e.preventDefault();
  }, { passive: false });
  shieldActivationKeys(card);
  shieldActivationKeys(menu);

  // ---------- visited ----------
  let visitedIds = [];
  try {
    const raw = storage ? storage.getItem(STORAGE_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) visitedIds = arr.filter((x) => typeof x === 'string');
  } catch (_) {
    visitedIds = [];
  }

  function saveVisited() {
    try {
      if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(visitedIds));
    } catch (_) {
      // storage blocked or full: the in-memory list still works
    }
  }

  const done = (id) => (isFound ? isFound(id) : visitedIds.includes(id));
  const doneCount = () => enabled.filter((it) => done(it.id)).length;

  function renderVisits() {
    if (!visits) return;
    const ids = new Set(enabled.map((it) => it.id));
    const n = visitedIds.filter((id) => ids.has(id)).length;
    visits.textContent = tx('visits.count', { n, total: enabled.length });
  }

  function markVisited(id) {
    if (!visitedIds.includes(id)) {
      visitedIds.push(id);
      saveVisited();
    }
    renderVisits();
  }

  renderVisits();

  // ---------- marker, announcer ----------
  let markerId = null;
  let lastAnnouncedId = null;
  let lastAnnounceAt = -Infinity;
  let pendingAnnounceId = null;

  function announce(item) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastAnnounceAt < ANNOUNCE_GAP_MS) {
      pendingAnnounceId = item.id;
      return;
    }
    pendingAnnounceId = null;
    lastAnnounceAt = now;
    lastAnnouncedId = item.id;
    announcer.textContent = pick(item.title, lang);
  }

  // the diamond over the machine whose panel is open, and its title for screen readers (no prompt: panels open by
  // themselves, js/main.js afterSelect)
  function setMarker(item, screen) {
    if (!item) {
      if (!marker.hidden) marker.hidden = true;
      markerId = null;
      pendingAnnounceId = null;
      lastAnnouncedId = null;
      return;
    }
    if (item.id !== markerId) {
      markerId = item.id;
      if (item.id !== lastAnnouncedId) announce(item);
    } else if (pendingAnnounceId === item.id) {
      announce(item);
    }
    if (screen && screen.onScreen) {
      marker.style.transform = `translate(${Math.round(screen.x)}px, ${Math.round(screen.y)}px)`;
      if (marker.hidden) marker.hidden = false;
    } else if (!marker.hidden) marker.hidden = true;
  }

  // ---------- card ----------
  let openId = null;

  function areaLabel(item) {
    const a = areas.find((x) => x.id === item.area);
    return a ? pick(a.label, lang) : null;
  }

  function renderCard(item) {
    const sources = [];
    const numberOf = (src) => {
      if (!src || !isHttps(src.url)) return null;
      let i = sources.findIndex((s) => s.url === src.url);
      if (i < 0) {
        sources.push(src);
        i = sources.length - 1;
      }
      return i + 1;
    };
    const refLink = (src) => {
      const n = numberOf(src);
      if (n == null) return null;
      return el('a', {
        class: 'it-ref',
        href: src.url,
        target: '_blank',
        rel: 'noopener',
        title: src.title || src.url,
        'aria-label': tx('card.sourceRef', { n, title: src.title || src.url }),
        text: `[${n}]`
      });
    };

    const close = el('button', { type: 'button', class: 'it-close', 'aria-label': tx('card.close') }, [closeIcon()]);
    close.addEventListener('click', () => onClose());

    const head = el('div', { class: 'it-card-head' }, [
      areaLabel(item) ? el('span', { class: 'it-chip', text: areaLabel(item) }) : el('span'),
      close
    ]);

    const body = el('div', { class: 'it-card-body' });
    body.append(el('h2', { id: 'it-card-title', class: 'it-card-title', text: pick(item.title, lang) }));

    const summaryText = item.summary ? pick(item.summary.text, lang) : null;
    if (summaryText) {
      const p = el('p', { class: 'it-summary' }, [document.createTextNode(summaryText + ' ')]);
      const ref = refLink(item.summary.source);
      if (ref) p.append(ref);
      body.append(p);
    }

    body.append(el('h3', { class: 'it-h3', text: tx('card.facts') }));
    const facts = Array.isArray(item.facts) ? item.facts : [];
    if (facts.length) {
      const ul = el('ul', { class: 'it-facts' });
      for (const f of facts) {
        const label = pick(f.label, lang);
        const text = pick(f.text, lang);
        if (!text) continue;
        const li = el('li', { class: 'it-fact' });
        if (label) li.append(el('span', { class: 'it-fact-label', text: `${label}: ` }));
        li.append(document.createTextNode(text + ' '));
        const ref = refLink(f.source);
        if (ref) li.append(ref);
        ul.append(li);
      }
      body.append(ul);
    } else {
      body.append(el('p', { class: 'it-empty', text: tx('card.noFacts') }));
    }

    const LAB_FIELDS = ['whoCanUse', 'inductionRequired', 'booking', 'whoToAsk', 'safetyNotes', 'costAndMaterials', 'openingHours'];
    const labRows = LAB_FIELDS.map((k) => [k, item.lab ? pick(item.lab[k], lang) : null]).filter(([, v]) => v);
    if (labRows.length) {
      body.append(el('h3', { class: 'it-h3', text: tx('card.atThisLab') }));
      const dl = el('dl', { class: 'it-lab' });
      for (const [k, v] of labRows) {
        dl.append(el('dt', { class: 'it-lab-label', text: tx(`lab.${k}`) }));
        dl.append(el('dd', { class: 'it-lab-value', text: v }));
      }
      body.append(dl);
    }

    const links = (Array.isArray(item.links) ? item.links : []).filter((l) => isHttps(l.url));
    if (links.length) {
      const ul = el('ul', { class: 'it-links' });
      for (const l of links) {
        ul.append(el('li', {}, [el('a', {
          href: l.url, target: '_blank', rel: 'noopener', text: pick(l.label, lang) || l.url
        })]));
      }
      body.append(ul);
    }

    if (sources.length) {
      body.append(el('h3', { class: 'it-h3', text: tx('card.sources') }));
      const ol = el('ol', { class: 'it-sources' });
      for (const s of sources) {
        const li = el('li', { class: 'it-source' });
        if (s.title) li.append(el('span', { class: 'it-source-title', text: s.title }), document.createTextNode(', '));
        li.append(el('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'it-source-url', text: s.url }));
        if (s.accessed) li.append(document.createTextNode(', ' + tx('card.accessed', { date: s.accessed })));
        ol.append(li);
      }
      body.append(ol);
    }

    if (isHttps(visitUrl)) {
      body.append(el('p', { class: 'it-visit' }, [el('a', { href: visitUrl, target: '_blank', rel: 'noopener', text: tx('card.visit') })]));
    }

    card.replaceChildren(el('div', { class: 'it-card-inner' }, [head, body]));
    return close;
  }

  function openCard(item) {
    if (!item) return;
    const close = renderCard(item);
    openId = item.id;
    card.dataset.itemId = item.id;
    card.hidden = false;
    card.classList.remove('it-card--leaving');
    const scroller = card.querySelector('.it-card-body');
    if (scroller) scroller.scrollTop = 0;
    markVisited(item.id);
    syncSheet();
    return close;
  }

  function setCardLeaving(on) {
    if (card.hidden) return;
    card.classList.toggle('it-card--leaving', !!on);
  }

  function closeCard() {
    card.classList.remove('it-card--leaving');
    const hadFocus = card.contains(document.activeElement);
    card.hidden = true;
    delete card.dataset.itemId;
    openId = null;
    syncSheet();
    const c = canvasEl();
    if (c && (hadFocus || !document.activeElement || document.activeElement === document.body)) c.focus({ preventScroll: true });
  }

  // ---------- menu ----------
  let menuOpen = false;

  function renderMenu() {
    const close = el('button', { type: 'button', class: 'it-menu-close' }, [document.createTextNode(tx('menu.close'))]);
    close.addEventListener('click', () => onMenuClose());
    const head = el('div', { class: 'it-menu-head' }, [
      el('h2', { id: 'it-menu-title', class: 'it-menu-title', text: tx('menu.title') }),
      el('p', { class: 'it-menu-count', text: tx('visits.count', { n: doneCount(), total: enabled.length }) })
    ]);
    const body = el('div', { class: 'it-menu-body' });
    const seen = new Set();
    const groups = areas.map((a) => ({ area: a, items: enabled.filter((it) => it.area === a.id) }));
    const rest = enabled.filter((it) => !areas.some((a) => a.id === it.area));
    if (rest.length) groups.push({ area: null, items: rest });
    let firstGo = null;
    for (const g of groups) {
      if (!g.items.length) continue;
      const sec = el('section', { class: 'it-menu-group' });
      if (g.area) sec.append(el('h3', { class: 'it-h3', text: pick(g.area.label, lang) }));
      const ul = el('ul', { class: 'it-menu-list' });
      for (const it of g.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        const titleId = `it-menu-item-${it.id}`;
        const isDone = done(it.id);
        const check = el('input', {
          type: 'checkbox', class: 'it-check', disabled: true, checked: isDone, 'aria-labelledby': titleId, tabindex: '-1'
        });
        check.checked = isDone;
        const go = el('button', { type: 'button', class: 'it-goto', 'data-item-id': it.id, 'aria-describedby': titleId }, [
          document.createTextNode(tx('menu.goto'))
        ]);
        go.addEventListener('click', () => onGoto(it.id));
        if (!firstGo) firstGo = go;
        ul.append(el('li', { class: `it-menu-row${isDone ? ' it-done' : ''}`, 'data-item-id': it.id }, [
          check,
          el('span', { id: titleId, class: 'it-menu-item-title', text: pick(it.title, lang) }),
          go
        ]));
      }
      sec.append(ul);
      body.append(sec);
    }
    menu.replaceChildren(el('div', { class: 'it-menu-inner' }, [head, body, el('div', { class: 'it-menu-foot' }, [close])]));
    return firstGo || close;
  }

  function openMenu() {
    const first = renderMenu();
    menu.hidden = false;
    menuOpen = true;
    first.focus({ preventScroll: true });
  }

  function closeMenu() {
    menu.hidden = true;
    menuOpen = false;
    if (!openId) {
      const c = canvasEl();
      if (c) c.focus({ preventScroll: true });
    }
  }

  return {
    setMarker,
    openCard,
    closeCard,
    setCardLeaving,
    isCardOpen: () => openId !== null && !card.hidden,
    openMenu,
    closeMenu,
    isMenuOpen: () => menuOpen && !menu.hidden,
    visited: () => visitedIds.slice()
  };
}
