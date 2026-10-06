import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {Txt} from '~/components/Txt';
import {
  PilotBlock,
  PilotNames,
  areaText,
  coordTitle,
  type Draft,
  type Notice,
  type OpenPanel,
} from '~/components/OwnersPilot';
import {copyFill, copyText} from '~/lib/copy';
import {drawWorld, placeAt, type Geo, type Shape} from '~/lib/owner-map-draw';
import {bucketLabel, type Snapshot} from '~/lib/owner-map';
import {cellHalfSpan, snapToCell, type Cell, type PilotCell} from '~/lib/pilot-map';
import type {Topology} from 'topojson-specification';

/**
 * The owners page is one map (README "Owners map"): countries and US states
 * with published owners filled in gold at a step per range, and, for a
 * signed-in owner, the pilot areas as gold dots. It pans by drag, zooms by
 * wheel, pinch and buttons, and sits under a single card in the /visit style.
 *
 * Geometry is drawn once per window size as SVG paths in screen pixels; panning
 * and zooming only change the transform of that group, so the paths never
 * re-render. Dots, squares and the popover are placed from the same
 * projection and the current view. Colours come from CSS (`.owners-land`).
 */

const MAX_K = 120;
/** From this width the world spans the window and the card floats over the South Pacific. */
const WIDE = 1280;
/** Room left of the world for the card on narrower desktop windows. */
const CARD_SPACE = 400;
/** A pick zooms in about to country level: borders stay visible and the ~10 km square still reads. */
const PICK_ZOOM = 7;
const NARROW = 640;

type View = {k: number; x: number; y: number};
type Size = {w: number; h: number};
type Pt = {x: number; y: number};

