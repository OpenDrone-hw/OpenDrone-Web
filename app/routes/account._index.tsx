import {data, redirect, useLoaderData, Link} from 'react-router';
import type {Route} from './+types/account._index';
import {accountHeaders, accountsEnabled, redirectTo, sameOrigin} from '~/lib/accounts/config';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {appAccountsEnabled, clearSession, readAccount} from '~/lib/commerce/app-account';
import {MyAccount} from '~/components/commerce/account/MyAccount';
import {shipCountries} from '~/lib/commerce/app-account-manage';
import {chatFpvConnected} from '~/lib/commerce/app-chatfpv';
import {HISTORY_NOTICES, type HistoryNotice} from '~/lib/accounts/rights';
import {clearSessionCookie, hasSessionCookie, readSession} from '~/lib/accounts/sessions';
import {readCustomerAccount, type AccountOrder, type AccountShopifyData} from '~/lib/accounts/customer-shopify';
import {formatOrderDate, formatOrderMoney, orderItems, orderStatus} from '~/lib/accounts/order-display';
import {subscribeWithShopify, unsubscribeWithShopify} from '~/lib/growth/shopify-newsletter';
import {customerAccountUrl} from '~/lib/shop-links';
import {pilotMapEnabled, readOwnPin} from '~/lib/pilot-map-data';
import {supportHeaders} from '~/lib/support/server';
import {CAMPAIGN} from '~/lib/catalog-client';
import {Bird, ChevronRight, LifeBuoy, LogOut, Mail, MapPin, Package, Settings, type LucideIcon} from 'lucide-react';

/**
 * GET /account with ACCOUNTS_ENABLED "1": the signed-in dashboard.
 *
 * Identity (email), orders and newsletter consent are read LIVE from
 * Shopify by the session's shopify_gid on every request
 * (readCustomerAccount, customer-shopify.ts): Shopify owns that record
 * (migrations/0005_accounts.sql), so nothing here stores email, name or
 * orders - a failed read just falls back to the plain Shopify account link.
 * Orders and addresses stay in Shopify customer accounts: customerAccountUrl
 * resolves SHOPIFY_CUSTOMER_ACCOUNT_URL when set, else derives it from the
 * numeric SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID the sign-in OIDC client already
 * uses (app/lib/shop-links.ts). The newsletter toggle (POST here) reuses
 * subscribeWithShopify/unsubscribeWithShopify (growth/shopify-newsletter.ts).
 * The page is a side nav plus one open panel, picked with ?tab= (plain
 * links, no client state); a ChatFPV or newsletter notice opens its own
 * panel. ChatFPV history export and delete post to /account/chatfpv-history
 * and live in the "Settings and data" panel - ChatFPV is not a primary
 * account feature. Sign out posts to /account/logout. Signed out, it starts sign-in. Flag off: the legacy
 * Shopify redirect.
 *
 * In local dev (import.meta.env.DEV, folded to `false` and dropped by the
 * production build - same rule as app/lib/support/dev-overrides.ts) every
 * Shopify customer read and every newsletter write is mocked: a local run
 * never touches the shared store. The mock is keyed off the test IdP's own
 * customer picker (account/test-idp/authorize.tsx): the first test customer
 * renders a full mock account, the second an empty one, and typing any
 * other test GID shows the fallback state.
 */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () => [{title: 'Your account | OpenDrone'}, {name: 'robots', content: 'noindex, nofollow'}];

const NEWSLETTER_NOTICES = ['ok', 'unavailable'] as const;

/** The dashboard's panels, one open at a time, picked with ?tab= so every panel is a plain link. */
const ACCOUNT_TABS = ['orders', 'newsletter', 'discord', 'pilot-map', 'support', 'data'] as const;
type AccountTab = (typeof ACCOUNT_TABS)[number];
type NewsletterNotice = (typeof NEWSLETTER_NOTICES)[number];

