import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {Link, useRevalidator} from 'react-router';
import {geoPath} from 'd3-geo';
import {HEIGHT, WIDTH, useGeo, worldProjection} from '~/components/OwnerMap';
import {Txt} from '~/components/Txt';
import {copyFill, copyText} from '~/lib/copy';
import {
  PILOT_CONSENT_VERSION,
  discordProfileUrl,
  snapToCell,
  type PilotCell,
} from '~/lib/pilot-map';
import type {OwnPin} from '~/lib/pilot-map-data';
import type {PilotPanel} from '~/lib/pilot-map-server';

/**
 * "Find pilots near you" on /owners (README "Owners map"). The server decides
 * what this viewer may see (`pilotPanel`, app/lib/pilot-map-server.ts); this
 * component only draws what it was given:
 *
 * | Viewer | Sees |
 * |---|---|
 * | Signed out | the number of pilots and a sign-in link |
 * | Signed in, no qualifying order | the number and a note |
 * | Owner | the map with ~10 km cells, who is in each, and the sign-up or withdraw controls |
 *
 * The point an owner clicks is held in this component's state until Submit
 * and is snapped to its cell on the server; only the cell is stored.
 */

type OpenPanel = Extract<PilotPanel, {enabled: true}>;

const MAX_ZOOM = 100;
const MARKER_R = 9;
const NOTICES = [
  'linked',
  'denied',
  'failed',
  'unavailable',
  'owners-only',
] as const;
type Notice = (typeof NOTICES)[number];

export const pilotNotice = (raw: string | null): Notice | null =>
  (NOTICES as readonly string[]).includes(raw ?? '') ? (raw as Notice) : null;

const coord = (n: number) => n.toFixed(3);

function countText(n: number): string {
  if (n === 0)
    return (
      copyText('owners.pilot_count_none') ?? 'Nobody is on the pilot map yet.'
    );
  if (n === 1)
    return copyText('owners.pilot_count_one') ?? '1 pilot is on the map.';
  return copyFill('owners.pilot_count', '{n} pilots are on the map.', {n});
}

export function PilotMap({
  panel,
  notice,
}: {
  panel: OpenPanel;
  notice: Notice | null;
}) {
  return (
    <section
      id="pilots"
      className="editorial-section pilot-section"
      aria-labelledby="pilot-title"
    >
      <Txt id="owners.pilot_eyebrow" as="p" className="editorial-eyebrow" />
      <h2 id="pilot-title" className="editorial-section-title pilot-title">
        {copyText('owners.pilot_title') ?? 'Find pilots near you'}
      </h2>
      <Txt id="owners.pilot_lead" as="p" className="pilot-lead" />

      {notice && !(notice === 'linked' && panel.own) ? (
        <p
          className="pilot-notice"
          role="status"
          data-tone={notice === 'linked' ? 'ok' : 'warn'}
        >
          {copyText(`owners.pilot_notice_${notice.replace('-', '_')}`)}
        </p>
      ) : null}

      <p className="pilot-count">{countText(panel.view.total)}</p>

      {!panel.signedIn ? (
        <div className="pilot-card">
          <p>{copyText('owners.pilot_signin_note')}</p>
          <Link
            to="/account/login?return_to=%2Fowners%23pilots"
            className="od-btn od-btn-primary"
          >
            {copyText('owners.pilot_signin_cta') ?? 'Sign in'}
          </Link>
        </div>
      ) : !panel.owner ? (
        <div className="pilot-card">
          <p>{copyText('owners.pilot_not_owner')}</p>
        </div>
      ) : (
        <OwnerPanel panel={panel} />
      )}
    </section>
  );
}

type Draft = {lat: number; lon: number};

