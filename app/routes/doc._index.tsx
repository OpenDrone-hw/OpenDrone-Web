import {useLoaderData, Link} from 'react-router';
import type {Route} from './+types/doc._index';
import {DOC_REGISTRY} from '~/lib/doc-registry';
import {getCompanyIdentity} from '~/lib/company';
import {buildSeoMeta} from '~/lib/seo';

/** Index of EU declarations of conformity, one stable URL per SKU. */

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: 'EU Declarations of Conformity',
    description:
      'EU declarations of conformity for OpenDrone hardware, published per hardware revision.',
    // Reached from the packaging QR code only: unlinked and not indexed.
    robots: 'noindex,nofollow',
  });

export async function loader({context}: Route.LoaderArgs) {
  const env = context.env as unknown as Record<string, string | undefined>;
  return {company: getCompanyIdentity(env)};
}

export default function DocIndexRoute() {
  const {company} = useLoaderData<typeof loader>();
  return (
    <article className="page-shell">
      <div className="reading-column">
        <header className="page-header">
          <p className="page-eyebrow">Compliance</p>
          <h1 className="page-title">EU Declarations of Conformity</h1>
        </header>
        <div className="rich-content legal-body">
          <p>
            {company.name} issues an EU declaration of conformity per product
            and hardware revision, and publishes each signed declaration on
            its product page here. A declaration is published only when the
            evidence behind it is complete; until then its status is shown as
            in preparation.
          </p>
          <ul>
            {DOC_REGISTRY.map((e) => (
              <li key={e.sku}>
                <Link to={`/doc/${e.sku}`}>{e.name}</Link>
                {': '}
                {e.status === 'published'
                  ? 'published'
                  : e.legislation.length > 0
                    ? 'in preparation'
                    : 'no CE marking applies'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}
