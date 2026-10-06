import {redirect} from 'react-router';
import type {Route} from './+types/owners_.discord';
import {accountHeaders, notFound} from '~/lib/accounts/config';
import {discordStart, pilotMapEnabled} from '~/lib/pilot-map-data';
import {readViewer, devDiscordActive} from '~/lib/pilot-map-server';

/**
 * GET /owners/discord: start linking a Discord account for the pilot map.
 * Owners only. Sends the browser to Discord's authorize screen (scope
 * identify, state and PKCE S256), or on the dev server to the fake screen
 * (app/lib/pilot-map-dev.ts). The answer comes back to
 * /owners/discord/callback.
 */
export const headers = () => accountHeaders();

export async function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!pilotMapEnabled(env)) throw notFound();
  const viewer = await readViewer(env, request);
  const back = (notice: string) => redirect(`/owners?pilot=${notice}#pilots`, {headers: cookieHeaders(viewer.cookies)});
  if (!viewer.session || !viewer.owner) return back('owners-only');
  const origin = new URL(request.url).origin;
  const dev = devDiscordActive(env);
  const start = await discordStart(env, viewer.session.shopifyGid, origin, dev ? '/owners/dev-discord/authorize' : undefined);
  if (!start || (!dev && !env.DISCORD_OAUTH_CLIENT_ID)) return back('unavailable');
  const responseHeaders = cookieHeaders([...viewer.cookies, start.cookie]);
  return redirect(start.location, {headers: responseHeaders});
}

function cookieHeaders(cookies: string[]): Headers {
  const headers = accountHeaders();
  for (const c of cookies) headers.append('Set-Cookie', c);
  return headers;
}