function OwnerPanel({panel}: {panel: OpenPanel}) {
  const revalidator = useRevalidator();
  const {own, linkedName} = panel;
  const cells = panel.view.cells ?? [];
  const [moving, setMoving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [consent, setConsent] = useState(false);
  const [age16, setAge16] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);

  const signingUp = !own ? Boolean(linkedName) : moving;
  const cell = draft ? snapToCell(draft.lat, draft.lon) : null;

  async function send(body: FormData): Promise<{ok: boolean; error?: string}> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/pilot-map', {
        method: 'POST',
        body,
        credentials: 'same-origin',
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      return {ok: res.ok && json.ok === true, error: json.error};
    } catch {
      return {ok: false, error: 'generic'};
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return setError('position');
    if (!consent || !age16) return setError('consent');
    const body = new FormData();
    body.set('intent', 'place');
    body.set('lat', String(draft.lat));
    body.set('lon', String(draft.lon));
    body.set('consent', '1');
    body.set('age16', '1');
    body.set('version', PILOT_CONSENT_VERSION);
    const result = await send(body);
    if (!result.ok) return setError(result.error ?? 'generic');
    setDraft(null);
    setConsent(false);
    setAge16(false);
    setMoving(false);
    setWithdrawn(false);
    void revalidator.revalidate();
  }

  async function withdraw() {
    const body = new FormData();
    body.set('intent', 'withdraw');
    const result = await send(body);
    if (!result.ok) return setError(result.error ?? 'generic');
    setMoving(false);
    setDraft(null);
    setWithdrawn(true);
    void revalidator.revalidate();
  }

  function locate() {
    setError(null);
    if (!navigator.geolocation) return setError('locate');
    navigator.geolocation.getCurrentPosition(
      (pos) => setDraft({lat: pos.coords.latitude, lon: pos.coords.longitude}),
      () => setError('locate'),
      {enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000},
    );
  }

  const errorText = error
    ? error === 'locate'
      ? (copyText('owners.pilot_locate_failed') ??
        'Could not read your location.')
      : (copyText(`owners.pilot_err_${error.replace('-', '_')}`) ??
        copyText('owners.pilot_err_generic'))
    : null;

  return (
    <div className="pilot-layout">
      <div className="pilot-side">
        {withdrawn && !own ? (
          <p className="pilot-notice" role="status" data-tone="ok">
            {copyText('owners.pilot_withdrawn')}
          </p>
        ) : null}

        {own && !moving ? (
          <div className="pilot-card" data-state="on">
            <h3 className="pilot-card-title">
              {copyText('owners.pilot_own_title')}
            </h3>
            <p>
              {copyFill('owners.pilot_own_body', 'Shown as {name}.', {
                name: own.discordName,
                lat: coord(own.cellLat),
                lon: coord(own.cellLon),
                date: new Date(own.consentAt).toLocaleDateString('en', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  timeZone: 'UTC',
                }),
              })}
            </p>
            <div className="pilot-actions">
              <button
                type="button"
                className="od-btn od-btn-secondary od-btn-sm"
                onClick={() => setMoving(true)}
              >
                {copyText('owners.pilot_own_move')}
              </button>
              <button
                type="button"
                className="od-btn od-btn-danger od-btn-sm"
                disabled={busy}
                onClick={() => void withdraw()}
              >
                {copyText('owners.pilot_own_withdraw')}
              </button>
            </div>
            {errorText ? (
              <p className="pilot-error" role="alert">
                {errorText}
              </p>
            ) : null}
          </div>
        ) : !own && !linkedName ? (
          <div className="pilot-card">
            <h3 className="pilot-card-title">
              {copyText('owners.pilot_step1_title')}
            </h3>
            <p>{copyText('owners.pilot_step1_body')}</p>
            {panel.canLink ? (
              // A plain link: the route redirects to Discord, so no client navigation.
              <a href="/owners/discord" className="od-btn od-btn-primary">
                {copyText('owners.pilot_step1_cta') ?? 'Link Discord'}
              </a>
            ) : (
              <p className="pilot-muted">
                {copyText('owners.pilot_step1_unavailable')}
              </p>
            )}
          </div>
        ) : (
          <form className="pilot-card" onSubmit={(e) => void submit(e)} noValidate>
            <h3 className="pilot-card-title">
              {copyText('owners.pilot_step2_title')}
            </h3>
            {linkedName ? (
              <p className="pilot-muted">
                {copyFill('owners.pilot_linked_as', 'Linked as {name}.', {
                  name: linkedName,
                })}
              </p>
            ) : null}
            <p>{copyText('owners.pilot_step2_body')}</p>
            <div className="pilot-actions">
              <button
                type="button"
                className="od-btn od-btn-secondary od-btn-sm"
                onClick={locate}
              >
                {copyText('owners.pilot_locate')}
              </button>
            </div>
            <p className="pilot-draft" aria-live="polite">
              {cell
                ? copyFill(
                    'owners.pilot_draft',
                    'Chosen: about 10 km around {lat}, {lon}.',
                    {lat: coord(cell.lat), lon: coord(cell.lon)},
                  )
                : copyText('owners.pilot_draft_none')}
            </p>
            <label className="pilot-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>{copyText('owners.pilot_consent_box')}</span>
            </label>
            <label className="pilot-check">
              <input
                type="checkbox"
                checked={age16}
                onChange={(e) => setAge16(e.target.checked)}
              />
              <span>{copyText('owners.pilot_age_box')}</span>
            </label>
            <Txt
              id="owners.pilot_consent_more"
              as="p"
              className="pilot-muted"
            />
            {errorText ? (
              <p className="pilot-error" role="alert">
                {errorText}
              </p>
            ) : null}
            <div className="pilot-actions">
              <button
                type="submit"
                className="od-btn od-btn-primary"
                disabled={busy || !draft || !consent || !age16}
              >
                {busy
                  ? copyText('owners.pilot_submitting')
                  : copyText('owners.pilot_submit')}
              </button>
              {own ? (
                <button
                  type="button"
                  className="od-btn od-btn-ghost"
                  onClick={() => {
                    setMoving(false);
                    setDraft(null);
                    setError(null);
                  }}
                >
                  {copyText('owners.pilot_own_cancel')}
                </button>
              ) : null}
            </div>
          </form>
        )}
      </div>
      <div className="pilot-main">
        <h3 className="pilot-subtitle">{copyText('owners.pilot_map_title')}</h3>
        <PilotWorld
          cells={cells}
          own={own}
          draft={signingUp ? draft : null}
          canPlace={signingUp}
          onPick={(lat, lon) => (setDraft({lat, lon}), setError(null))}
        />
        <PilotList cells={cells} own={own} />
      </div>
    </div>
  );
}

