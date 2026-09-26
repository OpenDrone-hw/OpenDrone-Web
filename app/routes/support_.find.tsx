import {useState} from 'react';
import {data, Form, Link, redirect, useActionData, useNavigation, useRouteLoaderData} from 'react-router';
import type {Route} from './+types/support_.find';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {fill, SupportError, TicketList, TurnstileBox} from '~/components/SupportUi';
import {clientIp} from '~/lib/rate-limit';
import {verifyTurnstile} from '~/lib/turnstile';
import {doorAllowed} from '~/lib/support/limits';
import {originOf, sameOrigin, secureCookies, supportDeps, supportReady, supportHeaders} from '~/lib/support/server';
import {findTickets, publicTicket, type PublicTicket} from '~/lib/support/tickets';
import {readTicketCookie, ticketCookie} from '~/lib/support/tokens';

/**
 * Find my ticket: email plus the order number or ticket number. A match
 * adds the tickets to this browser's cookie; one match opens it directly.
 * A miss says only that nothing matched, never whether the email exists.
 */
/** Private, never cached, never indexed; keeps loader and action headers. */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({title: copyText('support.find_page_title') ?? 'Find your ticket', description: copyText('support.find_lede') ?? ''});

const t = (key: string, vars: Record<string, string> = {}) => fill(copyText(`support.${key}`), vars);

type Result = {ok: false; error: string; at: number} | {ok: true; tickets: PublicTicket[]; at: number};

export async function action({request, context}: Route.ActionArgs) {
  const env = context.env;
  const fail = (error: string, status: number) => data<Result>({ok: false, error, at: Date.now()}, {status});
  if (!sameOrigin(request)) return fail('err_forbidden', 403);
  if (!supportReady(env)) return fail('err_unavailable', 503);
  const ip = clientIp(request);
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase().slice(0, 254);
  const key = String(form.get('key') ?? '').trim().slice(0, 40);
  const deps = supportDeps(env, originOf(request));
  const allowed = await doorAllowed(deps.store, env.SUPPORT_SESSION_SECRET || env.SESSION_SECRET, [
    ['findPerIp', ip],
    ['findPerIpEmail', ip, email],
  ]);
  if (!allowed) return fail('err_rate', 429);
  const turnstile = await verifyTurnstile(env, String(form.get('cf-turnstile-response') ?? ''), ip);
  if (!turnstile.ok) return fail('err_turnstile', 400);

  const found = await findTickets(deps, email, key);
  if (!found.length) return fail('find_none', 404);
  const current = await readTicketCookie(env, request);
  const merged = [...found.map((f) => ({r: f.ref, k: f.linkVersion})), ...current.filter((c) => !found.some((f) => f.ref === c.r))];
  const cookie = await ticketCookie(env, merged, secureCookies(request));
  if (found.length === 1) return redirect(`/support/t/${found[0]!.ref}`, {headers: {'Set-Cookie': cookie}});
  return data<Result>({ok: true, tickets: found.map(publicTicket), at: Date.now()}, {headers: {'Set-Cookie': cookie, 'Cache-Control': 'no-store'}});
}

export function ErrorBoundary() {
  return <SupportError />;
}

export default function FindRoute() {
  const result = useActionData<Result>();
  const nav = useNavigation();
  const root = useRouteLoaderData('root') as {turnstileSiteKey?: string | null} | undefined;
  const [touched, setTouched] = useState(false);
  const busy = nav.state !== 'idle';

  return (
    <div className="page-shell sp-page">
      <nav className="sp-crumbs" aria-label="Breadcrumb">
        <Link to="/support">{t('title')}</Link>
        <span aria-hidden="true">/</span>
        <span>{t('find_cta')}</span>
      </nav>
      <header className="page-header">
        <h1 className="page-title">{t('find_page_title')}</h1>
        <p className="page-description">{t('find_lede')}</p>
      </header>

      <div className="sp-narrow">
        {result?.ok ? (
          <section className="sp-card">
            <h2 className="sp-card-title">{t('find_results')}</h2>
            <TicketList tickets={result.tickets} />
          </section>
        ) : (
          <Form method="post" className="sp-form sp-find" onFocus={() => setTouched(true)}>
            {result && !result.ok ? (
              <p role="alert" className="sp-banner sp-banner-error">
                {t(result.error)}
              </p>
            ) : null}
            <label className="sp-field">
              <span className="sp-label">{t('find_email')}</span>
              <input name="email" type="email" inputMode="email" autoComplete="email" required className="sp-input" />
            </label>
            <label className="sp-field">
              <span className="sp-label">{t('find_key')}</span>
              <input name="key" required maxLength={40} placeholder={t('find_key_placeholder')} className="sp-input" autoCapitalize="characters" />
            </label>
            <TurnstileBox siteKey={root?.turnstileSiteKey ?? null} active={touched} resetKey={result?.at} />
            <div className="sp-submit-row">
              <button type="submit" className="od-btn od-btn-primary" disabled={busy}>
                {busy ? t('finding') : t('find_submit')}
              </button>
              <Link to="/support" className="od-btn od-btn-ghost">
                {t('find_new')}
              </Link>
            </div>
          </Form>
        )}
      </div>
    </div>
  );
}
