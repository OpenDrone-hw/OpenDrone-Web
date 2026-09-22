import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/support';
import {buildSeoMeta} from '~/lib/seo';
import {Txt} from '~/components/Txt';
import {legalHref} from '~/components/LangToggle';
import {CompanyFooterBlock} from '~/components/CompanyFooterBlock';
import {copyText} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {customerAccountUrl} from '~/lib/shop-links';

/**
 * The help page: order questions by email, build questions on Discord, and
 * the policy pages a buyer looks for (preorders, shipping, returns,
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
        <Txt id="support.lead" as="p" className="page-description" />
      </header>

      <section className="support-block" id="contact">
        <Txt id="support.orders_title" as="h2" className="support-block-title" />
        <Txt id="support.orders_body" as="p" />
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
        {data.accountUrl ? <Txt id="support.account_body" as="p" className="support-note" /> : null}
        {data.existingConversation ? (
          <Txt id="support.existing_note" as="p" className="support-note" />
        ) : null}
      </section>

      <section className="support-block">
        <Txt id="support.topics_title" as="h2" className="support-block-title" />
        <ul className="support-topics">
          {TOPICS.map((t) => (
            <li key={t.key}>
              <Link prefetch="viewport" to={legalHref(t.to, 'en')} className="support-topic">
                <Txt id={`support.topic_${t.key}`} as="span" className="support-topic-title" />
                <Txt id={`support.topic_${t.key}_desc`} as="span" className="support-topic-desc" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="support-block">
        <Txt id="support.discord_title" as="h2" className="support-block-title" />
        <Txt id="support.discord_body" as="p" />
        <div className="support-intake-form-actions">
          <a
            className="od-btn od-btn-secondary"
            href={data.discordInvite}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Txt id="support.discord_cta" />
          </a>
        </div>
      </section>

      <section className="support-block">
        <Txt id="support.company_title" as="h2" className="support-block-title" />
        <CompanyFooterBlock company={data.company} />
      </section>
    </div>
  );
}
