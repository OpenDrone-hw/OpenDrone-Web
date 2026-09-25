import {data, Link, redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/support_.resume';
import {copyText} from '~/lib/copy';
import {fill} from '~/components/SupportUi';
import {clientIp} from '~/lib/rate-limit';
import {resumeRateLimit} from '~/lib/support/limits';
import {originOf, secureCookies, supportDeps, supportReady, supportHeaders} from '~/lib/support/server';
import {readTicketCookie, verifyResumeToken, withTicket} from '~/lib/support/tokens';

/**
 * A private link: `/support/resume?t=<token>`. A valid token for the
 * ticket's current link version adds the ticket to this browser's cookie
 * and moves on to the clean ticket URL, so the token leaves the address
 * bar and the history.
 */
/** Private, never cached, never indexed; keeps loader and action headers. */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () => [{title: 'Support'}, {name: 'robots', content: 'noindex, nofollow'}];

const t = (key: string, vars: Record<string, string> = {}) => fill(copyText(`support.${key}`), vars);

export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;
  const headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'};
  if (!supportReady(env)) return data({reason: 'unavailable' as const}, {status: 503, headers});
  if (!resumeRateLimit(clientIp(request)).allowed) return data({reason: 'rate' as const}, {status: 429, headers});
  const token = new URL(request.url).searchParams.get('t');
  const claim = await verifyResumeToken(env, token);
  if (claim) {
    const deps = supportDeps(env, originOf(request));
    const ticket = await deps.store.getTicket(claim.ref);
    if (ticket && ticket.linkVersion === claim.version) {
      const cookie = await withTicket(env, await readTicketCookie(env, request), {r: ticket.ref, k: ticket.linkVersion}, secureCookies(request));
      return redirect(`/support/t/${ticket.ref}`, {headers: {...headers, 'Set-Cookie': cookie}});
    }
  }
  return data({reason: 'invalid' as const}, {status: 410, headers});
}

export default function ResumeRoute() {
  const {reason} = useLoaderData<typeof loader>();
  const key = reason === 'invalid' ? 'resume_invalid' : reason === 'rate' ? 'resume_rate' : 'resume_unavailable';
  return (
    <div className="page-shell sp-page">
      <header className="page-header">
        <h1 className="page-title">{t(`${key}_title`)}</h1>
        <p className="page-description">{t(`${key}_body`)}</p>
      </header>
      <div className="sp-actions">
        <Link to="/support/find" className="od-btn od-btn-primary">
          {t('find_cta')}
        </Link>
        <Link to="/support" className="od-btn od-btn-secondary">
          {t('find_new')}
        </Link>
      </div>
    </div>
  );
}
