import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/support';
import {buildSeoMeta} from '~/lib/seo';
import {Txt} from '~/components/Txt';
import {legalHref} from '~/components/LangToggle';
import {copyText} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {customerAccountUrl} from '~/lib/shop-links';

/**
 * The help page: order questions by email, build questions on Discord, and
 * a plain list of the policy pages (pre-orders, shipping, returns,
 * warranty, terms). Words come from `content/copy/support.json`. /contact
 * redirects here and the footer's Contact link lands on `#contact`.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('support.meta_title') ?? 'Support',
    description: copyText('support.meta_description') ?? '',
  });

const TOPICS: Array<{to: string; key: string}> = [
  {to: '/preorder#questions', key: 'preorder'},
  {to: '/shipping', key: 'shipping'},
  {to: '/herroepingsrecht', key: 'returns'},
  {to: '/warranty', key: 'warranty'},
  {to: '/algemene-voorwaarden', key: 'terms'},
];

export function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;
  const url = new URL(request.url);
  const company = getCompanyIdentity(env as unknown as Record<string, string | undefined>);
  let accountUrl: string | null = null;
  try {
    accountUrl = customerAccountUrl(env);
  } catch {
    accountUrl = null;
  }
  return {
    discordInvite: env.DISCORD_SUPPORT_INVITE ?? 'https://discord.gg/ABajnacUsS',
    email: company.email,
    company,
    accountUrl,
    existingConversation: url.searchParams.get('existing') === '1',
  };
}

export default function SupportRoute() {
  const data = useLoaderData<typeof loader>();
  const emailCta = (copyText('support.email_cta') ?? 'Email {email}').replace(
    '{email}',
    data.email,
  );
  return (
    <div className="page-shell support-page">
      <header className="page-header">
        <Txt id="support.title" as="h1" className="page-title" />
      </header>

      <section className="support-block" id="contact">
        <Txt id="support.orders_title" as="h2" className="support-block-title" />
        <div className="support-intake-form-actions">
          <a className="od-btn od-btn-primary" href={`mailto:${data.email}`}>
            {emailCta}
          </a>
          {data.accountUrl ? (
            <a className="od-btn od-btn-secondary" href={data.accountUrl}>
              <Txt id="support.account_cta" />
            </a>
          ) : null}
        </div>
        <Txt id="support.orders_note" as="p" className="support-note" />
        {data.existingConversation ? (
          <Txt id="support.existing_note" as="p" className="support-note" />
        ) : null}
      </section>

      <section className="support-block">
        <Txt id="support.discord_title" as="h2" className="support-block-title" />
        <a href={data.discordInvite} target="_blank" rel="noopener noreferrer">
          <Txt id="support.discord_cta" />
        </a>
      </section>

      <section className="support-block">
        <Txt id="support.topics_title" as="h2" className="support-block-title" />
        <ul className="support-topics">
          {TOPICS.map((t) => (
            <li key={t.key}>
              <Link prefetch="viewport" to={legalHref(t.to, 'en')}>
                <Txt id={`support.topic_${t.key}`} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
