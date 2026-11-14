import {Link, useLoaderData, useRouteLoaderData} from 'react-router';
import type {Route} from './+types/markets';
import type {RootLoader} from '~/root';
import {NewsletterSignup} from '~/components/NewsletterSignup';
import {copyText} from '~/lib/copy';
import {MARKET_COLUMNS, marketRows} from '~/lib/markets';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {usSalesRate} from '~/lib/us-sales';

/**
 * /markets, "Where we ship": one table of the markets, generated from the
 * region resolver and the shipping data (app/lib/markets.ts), then the few
 * lines the table cannot say. The header's country picker links here
 * ("How prices and shipping work"), so the picker itself carries no tax or
 * market sentences.
 */

const t = (key: string, fallback: string) => copyText(`markets.${key}`) ?? fallback;

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: t('meta_title', 'Where we ship | OpenDrone'),
    description: t('meta_description', 'Prices, taxes and shipping by country.'),
    canonical: `${SITE_ORIGIN}/markets`,
  });

export function loader({context}: Route.LoaderArgs) {
  return {usRate: usSalesRate(context.env)};
}

export default function MarketsRoute() {
  const {usRate} = useLoaderData<typeof loader>();
  const root = useRouteLoaderData<RootLoader>('root');
  const ordinary = Boolean((root as {ordinaryShop?: boolean} | undefined)?.ordinaryShop);
  const rows = marketRows(usRate, ordinary);
  const current = root?.region?.country ? root.region.market : null;
  return (
    <div className="page-shell markets-page">
      <div className="markets-inner">
        <header className="markets-header">
          <h1 className="page-title">{t('title', 'Where we ship')}</h1>
          <p className="markets-lead">{t('lead', 'One row per market. Choose your country in the header to see your prices.')}</p>
        </header>
        <div className="markets-table-scroll">
          <table className="markets-table" data-markets-table>
            <caption className="sr-only">{t('table_caption', 'Markets')}</caption>
            <thead>
              <tr>
                {MARKET_COLUMNS.map(([key, label]) => (
                  <th key={key} scope="col">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.market} data-market={row.market} data-current={row.market === current ? 'true' : undefined}>
                  {MARKET_COLUMNS.map(([key, label], i) =>
                    i === 0 ? (
                      <th key={key} scope="row" data-label={label}>
                        {row[key]}
                        {row.market === current ? <span className="markets-you">{t('your_market', 'You')}</span> : null}
                      </th>
                    ) : (
                      <td key={key} data-label={label}>{row[key]}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="markets-notes">
          <li>{t('why_prices', 'Prices: one base price before tax per product. EU prices add VAT. Outside the EU you pay the base price with no EU VAT; import taxes may be due on delivery. US prices add US duties and are duties included.')}</li>
          <li>
            {t('wholesale', 'Shops and dealers can apply for wholesale.')}{' '}
            <Link prefetch="intent" to="/wholesale">{t('wholesale_link', 'Wholesale')}</Link>
          </li>
          {ordinary ? null : (
            <li>
              {t('preorder_terms', 'Pre-orders follow the pre-order terms.')}{' '}
              <Link prefetch="intent" to="/preorder">{t('preorder_terms_link', 'Pre-order terms')}</Link>
            </li>
          )}
        </ul>
        <section className="markets-notify" data-markets-notify>
          <NewsletterSignup
            variant="compact"
            className="markets-notify-form"
            titleId="markets.notify_title"
            turnstileSiteKey={root?.turnstileSiteKey ?? null}
          />
        </section>
      </div>
    </div>
  );
}
