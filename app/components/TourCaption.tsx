import {useMemo} from 'react';
import {Link, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {AddToCartButton} from '~/components/AddToCartButton';
import {ShipChip} from '~/components/ShipChip';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {useProductStatusResolver} from '~/lib/coming-soon';
import {isPurchasableStatus, lineDisplayName} from '~/lib/product-content';
import {stepCounter, type TourStep} from '~/lib/home-tour';
import {
  picksForStep,
  resolveHeroBuilds,
  type HeroBuild,
  type HeroBuildsConfig,
  type HeroPick,
} from '~/lib/hero-build';
import buildsJson from '../../content/builds.json';

/** The step that closes the tour with the whole build (studio.json beat id). */
export const BUILD_STEP_ID = 'build';

/** The build the tour starts on: the 3D model is a 3". */
export const DEFAULT_BUILD = '3-inch';

const t = (key: string, fallback: string) => copyText(`home.${key}`) ?? fallback;

/**
 * Every build of content/builds.json resolved against the catalog the root
 * loader already carries: names, live prices, ship promises, cart links.
 */
export function useHeroBuilds(): HeroBuild[] {
  const root = useRouteLoaderData<RootLoader>('root');
  const status = useProductStatusResolver();
  const products = root?.familyProducts;
  return useMemo(
    () =>
      resolveHeroBuilds(buildsJson as HeroBuildsConfig, products ?? [], {
        sellable: (handle) => isPurchasableStatus(status(handle)),
        nameOf: lineDisplayName,
      }),
    [products, status],
  );
}

/** The product page a step's part opens, for the given build: its variant
 *  when the build has one, else the product. Null for a step with no product. */
export function stepProductUrl(step: TourStep, build: HeroBuild | undefined): string | null {
  if (!step.handle) return null;
  return picksForStep(build, step.handle)[0]?.url ?? `/products/${step.handle}`;
}

/** `3-inch` as the tab reads it: `3"`. */
function sizeLabel(label: string): string {
  const n = /^(\d+(?:\.\d+)?)/.exec(label)?.[1];
  return n ? `${n}"` : label;
}

function price(amount: number | string, currency: string): string {
  return formatPrice(amount, currency);
}

/** 3" / 5": which build the picks are for. */
export function BuildToggle({
  builds,
  value,
  onChange,
}: {
  builds: HeroBuild[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (builds.length < 2) return null;
  return (
    <div className="tour-build-toggle" role="group" aria-label={t('tour_build_label', 'Build size')}>
      {builds.map((b) => (
        <button
          key={b.id}
          type="button"
          aria-pressed={b.id === value}
          onClick={() => onChange(b.id)}
        >
          {sizeLabel(b.label)}
        </button>
      ))}
    </div>
  );
}

/** One part of the build: name linked to its product page, price, ship
 *  chip and Add. */
function PickRow({pick, compact = false}: {pick: HeroPick; compact?: boolean}) {
  const amount = (Number(pick.price.amount) || 0) * pick.quantity;
  const name = `${pick.quantity > 1 ? `${pick.quantity}x ` : ''}${pick.name}`;
  return (
    <li className={`tour-pick${compact ? ' is-compact' : ''}`}>
      <Link className="tour-pick-name" to={pick.url} prefetch="intent">
        {name}
      </Link>
      {pick.listed ? <span className="tour-pick-price">{price(amount, pick.price.currencyCode)}</span> : null}
      {compact ? null : (
        <>
          <ShipChip promise={pick.shipPromise} className="tour-pick-ship" />
          {pick.buyable ? (
            <AddToCartButton
              className="tour-pick-add"
              href={pick.addHref}
              product={pick.handle}
              revenue={{currency: pick.price.currencyCode, amount}}
              ariaLabel={`${t('tour_add', 'Add')}: ${name}`}
            >
              {t('tour_add', 'Add')}
            </AddToCartButton>
          ) : null}
        </>
      )}
    </li>
  );
}

/** The last step: the build's parts, the total, one add for all of it and
 *  what a quad needs that is not sold here. */
function BuildSummary({build}: {build: HeroBuild}) {
  return (
    <div className="tour-summary">
      <ul className="tour-picks">
        {build.parts.map((p) => (
          <PickRow key={p.sku} pick={p} compact />
        ))}
      </ul>
      <p className="tour-total">
        <span>{t('tour_total', 'Total')}</span>
        <span className="tour-pick-price">{price(build.total, build.currency)}</span>
      </p>
      {build.addHref ? (
        <AddToCartButton
          className="btn-primary tour-add-build"
          href={build.addHref}
          product="build"
          revenue={{currency: build.currency, amount: build.total}}
        >
          {t('tour_add_build', 'Add the build')}
        </AddToCartButton>
      ) : null}
      <p className="tour-not-sold">
        {t('tour_not_sold', 'Not sold here: camera and VTX, battery, radio, goggles.')}
      </p>
    </div>
  );
}

/**
 * One walkthrough step as the text block shows it: counter and build toggle,
 * the part's role, what it does, and the build's pick for that part (or the
 * whole build on the last step). Shared by the desktop panel, its no-3D list
 * and the phone walkthrough.
 */
export function TourCaption({
  step,
  index,
  total,
  builds,
  buildId,
  onBuild,
  toggle = true,
  as: Heading = 'h2',
}: {
  step: TourStep;
  index: number;
  total: number;
  builds: HeroBuild[];
  buildId: string;
  onBuild: (id: string) => void;
  /** Show the 3" / 5" toggle (the no-3D list shows it once). */
  toggle?: boolean;
  as?: 'h2' | 'h3';
}) {
  const build = builds.find((b) => b.id === buildId) ?? builds[0];
  const picks = picksForStep(build, step.handle);
  return (
    <>
      <div className="tour-head">
        <p className="tour-count">{stepCounter(index, total)}</p>
        {toggle ? <BuildToggle builds={builds} value={build?.id ?? buildId} onChange={onBuild} /> : null}
      </div>
      <Heading className="tour-role">{step.title}</Heading>
      {step.caption ? <p className="tour-text">{step.caption}</p> : null}
      {step.id === BUILD_STEP_ID && build?.parts.length ? (
        <BuildSummary build={build} />
      ) : picks.length ? (
        <ul className="tour-picks">
          {picks.map((p) => (
            <PickRow key={p.sku} pick={p} />
          ))}
        </ul>
      ) : null}
    </>
  );
}
