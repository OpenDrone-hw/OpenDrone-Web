import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/guides.$family.$step';
import {buildBreadcrumbJsonLd, buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {
  buildHowToJsonLd,
  findGuide,
  guidePath,
  jsonLd,
  resolveGuidePage,
  type Callout,
} from '~/lib/guides';
import {useDirectInstallEnabled} from '~/lib/flasher/ui/use-direct-install';
import {GuideText} from '~/components/GuideText';
import {Txt} from '~/components/Txt';
import {copyFill, copyText} from '~/lib/copy';

/**
 * /guides/<family>/<step> - one step of a beginner firmware guide.
 *
 * Server-rendered and indexable. The page body, the HowTo JSON-LD and the
 * prev/next links all come from the same record in `app/lib/guides.ts`.
 */

export const meta: Route.MetaFunction = ({data}) => {
  if (!data) {
    return buildSeoMeta({title: copyText('guides.meta_title') ?? 'Firmware guides', robots: 'noindex'});
  }
  return buildSeoMeta({
    title: data.page.title,
    description: data.page.description,
    type: 'article',
    canonical: `${SITE_ORIGIN}${guidePath(data.family.id, data.page.slug)}`,
  });
};

export async function loader({params}: Route.LoaderArgs) {
  const loc = findGuide(params.family ?? '', params.step ?? '');
  if (!loc) throw new Response('Not Found', {status: 404});
  return {
    ...loc,
    total: loc.family.pages.length,
    // No HowTo for pages whose steps cannot be carried out yet.
    howTo: loc.page.howTo === false ? null : buildHowToJsonLd(loc, SITE_ORIGIN),
  };
}

function CalloutBox({callout}: {callout: Callout}) {
  const safety = callout.kind === 'safety';
  return (
    <aside
      className={`mt-4 border-l-2 p-4 ${
        safety
          ? 'border-[var(--color-error)] bg-[var(--color-bg-card)]'
          : 'border-[var(--color-accent)] bg-[var(--color-gold-soft)]'
      }`}
      aria-label={
        safety
          ? (copyText('guides.callout_safety') ?? 'Safety')
          : (copyText('guides.callout_note') ?? 'Note')
      }
    >
      <p className="font-semibold">
        {safety ? `${copyText('guides.callout_safety') ?? 'Safety'}: ` : ''}
        {callout.title}
      </p>
      {callout.text ? (
        <p className="mt-1 text-[var(--color-text-muted)]">
          <GuideText value={callout.text} />
        </p>
      ) : null}
      {callout.items?.length ? (
        <ol className="mt-1 list-decimal pl-5 text-[var(--color-text-muted)]">
          {callout.items.map((item) => (
            <li key={item}>
              <GuideText value={item} />
            </li>
          ))}
        </ol>
      ) : null}
    </aside>
  );
}

export default function GuideStepRoute() {
  const {family, page: basePage, index, prev, next, total, howTo} = useLoaderData<typeof loader>();
  // The firmware page's one-button install (same gate as FcFlasher), read after mount: the server
  // render and production show the base copy; the direct variant only while the gate is on.
  const page = resolveGuidePage(basePage, useDirectInstallEnabled());
  const seeLabel = copyText('guides.see_label') ?? 'You should see:';

  return (
    <article className="page-shell guide-page">
      {howTo ? <script type="application/ld+json" dangerouslySetInnerHTML={{__html: jsonLd(howTo)}} /> : null}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            buildBreadcrumbJsonLd([
              {name: 'OpenDrone', path: '/'},
              {name: copyText('guides.title') ?? 'Firmware guides', path: '/guides'},
              {name: page.title, path: guidePath(family.id, page.slug)},
            ]),
          ),
        }}
      />
      <div className="reading-column">
        <div className="policy-back-link">
          <Link prefetch="intent" to="/guides">
            <Txt id="guides.back_link" fallback="All guides" />
          </Link>
        </div>

        <header className="page-header">
          <p className="page-eyebrow">
            {family.board}, {family.firmware}.{' '}
            {copyFill('guides.step_label', 'Step {n} of {total}', {n: index + 1, total})}
          </p>
          <h1 className="page-title">{page.title}</h1>
        </header>

        <nav
          aria-label={copyText('guides.steps_nav_aria') ?? 'Guide steps'}
          className="mt-2 text-[14px]"
        >
          <ol className="flex flex-wrap gap-x-4 gap-y-1">
            {family.pages.map((p, i) => (
              <li key={p.slug}>
                {p.slug === page.slug ? (
                  <span aria-current="page" className="font-semibold">
                    {i + 1}. {p.label}
                  </span>
                ) : (
                  <Link prefetch="intent" to={guidePath(family.id, p.slug)} className="underline">
                    {i + 1}. {p.label}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <div className="rich-content mt-6">
          {page.intro.map((para, i) => (
            <p key={i}>
              <GuideText value={para} />
            </p>
          ))}

          {page.callouts.map((c) => (
            <CalloutBox key={c.title + c.kind} callout={c} />
          ))}

          <h2 className="mt-8 text-[22px]">
            {copyText('guides.you_need_heading') ?? 'You need'}
          </h2>
          <ul className="list-disc">
            {page.tools.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>

          <h2 className="mt-8 text-[22px]">{copyText('guides.steps_heading') ?? 'Steps'}</h2>
          <ol className="list-decimal">
            {page.steps.map((s, i) => (
              <li key={s.title} id={`step-${i + 1}`}>
                <strong>{s.title}.</strong> <GuideText value={s.text} />
                {s.see ? (
                  <p className="mt-1 text-[var(--color-text-muted)]">
                    <em>{seeLabel}</em> <GuideText value={s.see} />
                  </p>
                ) : null}
                {s.code ? (
                  <pre className="mt-2 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 text-[13px]">
                    <code>{s.code}</code>
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>

          {page.sections?.map((sec) => (
            <section key={sec.heading}>
              <h2 className="mt-8 text-[22px]">{sec.heading}</h2>
              {sec.paragraphs?.map((para, i) => (
                <p key={i}>
                  <GuideText value={para} />
                </p>
              ))}
              {sec.bullets ? (
                <ul className="list-disc">
                  {sec.bullets.map((b, i) => (
                    <li key={i}>
                      <GuideText value={b} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {sec.code ? (
                <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 text-[13px]">
                  <code>{sec.code}</code>
                </pre>
              ) : null}
            </section>
          ))}

          <section>
            <h2 className="mt-8 text-[22px]">
              {copyText('guides.trouble_heading') ?? "If it doesn't work"}
            </h2>
            <dl>
              {page.troubleshooting.map((t) => (
                <div key={t.problem} className="mt-4">
                  <dt className="font-semibold">
                    <GuideText value={t.problem} />
                  </dt>
                  <dd className="mt-1">
                    <GuideText value={t.fix} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <p className="mt-8">
            {/* Full document load: see GuideText on /guides/flash links. */}
            <a href="/guides/flash" className="btn-primary btn-sm inline-block">
              {copyText('guides.flash_link') ?? 'Go to the firmware page'}
            </a>
          </p>
        </div>

        <nav
          aria-label={copyText('guides.pager_aria') ?? 'Previous and next step'}
          className="mt-10 flex flex-wrap justify-between gap-4 border-t border-[var(--color-border)] pt-4"
        >
          {prev ? (
            <Link prefetch="intent" to={guidePath(family.id, prev.slug)} rel="prev">
              <span className="block text-[13px] text-[var(--color-text-muted)]">
                {copyText('guides.prev_label') ?? 'Previous step'}
              </span>
              {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link prefetch="intent" to={guidePath(family.id, next.slug)} rel="next" className="text-right">
              <span className="block text-[13px] text-[var(--color-text-muted)]">
                {copyText('guides.next_label') ?? 'Next step'}
              </span>
              {next.title}
            </Link>
          ) : (
            <Link prefetch="intent" to="/guides" className="text-right">
              {copyText('guides.done_label') ?? 'All guides'}
            </Link>
          )}
        </nav>
      </div>
    </article>
  );
}
