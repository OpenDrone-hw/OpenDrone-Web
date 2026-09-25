import {useLoaderData, Link} from 'react-router';
import type {Route} from './+types/doc.$sku';
import {findDocEntry} from '~/lib/doc-registry';
import {getCompanyIdentity} from '~/lib/company';
import {buildSeoMeta} from '~/lib/seo';
import {Txt} from '~/components/Txt';
import {copyFill, copyText, editAttrs} from '~/lib/copy';

/**
 * Per-SKU EU Declaration of Conformity page: the stable URL a simplified
 * DoC (RED Art. 10(9)) and product packaging point at. Serves the signed
 * PDF once published; states the real status until then.
 */

export const meta: Route.MetaFunction = ({data}) => {
  return buildSeoMeta({
    title: data?.entry
      ? copyFill('doc.sku_meta_title', 'EU Declaration of Conformity: {product}', {
          product: data.entry.name,
        })
      : (copyText('doc.sku_title') ?? 'EU Declaration of Conformity'),
    description:
      copyText('doc.meta_description') ??
      'EU declarations of conformity for OpenDrone hardware, published per hardware revision.',
    // Reached from the packaging QR code only: unlinked and not indexed.
    robots: 'noindex,nofollow',
  });
};

export async function loader({params, context}: Route.LoaderArgs) {
  const entry = findDocEntry(params.sku ?? '');
  if (!entry) {
    throw new Response('Not found', {status: 404});
  }
  const env = context.env as unknown as Record<string, string | undefined>;
  return {entry, company: getCompanyIdentity(env)};
}

export default function DocSkuRoute() {
  const {entry, company} = useLoaderData<typeof loader>();
  return (
    <article className="page-shell">
      <div className="reading-column">
        <div className="policy-back-link">
          <Link prefetch="viewport" to="/doc">
            <Txt id="doc.back_link" fallback="All declarations" />
          </Link>
        </div>
        <header className="page-header">
          <Txt id="doc.eyebrow" as="p" className="page-eyebrow" fallback="Compliance" />
          <Txt
            id="doc.sku_title"
            as="h1"
            className="page-title"
            fallback="EU Declaration of Conformity"
          />
        </header>
        <div className="rich-content legal-body">
          <h2>{entry.name}</h2>
          <p {...editAttrs('doc.manufacturer_line')}>
            {copyFill(
              'doc.manufacturer_line',
              'Manufacturer: {name}, {address}. KBO/BCE {kbo}, VAT {vat}. {email}',
              {
                name: company.name,
                address: company.address,
                kbo: company.kbo,
                vat: company.vat,
                email: company.email,
              },
            )}
          </p>
          {entry.legislation.length > 0 ? (
            <p {...editAttrs('doc.legislation_line')}>
              {copyFill(
                'doc.legislation_line',
                'Union harmonisation legislation for this product: {legislation}.',
                {legislation: entry.legislation.join('; ')},
              )}
            </p>
          ) : (
            <Txt id="doc.no_legislation" as="p" />
          )}
          {entry.status === 'published' && entry.pdf ? (
            <p>
              <a href={entry.pdf} {...editAttrs('doc.download_link')}>
                {copyText('doc.download_link') ?? 'Download the signed declaration (PDF)'}
              </a>
              .{' '}
              <Txt
                id="doc.download_note"
                fallback="The declaration names the hardware revision and, for radio equipment, the firmware build it covers."
              />
            </p>
          ) : entry.legislation.length > 0 ? (
            <p {...editAttrs('doc.pending_note')}>
              {copyFill(
                'doc.pending_note',
                'The declaration of conformity for this product is published on this page per hardware revision once its evidence set is complete and the declaration is signed. It is not published yet. Conformity documentation can be requested from the manufacturer at {email}.',
                {email: company.email},
              )}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