type View = {k: number; x: number; y: number};
const WHOLE: View = {k: 1, x: 0, y: 0};

const clampView = (v: View): View => ({
  k: v.k,
  x: Math.min(0, Math.max(WIDTH * (1 - v.k), v.x)),
  y: Math.min(0, Math.max(HEIGHT * (1 - v.k), v.y)),
});

function PilotWorld({
  cells,
  own,
  draft,
  canPlace,
  onPick,
}: {
  cells: PilotCell[];
  own: OwnPin | null;
  draft: Draft | null;
  canPlace: boolean;
  onPick: (lat: number, lon: number) => void;
}) {
  const {geo, failed} = useGeo();
  const world = useMemo(() => {
    if (!geo) return null;
    const {countryFeatures, projection} = worldProjection(geo);
    const path = geoPath(projection);
    return {
      projection,
      paths: countryFeatures.map((f, i) => ({
        key: String(f.id ?? i),
        d: path(f) ?? '',
      })),
    };
  }, [geo]);
  const [view, setView] = useState<View>(WHOLE);
  const [active, setActive] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    sx: number;
    sy: number;
    vx: number;
    vy: number;
    moved: boolean;
    cell: string | null;
  } | null>(null);

  const zoomAt = (factor: number, px = WIDTH / 2, py = HEIGHT / 2) =>
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(1, v.k * factor));
      return clampView({
        k,
        x: px - ((px - v.x) * k) / v.k,
        y: py - ((py - v.y) * k) / v.k,
      });
    });

  // Pinch on a trackpad (and ctrl or cmd with the wheel) zooms at the cursor; a plain wheel still scrolls the page.
  // A native listener, because React's wheel handler is passive and could not stop the page zoom.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomAt(
        Math.exp(-event.deltaY * 0.01),
        ((event.clientX - rect.left) * WIDTH) / rect.width,
        ((event.clientY - rect.top) * HEIGHT) / rect.height,
      );
    };
    svg.addEventListener('wheel', onWheel, {passive: false});
    return () => svg.removeEventListener('wheel', onWheel);
  }, [world]);

  function toSvg(event: {clientX: number; clientY: number}): [number, number] {
    const rect = svgRef.current!.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) * WIDTH) / rect.width,
      ((event.clientY - rect.top) * HEIGHT) / rect.height,
    ];
  }

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    const [sx, sy] = toSvg(event);
    drag.current = {
      sx,
      sy,
      vx: view.x,
      vy: view.y,
      moved: false,
      cell:
        (event.target as Element)
          .closest('[data-cell]')
          ?.getAttribute('data-cell') ?? null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    const [sx, sy] = toSvg(event);
    if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 4) return;
    d.moved = true;
    setView((v) =>
      clampView({k: v.k, x: d.vx + sx - d.sx, y: d.vy + sy - d.sy}),
    );
  }

  function up(event: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !world) return;
    if (d.cell) return setActive(d.cell);
    if (!canPlace) return;
    const [sx, sy] = toSvg(event);
    const point = world.projection.invert?.([
      (sx - view.x) / view.k,
      (sy - view.y) / view.k,
    ]);
    if (point && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      onPick(point[1], point[0]);
  }

  const place = (lat: number, lon: number): [number, number] | null => {
    const p = world?.projection([lon, lat]);
    return p ? [p[0] * view.k + view.x, p[1] * view.k + view.y] : null;
  };

  const chosen = cells.find((c) => c.id === active) ?? null;
  const draftCell = draft ? snapToCell(draft.lat, draft.lon) : null;
  const draftAt = draftCell ? place(draftCell.lat, draftCell.lon) : null;
  // Half a cell (0.045 degrees of latitude) in screen units, so the ring shows the real area at any zoom.
  const halfCell = (() => {
    if (!world || !draftCell) return 0;
    const a = world.projection([draftCell.lon, draftCell.lat]);
    const b = world.projection([draftCell.lon, draftCell.lat + 0.045]);
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) * view.k : 0;
  })();

  return (
    <figure className="owner-map pilot-world">
      <div className="owner-map-frame">
        {world ? (
          <svg
            ref={svgRef}
            className="owner-map-svg pilot-world-svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label={copyText('owners.pilot_map_aria') ?? 'Map of pilots'}
            data-placing={canPlace ? '1' : undefined}
            style={{touchAction: view.k > 1 ? 'none' : 'manipulation'}}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => (drag.current = null)}
            onDoubleClick={(e) => zoomAt(2, ...toSvg(e))}
          >
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {world.paths.map((p) => (
                <path
                  key={p.key}
                  d={p.d}
                  className="owner-map-region pilot-country"
                />
              ))}
            </g>
            {cells.map((c) => {
              const at = place(c.lat, c.lon);
              if (!at) return null;
              const isOwn =
                own !== null && c.lat === own.cellLat && c.lon === own.cellLon;
              return (
                <g
                  key={c.id}
                  data-cell={c.id}
                  transform={`translate(${at[0]} ${at[1]})`}
                  className={`pilot-marker${isOwn ? ' is-own' : ''}${active === c.id ? ' is-active' : ''}`}
                >
                  <circle r={MARKER_R} />
                  {c.count > 1 ? <text y="3.5">{c.count}</text> : null}
                </g>
              );
            })}
            {draftAt ? (
              <g
                className="pilot-draft-marker"
                transform={`translate(${draftAt[0]} ${draftAt[1]})`}
                pointerEvents="none"
              >
                <circle r={Math.max(6, halfCell)} />
                <circle r="2.5" className="pilot-draft-dot" />
              </g>
            ) : null}
          </svg>
        ) : (
          <p className="owner-map-status">
            {failed
              ? copyText('owners.map_failed')
              : copyText('owners.map_loading')}
          </p>
        )}
        <div className="pilot-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="od-btn-icon"
            onClick={() => zoomAt(2)}
            aria-label={copyText('owners.pilot_zoom_in') ?? 'Zoom in'}
          >
            +
          </button>
          <button
            type="button"
            className="od-btn-icon"
            onClick={() => zoomAt(0.5)}
            aria-label={copyText('owners.pilot_zoom_out') ?? 'Zoom out'}
          >
            -
          </button>
          <button
            type="button"
            className="od-btn-icon"
            onClick={() => setView(WHOLE)}
            aria-label={copyText('owners.pilot_zoom_reset') ?? 'Whole world'}
          >
            &#8962;
          </button>
        </div>
      </div>
      <figcaption className="pilot-caption">
        {chosen ? (
          <div className="pilot-selected" aria-live="polite">
            <p className="pilot-selected-title">
              {copyFill(
                'owners.pilot_cell',
                'About 10 km around {lat}, {lon}',
                {lat: coord(chosen.lat), lon: coord(chosen.lon)},
              )}
            </p>
            <PilotNames cell={chosen} own={own} />
          </div>
        ) : (
          <p className="pilot-muted">
            {cells.length
              ? copyText('owners.pilot_selected_none')
              : copyText('owners.pilot_empty_owner')}
          </p>
        )}
        <p className="pilot-muted">{copyText('owners.pilot_map_hint')}</p>
      </figcaption>
    </figure>
  );
}