function devMockAccount(shopifyGid: string): AccountShopifyData | null {
  if (shopifyGid === 'gid://shopify/Customer/test-1') {
    return {
      email: 'jane@example.com',
      newsletter: 'SUBSCRIBED',
      orders: [
        {
          id: 'mock-order-1',
          name: '#1001',
          createdAt: '2026-09-29T09:00:00Z',
          statusPageUrl: 'https://opendrone-test.myshopify.com/orders/1/authenticate?key=mock',
          lines: [
            {sku: 'OPENFRAME-5', name: 'OpenFrame', variant: '5" Freestyle', quantity: 1, image: null},
            {sku: 'OPENMOTOR-2306', name: 'OpenMotor', variant: '2306', quantity: 4, image: null},
            {sku: 'OPENRX-MONO', name: 'OpenRX', variant: 'Mono', quantity: 1, image: '/boards/openrx-mono/front-w528.webp'},
            {sku: 'PROP-HQ-5043', name: 'HQProp 5x4.3x3 V2S propeller set', variant: '5 inch', quantity: 1, image: null},
            {sku: 'OPENESC-3030', name: 'OpenESC', variant: '30×30', quantity: 1, image: '/boards/openesc-30x30/front-w528.webp'},
            {sku: 'OPENFC-LITE-3030', name: 'OpenFC Lite', variant: '30×30', quantity: 1, image: '/boards/openfc-lite/front-w528.webp'},
          ],
          total: {amount: '612.40', currencyCode: 'EUR'},
          fulfillmentStatus: 'UNFULFILLED',
          financialStatus: 'PAID',
          cancelled: false,
          isPreorder: true,
          // The latest of the lines' promises: the "early November 2026"
          // line does not decide it, the March funding targets do.
          promise: {kind: 'target', day: '2027-03-31', text: 'ships by 31 Mar 2027'},
        },
        {
          id: 'mock-order-2',
          name: '#1031',
          createdAt: '2026-09-14T09:00:00Z',
          statusPageUrl: 'https://opendrone-test.myshopify.com/orders/2/authenticate?key=mock',
          lines: [
            {sku: 'ACC-STRAP-15X200', name: 'Battery strap 15x200', variant: null, quantity: 2, image: null},
            {sku: 'ACC-XT60', name: 'XT60 pigtail', variant: '10 cm', quantity: 1, image: null},
          ],
          total: {amount: '18.50', currencyCode: 'EUR'},
          fulfillmentStatus: 'FULFILLED',
          financialStatus: 'PAID',
          cancelled: false,
          isPreorder: false,
          promise: null,
        },
        {
          id: 'mock-order-3',
          name: '#1024',
          createdAt: '2026-09-02T09:00:00Z',
          statusPageUrl: null,
          lines: [{sku: 'OPENFC-LITE-2020', name: 'OpenFC Lite', variant: '20×20', quantity: 1, image: '/boards/openfc-lite-mini/front-w528.webp'}],
          total: {amount: '89.00', currencyCode: 'EUR'},
          fulfillmentStatus: 'UNFULFILLED',
          financialStatus: 'PAID',
          cancelled: false,
          isPreorder: true,
          promise: {kind: 'date', day: '2026-11-05', text: 'ships early Nov 2026'},
        },
      ],
    };
  }
  if (shopifyGid === 'gid://shopify/Customer/test-2') {
    return {email: 'sam@example.com', newsletter: 'UNSUBSCRIBED', orders: []};
  }
  return null;
}

