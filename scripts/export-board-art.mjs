#!/usr/bin/env node
/**
 * Export a layered SVG of a KiCad PCB for use on a product detail page.
 *
 *   node scripts/export-board-art.mjs <path-to-.kicad_pcb> <product-handle>
 *   node scripts/export-board-art.mjs --all      # every board in boards.config.json
 *   node scripts/export-board-art.mjs --all --components-only
 *   node scripts/export-board-art.mjs <pcb> <handle> --components-only
 *
 * --components-only regenerates ONLY public/boards/<handle>/components.json
 * (the per-footprint highlight boxes from board-components.py) and DOES NOT
 * touch board.svg / front.png / back.png. It runs no kicad-cli svg export and
 * no render_board.py — so it's the fast, render-free path to pick up a
 * board-components.py change (e.g. a bbox fix) without re-rendering the art.
 * It reuses the existing board.svg's viewBox as the shared frame, so the new
 * boxes line up with the unchanged art; run the full pipeline first if a board
 * has no board.svg yet. Exposed as `npm run gen:components`.
 *
 * Pipeline (per board):
 *   1. `kicad-cli pcb export svg --mode-multi` emits one SVG per copper
 *      layer (Edge.Cuts, F.Cu, B.Cu) into a temp dir.
 *   2. `scripts/board-outline.py` (KiCad's bundled pcbnew) returns the
 *      true board-outline polygon — arcs, chamfers, castellations and
 *      cutouts resolved. OpenDrone boards intentionally have pads that
 *      overshoot the routed edge so JLCPCB CNC-trims them flush; clipping
 *      to the real outline keeps those stubs from showing past the edge.
 *   3. Each layer body is wrapped in `<g id="layer-{slug}">`; F.Cu and
 *      B.Cu are clipped to the outline (Edge.Cuts is the outline, so it
 *      is left unclipped). B.Cu is mirrored about the board's vertical
 *      centre on an inner group so the clip still resolves in the
 *      un-mirrored frame — that gives a clean flip-to-back view. Each
 *      copper layer KEEPS its own kicad-cli theme colour (red F.Cu, blue
 *      B.Cu, distinct inner-layer hues) so the folder viewer is colour-
 *      coded per layer.
 *   4. The realistic front/back faces are PHOTOREAL orthographic 3D
 *      renders (OpenDrone's canonical render_board.py — strips vias +
 *      solder paste so vias render filled/capped, the SAME images used for
 *      the GitHub README and Shopify product shots), saved as
 *      front.png / back.png and embedded as `<image>` in the master
 *      viewBox. The render registers with the copper/components frame by
 *      a single (scale, offset[, back mirror]) derived from the rendered
 *      board-substrate silhouette → Edge.Cuts bbox. This shows real
 *      component 3D bodies with correct silk/mask/copper layering (silk
 *      clipped by mask openings — copper wins) that a flat vector
 *      composite can't reproduce.
 *   5. Result is written to `public/boards/<handle>/board.svg`.
 *
 * <BoardArt /> inlines this file and addresses the layer groups by id:
 * CSS drives the entrance reveal and the gold glow, and the Top/Bottom
 * toggle simply shows one copper group at a time.
 *
 * Everything here is written in the look-through frame (straight down through
 * the board), which is why the back render is mirrored on the way in: it keeps
 * back-side parts at the XY the copper and components.json use. The BOTTOM
 * face is then flipped back for display by `.board-sheet-svg-back` in
 * app.css, so a viewer sees the board turned over, with its silkscreen the
 * right way round, and the highlight boxes ride along inside that same <svg>.
 * Change one without the other and the bottom view reads mirrored again.
 *
 * One handle per physical PCB. Product lines (OpenESC, OpenFC, OpenRX) are
 * one Shopify product with several boards behind a variant axis, so each
 * tier gets its own handle (openesc + openesc-30x30, openfc + openfc-lite,
 * openrx-lite + openrx-lite-ufl + openrx-mono + openrx-gemini). Wire each
 * handle into the matching tier's `boardArt` in app/lib/product-content.ts
 * (or `teardown.boardArt` for the default board); the PDP swaps the art as
 * the ladder selects a tier.
 *
 * Point `pcb` at the SINGLE-board source, not a production panel. A panel
 * resolves to dozens of outline rings and a viewBox several boards wide —
 * the art then renders the whole array, not one board.
 *
 * Rerun whenever a hardware rev ships. Idempotent.
 */
