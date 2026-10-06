import {redirect} from 'react-router';
import type {Route} from './+types/owners_.discord.callback';
import {accountHeaders, notFound} from '~/lib/accounts/config';
import {
  callbackUrl,
  clearOauthCookie,
  discordCallbackCheck,
  discordIdentity,
  linkCookie,
  pilotMapEnabled,
  type DiscordIdentity,
} from '~/lib/pilot-map-data';
import {readViewer, devDiscordActive} from '~/lib/pilot-map-server';

/**
 * GET /owners/discord/callback: Discord's answer. Checks the state cookie and
 * that the same owner is still signed in, trades the code for the Discord id
 * and username (nothing else, and the token is revoked at once), and keeps
 * them in a one-hour cookie until the owner ticks consent and places the pin.
 * Nothing is written to the database here.
 */
export const headers = () => accountHeaders();

export async function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!pilotMapEnabled(env)) throw notFound();
  const url = new URL(request.url);
  const viewer = await readViewer(env, request);
  const cookies = [...viewer.cookies, clearOauthCookie()];
  const done = (notice: string, extra: string[] = []) => {
    const headers = accountHeaders();
    for (const c of [...cookies, ...extra]) headers.append('Set-Cookie', c);
    return redirect(`/owners?pilot=${notice}#pilots`, {headers});
  };
  if (!viewer.session || !viewer.owner) return done('owners-only');
  if (url.searchParams.get('error')) return done('denied');
  const code = url.searchParams.get('code');
  const checked = await discordCallbackCheck(env, request, viewer.session.shopifyGid, url.searchParams.get('state'));
  if (!code || !checked) return done('failed');

  let identity: DiscordIdentity | null;
  if (import.meta.env.DEV && devDiscordActive(env)) {
    const {devDiscordIdentity} = await import('~/lib/pilot-map-dev');
    identity = await devDiscordIdentity(env, code);
  } else {
    identity = await discordIdentity(env, code, checked.verifier, callbackUrl(env, url.origin));
  }
  const cookie = identity ? await linkCookie(env, viewer.session.shopifyGid, identity) : null;
  return cookie ? done('linked', [cookie]) : done('failed');
}