export async function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (appAccountsEnabled(env)) {
    // The test shop (app mode): the account is the incutec app's, signed in with a mailed link.
    const {account, clear, down} = await readAccount(request, env);
    const headers = new Headers({'Cache-Control': 'no-store'});
    if (clear) headers.append('Set-Cookie', await clearSession(env));
    if (!account && !down) throw redirect('/account/login?return_to=%2Faccount', {headers});
    const raw = new URL(request.url).searchParams.get('chatfpv') ?? '';
    const extras = {
      countries: account ? await shipCountries(env) : [],
      chatfpv: {connected: chatFpvConnected(env), notice: (HISTORY_NOTICES as readonly string[]).includes(raw) ? (raw as HistoryNotice) : null},
      // The owners map card shows only where the map itself is on.
      pilotMap: env.PILOT_MAP_ENABLED?.trim() === '1',
    };
    return data({appAccount: account, ...extras}, {headers});
  }
  if (!accountsEnabled(env)) return legacyAccountResponse('', env);
  const session = await readSession(env.SUPPORT_DB, request);
  if (!session) {
    // A stale cookie (expired or revoked session) goes, so the header says "Sign in" again.
    const headers = new Headers({'Cache-Control': 'no-store'});
    if (hasSessionCookie(request)) headers.append('Set-Cookie', clearSessionCookie());
    throw redirect('/account/login?return_to=%2Faccount', {headers});
  }
  const headers = new Headers({'Cache-Control': 'no-store'});
  if (session.refreshCookie) headers.append('Set-Cookie', session.refreshCookie);
  const url = new URL(request.url);
  const rawChatfpv = url.searchParams.get('chatfpv');
  const notice = (HISTORY_NOTICES as readonly string[]).includes(rawChatfpv ?? '') ? (rawChatfpv as HistoryNotice) : null;
  const rawNewsletter = url.searchParams.get('newsletter');
  const newsletterNotice = (NEWSLETTER_NOTICES as readonly string[]).includes(rawNewsletter ?? '')
    ? (rawNewsletter as NewsletterNotice)
    : null;
  const ordersUrl = customerAccountUrl(env);
  const shopify = import.meta.env.DEV ? devMockAccount(session.shopifyGid) : await readCustomerAccount(env, session.shopifyGid, CAMPAIGN);
  // The "Pilot map" card: shown while PILOT_MAP_ENABLED is on, says whether this customer is listed (README "Owners map").
  const pilot = pilotMapEnabled(env) ? {listed: Boolean(await readOwnPin(env.SUPPORT_DB!, session.shopifyGid))} : null;
  // The open panel: ?tab= when it names one, else the panel a notice belongs to, else Orders.
  const rawTab = url.searchParams.get('tab') ?? '';
  const tab: AccountTab = (ACCOUNT_TABS as readonly string[]).includes(rawTab)
    ? (rawTab as AccountTab)
    : notice
      ? 'data'
      : newsletterNotice
        ? 'newsletter'
        : 'orders';
  return data(
    {ordersUrl, since: new Date(session.createdAt).toISOString().slice(0, 10), notice, newsletterNotice, shopify, pilot, tab},
    {headers},
  );
}

/** POST /account: the newsletter toggle only (ChatFPV history has its own route). */
export async function action({request, context}: Route.ActionArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('', env);
  if (request.method !== 'POST' || !sameOrigin(request)) {
    return new Response('Forbidden', {status: 403, headers: accountHeaders()});
  }
  const session = await readSession(env.SUPPORT_DB, request);
  if (!session) return redirectTo('/account/login?return_to=%2Faccount', [], 303);
  const form = await request.formData();
  const intent = form.get('intent');
  if (intent !== 'newsletter-subscribe' && intent !== 'newsletter-unsubscribe') {
    return new Response('Bad Request', {status: 400, headers: accountHeaders()});
  }
  if (import.meta.env.DEV) {
    // Never write to the shared Shopify store from a local run - see the
    // loader's devMockAccount and app/lib/support/dev-overrides.ts.
    return redirectTo('/account?newsletter=ok', [], 303);
  }
  const account = await readCustomerAccount(env, session.shopifyGid, CAMPAIGN);
  if (!account?.email) return redirectTo('/account?newsletter=unavailable', [], 303);
  const result =
    intent === 'newsletter-subscribe'
      ? await subscribeWithShopify(env, account.email)
      : await unsubscribeWithShopify(env, account.email);
  const ok = result === 'subscribed' || result === 'already-subscribed' || result === 'unsubscribed';
  return redirectTo(`/account?newsletter=${ok ? 'ok' : 'unavailable'}`, [], 303);
}