function useGeo(): {geo: Geo | null; failed: boolean} {
  const [state, setState] = useState<{geo: Geo | null; failed: boolean}>({geo: null, failed: false});
  useEffect(() => {
    let live = true;
    const load = (file: string): Promise<Topology> =>
      fetch(`/geo/${file}`).then((r) => (r.ok ? (r.json() as Promise<Topology>) : Promise.reject(new Error(file))));
    Promise.all([load('countries-50m.json'), load('states-10m.json')]).then(
      ([countries, states]) => live && setState({geo: {countries, states}, failed: false}),
      () => live && setState({geo: null, failed: true}),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

function useSize(ref: React.RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((s) => (s && s.w === w && s.h === h ? s : {w, h}));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** The land, drawn once per size: nothing in it depends on the view or the hover. */
const Land = memo(function Land({shapes, snapshot}: {shapes: Shape[]; snapshot: Snapshot | null}) {
  return (
    <>
      {shapes.map((s) => {
        const bucket = s.region === null || !snapshot ? undefined : snapshot.regions[s.region];
        return <path key={s.key} d={s.d} data-key={s.key} data-b={bucket} className="owners-land" />;
      })}
    </>
  );
});

/** "50-99" for a region with owners, "-" for one without. */
function rangeFor(shape: Shape, snapshot: Snapshot | null): string {
  const bucket = shape.region === null || !snapshot ? undefined : snapshot.regions[shape.region];
  return bucket === undefined ? '-' : bucketLabel(bucket);
}

export function OwnersMap({
  snapshot,
  fixture,
  panel,
  notice,
  children,
}: {
  snapshot: Snapshot | null;
  fixture: boolean;
  panel: OpenPanel | null;
  notice: Notice | null;
  /** Rendered inside the section, for the text twin of the map. */
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const size = useSize(stage);
  const {geo, failed} = useGeo();
  const hasRegions = snapshot !== null && Object.keys(snapshot.regions).length > 0;
  const drawStates = snapshot?.regions.US !== undefined;
  const narrow = size !== null && size.w <= NARROW;

  // The world fills the window wherever the card leaves it room.
  const frame = useMemo<[number, number, number, number] | null>(() => {
    if (!size) return null;
    // Wide windows: the card sits bottom left, over the empty South Pacific.
    // Narrower ones keep the world beside it.
    const left = narrow || size.w >= WIDE ? 12 : CARD_SPACE;
    const bottom = narrow ? Math.round(size.h * 0.46) : 12;
    return [left, 72, size.w - 64, size.h - bottom - 8];
  }, [size, narrow]);

  const drawn = useMemo(() => (geo && frame ? drawWorld(geo, drawStates, frame) : null), [geo, frame, drawStates]);
  const byKey = useMemo(() => new Map(drawn?.shapes.map((s) => [s.key, s]) ?? []), [drawn]);

  const [view, setView] = useState<View>({k: 1, x: 0, y: 0});
  const viewRef = useRef(view);
  viewRef.current = view;
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [placing, setPlacing] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const ownKey = panel?.own ? `${panel.own.cellLat},${panel.own.cellLon}` : '';
  // A new card state starts at its top, never scrolled into the middle.
  useEffect(() => {
    card.current?.scrollTo({top: 0});
  }, [placing, ownKey, panel?.signedIn, panel?.linkedName]);
  const onPlacing = useCallback((p: boolean) => setPlacing(p), []);

  const cells: PilotCell[] = panel?.view.cells ?? [];
  const own = panel?.own ?? null;

  const limits = useMemo(() => {
    if (!drawn || !size) return null;
    const [[x0, y0], [x1, y1]] = drawn.bounds;
    return {x0, y0, x1, y1, minK: Math.max(0.12, Math.min(1, size.w / (x1 - x0)))};
  }, [drawn, size]);

  /** Keeps the middle of the window inside the world, so the map can never be dragged away. */
  const clampView = useCallback(
    (v: View): View => {
      if (!limits || !size) return v;
      const k = Math.min(MAX_K, Math.max(limits.minK, v.k));
      const cx = size.w / 2;
      const cy = size.h / 2;
      return {
        k,
        x: Math.min(cx - limits.x0 * k, Math.max(cx - limits.x1 * k, v.x)),
        y: Math.min(cy - limits.y0 * k, Math.max(cy - limits.y1 * k, v.y)),
      };
    },
    [limits, size],
  );

  /** Zoom by `factor` around `at`, and move that point to `to` (pan and pinch in one). */
  const transform = useCallback(
    (factor: number, at: Pt, to: Pt) =>
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(limits?.minK ?? 0.12, v.k * factor));
        const real = k / v.k;
        return clampView({k, x: to.x - (at.x - v.x) * real, y: to.y - (at.y - v.y) * real});
      }),
    [clampView, limits],
  );

  const reset = useCallback(() => setView({k: 1, x: 0, y: 0}), []);
  const centre = (): Pt => (size && frame ? {x: (frame[0] + frame[2]) / 2, y: (frame[1] + frame[3]) / 2} : {x: 0, y: 0});

  // The wheel zooms at the cursor. A native listener, because React's wheel
  // handler is passive and could not stop the page scrolling. At the zoom
  // limit the wheel is left to the page, so the footer stays reachable.
  useEffect(() => {
    const el = stage.current;
    if (!el || !limits) return;
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : 1;
      const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0018));
      const k = viewRef.current.k;
      if ((factor < 1 && k <= limits.minK + 1e-6) || (factor > 1 && k >= MAX_K - 1e-6)) return;
      event.preventDefault();
      const r = el.getBoundingClientRect();
      const p = {x: event.clientX - r.left, y: event.clientY - r.top};
      transform(factor, p, p);
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, [limits, transform]);

  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{start: Pt; moved: boolean; multi: boolean; key: string | null; cell: string | null} | null>(null);

  const local = (e: {clientX: number; clientY: number}): Pt => {
    const r = stage.current!.getBoundingClientRect();
    return {x: e.clientX - r.left, y: e.clientY - r.top};
  };
  const gesturePoint = (): {c: Pt; d: number} => {
    const pts = [...pointers.current.values()];
    const c = {x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length};
    const d = pts.length > 1 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0;
    return {c, d};
  };
  const last = useRef<{c: Pt; d: number}>({c: {x: 0, y: 0}, d: 0});

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('.owners-ui')) return;
    const p = local(event);
    pointers.current.set(event.pointerId, p);
    const target = event.target as Element;
    if (pointers.current.size === 1) {
      gesture.current = {
        start: p,
        moved: false,
        multi: false,
        key: target.closest('[data-key]')?.getAttribute('data-key') ?? null,
        cell: target.closest('[data-cell]')?.getAttribute('data-cell') ?? null,
      };
    } else if (gesture.current) {
      gesture.current.multi = true;
    }
    last.current = gesturePoint();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!pointers.current.has(event.pointerId) || !g) {
      // Hover: a mouse names the region under it; touch names it on tap.
      if (event.pointerType === 'mouse') {
        const key = (event.target as Element).closest('[data-key]')?.getAttribute('data-key') ?? null;
        setActive((a) => (a === key ? a : key));
      }
      return;
    }
    pointers.current.set(event.pointerId, local(event));
    const now = gesturePoint();
    if (!g.moved && !g.multi && Math.hypot(now.c.x - g.start.x, now.c.y - g.start.y) < 5) return;
    g.moved = true;
    const prev = last.current;
    transform(prev.d > 0 && now.d > 0 ? now.d / prev.d : 1, prev.c, now.c);
    last.current = now;
  }

  function up(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (pointers.current.size > 0) {
      last.current = gesturePoint();
      return;
    }
    gesture.current = null;
    if (!g || g.moved || g.multi || !drawn) return;
    if (g.cell) {
      setSelected(g.cell);
      return;
    }
    setSelected(null);
    if (g.key) setActive(g.key);
    if (!placing) return;
    const v = viewRef.current;
    const point = drawn.projection.invert?.([(g.start.x - v.x) / v.k, (g.start.y - v.y) / v.k]);
    if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) setDraft({lat: point[1], lon: point[0]});
  }

  const place = (lat: number, lon: number): [number, number] | null => {
    const p = drawn?.projection([lon, lat]);
    return p ? [p[0] * view.k + view.x, p[1] * view.k + view.y] : null;
  };

  /** The real ~10 km cell as a screen path, so the owner can see what area they are choosing. */
  const cellPath = (c: Cell): string | null => {
    const h = cellHalfSpan(c);
    const corners = [
      place(c.lat - h.lat, c.lon - h.lon),
      place(c.lat - h.lat, c.lon + h.lon),
      place(c.lat + h.lat, c.lon + h.lon),
      place(c.lat + h.lat, c.lon - h.lon),
    ];
    if (corners.some((p) => p === null)) return null;
    return `M${corners.map((p) => `${p![0].toFixed(1)} ${p![1].toFixed(1)}`).join('L')}Z`;
  };

  const draftCell = draft && placing ? snapToCell(draft.lat, draft.lon) : null;
  const draftAt = draftCell ? place(draftCell.lat, draftCell.lon) : null;
  const draftPath = draftCell ? cellPath(draftCell) : null;
  const ownCell = own ? snapToCell(own.cellLat, own.cellLon) : null;
  const ownPath = ownCell ? cellPath(ownCell) : null;
  const chosen = cells.find((c) => c.id === selected) ?? null;
  const chosenAt = chosen ? place(chosen.lat, chosen.lon) : null;

  // After a pick, zoom to the chosen spot so its square is big enough to check.
  const draftId = draftCell?.id;
  useEffect(() => {
    if (!drawn || !draftCell || !size || !frame) return;
    const p = drawn.projection([draftCell.lon, draftCell.lat]);
    if (!p) return;
    const c = centre();
    setView((v) => (v.k >= PICK_ZOOM ? v : clampView({k: PICK_ZOOM, x: c.x - p[0] * PICK_ZOOM, y: c.y - p[1] * PICK_ZOOM})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, drawn]);

  const current = active ? byKey.get(active) : undefined;
  const chosenPlace = geo && chosen ? placeAt(geo, chosen.lat, chosen.lon) : null;
  const zoomBy = (f: number) => {
    const c = centre();
    transform(f, c, c);
  };

  return (
    <section className="owners-map" aria-labelledby="owners-title">
      <div
        ref={stage}
        className="owners-stage"
        data-placing={placing ? '1' : undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          gesture.current = null;
        }}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
        onDoubleClick={(e) => {
          const p = local(e);
          transform(2, p, p);
        }}
      >
        {drawn && size ? (
          <svg
            className="owners-svg"
            width={size.w}
            height={size.h}
            viewBox={`0 0 ${size.w} ${size.h}`}
            role="img"
            aria-label={copyText('owners.map_aria') ?? 'Map of OpenDrone owners by country and US state'}
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <Land shapes={drawn.shapes} snapshot={snapshot} />
              {current ? <path d={current.d} className="owners-land is-active" data-b={current.region && snapshot ? snapshot.regions[current.region] : undefined} pointerEvents="none" /> : null}
            </g>
            {ownPath ? <path d={ownPath} className="owners-cell is-own" pointerEvents="none" /> : null}
            {draftPath ? <path d={draftPath} className="owners-cell" pointerEvents="none" /> : null}
            {cells.map((c) => {
              const at = place(c.lat, c.lon);
              if (!at) return null;
              const isOwn = own !== null && c.lat === own.cellLat && c.lon === own.cellLon;
              return (
                <g
                  key={c.id}
                  data-cell={c.id}
                  transform={`translate(${at[0].toFixed(1)} ${at[1].toFixed(1)})`}
                  className={`owners-pin${isOwn ? ' is-own' : ''}${selected === c.id ? ' is-active' : ''}`}
                >
                  <circle className="owners-pin-halo" r={c.count > 1 ? 13 : 10} />
                  <circle className="owners-pin-dot" r={c.count > 1 ? 10 : 7} />
                  {c.count > 1 ? <text y="3.5">{c.count}</text> : null}
                </g>
              );
            })}
            {draftAt ? (
              <g transform={`translate(${draftAt[0].toFixed(1)} ${draftAt[1].toFixed(1)})`} pointerEvents="none">
                <circle r="14" className="owners-draft-ring" />
                <circle r="2.5" className="owners-draft-dot" />
              </g>
            ) : null}
          </svg>
        ) : (
          <p className="owners-status">
            {failed ? copyText('owners.map_failed') : copyText('owners.map_loading')}
          </p>
        )}

        {chosen && chosenAt && size ? (
          <div
            className="visit-card owners-pop owners-ui"
            style={{
              left: Math.min(size.w - 120, Math.max(120, chosenAt[0])),
              top: chosenAt[1] < 150 ? chosenAt[1] + 18 : chosenAt[1] - 14,
              transform: chosenAt[1] < 150 ? 'translateX(-50%)' : 'translate(-50%, -100%)',
            }}
            aria-live="polite"
          >
            <button type="button" className="owners-pop-close" onClick={() => setSelected(null)} aria-label={copyText('owners.pilot_close') ?? 'Close'}>
              &times;
            </button>
            <p className="owners-pop-title" title={coordTitle(chosen.lat, chosen.lon)}>
              {areaText(chosenPlace)}
            </p>
            <PilotNames cell={chosen} own={own} />
          </div>
        ) : null}
      </div>

      <div className="owners-zoom owners-ui" role="group" aria-label={copyText('owners.zoom_label') ?? 'Zoom'}>
        <button type="button" className="od-btn-icon" onClick={() => zoomBy(2)} aria-label={copyText('owners.pilot_zoom_in') ?? 'Zoom in'}>
          +
        </button>
        <button type="button" className="od-btn-icon" onClick={() => zoomBy(0.5)} aria-label={copyText('owners.pilot_zoom_out') ?? 'Zoom out'}>
          -
        </button>
        <button type="button" className="od-btn-icon" onClick={reset} aria-label={copyText('owners.pilot_zoom_reset') ?? 'Reset view'}>
          &#8962;
        </button>
      </div>

      <div ref={card} className="visit-card owners-card owners-ui" data-placing={placing ? '1' : undefined}>
        <h1 id="owners-title" className="editorial-section-title">
          <Txt id="owners.title" />
        </h1>
        <table className="visit-hours owners-figures">
          <tbody>
            <tr aria-live="polite">
              <th scope="row">
                {current ? current.name : (copyText('owners.row_world') ?? 'Worldwide')}
                <span className="visit-hours-what">{copyText('owners.row_owners') ?? 'Owners'}</span>
              </th>
              <td className="visit-hours-time">{current ? rangeFor(current, snapshot) : (snapshot?.total ? `${snapshot.total}+` : '-')}</td>
            </tr>
            {!current && snapshot?.countries ? (
              <tr>
                <th scope="row">{copyText('owners.row_countries') ?? 'Countries'}</th>
                <td className="visit-hours-time">{snapshot.countries}</td>
              </tr>
            ) : null}
            {!current && panel ? (
              <tr>
                <th scope="row">
                  {copyText('owners.row_pilots') ?? 'Pilots'}
                  <span className="visit-hours-what">{copyText('owners.row_pilots_what') ?? 'On the pilot map'}</span>
                </th>
                <td className="visit-hours-time">{panel.view.total}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <Txt id={hasRegions ? 'owners.note' : 'owners.empty'} as="p" className="visit-card-note" />

        {panel ? <PilotBlock panel={panel} notice={notice} geo={geo} draft={draft} onDraft={setDraft} onPlacing={onPlacing} /> : null}

        <p className="visit-map-credit">
          {copyText('owners.credit')}
          {fixture && import.meta.env.DEV ? ` · ${copyText('owners.fixture_note') ?? 'Sample numbers.'}` : null}
        </p>
      </div>
      {children}
    </section>
  );
}
