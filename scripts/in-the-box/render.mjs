#!/usr/bin/env node
// "What's in the box" flat-lay renderer. stage.js (headless Chromium,
// three.js) lays the parts of one or more GLBs out as a knolling shot and
// exports the composition; blender_render.py renders it in Blender Cycles.
// Writes public/boxes/<handle>/<variant>.png (transparent, 2400 px) plus
// -w528/-w800/-w1024/-w1280 WebPs, sets the product's inTheBoxImage (size,
// hash, per-row boxes for the page's annotations) and puts dark and light
// review composites in the review directory. Needs Blender (BLENDER or on
// PATH, or /Applications/Blender.app), cwebp and ImageMagick.
//
//   node scripts/in-the-box/render.mjs --all
//   node scripts/in-the-box/render.mjs --spec scripts/in-the-box/specs/openframe-3in.json
//   node scripts/in-the-box/render.mjs --probe public/models/od3/frame.glb
//
// Options:
//   --only <handle[/variant]>  with --all: render only matching specs
//   --design-dir <dir>    Incutec design repo (wordmark source); default
//                         $INCUTEC_DESIGN_DIR, else ../../design
//   --all                 render every spec in scripts/in-the-box/specs/
//   --spec <file>         render one spec (repeatable)
//   --probe <glb...>      list unique parts (name, count, size) and exit
//   --review-dir <dir>    where dark/debug variants go (default: $TMPDIR/in-the-box-review)
//   --no-webp             skip the WebP derivatives
//   --samples <n>         Cycles samples (default 96, denoised)
//   --width <px>          render width (default 2400)
//   --work-dir <dir>      keep the Blender job (scene.glb, tex/, job.json) there for re-renders
//
// Spec format: see scripts/in-the-box/specs/*.json. Every unique part of every
// source must match exactly one group or one exclude pattern, otherwise the
// run fails and lists the unmatched parts.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const WEBP_WIDTHS = [528, 800, 1024, 1280];

function usage(code) {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .slice(1, 27)
    .map((l) => l.replace(/^\/\/ ?/, ''))
    .join('\n');
  console.log(text);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {specs: [], probe: [], reviewDir: join(tmpdir(), 'in-the-box-review'), webp: true, only: null,
    designDir: process.env.INCUTEC_DESIGN_DIR || resolve(root, '..', '..', 'design')};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--all') {
      const dir = join(here, 'specs');
      for (const f of readdirSync(dir).sort()) if (f.endsWith('.json')) opts.specs.push(join(dir, f));
    } else if (a === '--spec') opts.specs.push(resolve(argv[++i]));
    else if (a === '--review-dir') opts.reviewDir = resolve(argv[++i]);
    else if (a === '--no-webp') opts.webp = false;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--samples') opts.samples = Number(argv[++i]);
    else if (a === '--width') opts.width = Number(argv[++i]);
    else if (a === '--work-dir') opts.workDir = resolve(argv[++i]);
    else if (a === '--design-dir') opts.designDir = resolve(argv[++i]);
    else if (a === '--probe') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.probe.push(resolve(argv[++i]));
    } else {
      console.error(`Unknown argument: ${a}`);
      usage(2);
    }
  }
  if (opts.only) {
    opts.specs = opts.specs.filter((f) => {
      const s = JSON.parse(readFileSync(f, 'utf8'));
      return `${s.handle}/${s.variant}`.startsWith(opts.only);
    });
  }
  if (!opts.specs.length && !opts.probe.length) usage(2);
  return opts;
}

const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary',
  '.json': 'application/json', '.wasm': 'application/wasm'};

