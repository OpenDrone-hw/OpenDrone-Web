import {data, Link, redirect} from 'react-router';
import type {Route} from './+types/support_.resume';
import {copyText} from '~/lib/copy';
import {fill} from '~/components/SupportUi';
import {clientIp} from '~/lib/rate-limit';
import {supportRateLimit} from '~/lib/support/limits';
import {originOf, secureCookies, supportDeps, supportReady} from '~/lib/support/server';
import {readTicketCookie, verifyResumeToken, withTicket} from '~/lib/support/tokens';

/**
 * A private link: `/support/resume?t=<token>`. A valid token for the
 * ticket's current link version adds the ticket to this browser's cookie
 * and moves on to the clean ticket URL, so the token leaves the address
 * bar and the history.
 */
export const meta: Route.MetaFunction = () => [{title: 'Support'}, {name: 'robots', content: 'noindex, nofollow'}];

const t = (key: string, vars: Record<string, string> = {}) => fill(copyText(`support.${key}`), vars);

export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;
  const headers = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'};
  if (!supportReady(env) || !supportRateLimit('resume', clientIp(request)).allowed) {
    return data({ok: false}, {status: 429, headers});
  }
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
  return data({ok: false}, {status: 410, headers});
}

export default function ResumeRoute() {
  return (
    <div className="page-shell sp-page">
      <header className="page-header">
        <h1 className="page-title">{t('resume_invalid_title')}</h1>
        <p className="page-description">{t('resume_invalid_body')}</p>
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
