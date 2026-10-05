import {useEffect, useState} from 'react';
import {HeroBuildGuide} from '~/components/HeroBuildGuide';
import {CartPlacementProvider} from '~/components/AddToCartButton';
import {copyText} from '~/lib/copy';
import {airframeLabel} from '~/lib/hero-airframes';
import type {HeroBuild} from '~/lib/hero-build';

/**
 * The build card in a product page's "What you need to fly" chapter: the
 * homepage build card (`HeroBuildGuide`, same parts, prices, ship line and
 * one add for the whole build) for the build this part belongs to. A part that fits more than one
 * build opens on the selected variant's build and offers the others as a
 * toggle; changing the variant moves the card with it.
 */
export function BuildWithThis({
  builds,
  selectedBuild,
}: {
  /** The builds that use this product, in build order. */
  builds: readonly HeroBuild[];
  /** The build of the selected variant (`buildForProduct`). */
  selectedBuild: string | null;
}) {
  const [shown, setShown] = useState(selectedBuild);
  useEffect(() => setShown(selectedBuild), [selectedBuild]);
  const build = builds.find((b) => b.id === shown) ?? builds[0];
  if (!build) return null;
  return (
    <section
      className="pdp-build"
      aria-label={copyText('product-chrome.build_block_label') ?? 'Build with this'}
    >
      {builds.length > 1 ? (
        <div className="pdp-build-head">
          <div
            className="hero-build-sizes pdp-build-sizes"
            role="group"
            aria-label={copyText('home.build_size_aria') ?? 'Build size'}
          >
            {builds.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={b.id === build.id}
                onClick={() => setShown(b.id)}
              >
                {airframeLabel(b.size)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <CartPlacementProvider value="build_block">
        <HeroBuildGuide key={build.id} build={build} />
      </CartPlacementProvider>
    </section>
  );
}