function PilotNames({cell, own}: {cell: PilotCell; own: OwnPin | null}) {
  const isOwn = (name: string) =>
    own !== null &&
    cell.lat === own.cellLat &&
    cell.lon === own.cellLon &&
    name === own.discordName;
  return (
    <ul className="pilot-names">
      {cell.pilots.map((p) => (
        <li key={p.discordId}>
          <a
            href={discordProfileUrl(p.discordId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {p.name}
          </a>
          {isOwn(p.name) ? (
            <span className="pilot-you">
              {copyText('owners.pilot_cell_you')}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The text twin of the map: every area and who is in it, readable without it. */
function PilotList({cells, own}: {cells: PilotCell[]; own: OwnPin | null}) {
  if (!cells.length) return null;
  return (
    <details className="pilot-list">
      <summary>{copyText('owners.pilot_list_title') ?? 'All areas'}</summary>
      <ul>
        {cells.map((c) => (
          <li key={c.id}>
            <span className="pilot-list-area">
              {copyFill(
                'owners.pilot_cell',
                'About 10 km around {lat}, {lon}',
                {lat: coord(c.lat), lon: coord(c.lon)},
              )}
            </span>
            <PilotNames cell={c} own={own} />
          </li>
        ))}
      </ul>
    </details>
  );
}
