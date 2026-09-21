import {useLoaderData} from 'react-router';
import type {Route} from './+types/support';
import {buildSeoMeta} from '~/lib/seo';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/**
 * Support is the public Discord server and the company mailbox. Words come
 * from `content/copy/support.json`.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('support.meta_title') ?? 'Support',
    description: copyText('support.meta_description') ?? '',
    robots: 'noindex,nofollow',
  });

export function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;
  const url = new URL(request.url);
  return {
    discordInvite: env.DISCORD_SUPPORT_INVITE ?? 'https://discord.gg/ABajnacUsS',
    email: env.PUBLIC_COMPANY_EMAIL || 'contact@opendrone.be',
    existingConversation: url.searchParams.get('existing') === '1',
  };
}

export default function SupportRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <div className="page-shell">
      <section className="support-intake-shell">
        <Txt id="support.title" as="h1" />
        <p>
          Ask build and tuning questions on Discord. For orders and your
          account, email us.
        </p>
        <div className="support-intake-form-actions">
          <a
            className="od-btn od-btn-primary"
            href={data.discordInvite}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Discord support
          </a>
          <a className="od-btn od-btn-secondary" href={`mailto:${data.email}`}>
            Email {data.email}
          </a>
        </div>
        {data.existingConversation ? (
          <p className="support-intake-note">
            To continue an earlier conversation, reply on Discord or by email.
          </p>
        ) : null}
      </section>
    </div>
  );
}
