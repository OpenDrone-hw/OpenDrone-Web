import type {Route} from './+types/testing';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {getIndex, getPreviews} from '~/lib/testing/data.server';
import {numberFigures, photoNumbers} from '~/lib/testing/layout';
import {WorkspaceShell} from '~/components/testing/WorkspaceShell';
import {ProductSection} from '~/components/testing/ProductSection';
import {LogSection} from '~/components/testing/LogSection';
import {TitleBlock} from '~/components/testing/TitleBlock';

/**
 * The Incutec testing page, laid out as a report. It is a page of its own:
 * `root.tsx` renders it without the storefront header, footer or chapter strip.
 * Data comes from `public/testing/` (written by `npm run sync:testing` from the
 * bench app's published views); each figure's full series is fetched when it
 * scrolls near.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('testing.meta_title') ?? 'Testing',
    description: copyText('testing.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/testing`,
  });

export async function loader(_args: Route.LoaderArgs) {
  return {index: getIndex(), previews: getPreviews(240)};
}

export default function TestingRoute({loaderData}: Route.ComponentProps) {
  const {index, previews} = loaderData;
  const numbers = numberFigures(index, (id) => Boolean(previews[id]));
  const photos = photoNumbers(index);
  return (
    <WorkspaceShell>
      <TitleBlock index={index} />
      {index.products.map((p) => (
        <ProductSection key={p.handle} product={p} index={index} previews={previews} numbers={numbers} photoNo={photos[p.handle]} />
      ))}
      {index.log.length ? <LogSection index={index} numbers={numbers} /> : null}
    </WorkspaceShell>
  );
}