import {execSync, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import {join, basename, dirname, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadBoards} from './boards-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const KICAD_CLI =
  process.env.KICAD_CLI ||
  '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli';

// KiCad's bundled interpreter — the only Python with `pcbnew` available.
const KICAD_PYTHON =
  process.env.KICAD_PYTHON ||
  '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3';

const OUTLINE_SCRIPT = resolve(here, 'board-outline.py');
const COMPONENTS_SCRIPT = resolve(here, 'board-components.py');
const RENDER_FIT_SCRIPT = resolve(here, 'board-render-fit.py');

// ImageMagick — used to horizontally mirror the bottom render into the
// look-through top-down frame (and only there; render + detection do the math).
const MAGICK = process.env.MAGICK || 'magick';

// Every copper layer of a (up to) 6-layer stackup, plus the board outline.
// Boards with fewer layers simply don't emit the missing inner files; we skip
// them. The <BoardArt/> folder viewer renders one sheet per copper layer.
const LAYERS = ['Edge.Cuts', 'F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'];

/** Map kicad-cli's output filename suffix back to the layer slug we use as `id`. */
const FILENAME_TO_SLUG = {
  Edge_Cuts: 'edge-cuts',
  F_Cu: 'f',
  In1_Cu: 'in1',
  In2_Cu: 'in2',
  In3_Cu: 'in3',
  In4_Cu: 'in4',
  B_Cu: 'b',
};

// Document order = SVG paint order (earlier = lower in the stack, later = on
// top). `back` is the realistic bottom-of-board composite, painted first so it
// sits at the very bottom; then edge-cuts (the shared silhouette) and the
// copper sheets; then `front`, the realistic top-of-board composite, painted
// last so it sits at the very top. The copper folder viewer ignores the
// `front`/`back` composites (see BoardArt.parseSheets).
const STACK_ORDER = ['back', 'edge-cuts', 'f', 'in1', 'in2', 'in3', 'in4', 'b', 'front'];

// All copper is shown from the top now (the stack reads as looking straight
// down through the board), so nothing is mirrored.
const MIRROR_SLUGS = new Set();

// Each copper layer KEEPS its own kicad-cli theme colour — kicad-cli paints
// F.Cu red (~#C83434), B.Cu blue (~#4D7FC4), and the inner layers in distinct
// hues. The folder viewer is meant to be colour-coded per layer, so we do NOT
// recolour them to a single copper tone.

// Photoreal orthographic 3D renders are the realistic front/back faces, made by
// OpenDrone's canonical render_board.py (the SAME renderer behind the GitHub
// README + Shopify product images). It STRIPS VIAS and solder paste (vias
// render filled/capped, not as open holes), renders orthographic with a
// transparent background, and squares+centres the output to 1568². We then
// detect the rendered board-substrate silhouette and embed the PNG as an
// <image> mapped substrate→Edge.Cuts bbox (a pure scale+offset; the back is
// additionally mirrored into the look-through top-down frame so back-side parts
// sit at their true XY under the copper/components).
const RENDER_PX = 1568; // render_board.py squares+centres to 1568².
// Side per face; back is mirrored after rendering.
const RENDER_SIDE = {front: 'top', back: 'bottom'};
// Compatible renderer supplied explicitly by the caller.
const RENDER_BOARD_PY = process.env.RENDER_BOARD_PY;

const TAU = Math.PI * 2;
/** Max arc/bezier chord ≈ this many radians per sample — fine enough that a
 *  curve's true extent is captured to well under the SVG's rounding. */
const ARC_STEP = Math.PI / 24;
const BEZIER_STEPS = 24;

/** Flatten a cubic bezier into points (excluding the start, which is already
 *  recorded as the previous anchor). */
function sampleCubic(x0, y0, x1, y1, x2, y2, x3, y3, out) {
  for (let k = 1; k <= BEZIER_STEPS; k++) {
    const t = k / BEZIER_STEPS;
    const u = 1 - t;
    out.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
}

/** Flatten a quadratic bezier into points (excluding the start). */
function sampleQuad(x0, y0, x1, y1, x2, y2, out) {
  for (let k = 1; k <= BEZIER_STEPS; k++) {
    const t = k / BEZIER_STEPS;
    const u = 1 - t;
    out.push([u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2]);
  }
}

/** Flatten an SVG elliptical arc (endpoint parameterization) into points
 *  (excluding the start). Center-conversion per the SVG 1.1 implementation
 *  notes (F.6). Used so the bbox captures a curved board edge whose extreme
 *  lies mid-arc, not on an anchor. */
function sampleArc(x0, y0, rx, ry, xrotDeg, fA, fS, x, y, out) {
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
    out.push([x, y]);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (xrotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const sign = fA !== fS ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * (rx * y1p)) / ry;
  const cyp = (-co * (ry * x1p)) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dTheta = angle(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fS && dTheta > 0) dTheta -= TAU;
  else if (fS && dTheta < 0) dTheta += TAU;
  const steps = Math.max(2, Math.ceil(Math.abs(dTheta) / ARC_STEP));
  for (let k = 1; k <= steps; k++) {
    const t = theta1 + (dTheta * k) / steps;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    out.push([cx + rx * ct * cosP - ry * st * sinP, cy + rx * ct * sinP + ry * st * cosP]);
  }
}

/**
 * Walk an SVG path `d` and return points along the curve — anchors for
 * straight segments, flattened samples for arcs/beziers. Enough to compute a
 * tight bounding box. KiCad's SVG plotter is inconsistent about how it emits
 * an Edge.Cuts ring: sometimes one polyline (`M x,y` then bare lineto pairs),
 * sometimes a mix of line, arc (`A`) and bezier (`C`) segments for filleted
 * corners. Reading raw number pairs breaks on the arc/bezier boards (radii,
 * rotation and the two single-digit flags get mistaken for coordinates), and
 * anchors alone undersize the box when a board edge's extreme lies mid-arc.
 * So we walk the grammar and flatten curves.
 *
 * Handles absolute + relative commands, implicit lineto runs after a moveto,
 * and the SVG arc-flag quirk (large-arc/sweep are single digits that may abut
 * the next number with no separator). S/T (smooth) reflection isn't tracked —
 * KiCad doesn't emit them for Edge.Cuts; their endpoints are still recorded.
 */
function pathPoints(d) {
  const pts = [];
  let i = 0;
  const n = d.length;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  const isCmdChar = (c) => 'MmLlHhVvCcSsQqTtAaZz'.includes(c);
  const skipSep = () => {
    while (i < n && (d[i] === ' ' || d[i] === ',' || d[i] === '\n' || d[i] === '\t' || d[i] === '\r')) i++;
  };
  const readNumber = () => {
    skipSep();
    const s = i;
    if (d[i] === '+' || d[i] === '-') i++;
    while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    if (d[i] === '.') {
      i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    }
    if (d[i] === 'e' || d[i] === 'E') {
      i++;
      if (d[i] === '+' || d[i] === '-') i++;
      while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    }
    return parseFloat(d.slice(s, i));
  };
  const readFlag = () => {
    skipSep();
    const f = d[i] === '1' ? 1 : 0;
    i++;
    return f;
  };
  const rd = (base) => readNumber() + base;

  while (i < n) {
    skipSep();
    if (i >= n) break;
    if (isCmdChar(d[i])) {
      cmd = d[i];
      i++;
    } else if (!cmd) {
      i++; // stray token before any command
      continue;
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const bx = rel ? cx : 0;
    const by = rel ? cy : 0;
    let x = cx;
    let y = cy;
    switch (up) {
      case 'Z':
        continue;
      case 'H':
        x = rd(bx);
        pts.push([x, y]);
        break;
      case 'V':
        y = rd(by);
        pts.push([x, y]);
        break;
      case 'A': {
        const rx = readNumber();
        const ry = readNumber();
        const rot = readNumber();
        const fA = readFlag();
        const fS = readFlag();
        x = rd(bx);
        y = rd(by);
        sampleArc(cx, cy, rx, ry, rot, fA, fS, x, y, pts);
        break;
      }
      case 'C': {
        const c1x = rd(bx);
        const c1y = rd(by);
        const c2x = rd(bx);
        const c2y = rd(by);
        x = rd(bx);
        y = rd(by);
        sampleCubic(cx, cy, c1x, c1y, c2x, c2y, x, y, pts);
        break;
      }
      case 'Q': {
        const c1x = rd(bx);
        const c1y = rd(by);
        x = rd(bx);
        y = rd(by);
        sampleQuad(cx, cy, c1x, c1y, x, y, pts);
        break;
      }
      case 'S': {
        readNumber();
        readNumber();
        x = rd(bx);
        y = rd(by);
        pts.push([x, y]);
        break;
      }
      default: {
        // M / L / T — 2 coords. After a moveto, repeated pairs are linetos.
        x = rd(bx);
        y = rd(by);
        pts.push([x, y]);
        if (up === 'M') cmd = rel ? 'l' : 'L';
        break;
      }
    }
    cx = x;
    cy = y;
  }
  return pts;
}

/**
 * Tight bounding box of the actual Edge.Cuts geometry in the kicad-cli
 * page frame. `--fit-page-to-board` inflates the emitted viewBox to
 * include pads that overshoot the routed edge, so we recompute the true
 * board extent here from the flattened path (see {@link pathPoints}) for use
 * as the master viewBox and the alignment anchor for the pcbnew outline.
 * Boards with cutouts emit several `<path>` elements; we walk all of them.
 */
function edgeCutsBBox(edgeCutsSvg) {
  const re = /d="([^"]+)"/g;
  let m;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  while ((m = re.exec(edgeCutsSvg))) {
    for (const [x, y] of pathPoints(m[1])) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return null;
  return {minX, minY, width: maxX - minX, height: maxY - minY};
}

/**
 * True board outline polygon via KiCad's own pcbnew API (see
 * scripts/board-outline.py). Returns `{ bbox, rings }` in mm in the
 * board's native coordinate frame.
 */
function boardOutline(pcbPath) {
  const out = execFileSync(KICAD_PYTHON, [OUTLINE_SCRIPT, pcbPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Every real component (footprint with pads) via the same pcbnew API and unit
 * conversion as the outline (see scripts/board-components.py), so its
 * coordinates share the board-native frame. Returns `{ components: [...] }`
 * in mm, board frame.
 */
function boardComponents(pcbPath) {
  const out = execFileSync(KICAD_PYTHON, [COMPONENTS_SCRIPT, pcbPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Locate the board SUBSTRATE (pixel bbox) in a render PNG via the pcbnew-python
 * helper (PIL lives there). It returns the bbox of the SOLDERMASK substrate (the
 * green board area), NOT the full alpha silhouette: overhanging metal — USB
 * shells, connector bodies, U.FL, antennas, edge/castellated pads that overshoot
 * the routed edge — is excluded so the face registers to the Edge.Cuts extent
 * that the copper layers + component highlights share (not to proud parts, which
 * was the old misalignment bug). `expectAspect` is the Edge.Cuts bbox aspect
 * (w/h); the helper cross-validates the detected substrate against it and FAILS
 * LOUDLY if they disagree beyond tolerance (detection went wrong → don't emit a
 * bad fit). With `mirror`, the PNG is flipped horizontally first so the frame
 * lands in the un-mirrored look-through frame. `right`/`bottom` are half-open
 * (one past the last substrate pixel) so `right-left` is the covered pixel span.
 * Returns `{imgW, imgH, left, right, top, bottom, mirror, aspect, aspectDevPct}`.
 */
function renderFit(pngPath, mirror, expectAspect) {
  const a = [RENDER_FIT_SCRIPT, pngPath];
  if (mirror) a.push('--mirror');
  if (expectAspect != null) a.push('--expect-aspect', String(expectAspect));
  const out = execFileSync(KICAD_PYTHON, a, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Build a clip-path `d` from the outline rings, translated from the
 * board's native frame into the kicad-cli page frame. The two frames
 * relate by a pure translation (1:1 mm, no scale), so we align by their
 * bounding-box min corner. Rings close with Z; the clip uses fill-rule
 * evenodd so inner cutouts subtract.
 */
function outlineClipPath(outline, cliBBox) {
  const dx = cliBBox.minX - outline.bbox.minX;
  const dy = cliBBox.minY - outline.bbox.minY;
  return outline.rings
    .map((ring) => {
      const [hx, hy] = ring[0];
      const head = `M ${(hx + dx).toFixed(4)} ${(hy + dy).toFixed(4)}`;
      const rest = ring
        .slice(1)
        .map(([x, y]) => `L ${(x + dx).toFixed(4)} ${(y + dy).toFixed(4)}`)
        .join(' ');
      return `${head} ${rest} Z`;
    })
    .join(' ');
}

/** Strip the `<svg>` wrapper + KiCad's <title>/<desc> from a layer file. */
function layerBody(raw) {
  return raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/<desc>[\s\S]*?<\/desc>/g, '')
    .trim();
}

/** Generate `public/boards/<handle>/board.svg` from one .kicad_pcb. */
function buildBoard(pcbPath, handle) {
  const outDir = resolve(here, '..', 'public', 'boards', handle);
  mkdirSync(outDir, {recursive: true});

  const tmp = mkdtempSync(join(tmpdir(), 'board-art-'));
  try {
    execSync(
      [
        KICAD_CLI,
        'pcb export svg',
        `--output ${JSON.stringify(tmp + '/')}`,
        '--mode-multi',
        `--layers ${LAYERS.join(',')}`,
        '--page-size-mode 2',
        '--exclude-drawing-sheet',
        '--fit-page-to-board',
        // Ground pours are stored as polygons recomputed on the fly;
        // without this the board centre (GND flood) renders empty.
        '--check-zones',
        JSON.stringify(pcbPath),
      ].join(' '),
      {stdio: 'inherit'},
    );

    const projectBase = basename(pcbPath, '.kicad_pcb');
    const perLayer = {};
    let edgeCutsRaw = null;
    for (const [suffix, slug] of Object.entries(FILENAME_TO_SLUG)) {
      // Inner-layer files are absent on <6-layer boards — skip rather than throw.
      const file = join(tmp, `${projectBase}-${suffix}.svg`);
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      if (slug === 'edge-cuts') edgeCutsRaw = raw;
      perLayer[slug] = layerBody(raw);
    }

    const bbox = edgeCutsRaw && edgeCutsBBox(edgeCutsRaw);
    if (!bbox) throw new Error(`No Edge.Cuts geometry found in ${pcbPath}`);
    const outline = boardOutline(pcbPath);
    if (!outline.rings || !outline.rings.length) {
      throw new Error(`pcbnew returned no board outline for ${pcbPath}`);
    }
    // Panel guard: a single board (even with cutouts/slots) is ONE outer
    // outline; a production panel resolves to several disjoint outer outlines.
    // `outlineCount` counts only the OUTER outlines (not inner cutout rings), so
    // a board with mounting slots still passes. Refuse a panel — it would render
    // the whole array into one viewBox several boards wide.
    if (outline.outlineCount > 1) {
      throw new Error(
        `${pcbPath} has ${outline.outlineCount} disjoint board outlines — ` +
          `this looks like a PANEL. Point boards.config.json at the SINGLE-board ` +
          `source .kicad_pcb, not a production panel.`,
      );
    }

    const clipId = `board-clip-${handle}`;
    const clipD = outlineClipPath(outline, bbox);
    const r4 = (v) => +v.toFixed(4);
    const viewBox = `${r4(bbox.minX)} ${r4(bbox.minY)} ${r4(bbox.width)} ${r4(bbox.height)}`;
    // Mirror axis = board's vertical centre, so mirrored B.Cu stays in place.
    const mirrorTx = (bbox.minX * 2 + bbox.width).toFixed(4);

    // ---- Photoreal front/back faces (orthographic 3D renders) -------------
    // Render both sides with OpenDrone's canonical render_board.py — it strips
    // vias + solder paste (vias render filled/capped, not as open holes),
    // renders orthographic on a transparent bg, and squares+centres each side
    // to 1568². These are the SAME images used for the README/Shopify shots.
    // It backs up the .kicad_pcb, edits a throwaway copy in-place for the
    // render, then restores the original BYTE-IDENTICAL (verified with cmp).
    if (!RENDER_BOARD_PY) {
      throw new Error(
        'RENDER_BOARD_PY must point to a compatible render_board.py for full board-art generation.',
      );
    }
    const topRaw = join(tmp, 'top-raw.png');
    const botRaw = join(tmp, 'bottom-raw.png');
    execSync(
      [
        KICAD_PYTHON,
        JSON.stringify(RENDER_BOARD_PY),
        JSON.stringify(pcbPath),
        `--top ${JSON.stringify(topRaw)}`,
        `--bottom ${JSON.stringify(botRaw)}`,
        `--size ${RENDER_PX}`,
      ].join(' '),
      {stdio: 'inherit'},
    );
    const rawForSide = {top: topRaw, bottom: botRaw};

    // Detect each side's routed-substrate silhouette in the PNG and compute the
    // linear substrate-pixels → viewBox-mm map. The back PNG is saved mirrored
    // so it embeds in the un-mirrored look-through frame (its detected
    // silhouette is measured on the same flipped image). Each face is an
    // <image> placed so the substrate silhouette registers with the
    // copper/components viewBox — the UI's highlight boxes land on the chips.
    for (const [face, side] of Object.entries(RENDER_SIDE)) {
      const rawPng = rawForSide[side];
      if (!existsSync(rawPng)) {
        throw new Error(`render_board.py produced no ${side} render for ${pcbPath}`);
      }

      // Back is mirrored into the look-through frame; front stays as-is.
      const mirror = face === 'back';
      const facePng = join(outDir, `${face}.png`);
      if (mirror) {
        execSync(
          `${MAGICK} ${JSON.stringify(rawPng)} -flop ${JSON.stringify(facePng)}`,
          {stdio: 'inherit'},
        );
      } else {
        execSync(
          `${MAGICK} ${JSON.stringify(rawPng)} ${JSON.stringify(facePng)}`,
          {stdio: 'inherit'},
        );
      }

      // Measure the SOLDERMASK SUBSTRATE bbox on the SAVED (mirrored, for back)
      // image so pixel coords match the embedded PNG exactly. Cross-validate the
      // detected substrate aspect against the Edge.Cuts bbox aspect — the helper
      // throws if they disagree, so a detection failure can't emit a bad fit.
      const fit = renderFit(facePng, false, bbox.width / bbox.height);
      const spanX = fit.right - fit.left;
      const spanY = fit.bottom - fit.top;
      if (spanX <= 0 || spanY <= 0) {
        throw new Error(`Bad substrate bbox for ${face} of ${pcbPath}`);
      }
      console.log(
        `    ${face} substrate fit: ${spanX}x${spanY}px ` +
          `aspect=${fit.aspect} (Edge.Cuts ${(bbox.width / bbox.height).toFixed(4)}, ` +
          `dev=${fit.aspectDevPct}%)`,
      );
      // Substrate bbox [left,right) → viewBox [minX, minX+width] (= the Edge.Cuts
      // bbox); same for Y. The substrate bbox is the routed green board area, so
      // this maps the board (outline + mounting-hole ears) inside the viewBox and
      // ignores proud overhanging metal. <image> scales the full PNG (0..imgW)
      // into a rect, so size the rect by px/mm and offset it so the substrate
      // edge sits on the viewBox edge.
      const sx = bbox.width / spanX; // mm per px
      const sy = bbox.height / spanY;
      const imgX = r4(bbox.minX - fit.left * sx);
      const imgY = r4(bbox.minY - fit.top * sy);
      const imgW = r4(fit.imgW * sx);
      const imgH = r4(fit.imgH * sy);
      // Absolute public href: the board SVG is inlined into the PDP via
      // DOMParser (see app/components/BoardArt.tsx), so a relative href would
      // resolve against the page URL, not the SVG path. Point at the public dir.
      perLayer[face] =
        `    <image href="/boards/${handle}/${face}.png" x="${imgX}" y="${imgY}" ` +
        `width="${imgW}" height="${imgH}" ` +
        `preserveAspectRatio="none" image-rendering="optimizeQuality"/>`;
    }

    const layers = STACK_ORDER.map((slug) => {
      let body = perLayer[slug];
      if (!body) return '';
      if (slug === 'edge-cuts') {
        return `  <g id="layer-${slug}" class="board-layer board-layer-${slug}">\n${body}\n  </g>`;
      }
      // Photoreal faces are full PNGs (silk/mask/copper already composited and
      // clipped by the renderer); don't outline-clip them.
      if (slug === 'front' || slug === 'back') {
        return `  <g id="layer-${slug}" class="board-layer board-layer-${slug}">\n${body}\n  </g>`;
      }
      // Copper sheets keep their own kicad-cli theme colour — no recolour.
      const clipAttr = ` clip-path="url(#${clipId})"`;
      if (MIRROR_SLUGS.has(slug)) {
        // Clip on the outer (untransformed) group so it resolves in the
        // board frame; the inner group mirrors the copper.
        return `  <g id="layer-${slug}" class="board-layer board-layer-${slug}"${clipAttr}>\n    <g transform="matrix(-1 0 0 1 ${mirrorTx} 0)">\n${body}\n    </g>\n  </g>`;
      }
      return `  <g id="layer-${slug}" class="board-layer board-layer-${slug}"${clipAttr}>\n${body}\n  </g>`;
    })
      .filter(Boolean)
      .join('\n');

    const master = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}" width="${bbox.width.toFixed(4)}mm" height="${bbox.height.toFixed(4)}mm" preserveAspectRatio="xMidYMid meet" overflow="hidden" data-board="${handle}">
  <defs>
    <clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">
      <path d="${clipD}" clip-rule="evenodd"/>
    </clipPath>
  </defs>
${layers}
</svg>
`;
    const outPath = join(outDir, 'board.svg');
    writeFileSync(outPath, master);
    const sizeKb = (Buffer.byteLength(master) / 1024).toFixed(1);
    const pts = outline.rings.reduce((n, r) => n + r.length, 0);
    console.log(
      `Wrote ${outPath} (${sizeKb} KB, viewBox=${viewBox}) — clipped to board outline (${outline.rings.length} ring(s), ${pts} pts)`,
    );

    // ---- components.json --------------------------------------------------
    writeComponents(pcbPath, handle, outDir, bbox, outline, viewBox);
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
}

/**
 * Write public/boards/<handle>/components.json from board-components.py.
 *
 * `bbox` is the Edge.Cuts bbox in the kicad-cli page frame ({minX,minY,...});
 * `outline` is the pcbnew board outline; `viewBox` is the master viewBox string.
 * Same (dx, dy) the outline clip uses: viewBox = native + (dx, dy). The two
 * pcbnew scripts share LoadBoard + ToMM, so outline.bbox.min and component
 * coords are in one native frame; translating by this delta puts every
 * component into the master viewBox frame, ready to draw directly.
 *
 * Shared by the full pipeline (buildBoard) and the render-free --components-only
 * path (buildComponentsOnly), so both emit byte-identical component geometry.
 */
function writeComponents(pcbPath, handle, outDir, bbox, outline, viewBox) {
  const dx = bbox.minX - outline.bbox.minX;
  const dy = bbox.minY - outline.bbox.minY;
  const r4n = (v) => +v.toFixed(4);
  const {components: nativeComps} = boardComponents(pcbPath);
  const components = nativeComps.map((c) => {
    const entry = {
      ref: c.ref,
      value: c.value,
      footprint: c.footprint,
      layer: c.layer,
      x: r4n(c.x + dx),
      y: r4n(c.y + dy),
      rot: c.rot,
      bbox: {
        x: r4n(c.bbox.x + dx),
        y: r4n(c.bbox.y + dy),
        w: r4n(c.bbox.w),
        h: r4n(c.bbox.h),
      },
    };
    if (c.courtyard) {
      entry.courtyard = c.courtyard.map(([x, y]) => [r4n(x + dx), r4n(y + dy)]);
    }
    return entry;
  });
  const componentsJson = {
    handle,
    viewBox,
    units: 'mm',
    components,
  };
  const compPath = join(outDir, 'components.json');
  writeFileSync(compPath, JSON.stringify(componentsJson));
  console.log(
    `Wrote ${compPath} (${components.length} components, ` +
      `dx=${r4n(dx)} dy=${r4n(dy)})`,
  );
}

/**
 * Regenerate ONLY components.json for one board — no kicad-cli, no render.
 *
 * Reuses the EXISTING board.svg's viewBox as the shared frame so the new
 * highlight boxes register with the already-rendered art. The viewBox min
 * corner IS the Edge.Cuts bbox min in the page frame (buildBoard derives one
 * from the other), so we reconstruct the {minX,minY} bbox from it and recompute
 * (dx, dy) against the live pcbnew outline. board.svg / front.png / back.png are
 * never touched. Requires board.svg to exist (run the full pipeline once first).
 */
function buildComponentsOnly(pcbPath, handle) {
  const outDir = resolve(here, '..', 'public', 'boards', handle);
  const svgPath = join(outDir, 'board.svg');
  if (!existsSync(svgPath)) {
    throw new Error(
      `no board.svg at ${svgPath} — run the full pipeline once before ` +
        `--components-only (it needs the existing viewBox to align to).`,
    );
  }
  const svg = readFileSync(svgPath, 'utf8');
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) throw new Error(`no viewBox in ${svgPath}`);
  const viewBox = m[1].trim();
  const [vx, vy, vw, vh] = viewBox.split(/\s+/).map(Number);
  if ([vx, vy, vw, vh].some((n) => !isFinite(n))) {
    throw new Error(`bad viewBox "${viewBox}" in ${svgPath}`);
  }
  // viewBox min corner = Edge.Cuts bbox min in the kicad-cli page frame.
  const bbox = {minX: vx, minY: vy, width: vw, height: vh};
  const outline = boardOutline(pcbPath);
  if (!outline.bbox) {
    throw new Error(`pcbnew returned no board outline bbox for ${pcbPath}`);
  }
  writeComponents(pcbPath, handle, outDir, bbox, outline, viewBox);
}

/** Read the local board manifest (handle → .kicad_pcb path). */
// Bake a content version into the bundle so BoardArt can bust the CDN's 1-year
// immutable cache on the (unversioned) board.svg + front/back.png URLs. Oxygen
// serves everything under public/ with `max-age=31536000`, so an in-place regen
// (or a re-render that produces an IC-less → IC-full board face) never reaches
// returning visitors unless the request URL changes. We hash every exported
// board.svg + front.png + back.png — sorted, content-based, NO timestamps so the
// digest is stable when nothing changed — and write it to a TS module BoardArt
// imports; it appends `?v=<digest>` to the svg fetch AND to the face <image>
// hrefs. Regenerate → digest changes → cached browsers refetch. Mirrors
// scripts/export-schematics.mjs. See app/components/BoardArt.tsx.
function writeVersionFile() {
  const base = resolve(here, '..', 'public', 'boards');
  const h = createHash('sha256');
  const files = [];
  for (const handle of readdirSync(base).sort()) {
    const dir = join(base, handle);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      // Sources AND derived files: board-lite.svg, the copper rasters and the
      // face/thumbnail WebPs all carry this token in their URLs, and a
      // --rasters-only / --derivatives-only regen changes only them.
      if (
        f === 'board.svg' ||
        f === 'board-lite.svg' ||
        f === 'front.png' ||
        f === 'back.png' ||
        f.endsWith('.webp')
      ) {
        files.push(join(dir, f));
      }
    }
  }
  for (const f of files) h.update(readFileSync(f));
  const v = h.digest('hex').slice(0, 12);
  const out = resolve(here, '..', 'app', 'data', 'board-art-version.ts');
  writeFileSync(
    out,
    `// AUTO-GENERATED by scripts/export-board-art.mjs — do not edit by hand.\n` +
      `// Content hash of every board.svg, board-lite.svg, front/back PNG and WebP\n` +
      `// under public/boards (sources and derived rasters/thumbnails). BoardArt\n` +
      `// appends it as ?v= to bust Oxygen's 1-year immutable asset cache when board\n` +
      `// art is regenerated in place.\n` +
      `export const BOARD_ART_VERSION = '${v}';\n`,
  );
  console.log(`Wrote ${out} — version ${v}`);
}

// Downscaled WebP derivatives of front.png for the places that show a board
// as a thumbnail rather than as the teardown face: the mobile home stage,
// the roadmap kanban cards. front.png is a 1568 px RGBA render (400-700 KB);
// the largest of those slots is 264 CSS px, so a 528 px (2x) and 800 px (3x)
// WebP cover every phone at 40-80 KB. Needs cwebp on PATH (brew install
// webp). Alpha is kept lossless (-alpha_q 100) so the drop-shadow edge is
// identical to the PNG. Runs on every build and on --derivatives-only.
const FACE_DERIVATIVE_WIDTHS = [528, 800];
function writeFaceDerivatives() {
  const base = resolve(here, '..', 'public', 'boards');
  let n = 0;
  for (const handle of readdirSync(base).sort()) {
    const dir = join(base, handle);
    if (!statSync(dir).isDirectory()) continue;
    const src = join(dir, 'front.png');
    if (!existsSync(src)) continue;
    for (const w of FACE_DERIVATIVE_WIDTHS) {
      const out = join(dir, `front-w${w}.webp`);
      execFileSync(
        'cwebp',
        ['-quiet', '-q', '90', '-alpha_q', '100', '-m', '6', '-sharp_yuv',
         '-resize', String(w), '0', src, '-o', out],
        {stdio: 'pipe'},
      );
      n++;
    }
  }
  console.log(`Wrote ${n} front-w*.webp derivatives`);
}

// ---- Copper-layer rasters + board-lite.svg --------------------------------
// The site does NOT inline the vector copper layers any more. A board.svg is
// 1-2 MB with ~2000 via circles per layer; six of those stacked as inline SVG
// sheets, each behind CSS filters and transform transitions, made the layer
// sweep stutter on phones (measured 2026-08-15). So this step renders
// every copper layer of the finished board.svg to a WebP with headless
// Chromium (the same engine that would have painted the vector, so the pixels
// are what the vector would have produced) and writes board-lite.svg: the same
// master with each copper <g> body replaced by one <image> covering the
// viewBox. Faces (front/back) and the edge-cuts underlay stay as they are.
// BoardArt fetches board-lite.svg (see app/components/BoardArt.tsx) and swaps
// -w1280 for -w1024 on small screens. The stack is at most ~590 CSS px wide
// (measured 1280-2560 px viewports), so 1280 px covers a 2x desktop with the
// active sheet's 1.05 scale. Lossless: lossy WebP/AVIF is bigger on
// this flat-colour, hard-edged content and would smear the traces.
// Faces get 1280 / 1024 px lossy WebPs too (photoreal render, q95) for the
// same swap.
const LAYER_RASTER_WIDTHS = [1280, 1024];
const COPPER_SLUG_RE = /^(f|b|in\d+)$/;
async function writeLayerRasters(onlyHandle) {
  const {chromium} = await import('playwright');
  const base = resolve(here, '..', 'public', 'boards');
  const browser = await chromium.launch();
  try {
    for (const handle of readdirSync(base).sort()) {
      if (onlyHandle && handle !== onlyHandle) continue;
      const dir = join(base, handle);
      const svgPath = join(dir, 'board.svg');
      if (!statSync(dir).isDirectory() || !existsSync(svgPath)) continue;
      const svg = readFileSync(svgPath, 'utf8');
      const vb = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
      const defs = svg.slice(svg.indexOf('<defs>'), svg.indexOf('</defs>') + 7);
      // Top-level layer groups are written one per line at 2-space indent by
      // buildBoard above; each runs to the next one (or to </svg>).
      const heads = [...svg.matchAll(/\n {2}<g id="layer-([a-z0-9-]+)"/g)];
      const bounds = heads.map((m, i) => ({
        slug: m[1],
        start: m.index + 1,
        end: i + 1 < heads.length ? heads[i + 1].index + 1 : svg.lastIndexOf('</svg>'),
      }));
      const r4 = (v) => +v.toFixed(4);
      let lite = svg;
      for (const W of LAYER_RASTER_WIDTHS) {
        const H = Math.round((W * vb[3]) / vb[2]);
        const page = await browser.newPage({
          viewport: {width: W, height: H},
          deviceScaleFactor: 1,
        });
        for (const b of bounds) {
          if (!COPPER_SLUG_RE.test(b.slug)) continue;
          const group = svg.slice(b.start, b.end);
          await page.setContent(
            `<!doctype html><body style="margin:0;background:transparent">` +
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" ` +
              `width="${W}" height="${H}" style="display:block">${defs}${group}</svg>`,
          );
          const png = join(dir, `.layer-${b.slug}-w${W}.png`);
          await page.screenshot({
            path: png,
            omitBackground: true,
            clip: {x: 0, y: 0, width: W, height: H},
          });
          execFileSync(
            'cwebp',
            ['-quiet', '-lossless', '-z', '7', '-exact', png, '-o', join(dir, `layer-${b.slug}-w${W}.webp`)],
            {stdio: 'pipe'},
          );
          rmSync(png);
        }
        await page.close();
      }
      // Replace each copper group's body with one <image>. Absolute public
      // href, like the faces: the SVG is inlined into the page by DOMParser.
      // No clip-path on the group: the raster is already clipped.
      for (const b of [...bounds].reverse()) {
        if (!COPPER_SLUG_RE.test(b.slug)) continue;
        const group = svg.slice(b.start, b.end);
        const open = group.match(/^ {2}<g id="layer-[a-z0-9-]+" class="[^"]*"/)[0];
        const img =
          `    <image href="/boards/${handle}/layer-${b.slug}-w1280.webp" ` +
          `x="${r4(vb[0])}" y="${r4(vb[1])}" width="${r4(vb[2])}" height="${r4(vb[3])}" ` +
          `preserveAspectRatio="none"/>`;
        lite = lite.slice(0, b.start) + `${open}>\n${img}\n  </g>\n` + lite.slice(b.end);
      }
      writeFileSync(join(dir, 'board-lite.svg'), lite);
      // Faces as lossy WebP at 1280 (desktop) and 1024 (phones); BoardArt swaps
      // front.png -> front-w1280.webp / -w1024.webp. The 1568 px PNGs (394 +
      // 684 KB on openesc) were the largest teardown payload; the WebPs are
      // ~100-160 KB each and the stack never shows a face above ~1180 device
      // px. Alpha stays lossless (-alpha_q 100): the spotlight masks by it.
      for (const face of ['front', 'back']) {
        const src = join(dir, `${face}.png`);
        if (!existsSync(src)) continue;
        for (const W of LAYER_RASTER_WIDTHS) {
          execFileSync(
            'cwebp',
            ['-quiet', '-q', '95', '-alpha_q', '100', '-m', '6', '-sharp_yuv', '-resize', String(W), '0', src, '-o', join(dir, `${face}-w${W}.webp`)],
            {stdio: 'pipe'},
          );
        }
      }
      const kb = (f) => (statSync(join(dir, f)).size / 1024).toFixed(0);
      console.log(
        `Wrote ${join(dir, 'board-lite.svg')} (${kb('board-lite.svg')} KB) + ` +
          `${bounds.filter((b) => COPPER_SLUG_RE.test(b.slug)).length} copper rasters x ${LAYER_RASTER_WIDTHS.join('/')} px`,
      );
    }
  } finally {
    await browser.close();
  }
}

function usage() {
  console.error(
    'Usage:\n' +
      '  node scripts/export-board-art.mjs <path-to-.kicad_pcb> <handle>\n' +
      '  node scripts/export-board-art.mjs --all\n' +
      '  node scripts/export-board-art.mjs --all --components-only\n' +
      '  node scripts/export-board-art.mjs <pcb> <handle> --components-only\n' +
      '  node scripts/export-board-art.mjs --derivatives-only\n' +
      '  node scripts/export-board-art.mjs --rasters-only [handle]\n' +
      '\n' +
      '  --components-only  regenerate ONLY components.json (no svg/render).\n' +
      '  --derivatives-only regenerate ONLY the front-w*.webp thumbnails.\n' +
      '  --rasters-only     regenerate ONLY board-lite.svg + layer rasters.\n' +
      '\n' +
      '  Full generation requires RENDER_BOARD_PY to point to a compatible renderer.',
  );
  process.exit(2);
}

const rawArgs = process.argv.slice(2);
const componentsOnly = rawArgs.includes('--components-only');
const derivativesOnly = rawArgs.includes('--derivatives-only');
const rastersOnly = rawArgs.includes('--rasters-only');
const args = rawArgs.filter(
  (a) =>
    a !== '--components-only' &&
    a !== '--derivatives-only' &&
    a !== '--rasters-only',
);
// In --components-only mode we skip kicad-cli svg + render and only rewrite
// components.json (board.svg / front.png / back.png are left untouched).
const build = componentsOnly ? buildComponentsOnly : buildBoard;

if (rastersOnly) {
  await writeLayerRasters(args[0]);
  writeVersionFile();
} else if (derivativesOnly) {
  writeFaceDerivatives();
  writeVersionFile();
} else if (args[0] === '--all') {
  const boards = loadBoards();
  const failures = [];
  for (const {handle, pcb} of boards) {
    if (!handle || !pcb) {
      failures.push(`${handle || '(no handle)'}: missing handle or pcb`);
      continue;
    }
    try {
      build(pcb, handle);
    } catch (err) {
      failures.push(`${handle}: ${err.message}`);
    }
  }
  // Refresh the cache-bust token from the on-disk outputs — runs on both the
  // full render path and the render-free --components-only path, so the token
  // can be rebaked without re-rendering. The hash covers board.svg/front/back
  // PNGs, so a render-free run that doesn't touch them yields the same token.
  writeVersionFile();
  if (!componentsOnly) {
    writeFaceDerivatives();
    await writeLayerRasters();
  }
  if (failures.length) {
    console.error(`\n${failures.length} board(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
} else if (args.length === 2) {
  build(args[0], args[1]);
  writeVersionFile();
  if (!componentsOnly) {
    writeFaceDerivatives();
    await writeLayerRasters(args[1]);
  }
} else {
  usage();
}
