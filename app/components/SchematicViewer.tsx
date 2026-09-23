import {useEffect, useMemo, useRef, useState} from 'react';
import {
  fetchJsonCached,
  fetchTextCached,
  peekJson,
  prefetchBytes,
  prefetchImage,
} from '~/lib/asset-prefetch';
import {SCHEMATICS_VERSION} from '~/data/schematics-version';
import {useIsMobile} from '~/lib/use-media-query';
import {useLayerSwipe} from '~/lib/use-layer-swipe';
import {Txt} from './Txt';
import {copyText} from '~/lib/copy';

export type SchematicViewerProps = {
  /** Board handle whose schematic lives at /schematics/<handle>/manifest.json */
  handle: string;
  /** Every tier's schematic handle, so siblings (manifest + sheet images) are
   *  warmed in the background and a tier toggle swaps in with no blank frame. */
  handles?: string[];
  /** Optional deep-dive link (e.g. KiCanvas hosted schematic). */
  inspectUrl?: string;
  /** Reference designators to spotlight (the teardown's hovered component).
   *  Matching symbols get a gold box; if none sit on the active sheet, the
   *  viewer pages to the first sheet that has one. */
  highlightRefs?: string[];
};

type Sheet = {
  slug: string;
  label: string;
  file: string;
  w?: number;
  h?: number;
};
type Manifest = {sheets?: Sheet[]};

// `?v=` busts Oxygen's 1-year immutable cache when schematics are regenerated in
// place - the token is the content hash of all exported sheets, baked into the
// bundle by scripts/export-schematics.mjs.
const manifestUrl = (h: string) =>
  `/schematics/${h}/manifest.json?v=${SCHEMATICS_VERSION}`;
const sheetUrl = (h: string, file: string) =>
  `/schematics/${h}/${file}?v=${SCHEMATICS_VERSION}`;

type TextBox = {x: number; y: number; w: number; h: number};
type SheetIndex = {viewBox: string; texts: Map<string, TextBox[]>};
type ComponentsFile = {
  sheets?: Record<
    string,
    {viewBox?: string; components?: Record<string, number[][]>}
  >;
};
const componentsUrl = (h: string) =>
  `/schematics/${h}/components.json?v=${SCHEMATICS_VERSION}`;

/**
 * Per-sheet index of every text label in the exported SVG. kicad-cli draws
 * visible text as strokes but ALSO emits an invisible real `<text>` per label
 * (opacity 0) carrying exact x/y/textLength/font-size in viewBox units - so a
 * refdes can be located precisely with a regex, no DOM mounting or getBBox.
 * Keyed by sheet URL; the SVG text ride the same fetchTextCached cache the
 * rest of the asset pipeline uses.
 */
const sheetIndexCache = new Map<string, Promise<SheetIndex>>();
function sheetIndex(url: string): Promise<SheetIndex> {
  let hit = sheetIndexCache.get(url);
  if (!hit) {
    hit = fetchTextCached(url).then((svg) => {
      const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '';
      const texts = new Map<string, TextBox[]>();
      const re =
        /<text ([^>]*)>([^<]*)<\/text>/g;
      const attr = (s: string, name: string) => {
        const m = new RegExp(`${name}="([-\\d.]+)"`).exec(s);
        return m ? parseFloat(m[1]) : undefined;
      };
      for (const m of svg.matchAll(re)) {
        const label = m[2].trim();
        if (!label) continue;
        const x = attr(m[1], 'x');
        const y = attr(m[1], 'y');
        const fs = attr(m[1], 'font-size') ?? 1.7;
        if (x == null || y == null) continue;
        const w = attr(m[1], 'textLength') ?? label.length * fs * 0.62;
        const anchorMiddle = m[1].includes('text-anchor="middle"');
        const box: TextBox = {
          x: anchorMiddle ? x - w / 2 : x,
          // y is the baseline; the glyph box sits one font-size above it.
          y: y - fs,
          w,
          h: fs * 1.25,
        };
        const list = texts.get(label);
        if (list) list.push(box);
        else texts.set(label, [box]);
      }
      return {viewBox, texts};
    });
    sheetIndexCache.set(url, hit);
  }
  return hit;
}

