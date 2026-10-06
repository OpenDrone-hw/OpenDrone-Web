/**
 * Local-development stand-in for Discord's OAuth screen (README "Owners map").
 *
 * Only the dev server loads this file: every caller imports it dynamically
 * behind `import.meta.env.DEV`, a production build replaces that with `false`
 * and drops the import, so the marker below never reaches the Worker bundle
 * (pilot-map-data.test.ts scans a build for it). It never talks to Discord.
 */
import {openBlob, signBlob} from './accounts/crypto.ts';
import {cleanDiscordId, cleanDiscordName} from './pilot-map.ts';
import type {DiscordIdentity, PilotEnv} from './pilot-map-data.ts';

const LABEL = 'od-pilot-dev-discord';
const CODE_TTL_SEC = 60;

const FAKE_USERS: ReadonlyArray<DiscordIdentity> = [
  {id: '80351110224678912', name: 'mira_fpv'},
  {id: '80351110224678913', name: 'Jonas (dev)'},
];

const html = (body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Fake Discord (dev)</title>
<body style="font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">${body}</body>`,
    {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}},
  );

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** GET: the fake "Authorize OpenDrone" screen. */
export function devAuthorizePage(url: URL): Response {
  const keep = ['state', 'redirect_uri', 'code_challenge', 'scope'].map((k) => `<input type="hidden" name="${k}" value="${esc(url.searchParams.get(k) ?? '')}">`).join('');
  const options = FAKE_USERS.map((u, i) => `<label style="display:block;margin:.5rem 0"><input type="radio" name="user" value="${i}" ${i === 0 ? 'checked' : ''}> ${esc(u.name)} <small>(${u.id})</small></label>`).join('');
  return html(`<h1>Fake Discord</h1><p>Local development only. OpenDrone asks to read your Discord username and id (scope: identify).</p>
<form method="post">${keep}${options}<button type="submit" style="margin-top:1rem;padding:.5rem 1rem">Authorize</button></form>`);
}

/** POST: pick a fake user and send the browser back to the callback with a signed one-minute code. */
export async function devAuthorizeSubmit(request: Request, env: PilotEnv): Promise<Response> {
  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? '');
  const origin = new URL(request.url).origin;
  if (field('redirect_uri') !== `${origin}/owners/discord/callback` || field('scope') !== 'identify') return new Response('Bad request', {status: 400});
  const user = FAKE_USERS[Number(field('user'))] ?? FAKE_USERS[0]!;
  if (!env.SESSION_SECRET) return new Response('SESSION_SECRET missing', {status: 500});
  const code = await signBlob(env.SESSION_SECRET, LABEL, {i: user.id, n: user.name, c: field('code_challenge'), exp: Math.floor(Date.now() / 1000) + CODE_TTL_SEC});
  const target = new URL(field('redirect_uri'));
  target.searchParams.set('code', code);
  target.searchParams.set('state', field('state'));
  return new Response(null, {status: 303, headers: {Location: target.toString(), 'Cache-Control': 'no-store'}});
}

/** The "token exchange" of the fake: the identity inside a code this dev server signed. */
export async function devDiscordIdentity(env: PilotEnv, code: string): Promise<DiscordIdentity | null> {
  if (!env.SESSION_SECRET) return null;
  const blob = await openBlob<{i: string; n: string; exp: number}>(env.SESSION_SECRET, LABEL, code, Math.floor(Date.now() / 1000));
  const id = cleanDiscordId(blob?.i);
  const name = cleanDiscordName(blob?.n);
  return id && name ? {id, name} : null;
}