function serve() {
  const server = createServer((req, res) => {
    const p = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root) || !existsSync(p)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {'content-type': MIME[extname(p)] || 'application/octet-stream'});
    res.end(readFileSync(p));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// Artwork the stage draws onto cards, stickers and decals. The OpenDrone
// wordmark is the site's own copy; the Incutec wordmark comes only from the
// design repository.
function loadAssets(designDir) {
  const assets = {opendrone: readFileSync(join(root, 'public', 'opendrone-wordmark.svg'), 'utf8')};
  const incutec = join(designDir, 'assets', 'logos', 'dark', 'incutec.svg');
  if (existsSync(incutec)) assets.incutec = readFileSync(incutec, 'utf8');
  return assets;
}

// A board-art card: the front face PNG and its placement in board.svg give
// the image's true size in millimetres.
function boardArt(handle, base) {
  const svg = readFileSync(join(root, 'public', 'boards', handle, 'board.svg'), 'utf8');
  const img = new RegExp(`<image href="/boards/${handle}/front.png" x="[^"]*" y="[^"]*" width="([\\d.]+)" height="([\\d.]+)"`).exec(svg);
  if (!img) throw new Error(`no face image in public/boards/${handle}/board.svg`);
  return {src: `${base}/public/boards/${handle}/front.png`, imageW: +img[1], imageH: +img[2]};
}

const url = (base, file) => `${base}/${relative(root, file).split('\\').join('/')}`;

function writeDataUrl(file, dataUrl) {
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

function findBlender() {
  const candidates = [process.env.BLENDER, '/opt/homebrew/bin/blender',
    '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], {encoding: 'utf8'});
    if (r.status === 0 && /Blender/.test(r.stdout)) return c;
  }
  console.error('Blender not found. Install Blender 4.2 or newer (brew install --cask blender) or set BLENDER=<path>.');
  process.exit(2);
}

// The merged in-the-box list the page shows for this variant: groups name
// their row by text, stage.js resolves it to the index the page numbers.
function boxList(spec) {
  if (!spec.content) return [];
  const data = JSON.parse(readFileSync(join(root, 'content', 'products', `${spec.content.product}.json`), 'utf8'));
  const v = spec.content.variant ? data.variants?.[spec.content.variant] : null;
  return [...(data.inTheBox ?? []), ...(v?.inTheBox ?? [])].map((it) => it.item);
}

// Points the product (or variant) content at the image and records its
// pixel size, so the page reserves the right box. Alt text, when set by
// hand, is kept; otherwise the page builds it from the in-the-box list.
function setContentImage(spec, out) {
  const file = join(root, 'content', 'products', `${spec.content.product}.json`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const target = spec.content.variant ? data.variants?.[spec.content.variant] : data;
  if (!target) throw new Error(`${file}: no variant ${spec.content.variant}`);
  const prev = target.inTheBoxImage ?? {};
  const png = join(root, 'public', 'boxes', spec.handle, `${spec.variant}.png`);
  const v = createHash('sha256').update(readFileSync(png)).digest('hex').slice(0, 12);
  target.inTheBoxImage = {src: `/boxes/${spec.handle}/${spec.variant}.png`, ...(prev.alt ? {alt: prev.alt} : {}),
    width: out.width, height: out.height, v, ...(out.boxes?.length ? {boxes: out.boxes} : {})};
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// One in-the-box row can cover several layout blocks (a hardware kit is a
// dozen). Merge a row's boxes while their union stays compact (no more than
// 1.6x the area they cover), so the image carries one bracket per group, then
// pad each box a little off the parts. Boxes are percent, top-left origin.
function mergeBoxes(boxes, width, height) {
  const area = (b) => b.w * b.h;
  const union = (a, b) => {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {item: a.item, x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y,
      covered: (a.covered ?? area(a)) + (b.covered ?? area(b))};
  };
  const out = [];
  for (const item of [...new Set(boxes.map((b) => b.item))]) {
    let group = boxes.filter((b) => b.item === item).map((b) => ({...b}));
    for (let merged = true; merged && group.length > 1;) {
      merged = false;
      let best = null;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const u = union(group[i], group[j]);
          const ratio = area(u) / u.covered;
          if (ratio <= 1.6 && (!best || ratio < best.ratio)) best = {i, j, u, ratio};
        }
      }
      if (best) {
        group = group.filter((_, k) => k !== best.i && k !== best.j).concat(best.u);
        merged = true;
      }
    }
    out.push(...group);
  }
  const px = 0.9;
  const py = (px * width) / height;
  const r = (v) => Math.round(v * 100) / 100;
  return out.map((b) => {
    const x = Math.max(0, b.x - px);
    const y = Math.max(0, b.y - py);
    return {item: b.item, x: r(x), y: r(y), w: r(Math.min(100, b.x + b.w + px) - x), h: r(Math.min(100, b.y + b.h + py) - y)};
  }).sort((a, b) => a.item - b.item || a.y - b.y || a.x - b.x);
}

function webps(png) {
  for (const w of WEBP_WIDTHS) {
    execFileSync('cwebp', ['-quiet', '-q', '90', '-alpha_q', '100', '-m', '6', '-sharp_yuv', '-resize', String(w), '0',
      png, '-o', png.replace(/\.png$/, `-w${w}.webp`)], {stdio: 'pipe'});
  }
}

const opts = parseArgs(process.argv.slice(2));
const assets = loadAssets(opts.designDir);
const blender = opts.specs.length ? findBlender() : null;
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
  await page.goto(`${base}/scripts/in-the-box/stage.html`);
  await page.waitForFunction(() => window.inTheBoxReady === true, null, {timeout: 30000});

  if (opts.probe.length) {
    const parts = await page.evaluate((s) => window.inTheBox.probe(s), opts.probe.map((f) => url(base, f)));
    for (const p of parts) {
      console.log(`${String(p.count).padStart(3)}x  ${p.name}  [src ${p.source} mesh ${p.mesh}]  ` +
        `size ${p.sizeMm.join(' x ')} mm  at ${p.centerMm.join(', ')}`);
    }
  }

  for (const specFile of opts.specs) {
    const spec = JSON.parse(readFileSync(specFile, 'utf8'));
    const groups = spec.groups.map((g) =>
      g.procedural?.kind === 'boardCard' ? {...g, procedural: {...g.procedural, ...boardArt(g.procedural.board, base)}} : g);
    const needs = JSON.stringify(spec).includes('"incutec"');
    if (needs && !assets.incutec) throw new Error(`Incutec wordmark not found under ${opts.designDir}; pass --design-dir`);
    const job = {...spec, groups, assets, boxList: boxList(spec),
      sources: (spec.sources || []).map((s) => url(base, resolve(root, s)))};
    const t0 = Date.now();
    const out = await page.evaluate((j) => window.inTheBox.layout(j), job);
    const tag = `${spec.handle}/${spec.variant}`;
    if (out.report.unmatched.length) {
      console.error(`${tag}: parts matched by no group or exclude:`);
      for (const u of out.report.unmatched) console.error(`  ${u.count}x ${u.name} (source ${u.source})`);
      failed = true;
      continue;
    }
    // Hand the composition to Blender.
    const work = opts.workDir ? join(opts.workDir, spec.handle, spec.variant) : mkdtempSync(join(tmpdir(), 'in-the-box-'));
    const texDir = join(work, 'tex');
    rmSync(work, {recursive: true, force: true});
    mkdirSync(texDir, {recursive: true});
    writeFileSync(join(work, 'scene.glb'), Buffer.from(out.glb, 'base64'));
    for (const [id, src] of Object.entries(out.textures)) {
      if (typeof src === 'string') writeDataUrl(join(texDir, `${id}.png`), src);
      else copyFileSync(join(root, new URL(src.url).pathname.replace(/^\//, '')), join(texDir, `${id}.png`));
    }
    const png = join(root, 'public', 'boxes', spec.handle, `${spec.variant}.png`);
    mkdirSync(dirname(png), {recursive: true});
    const jobFile = join(work, 'job.json');
    const boxesOut = join(work, 'boxes.json');
    writeFileSync(jobFile, JSON.stringify({glb: join(work, 'scene.glb'), texDir, out: png, boxesOut, width: 2400,
      ...(spec.render ?? {}), samples: opts.samples ?? spec.render?.samples ?? 96,
      ...(opts.width ? {width: opts.width} : {}), tiltDeg: spec.camera?.tiltDeg ?? 0}));
    const r = spawnSync(blender, ['-b', '--factory-startup', '-P', join(here, 'blender_render.py'), '--', jobFile],
      {encoding: 'utf8', maxBuffer: 1 << 26});
    if (r.status !== 0 || !existsSync(boxesOut)) {
      console.error(`${tag}: Blender failed\n${(r.stdout + r.stderr).split('\n').filter((l) => /Error|Traceback|File "/.test(l)).slice(-15).join('\n')}`);
      failed = true;
      continue;
    }
    const result = JSON.parse(readFileSync(boxesOut, 'utf8'));
    if (!opts.workDir) rmSync(work, {recursive: true, force: true});
    Object.assign(out, {width: result.width, height: result.height,
      boxes: mergeBoxes(result.boxes, result.width, result.height)});
    for (const [bg, name] of [['#0d0d10', 'dark'], ['#f7f6f3', 'light']]) {
      execFileSync('magick', [png, '-background', bg, '-flatten', join(opts.reviewDir, `${spec.handle}-${spec.variant}-${name}.png`)]);
    }
    if (opts.webp) webps(png);
    if (spec.content) setContentImage(spec, out);
    console.log(`${tag}: ${out.width}x${out.height} px, ${(out.width / out.layoutMm[0]).toFixed(2)} px/mm, ` +
      `${out.rows} rows, layout ${out.layoutMm.map((v) => v.toFixed(0)).join(' x ')} mm, ` +
      `Blender ${result.seconds} s, total ${((Date.now() - t0) / 1000).toFixed(1)} s, ${out.boxes.length} boxes`);
    for (const p of out.report.included) {
      console.log(`  + ${String(p.count).padStart(2)}x ${p.name}${p.shown !== p.count ? ` (shown ${p.shown})` : ''}  [${p.group}]`);
    }
    for (const p of out.report.excluded) console.log(`  - ${String(p.count).padStart(2)}x ${p.name}`);
    console.log(`  -> ${relative(root, png)}; review variants in ${opts.reviewDir}`);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
