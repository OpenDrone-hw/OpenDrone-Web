import {useEffect, useState, type FormEvent} from 'react';
import {Link, useRevalidator} from 'react-router';
import {Txt} from '~/components/Txt';
import {copyFill, copyText} from '~/lib/copy';
import {placeAt, type Geo} from '~/lib/owner-map-draw';
import {PILOT_CONSENT_VERSION, discordProfileUrl, snapToCell, type PilotCell} from '~/lib/pilot-map';
import type {OwnPin} from '~/lib/pilot-map-data';
import type {PilotPanel} from '~/lib/pilot-map-server';

/**
 * The pilot block of the owners card (README "Owners map"). The server decides
 * what this viewer may see (`pilotPanel`, app/lib/pilot-map-server.ts); this
 * component only draws what it was given:
 *
 * | Viewer | Sees |
 * |---|---|
 * | Signed out | the number of pilots and a sign-in link |
 * | Signed in, no qualifying order | the number and a note |
 * | Owner | who is in each area (dots on the map), and the sign-up or withdraw controls |
 *
 * The point an owner taps is held in `draft` (owned by the map) until Submit
 * and is snapped to its cell on the server; only the cell is stored.
 */

export type OpenPanel = Extract<PilotPanel, {enabled: true}>;
export type Draft = {lat: number; lon: number};

const NOTICES = ['linked', 'denied', 'failed', 'unavailable', 'owners-only'] as const;
export type Notice = (typeof NOTICES)[number];

export const pilotNotice = (raw: string | null): Notice | null =>
  (NOTICES as readonly string[]).includes(raw ?? '') ? (raw as Notice) : null;

/** Coordinates only for a tooltip: the visible text names the area instead. */
export const coordTitle = (lat: number, lon: number) => `${lat.toFixed(3)}, ${lon.toFixed(3)}`;

/** "About 10 km area in Texas, United States", or without the place over open sea. */
export function areaText(place: string | null): string {
  return place
    ? copyFill('owners.pilot_cell', 'About 10 km area in {place}', {place})
    : (copyText('owners.pilot_cell_open') ?? 'About 10 km area');
}