const NOTICE_TEXT: Record<HistoryNotice, string> = {
  deleted: 'Your ChatFPV history is deleted.',
  unavailable: 'ChatFPV did not answer. Nothing changed; try again later.',
  confirm: 'Tick the box to confirm the delete.',
};

const NEWSLETTER_NOTICE_TEXT: Record<NewsletterNotice, string> = {
  ok: 'Newsletter preference updated.',
  unavailable: 'Could not update your newsletter preference. Try again later.',
};

const NAV: {tab: AccountTab; label: string; Icon: LucideIcon}[] = [
  {tab: 'orders', label: 'Orders', Icon: Package},
  {tab: 'newsletter', label: 'Newsletter', Icon: Mail},
  {tab: 'discord', label: 'Early Bird role', Icon: Bird},
  {tab: 'pilot-map', label: 'Pilot map', Icon: MapPin},
  {tab: 'support', label: 'Support', Icon: LifeBuoy},
  {tab: 'data', label: 'Settings and data', Icon: Settings},
];

/** Thumbnails drawn per order before the rest collapse into a "+N" tile. */
const ORDER_THUMBS = 4;

function OrderCard({order}: {order: AccountOrder}) {
  const status = orderStatus(order);
  const {shown, more} = orderItems(order.lines);
  const total = formatOrderMoney(order.total);
  const thumbs = order.lines.slice(0, ORDER_THUMBS);
  const rest = order.lines.length - thumbs.length;
  return (
    <li className="account-hub-order">
      <div className="account-hub-order-top">
        <ul className="account-hub-thumbs" aria-label="Items">
          {thumbs.map((line) => (
            <li key={`${line.sku ?? line.name}|${line.variant ?? ''}`} className="account-hub-thumb" title={line.variant ? `${line.name}, ${line.variant}` : line.name}>
              {line.image ? (
                <img src={line.image} alt={line.name} loading="lazy" width={88} height={88} />
              ) : (
                <span className="account-hub-thumb-empty" aria-label={line.name}>
                  <Package aria-hidden="true" size={22} strokeWidth={1.5} />
                </span>
              )}
              {line.quantity > 1 ? <span className="account-hub-thumb-qty">{line.quantity}×</span> : null}
            </li>
          ))}
          {rest > 0 ? (
            <li className="account-hub-thumb account-hub-thumb-more" aria-label={`${rest} more`}>
              +{rest}
            </li>
          ) : null}
        </ul>
        {order.statusPageUrl ? (
          <a href={order.statusPageUrl} className="account-hub-btn">
            View order
          </a>
        ) : null}
      </div>
      <dl className="account-hub-meta">
        <div>
          <dt>Order number</dt>
          <dd>{order.name}</dd>
        </div>
        <div>
          <dt>Order date</dt>
          <dd>{formatOrderDate(order.createdAt)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{total ?? '-'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className="account-hub-status" data-tone={status.tone}>
            {status.label}
          </dd>
        </div>
      </dl>
      {shown.length > 0 ? (
        <p className="account-hub-items">
          {shown.map((item) => `${item.quantity}× ${item.name}${item.variant ? ` ${item.variant}` : ''}`).join(' · ')}
          {more > 0 ? ` · +${more} more` : null}
        </p>
      ) : null}
      {status.note ? <p className="account-hub-items">{status.note}</p> : null}
    </li>
  );
}

export default function AccountRoute() {
  const loaded = useLoaderData<typeof loader>();
  if ('appAccount' in loaded) {
    return loaded.appAccount ? (
      <MyAccount account={loaded.appAccount} countries={loaded.countries} chatfpv={loaded.chatfpv} pilotMap={loaded.pilotMap} />
    ) : (
      <div className="page-shell app-shop"><h1 className="app-shop-title">My account</h1><p className="app-shop-note">Your account cannot be reached right now. Try again in a minute.</p></div>
    );
  }
  const {ordersUrl, since, notice, newsletterNotice, shopify, pilot} = loaded;
  const nav = NAV.filter((item) => item.tab !== 'pilot-map' || pilot);
  const tab = nav.some((item) => item.tab === loaded.tab) ? loaded.tab : 'orders';
  const title = nav.find((item) => item.tab === tab)!.label;

  return (
    <div className="page-shell sp-page account-hub">
      <h1 className="page-title account-hub-title">My account</h1>
      <div className="account-hub-layout">
        <aside className="account-hub-side">
          <div className="account-hub-welcome">
            <p className="account-hub-welcome-title">Welcome back</p>
            {shopify?.email ? <p className="account-hub-welcome-email">{shopify.email}</p> : null}
            <p className="account-hub-welcome-since">Signed in since {since}</p>
          </div>
          <nav aria-label="Account">
            <ul className="account-hub-nav">
              {nav.map(({tab: id, label, Icon}) => (
                <li key={id}>
                  <Link
                    to={id === 'orders' ? '/account' : `/account?tab=${id}`}
                    className="account-hub-nav-link"
                    aria-current={id === tab ? 'page' : undefined}
                    // On a phone the nav is a scrolling chip row: keep the open panel's chip in view.
                    ref={id === tab ? (el) => el?.scrollIntoView({block: 'nearest', inline: 'center'}) : undefined}
                    preventScrollReset
                  >
                    <Icon aria-hidden="true" size={20} strokeWidth={1.5} />
                    <span>{label}</span>
                    <ChevronRight aria-hidden="true" size={16} className="account-hub-nav-chevron" />
                  </Link>
                </li>
              ))}
              <li>
                <form method="post" action="/account/logout">
                  <button type="submit" className="account-hub-nav-link">
                    <LogOut aria-hidden="true" size={20} strokeWidth={1.5} />
                    <span>Sign out</span>
                    <ChevronRight aria-hidden="true" size={16} className="account-hub-nav-chevron" />
                  </button>
                </form>
              </li>
            </ul>
          </nav>
        </aside>

        <section className="account-hub-panel" aria-labelledby="account-hub-panel-title">
          <h2 id="account-hub-panel-title" className="account-hub-panel-title">
            {title}
          </h2>

          {tab === 'orders' ? (
            shopify && shopify.orders.length > 0 ? (
              <>
                <ul className="account-hub-orders">
                  {shopify.orders.map((order) => (
                    <OrderCard key={order.id} order={order} />
                  ))}
                </ul>
                {ordersUrl ? (
                  <a href={ordersUrl} className="account-dashboard-card-link account-hub-more">
                    All orders and addresses ›
                  </a>
                ) : null}
              </>
            ) : shopify ? (
              <>
                <p className="account-dashboard-card-lede">No orders yet.</p>
                {ordersUrl ? (
                  <a href={ordersUrl} className="account-dashboard-card-link account-hub-more">
                    All orders and addresses ›
                  </a>
                ) : null}
              </>
            ) : ordersUrl ? (
              <>
                <p className="account-dashboard-card-lede">We can&rsquo;t show your recent orders right now.</p>
                <a href={ordersUrl} className="account-hub-btn">
                  Orders and addresses
                </a>
              </>
            ) : (
              <>
                <p className="account-dashboard-card-lede">
                  We don&rsquo;t have a link for your orders and addresses right now. Check your order confirmation email, or reach support with your
                  order number.
                </p>
                <div className="account-dashboard-card-actions">
                  <Link to="/support?topic=order" className="account-hub-btn">
                    Open a support ticket
                  </Link>
                  <Link to="/support/find" className="account-dashboard-card-link">
                    Find an existing ticket
                  </Link>
                </div>
              </>
            )
          ) : null}

          {tab === 'newsletter' ? (
            shopify ? (
              <div className="account-hub-block">
                <p className="account-dashboard-card-lede">
                  {shopify.newsletter === 'SUBSCRIBED' ? 'Subscribed to Engineering Essentials.' : 'Not subscribed.'}
                </p>
                {newsletterNotice ? (
                  <p className="account-chatfpv-notice" role="status">
                    {NEWSLETTER_NOTICE_TEXT[newsletterNotice]}
                  </p>
                ) : null}
                <form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value={shopify.newsletter === 'SUBSCRIBED' ? 'newsletter-unsubscribe' : 'newsletter-subscribe'}
                  />
                  <button type="submit" className="account-hub-btn">
                    {shopify.newsletter === 'SUBSCRIBED' ? 'Unsubscribe' : 'Subscribe'}
                  </button>
                </form>
              </div>
            ) : (
              <p className="account-dashboard-card-lede">Manage this from the newsletter signup in the footer.</p>
            )
          ) : null}

          {tab === 'discord' ? (
            <div className="account-hub-block">
              <p className="account-dashboard-card-lede">A paid preorder unlocks the Early Bird role and #early-birds on the OpenDrone Discord.</p>
              <Link to="/early-bird" className="account-hub-btn">
                Claim on Discord
              </Link>
            </div>
          ) : null}

          {tab === 'pilot-map' && pilot ? (
            <div className="account-hub-block">
              <p className="account-dashboard-card-lede">
                {pilot.listed
                  ? 'You are on the pilot map. Other signed-in owners see your Discord username and an area of about 10 km. You can move or withdraw there.'
                  : 'Find pilots near you. Optional: you choose whether to appear, and only signed-in owners can see the map.'}
              </p>
              <Link to="/owners#pilots" className="account-hub-btn">
                {pilot.listed ? 'Manage my entry' : 'Open the pilot map'}
              </Link>
            </div>
          ) : null}

          {tab === 'support' ? (
            <div className="account-hub-block">
              <p className="account-dashboard-card-lede">Open a new ticket or look up one you already opened, no account needed to file it.</p>
              <div className="account-dashboard-card-actions">
                <Link to="/support" className="account-hub-btn">
                  Open a ticket
                </Link>
                <Link to="/support/find" className="account-dashboard-card-link">
                  Find my ticket
                </Link>
              </div>
            </div>
          ) : null}

          {tab === 'data' ? (
            <div className="account-hub-block">
              <div className="account-chatfpv" aria-labelledby="account-chatfpv-title">
                <h3 id="account-chatfpv-title" className="account-chatfpv-title">
                  ChatFPV history
                </h3>
                <p>Your chatfpv.com conversations made while signed in (same sign-in as here). Export them as JSON, or delete them for good.</p>
                {notice ? (
                  <p className="account-chatfpv-notice" role="status">
                    {NOTICE_TEXT[notice]}
                  </p>
                ) : null}
                <form method="post" action="/account/chatfpv-history" className="account-chatfpv-export">
                  <input type="hidden" name="intent" value="export" />
                  <button type="submit" className="od-btn od-btn-secondary">
                    Export ChatFPV history
                  </button>
                </form>
                <form method="post" action="/account/chatfpv-history" className="account-chatfpv-delete">
                  <input type="hidden" name="intent" value="delete" />
                  <label>
                    <input type="checkbox" name="confirm" value="yes" required /> Delete every ChatFPV conversation of this account
                  </label>
                  <button type="submit" className="od-btn od-btn-danger">
                    Delete ChatFPV history
                  </button>
                </form>
              </div>
              <div className="account-settings-delete">
                <h3 className="account-chatfpv-title">Delete your account</h3>
                <p>To close your OpenDrone account, open a support ticket and we will process it.</p>
                <Link to="/support?topic=other" className="account-dashboard-card-link">
                  Contact support ›
                </Link>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