/**
 * Paged viewer for a multi-sheet KiCad schematic - the schematic analogue of
 * {@link BoardArt}. Reads /schematics/<handle>/manifest.json (written by
 * scripts/export-schematics.mjs), shows a tab per sheet, and renders one sheet
 * SVG at a time. The B&W export is inverted to white "blueprint" lines on the
 * dark page; CSS gives it a stacked-paper edge so it reads as a sheaf.
 *
 * Warms the active board's sheets and every sibling tier's manifest + sheets in
 * the background, so switching sheets - or switching tiers - is instant and
 * never flashes blank. Self-hiding: renders nothing until a manifest loads, and
 * stays empty if the board has no exported schematic.
 */
export function SchematicViewer({
  handle,
  handles,
  inspectUrl,
  highlightRefs,
}: SchematicViewerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The board currently on screen (handle + its sheets). Seed from cache so a
  // tier that was warmed earlier paints immediately. Kept until the next
  // board's manifest resolves, so a tier toggle never blanks.
  const [display, setDisplay] = useState<{
    handle: string;
    sheets: Sheet[];
  } | null>(() => {
    const m = peekJson<Manifest>(manifestUrl(handle));
    return m ? {handle, sheets: m.sheets ?? []} : null;
  });
  const [active, setActive] = useState(0);
  // Mirror of `active` for async prefetch callbacks (the manifest effect must
  // not re-run on every sheet page).
  const activeRef = useRef(0);
  activeRef.current = active;
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [inView, setInView] = useState(false);

  // Lazy gate: fetch nothing until the section nears the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            io.disconnect();
            setInView(true);
            return;
          }
        }
      },
      // Generous pre-mount margin: the sheet images are ~1MB each and their
      // first decode+raster caused a ~0.5s frame when mounted only 500px
      // ahead of an active scroll (see the same fix in BoardArt).
      {rootMargin: '1800px 0px', threshold: 0.01},
    );
    io.observe(el);
    // On a desktop the first sheet is also loaded once the page is idle
    // after load: parsing an SVG sheet takes the main thread for a few
    // hundred ms on a slow CPU, which is a stall when it lands mid-scroll
    // (the teardown sits far down the page) and nothing when it lands idle.
    let idleId: number | undefined;
    const wide =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 901px)').matches;
    if (wide && typeof requestIdleCallback !== 'undefined') {
      idleId = requestIdleCallback(() => setInView(true), {timeout: 4000});
    }
    return () => {
      io.disconnect();
      if (idleId != null && typeof cancelIdleCallback !== 'undefined') cancelIdleCallback(idleId);
    };
  }, []);

  // Load the active board's manifest + warm its sheets, then warm every sibling
  // tier's manifest + sheets. The previously shown board stays on screen until
  // the new manifest resolves, so a tier toggle swaps cleanly.
  useEffect(() => {
    if (!inView) return;
    let alive = true;
    fetchJsonCached<Manifest>(manifestUrl(handle))
      .then((m) => {
        if (!alive) return;
        const sheets = m.sheets ?? [];
        setDisplay({handle, sheets});
        // Keep the current sheet across a tier swap (clamped below if the new
        // board has fewer sheets) - mirrors BoardArt holding its active layer,
        // rather than snapping back to the first sheet on every variant switch.
        // Warm every sheet's bytes, but eagerly DECODE only the one that will
        // actually paint: decoding the whole sheaf (~1 MB per multi-megapixel
        // sheet) just evicts the on-screen bitmaps from the decoded-image
        // cache. Paging/hovering decodes the rest on demand (rail handlers).
        const visible = Math.min(
          activeRef.current,
          Math.max(0, sheets.length - 1),
        );
        // The visible sheet is parsed now; the rest are only fetched (an SVG
        // image parses on the main thread, ~200 ms a sheet on a slow CPU).
        sheets.forEach((s, i) =>
          i === visible
            ? prefetchImage(sheetUrl(handle, s.file), {decode: true})
            : prefetchBytes(sheetUrl(handle, s.file)),
        );
      })
      .catch(() => {
        if (alive) setDisplay({handle, sheets: []});
      });
    // Warm sibling tiers (manifest + sheet images, ~1 MB/sheet) only when the
    // main thread is idle, so they never compete with the active board's sheets
    // for the first paint. Cancelled if the effect re-runs before idle fires.
    // On a phone, or under data-saver / a sub-4G link, only the manifests are
    // warmed: the sibling SHEETS (~110 KB brotli each, 5-10 per line) wait for
    // an actual tier switch. That switch then shows the sheet a beat later
    // instead of instantly, which beats a megabyte of speculative SVG on
    // mobile data. Desktop keeps the full warm.
    let warmId: number | undefined;
    if (handles) {
      const conn = (navigator as {connection?: {saveData?: boolean; effectiveType?: string}}).connection;
      const frugal =
        Boolean(conn?.saveData) ||
        /(^|\b)(slow-)?[23]g\b/.test(String(conn?.effectiveType ?? '')) ||
        (typeof window.matchMedia === 'function' &&
          window.matchMedia('(max-width: 900px)').matches);
      const warm = () => {
        for (const h of handles) {
          if (h === handle) continue;
          void fetchJsonCached<Manifest>(manifestUrl(h))
            .then((m) => {
              if (frugal) return;
              for (const s of m.sheets ?? [])
                prefetchBytes(sheetUrl(h, s.file));
            })
            .catch(() => {});
        }
      };
      warmId =
        typeof requestIdleCallback !== 'undefined'
          ? requestIdleCallback(warm, {timeout: 1500})
          : (setTimeout(warm, 250) as unknown as number);
    }
    return () => {
      alive = false;
      if (warmId != null) {
        if (typeof cancelIdleCallback !== 'undefined')
          cancelIdleCallback(warmId);
        else clearTimeout(warmId);
      }
    };
  }, [inView, handle, handles]);

  const dh = display?.handle ?? handle;
  const sheets = display?.sheets ?? null;

  // Keep the active index in range when the board (re)loads with fewer sheets.
  useEffect(() => {
    if (sheets && sheets.length && active >= sheets.length) setActive(0);
  }, [sheets, active]);

  const current = sheets?.[active];

  // Lock the page to ONE height across all sheets (mobile) instead of letting it
  // jump per sheet. For a fixed full width, height = width / aspect-ratio, so the
  // tallest sheet is the one with the SMALLEST aspect ratio - use that as a
  // constant `--sheet-ar`. Every sheet then sits in the same box and the shorter
  // ones letterbox (object-fit: contain), no more height jump on paging.
  const pageAr = useMemo(() => {
    const ars = (sheets ?? [])
      .filter((s) => s.w && s.h)
      .map((s) => (s.w as number) / (s.h as number));
    return ars.length ? Math.min(...ars) : null;
  }, [sheets]);

  // Variant swap: when the displayed board (handle) changes, sweep a diagonal
  // line across the page that wipes the new sheet in over the old. Detected on
  // `dh` only, so paging sheets within one board still uses the plain fade.
  const lastImgRef = useRef<string | null>(null);
  const prevDhRef = useRef(dh);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  // Live "is the schematic roughly on screen" flag + a "reveal owed" flag: a SKU
  // swap while the schematic is off-screen (the user is up in the teardown, or
  // anywhere else) skips the wipe - animating it is wasted work that competes with
  // whatever IS on screen - and instead owes a quick fade-in reveal, played when
  // the schematic next scrolls into view.
  const visibleRef = useRef(false);
  const revealPendingRef = useRef(false);
  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    if (prevDhRef.current === dh) return;
    prevDhRef.current = dh;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !lastImgRef.current) return;
    if (!visibleRef.current) {
      // Off-screen: don't wipe; owe a reveal for when it scrolls back into view.
      revealPendingRef.current = true;
      return;
    }
    setOutgoing(lastImgRef.current);
    const t = setTimeout(() => setOutgoing(null), 640);
    return () => clearTimeout(t);
  }, [dh]);
  // Track on-screen state; when the schematic comes back into view owing a reveal
  // (an off-screen SKU swap happened), play the entrance fade-in once.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      visibleRef.current = true;
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        visibleRef.current = e.isIntersecting;
        if (e.isIntersecting && revealPendingRef.current) {
          revealPendingRef.current = false;
          setRevealing(true);
          window.setTimeout(() => setRevealing(false), 600);
        }
      },
      {rootMargin: '-15% 0px -15% 0px', threshold: 0},
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // Remember the sheet on screen so the next swap can hold it underneath. Runs
  // after the dh-swap effect above, so that effect reads the *previous* image.
  useEffect(() => {
    if (current) lastImgRef.current = sheetUrl(dh, current.file);
  });

  // Step through the sheets, clamped to the ends (used by arrow keys / wheel
  // over the rail) - mirrors the board folder's layer stepping.
  const step = (delta: number) =>
    setActive((i) =>
      Math.min((sheets?.length ?? 1) - 1, Math.max(0, i + delta)),
    );

  // Component spotlight: boxes for the hovered refs on the active sheet. If
  // the active sheet has none but another sheet does, page there (debounced,
  // so a cursor walking the teardown's part list doesn't thrash the pager).
  const [hl, setHl] = useState<{
    key: string;
    viewBox: string;
    boxes: TextBox[];
  } | null>(null);
  useEffect(() => {
    const refs = highlightRefs ?? [];
    if (!refs.length || !sheets?.length) {
      setHl(null);
      return;
    }
    let alive = true;
    let jump: ReturnType<typeof setTimeout> | undefined;
    // Whole-symbol boxes (components.json, written at export time) first;
    // the invisible-text index of the sheet SVG is the fallback for anything
    // the extractor missed. Both are in the sheet's viewBox coordinates.
    const boxesOn = async (i: number) => {
      const slug = sheets[i].slug;
      const comp = await fetchJsonCached<ComponentsFile>(
        componentsUrl(dh),
      ).catch(() => null);
      const sheet = comp?.sheets?.[slug];
      if (sheet?.components && sheet.viewBox) {
        const boxes = refs.flatMap((r) =>
          (sheet.components?.[r] ?? []).map(([x, y, w, h]) => ({x, y, w, h})),
        );
        if (boxes.length) return {viewBox: sheet.viewBox, boxes};
      }
      const idx = await sheetIndex(sheetUrl(dh, sheets[i].file));
      return {
        viewBox: sheet?.viewBox ?? idx.viewBox,
        boxes: refs.flatMap((r) => idx.texts.get(r) ?? []),
      };
    };
    void (async () => {
      try {
        const {viewBox, boxes} = await boxesOn(active);
        if (!alive) return;
        if (boxes.length) {
          setHl({key: `${dh}:${sheets[active].slug}`, viewBox, boxes});
          return;
        }
        setHl(null);
        // Not on this sheet: find the first sheet that has it, then page over.
        for (let i = 0; i < sheets.length; i++) {
          if (i === active) continue;
          const other = await boxesOn(i);
          if (!alive) return;
          if (other.boxes.length) {
            jump = setTimeout(() => {
              if (alive) setActive(i);
            }, 220);
            return;
          }
        }
      } catch {
        if (alive) setHl(null);
      }
    })();
    return () => {
      alive = false;
      if (jump) clearTimeout(jump);
    };
  }, [highlightRefs, sheets, active, dh]);

  // Touch: drag the sheet ←/→ to page through the schematic - the same peel as
  // the board explorer (active sheet slides out under the finger, the next/prev
  // chases in behind it). Vertical is left to the page; only horizontal is
  // captured. Wheel + hover stay mouse-only.
  const isMobile = useIsMobile();
  const pageRef = useRef<HTMLDivElement | null>(null);
  const {drag, dragging} = useLayerSwipe({
    ref: pageRef,
    count: sheets?.length ?? 0,
    index: active,
    setIndex: setActive,
    enabled: isMobile,
  });

  return (
    <div className="schematic-viewer" ref={ref} data-board={dh}>
      {inView && sheets === null ? (
        <div className="schematic-skeleton" aria-hidden="true">
          <span className="board-art-skeleton-spinner" />
          <Txt
            id="product-chrome.schematic_loading"
            as="span"
            className="board-art-skeleton-label"
          />
        </div>
      ) : null}
      {sheets && sheets.length ? (
        <>
          <div className="schematic-body">
            {/* Vertical sheet rail beside the schematic - the same selector as
                the board's copper-layer rail. Arrows/wheel step the sheets. */}
            {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            <div
              className="schematic-rail"
              role="group"
              aria-label={copyText('product-chrome.schematic_sheet_aria')}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  step(1);
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  step(-1);
                }
              }}
              onWheel={(e) => {
                if (Math.abs(e.deltaY) < 2) return;
                step(e.deltaY > 0 ? 1 : -1);
              }}
            >
              <span className="schematic-rail-head">
                {copyText('product-chrome.schematic_sheet_label')}
                <span className="schematic-rail-count">
                  {active + 1}/{sheets.length}
                </span>
              </span>
              <div className="schematic-rail-tabs">
                {sheets.map((s, i) => (
                  <button
                    type="button"
                    key={s.slug}
                    className={i === active ? 'is-active' : undefined}
                    aria-pressed={i === active}
                    onClick={() => setActive(i)}
                    onMouseEnter={() =>
                      prefetchImage(sheetUrl(dh, s.file), {decode: true})
                    }
                    onFocus={() =>
                      prefetchImage(sheetUrl(dh, s.file), {decode: true})
                    }
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
            <div
              ref={pageRef}
              className={`schematic-page${dragging ? ' is-dragging' : ''}${
                outgoing ? ' is-wiping' : ''
              }${revealing ? ' is-revealing' : ''}`}
              style={
                {
                  ...(pageAr ? {['--sheet-ar' as string]: `${pageAr}`} : {}),
                  ['--drag' as string]: drag,
                } as React.CSSProperties
              }
            >
              {/* Outgoing board held underneath while the new sheet wipes in. */}
              {outgoing ? (
                <img
                  className="schematic-sheet is-loaded schematic-sheet--leaving"
                  src={outgoing}
                  alt=""
                  aria-hidden="true"
                />
              ) : null}
              {/* Every sheet is rendered and parked at its offset from the active
                  one (--rel); the mobile peel slides each to (--rel + --drag).
                  Desktop shows only the active sheet (others held at opacity 0)
                  and pages by fade. */}
              {sheets.map((s, i) => {
                const k = `${dh}:${s.slug}`;
                return (
                  <img
                    key={k}
                    className={`schematic-sheet${loaded[k] ? ' is-loaded' : ''}${i === active ? ' is-active' : ''}${outgoing && i === active ? ' schematic-sheet--entering' : ''}`}
                    style={
                      {['--rel' as string]: i - active} as React.CSSProperties
                    }
                    // Only the active sheet and its neighbours carry a source:
                    // every mounted SVG image is parsed on the main thread.
                    src={Math.abs(i - active) <= 1 ? sheetUrl(dh, s.file) : undefined}
                    alt={`${s.label} ${copyText('product-chrome.schematic_sheet_alt_suffix') ?? ''}`}
                    loading="lazy"
                    decoding="async"
                    aria-hidden={i === active ? undefined : true}
                    onLoad={() => setLoaded((l) => ({...l, [k]: true}))}
                  />
                );
              })}
              {/* Component spotlight: gold boxes over the hovered refs, drawn
                  in the sheet's own viewBox space so they track any scaling.
                  Keyed to the active sheet - never painted over the wrong one. */}
              {hl && current && hl.key === `${dh}:${current.slug}` ? (
                <svg
                  className="schematic-hl"
                  viewBox={hl.viewBox}
                  preserveAspectRatio="xMidYMid meet"
                  aria-hidden="true"
                >
                  {hl.boxes.map((b, i) => (
                    <rect
                      key={i}
                      x={b.x - 1.6}
                      y={b.y - 1.6}
                      width={b.w + 3.2}
                      height={b.h + 3.2}
                      rx={0.9}
                    />
                  ))}
                </svg>
              ) : null}
              {/* The diagonal line that flies across to swap the boards. */}
              {outgoing ? (
                <span className="schematic-swap-line" aria-hidden="true" />
              ) : null}
            </div>
          </div>
          {/* Mobile: the sheet-tab rail is dropped (a mouse-era button strip);
              you page sheets by flicking the page ←/→. This slim deck mirrors the
              board explorer - a tick per sheet (tap to jump) + which sheet is up
              + a swipe hint. Hidden on desktop, where the rail is shown. */}
          <div className="schematic-deck">
            <div
              className="board-deck-dots"
              aria-label={copyText('product-chrome.schematic_sheet_aria')}
            >
              {sheets.map((s, i) => (
                <button
                  type="button"
                  key={s.slug}
                  className={`board-deck-dot${i === active ? ' is-active' : ''}${
                    i < active ? ' is-done' : ''
                  }`}
                  aria-label={`Show ${s.label} sheet`}
                  aria-current={i === active ? 'true' : undefined}
                  onClick={() => setActive(i)}
                />
              ))}
            </div>
            <p className="board-deck-meta" aria-live="polite">
              <span className="board-deck-count">
                {active + 1}/{sheets.length}
              </span>
              <span className="board-deck-name">{current?.label}</span>
              <Txt
                id="product-chrome.swipe_hint"
                as="span"
                className="board-deck-hint"
              />
            </p>
          </div>
          {inspectUrl ? (
            <div className="schematic-foot">
              <a
                className="board-art-inspect"
                href={inspectUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copyText('product-chrome.schematic_open_cta')}
              </a>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default SchematicViewer;
