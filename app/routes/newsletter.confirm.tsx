import {data, useFetcher, useLoaderData} from 'react-router';
import type {Route} from './+types/newsletter.confirm';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {appCommerceEnabled} from '~/lib/commerce/app-api';
import {confirmWithApp} from '~/lib/commerce/app-newsletter';
import {copyText} from '~/lib/copy';

// Newsletter double opt-in, the page the confirm mail links to (app mode only: the consent lives in the app).
//
// GET  → a Confirm button bound to the mailed token. GET never confirms anything: inbox link scanners prefetch GETs.
// POST → confirms in the app. The page says only what happened (joined, already joined, link old or not valid); it never
//        shows or asks for an address.

export const meta: Route.MetaFunction = ({location}) =>
  buildSeoMeta({
    title: copyText('newsletter.confirm_meta_title') ?? 'Confirm your subscription',
    description: 'Confirm your OpenDrone email subscription.',
    robots: 'noindex',
    url: `${SITE_ORIGIN}${location.pathname}`,
  });

export async function loader({request, context}: Route.LoaderArgs) {
  if (!appCommerceEnabled(context.env)) throw new Response('Not found', {status: 404});
  return {token: new URL(request.url).searchParams.get('token') ?? ''};
}

type ConfirmPageResult = {ok: boolean; message: string};

export async function action({request, context}: Route.ActionArgs) {
  if (!appCommerceEnabled(context.env)) throw new Response('Not found', {status: 404});
  const token = String((await request.formData()).get('token') ?? '').slice(0, 120);
  const result = token ? await confirmWithApp(context.env, token) : 'invalid';
  if (result === 'confirmed' || result === 'already-confirmed') {
    return data<ConfirmPageResult>({
      ok: true,
      message:
        copyText(result === 'confirmed' ? 'newsletter.confirm_done' : 'newsletter.confirm_already') ??
        (result === 'confirmed'
          ? "You're in. We'll email you when there is something worth reading."
          : 'This address is already confirmed. Nothing more to do.'),
    });
  }
  const failed = result === 'failed';
  return data<ConfirmPageResult>(
    {
      ok: false,
      message: failed
        ? (copyText('newsletter.action_generic_failure') ?? "Couldn't confirm right now. Try again in a moment.")
        : (copyText('newsletter.confirm_invalid') ??
          'This confirm link is old or not valid. Sign up again on the newsletter page and we will send a new one.'),
    },
    {status: failed ? 502 : 400},
  );
}

export default function ConfirmPage() {
  const {token} = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ConfirmPageResult>();
  const result = fetcher.data;
  const busy = fetcher.state !== 'idle';

  return (
    <div className="page-shell">
      <header className="rn-archive-head">
        <div>
          <p className="rn-eyebrow">{copyText('newsletter.confirm_eyebrow') ?? 'Newsletter'}</p>
          <h1>{copyText('newsletter.confirm_title') ?? 'Confirm your subscription'}</h1>
        </div>
      </header>
      <div className="max-w-xl">
        {result?.ok ? (
          <p className="text-[var(--color-text)]">{result.message}</p>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="token" value={token} />
            <p className="mb-4 text-[var(--color-text-dim)]">
              {copyText('newsletter.confirm_lede') ?? 'One click and you are on the list.'}
            </p>
            <button
              type="submit"
              disabled={busy || !token}
              className="border border-[var(--color-border)] bg-[var(--color-accent)] px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-[var(--color-on-accent)] disabled:opacity-60"
            >
              {busy ? (copyText('newsletter.confirm_busy') ?? 'Confirming') : (copyText('newsletter.confirm_submit') ?? 'Confirm')}
            </button>
          </fetcher.Form>
        )}
        {result && !result.ok ? <p className="mt-3 text-[13px] text-[var(--color-text-dim)]">{result.message}</p> : null}
      </div>
    </div>
  );
}
