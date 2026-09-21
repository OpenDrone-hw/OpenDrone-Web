import {useLoaderData, Link} from 'react-router';
import type {Route} from './+types/doc.$sku';
import {findDocEntry} from '~/lib/doc-registry';
import {getCompanyIdentity} from '~/lib/company';
import {buildSeoMeta} from '~/lib/seo';

/**
 * Per-SKU EU Declaration of Conformity page: the stable URL a simplified
 * DoC (RED Art. 10(9)) and product packaging point at. Serves the signed
 * PDF once published; states the real status until then.
 */

export const meta: Route.MetaFunction = ({data}) => {
  return buildSeoMeta({
    title: data?.entry
      ? `EU Declaration of Conformity: ${data.entry.name}`
      : 'EU Declaration of Conformity',
    description:
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
          <Link prefetch="viewport" to="/doc">All declarations</Link>
        </div>
        <header className="page-header">
          <p className="page-eyebrow">Compliance</p>
          <h1 className="page-title">EU Declaration of Conformity</h1>
        </header>
        <div className="rich-content legal-body">
          <h2>{entry.name}</h2>
          <p>
            Manufacturer: {company.name}, {company.address}. KBO/BCE{' '}
            {company.kbo}, VAT {company.vat}. {company.email}
          </p>
          {entry.legislation.length > 0 ? (
            <p>
              Union harmonisation legislation for this product:{' '}
              {entry.legislation.join('; ')}.
            </p>
          ) : (
            <p>
              No Union harmonisation legislation applies to this product. It
              carries no CE marking and no EU declaration of conformity is
              drawn up for it; its technical documentation is kept by the
              manufacturer.
            </p>
          )}
          {entry.status === 'published' && entry.pdf ? (
            <p>
              <a href={entry.pdf}>Download the signed declaration (PDF)</a>.
              The declaration names the hardware revision and, for radio
              equipment, the firmware build it covers.
            </p>
          ) : entry.legislation.length > 0 ? (
            <p>
              The declaration of conformity for this product is published on
              this page per hardware revision once its evidence set is
              complete and the declaration is signed. It is not published
              yet. Conformity documentation can be requested from the
              manufacturer at {company.email}.
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
