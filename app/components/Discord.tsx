import {Suspense, type ReactNode} from 'react';
import {Await, Link} from 'react-router';
import {DISCORD_INVITE_URL} from '~/lib/company';
import {copyFill, copyText, editAttrs} from '~/lib/copy';
import type {DiscordCounts} from '~/lib/discord-community';
import {trackEvent} from '~/lib/growth/plausible';
import {Txt} from '~/components/Txt';

/**
 * The Discord mark, one colour (currentColor), like the GitHub mark beside it.
 * Path: Simple Icons "discord" (CC0).
 */
export function DiscordMark({size = 20, className}: {size?: number; className?: string}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

/** Where a Discord link sits, the `placement` prop of the "Discord click" event. */
export type DiscordPlacement =
  | 'header'
  | 'mobile-menu'
  | 'home'
  | 'product'
  | 'support';

/** Records an outbound Discord click in Plausible. Never blocks the link. */
export function trackDiscordClick(placement: DiscordPlacement): void {
  trackEvent('Discord click', {props: {placement}});
}

/**
 * An outbound link to the public invite. Discord does not keep UTM tags, so
 * the click itself is counted as a Plausible event with its placement.
 */
export function DiscordLink({
  placement,
  href = DISCORD_INVITE_URL,
  className,
  children,
  ...rest
}: {
  placement: DiscordPlacement;
  href?: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  title?: string;
  onClick?: () => void;
}) {
  const {onClick, ...attrs} = rest;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={() => {
        trackDiscordClick(placement);
        onClick?.();
      }}
      {...attrs}
    >
      {children}
    </a>
  );
}

const fmt = new Intl.NumberFormat('en');

function CommunityCounts({counts}: {counts: DiscordCounts | null}) {
  if (!counts) return null;
  return (
    <p className="home-community-counts">
      <span>
        <strong>{fmt.format(counts.members)}</strong>{' '}
        {copyText('home.community_members') ?? 'members'}
      </span>
      <span>
        <strong>{fmt.format(counts.online)}</strong>{' '}
        {copyText('home.community_online') ?? 'online now'}
      </span>
    </p>
  );
}

const REASONS = ['engineers', 'builds', 'test'] as const;

/**
 * The homepage community section, shared by the desktop and phone layouts.
 * The counts stream in from the loader; a failed fetch resolves to null and
 * the line is simply absent.
 */
export function CommunitySection({
  counts,
}: {
  counts: Promise<DiscordCounts | null> | DiscordCounts | null;
}) {
  return (
    <section className="home-community" aria-labelledby="home-community-title">
      <div className="home-community-inner">
        <div className="home-community-head">
          <Txt id="home.community_label" as="p" className="section-label" />
          <h2
            id="home-community-title"
            className="home-community-title"
            {...editAttrs('home.community_title')}
          >
            {copyText('home.community_title') ?? 'Built in the open, with the community'}
          </h2>
          {counts instanceof Promise ? (
            <Suspense fallback={null}>
              <Await resolve={counts} errorElement={null}>
                {(c) => <CommunityCounts counts={c} />}
              </Await>
            </Suspense>
          ) : (
            <CommunityCounts counts={counts} />
          )}
          <DiscordLink placement="home" className="od-btn od-btn-primary home-community-cta">
            <DiscordMark size={16} />
            {copyText('home.community_cta') ?? 'Join the Discord'}
          </DiscordLink>
          <Link to="/owners" prefetch="intent" className="home-community-owners">
            <Txt id="home.community_owners_link" fallback="See where owners are" /> <span aria-hidden="true">→</span>
          </Link>
        </div>
        <ul className="home-community-reasons">
          {REASONS.map((key) => (
            <li key={key}>
              <Txt id={`home.community_${key}_title`} as="h3" />
              <Txt id={`home.community_${key}_body`} as="p" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The compact row under a product's specs. */
export function ProductDiscordRow({product}: {product: string}) {
  return (
    <p className="pdp-discord-row">
      <DiscordMark size={16} className="pdp-discord-mark" />
      <span>{copyFill('product-chrome.discord_row', 'Questions about the {product}?', {product})}</span>
      <DiscordLink placement="product" className="pdp-discord-link">
        {copyText('product-chrome.discord_row_cta') ?? 'Ask in the Discord'}
      </DiscordLink>
    </p>
  );
}
