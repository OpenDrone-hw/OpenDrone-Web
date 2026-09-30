import {useState} from 'react';
import {useRouteLoaderData} from 'react-router';
import {
  ArrowUpRight,
  Check,
  Fan,
  Package,
  Mail,
  RadioTower,
  ShoppingBag,
} from 'lucide-react';
import type {RootLoader} from '~/root';
import {Link} from '~/components/nav';
import {AddToCartButton} from '~/components/AddToCartButton';
import {InfoHint} from '~/components/InfoHint';
import {Txt} from '~/components/Txt';
import {copyFill, copyText} from '~/lib/copy';
import {useProductStatusResolver} from '~/lib/coming-soon';
import {formatPrice} from '~/lib/catalog';
import {isPurchasableStatus} from '~/lib/product-content';
import {
  BUILD_ROLES,
  heroBuildSelection,
  type HeroBuild,
} from '~/lib/hero-build';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {
  latestShipDate,
  parseCampaignConfig,
  shortCampaignDate,
} from '~/lib/preorder-campaign';
import {parcelPromise, shipChipText} from '~/components/ShipChip';
import preorders from '../../content/preorders.json';

const CAMPAIGN = parseCampaignConfig(preorders);

/**
 * The line under the build's button: when the parcel ships, one date. A
 * build with a funding-target part waits for that target, so the whole
 * parcel goes with it (a dated Nov part included); a build of dated parts
 * states its date. Null when nothing selected has a ship promise.
 */
function buildShipNote(
  mix: 'mixed' | 'target' | 'date' | 'none',
  promises: Array<string | null>,
): string | null {
  if (mix === 'none') return null;
  const promise = parcelPromise(promises);
  if (mix === 'date') return shipChipText(promise)?.text ?? null;
  const date = shortCampaignDate(latestShipDate(CAMPAIGN));
  if (!date) return null;
  return (copyText('home.build_ship_target') ?? 'Ships by {date}').replace('{date}', date);
}

export function HeroBuildGuide({
  build,
  onInspect,
  activePart,
}: {
  build: HeroBuild;
  onInspect?: (beat: string) => void;
  activePart?: string | null;
}) {
  const [selected, setSelected] = useState(
    () => new Set(build.parts.map((part) => part.sku)),
  );
  const status = useProductStatusResolver();
  const sellable = (handle: string) => isPurchasableStatus(status(handle));
  // Global PUBLIC_COMING_SOON gate; fail closed when root data is missing.
  const comingSoon =
    useRouteLoaderData<RootLoader>('root')?.comingSoon ?? true;
  const selection = heroBuildSelection(build, selected, sellable, comingSoon);
  const shipNote = selection.available
    ? buildShipNote(selection.shipMix, selection.parts.map((part) => part.shipPromise))
    : null;
  return (
    <section
      className="hero-build-guide"
      aria-label={copyFill('home.build_aria', '{size}-inch build', {size: build.size})}
    >
      <div className="hero-build-heading">
        <h2>
          {build.size}″ <Txt id="home.build_title" />
        </h2>
        <InfoHint label={copyText('home.build_help_label') ?? 'About this build'} iconOnly>
          <Txt id="home.build_help" />
        </InfoHint>
      </div>
      <ul
        className="hero-build-parts"
        onWheel={(event) => event.stopPropagation()}
      >
        {build.parts.map((part) => {
          const included = selected.has(part.sku);
          const available = part.available && sellable(part.handle);
          const role = BUILD_ROLES[part.role];
          const roleLabel = copyText(`home.build_role_${part.role}`) ?? role.label;
          const contents = (
            <>
              <span className="hero-build-thumb">
                {part.image ? (
                  <img
                    src={shopifyImageUrl(part.image, 100)}
                    alt=""
                    width={38}
                    height={38}
                    loading="lazy"
                    decoding="async"
                  />
                ) : part.role === 'props' ? (
                  <Fan size={20} aria-hidden="true" />
                ) : part.role === 'antenna' ? (
                  <RadioTower size={20} aria-hidden="true" />
                ) : (
                  <Package size={20} aria-hidden="true" />
                )}
              </span>
              <span className="hero-build-name">
                <strong>{part.title}</strong>
                <small>
                  {part.quantity}× {roleLabel}
                </small>
              </span>
            </>
          );
          return (
            <li
              key={part.sku}
              className={`hero-build-part${included ? '' : ' is-excluded'}${activePart === role.beat ? ' is-active' : ''}`}
            >
              <label className="hero-build-check">
                <input
                  type="checkbox"
                  checked={included}
                  aria-label={copyFill('home.build_include_aria', 'Include {part}', {part: part.title})}
                  onChange={() =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(part.sku)) next.delete(part.sku);
                      else next.add(part.sku);
                      return next;
                    })
                  }
                />
                <span aria-hidden="true">
                  <Check size={12} />
                </span>
              </label>
              {onInspect ? (
                <button
                  type="button"
                  className="hero-build-inspect"
                  onClick={() => onInspect(role.beat)}
                  aria-label={copyFill('home.build_explore_aria', 'Explore {role}', {role: roleLabel})}
                >
                  {contents}
                </button>
              ) : (
                <Link
                  className="hero-build-inspect"
                  to={part.url}
                  prefetch="intent"
                >
                  {contents}
                </Link>
              )}
              <span className="hero-build-price">
                {!available ? (
                  <Txt id="home.build_unavailable" />
                ) : part.price === null || !selection.showPrices ? (
                  ''
                ) : (
                  formatPrice(
                    (part.price * part.quantity).toFixed(2),
                    part.currency,
                  )
                )}
              </span>
              <Link
                className="hero-build-detail"
                to={part.url}
                prefetch="intent"
                aria-label={copyFill('home.build_view_aria', 'View {part}', {part: part.title})}
              >
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hero-build-buy">
        {selection.notify ? (
          <Link className="hero-build-add" to="/newsletter" prefetch="intent">
            <span className="btn-label">
              <Mail size={16} aria-hidden="true" />
              <Txt id="home.build_notify" />
            </span>
          </Link>
        ) : (
        <AddToCartButton
          href={selection.href}
          disabled={!selection.available}
          product={`build-${build.id}`}
          className="hero-build-add"
          compactError
          revenue={
            selection.total !== null && selection.currency
              ? {amount: selection.total, currency: selection.currency}
              : null
          }
        >
          <ShoppingBag size={16} aria-hidden="true" />
          <Txt
            id={
              selection.complete ? 'home.build_add' : 'home.build_add_selected'
            }
          />
          {selection.total !== null && selection.currency ? (
            <span className="hero-build-total">
              {formatPrice(selection.total.toFixed(2), selection.currency)}
            </span>
          ) : null}
        </AddToCartButton>
        )}
        {shipNote && !selection.notify ? <p className="hero-build-ship">{shipNote}</p> : null}
      </div>
    </section>
  );
}
