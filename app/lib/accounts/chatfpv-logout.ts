/**
 * Back-channel logout to ChatFPV (accounts contract): POST
 * `/v1/auth/backchannel-logout {sid}` with the store key, over the CHATFPV
 * service binding when the Worker has one. Best effort: a ChatFPV outage
 * never blocks signing out of opendrone.be.
 */
import {chatFpvOrigin} from '../support/chatfpv.ts';

export type BackchannelEnv = {
  CHATFPV?: {fetch: typeof fetch};
  CHATFPV_URL?: string;
  CHATFPV_KEY?: string;
};

const TIMEOUT_MS = 3000;

export async function chatFpvBackchannelLogout(env: BackchannelEnv, sid: string, fetcher?: typeof fetch): Promise<boolean> {
  const origin = chatFpvOrigin(env);
  if (!origin || !env.CHATFPV_KEY) return false;
  const binding = env.CHATFPV;
  const send: typeof fetch = fetcher ?? (binding ? (i, init) => binding.fetch(i, init) : (i, init) => fetch(i, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await send(new URL('/v1/auth/backchannel-logout', origin).toString(), {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json', 'X-ChatFPV-Key': env.CHATFPV_KEY},
      body: JSON.stringify({sid}),
      signal: controller.signal,
    });
    if (!res.ok) console.warn('[accounts] backchannel logout', res.status);
    return res.ok;
  } catch {
    console.warn('[accounts] backchannel logout failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
