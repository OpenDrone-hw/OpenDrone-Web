import {useEffect, useState} from 'react';
import {HeroBuildGuide} from '~/components/HeroBuildGuide';
import {CartPlacementProvider} from '~/components/AddToCartButton';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {airframeLabel} from '~/lib/hero-airframes';
import type {HeroBuild} from '~/lib/hero-build';

/**
 * "Build with this" under a product page's buy box: the homepage build card
 * (`HeroBuildGuide`, same parts, prices, ship line and one add for the whole
 * build) for the build this part belongs to. A part that fits more than one
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
      <div className="pdp-build-head">
        <Txt id="product-chrome.build_block_label" as="p" className="pdp-build-label" />
        {builds.length > 1 ? (
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
        ) : null}
      </div>
      <CartPlacementProvider value="build_block">
        <HeroBuildGuide key={build.id} build={build} />
      </CartPlacementProvider>
    </section>
  );
}
