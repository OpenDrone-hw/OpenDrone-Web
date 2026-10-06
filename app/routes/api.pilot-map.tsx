import type {Route} from './+types/api.pilot-map';
import {accountHeaders, jsonResponse, notFound, sameOrigin} from '~/lib/accounts/config';
import {clearLinkCookie, deletePin, pilotMapEnabled, placePin, readLink, readOwnPin} from '~/lib/pilot-map-data';
import {pilotPanel, readViewer} from '~/lib/pilot-map-server';

/**
 * /api/pilot-map, the pilot map's only data route.
 *
 * | Request | Answer |
 * |---|---|
 * | GET | `{total}` for everyone; `{total, cells}` only for a signed-in owner with a qualifying order. 404 while PILOT_MAP_ENABLED is off |
 * | POST `intent=place` (same Origin, signed in, owner) | snaps `lat`/`lon` to the grid cell, stores the cell, the Discord account and the consent; the point itself is not kept |
 * | POST `intent=withdraw` (same Origin, signed in) | deletes the row now |
 *
 * Who may see names and cells is decided here from the session, never from
 * anything the browser sends.
 */
export const headers = () => accountHeaders();

const withCookies = (res: Response, cookies: string[]) => {
  for (const c of cookies) res.headers.append('Set-Cookie', c);
  return res;
};

export async function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!pilotMapEnabled(env)) return notFound();
  const {panel, cookies} = await pilotPanel(env, request);
  if (!panel.enabled) return notFound();
  return withCookies(jsonResponse(panel.view), cookies);
}

export async function action({request, context}: Route.ActionArgs) {
  const {env} = context;
  if (!pilotMapEnabled(env)) return notFound();
  if (request.method !== 'POST' || !sameOrigin(request)) return new Response('Forbidden', {status: 403, headers: accountHeaders()});
  const viewer = await readViewer(env, request);
  if (!viewer.session) return withCookies(jsonResponse({error: 'sign-in'}, 401), viewer.cookies);
  const gid = viewer.session.shopifyGid;
  const db = env.SUPPORT_DB!;
  const form = await request.formData().catch(() => null);
  if (!form) return withCookies(jsonResponse({error: 'bad-request'}, 400), viewer.cookies);
  const intent = form.get('intent');

  if (intent === 'withdraw') {
    await deletePin(db, gid);
    return withCookies(jsonResponse({ok: true}), [...viewer.cookies, clearLinkCookie()]);
  }
  if (intent !== 'place') return withCookies(jsonResponse({error: 'bad-request'}, 400), viewer.cookies);

  const link = await readLink(env, request, gid);
  const num = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined;
  };
  const result = await placePin(db, {
    gid,
    owner: viewer.owner,
    link,
    form: {lat: num('lat'), lon: num('lon'), consent: form.get('consent'), age16: form.get('age16'), version: form.get('version')},
  });
  if (!result.ok) {
    const status = result.error === 'not-owner' ? 403 : 400;
    return withCookies(jsonResponse({error: result.error}, status), viewer.cookies);
  }
  const own = await readOwnPin(db, gid);
  return withCookies(jsonResponse({ok: true, own}), [...viewer.cookies, clearLinkCookie()]);
}
