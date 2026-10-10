import type {Route} from './+types/testing';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {getIndex, getPreviews, getTiles} from '~/lib/testing/data.server';
import {WorkspaceShell} from '~/components/testing/WorkspaceShell';
import {ProductSection} from '~/components/testing/ProductSection';
import {LogSection} from '~/components/testing/LogSection';
import {Landing} from '~/components/testing/Landing';

/**
 * The Incutec testing workspace. It is a page of its own: `root.tsx` renders it
 * without the storefront header, footer or chapter strip. Data comes from
 * `public/testing/` (written by `npm run sync:testing` from the bench app's
 * published views); each figure's full series is fetched when it scrolls near.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('testing.meta_title') ?? 'Testing',
    description: copyText('testing.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/testing`,
  });

export async function loader(_args: Route.LoaderArgs) {
  return {index: getIndex(), previews: getPreviews(240), tiles: getTiles()};
}

export default function TestingRoute({loaderData}: Route.ComponentProps) {
  const {index, previews, tiles} = loaderData;
  return (
    <WorkspaceShell index={index}>
      <Landing index={index} tiles={tiles} />
      {index.products.map((p, i) => (
        <ProductSection key={p.handle} product={p} index={index} previews={previews} first={i === 0} />
      ))}
      {index.log.length ? <LogSection index={index} /> : null}
    </WorkspaceShell>
  );
}