export function PilotNames({cell, own}: {cell: PilotCell; own: OwnPin | null}) {
  const isOwn = (name: string) =>
    own !== null && cell.lat === own.cellLat && cell.lon === own.cellLon && name === own.discordName;
  return (
    <ul className="owners-names">
      {cell.pilots.map((p) => (
        <li key={p.discordId}>
          <a href={discordProfileUrl(p.discordId)} target="_blank" rel="noopener noreferrer">
            {p.name}
          </a>
          {isOwn(p.name) ? <span className="owners-you">{copyText('owners.pilot_cell_you')}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function PilotBlock({
  panel,
  notice,
  geo,
  draft,
  onDraft,
  onPlacing,
}: {
  panel: OpenPanel;
  notice: Notice | null;
  geo: Geo | null;
  draft: Draft | null;
  onDraft: (d: Draft | null) => void;
  /** Tells the map whether a tap places a pin. */
  onPlacing: (placing: boolean) => void;
}) {
  const revalidator = useRevalidator();
  const {own, linkedName} = panel;
  const [moving, setMoving] = useState(false);
  const [consent, setConsent] = useState(false);
  const [age16, setAge16] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);

  const signingUp = panel.owner && (!own ? Boolean(linkedName) : moving);
  useEffect(() => {
    onPlacing(signingUp);
    return () => onPlacing(false);
  }, [signingUp, onPlacing]);

  const cell = draft ? snapToCell(draft.lat, draft.lon) : null;
  const draftPlace = geo && cell ? placeAt(geo, cell.lat, cell.lon) : null;
  const ownPlace = geo && own ? placeAt(geo, own.cellLat, own.cellLon) : null;

  async function send(body: FormData): Promise<{ok: boolean; error?: string}> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/pilot-map', {method: 'POST', body, credentials: 'same-origin'});
      const json = (await res.json().catch(() => ({}))) as {ok?: boolean; error?: string};
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
    onDraft(null);
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
    onDraft(null);
    setWithdrawn(true);
    void revalidator.revalidate();
  }

  function locate() {
    setError(null);
    if (!navigator.geolocation) return setError('locate');
    navigator.geolocation.getCurrentPosition(
      (pos) => onDraft({lat: pos.coords.latitude, lon: pos.coords.longitude}),
      () => setError('locate'),
      {enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000},
    );
  }

  const errorText = error
    ? error === 'locate'
      ? (copyText('owners.pilot_locate_failed') ?? 'Could not read your location.')
      : (copyText(`owners.pilot_err_${error.replace('-', '_')}`) ?? copyText('owners.pilot_err_generic'))
    : null;
  const error$ = errorText ? (
    <p className="owners-error" role="alert">
      {errorText}
    </p>
  ) : null;

  return (
    <div className="owners-pilot">
      {notice && !(notice === 'linked' && own) ? (
        <p className="owners-note" role="status" data-tone={notice === 'linked' ? 'ok' : 'warn'}>
          {copyText(`owners.pilot_notice_${notice.replace('-', '_')}`)}
        </p>
      ) : null}
      {withdrawn && !own ? (
        <p className="owners-note" role="status" data-tone="ok">
          {copyText('owners.pilot_withdrawn')}
        </p>
      ) : null}

      {!panel.signedIn ? (
        <Link to="/account/login?return_to=%2Fowners" className="visit-card-link">
          {copyText('owners.pilot_signin_cta') ?? 'Sign in to find pilots near you'} ↗
        </Link>
      ) : !panel.owner ? (
        <p className="owners-muted">{copyText('owners.pilot_not_owner')}</p>
      ) : own && !moving ? (
        <>
          <p className="owners-pilot-title">{copyText('owners.pilot_own_title')}</p>
          <p className="owners-muted">
            {copyFill('owners.pilot_own_body', 'Shown as {name}.', {
              name: own.discordName,
              place: ownPlace ?? (copyText('owners.pilot_place_unknown') ?? 'your chosen spot'),
              date: new Date(own.consentAt).toLocaleDateString('en', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}),
            })}
          </p>
          <div className="owners-actions">
            <button type="button" className="od-btn od-btn-secondary od-btn-sm" onClick={() => setMoving(true)}>
              {copyText('owners.pilot_own_move')}
            </button>
            <button type="button" className="od-btn od-btn-danger od-btn-sm" disabled={busy} onClick={() => void withdraw()}>
              {copyText('owners.pilot_own_withdraw')}
            </button>
          </div>
          {error$}
        </>
      ) : !own && !linkedName ? (
        <>
          <p className="owners-pilot-title">{copyText('owners.pilot_step1_title')}</p>
          <p className="owners-muted">{copyText('owners.pilot_step1_body')}</p>
          {panel.canLink ? (
            // A plain link: the route redirects to Discord, so no client navigation.
            <a href="/owners/discord" className="od-btn od-btn-primary od-btn-sm">
              {copyText('owners.pilot_step1_cta') ?? 'Link Discord'}
            </a>
          ) : (
            <p className="owners-muted">{copyText('owners.pilot_step1_unavailable')}</p>
          )}
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)} noValidate>
          <p className="owners-pilot-title">{copyText('owners.pilot_step2_title')}</p>
          {linkedName ? (
            <p className="owners-muted">{copyFill('owners.pilot_linked_as', 'Linked as {name}.', {name: linkedName})}</p>
          ) : null}
          <p className="owners-muted">{copyText('owners.pilot_step2_body')}</p>
          <p className="owners-draft" aria-live="polite" title={cell ? coordTitle(cell.lat, cell.lon) : undefined}>
            {cell
              ? draftPlace
                ? copyFill('owners.pilot_draft', 'Chosen: about 10 km area in {place}.', {place: draftPlace})
                : copyText('owners.pilot_draft_open')
              : copyText('owners.pilot_draft_none')}
          </p>
          <details className="owners-facts">
            <summary>{copyText('owners.pilot_facts_title')}</summary>
            <ul>
              <Txt id="owners.pilot_fact_shown" as="li" />
              <Txt id="owners.pilot_fact_to" as="li" />
              <Txt id="owners.pilot_fact_withdraw" as="li" />
            </ul>
          </details>
          <label className="owners-check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{copyText('owners.pilot_consent_box')}</span>
          </label>
          <label className="owners-check">
            <input type="checkbox" checked={age16} onChange={(e) => setAge16(e.target.checked)} />
            <span>{copyText('owners.pilot_age_box')}</span>
          </label>
          {error$}
          <div className="owners-actions">
            <button type="submit" className="od-btn od-btn-primary od-btn-sm" disabled={busy || !draft || !consent || !age16}>
              {busy ? copyText('owners.pilot_submitting') : copyText('owners.pilot_submit')}
            </button>
            <button type="button" className="od-btn od-btn-secondary od-btn-sm" onClick={locate}>
              {copyText('owners.pilot_locate')}
            </button>
            {own ? (
              <button
                type="button"
                className="od-btn od-btn-ghost od-btn-sm"
                onClick={() => {
                  setMoving(false);
                  onDraft(null);
                  setError(null);
                }}
              >
                {copyText('owners.pilot_own_cancel')}
              </button>
            ) : null}
          </div>
          {!busy && (!draft || !consent || !age16) ? (
            <p className="owners-muted" aria-live="polite">
              {copyText('owners.pilot_submit_hint')}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}
