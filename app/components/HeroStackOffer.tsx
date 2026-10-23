import {useRouteLoaderData} from 'react-router';
import {ShoppingBag} from 'lucide-react';
import type {RootLoader} from '~/root';
import {Link} from '~/components/nav';
import {AddToCartButton} from '~/components/AddToCartButton';
import {Txt} from '~/components/Txt';
import {copyFill} from '~/lib/copy';
import {useProductStatusResolver} from '~/lib/coming-soon';
import {formatPrice} from '~/lib/catalog';
import {isPurchasableStatus, shortShipPromise} from '~/lib/product-content';
import {heroBuildSelection, heroStack, type HeroBuild} from '~/lib/hero-build';
import {shopifyImageUrl} from '~/lib/shopify-image';

/**
 * The FC + ESC of the hero's build size as one compact offer, above the
 * build card. Only for a buyer whose region gets the dated batch (the loader
 * passes `show`) and only while `heroStack` finds both boards on that date;
 * nothing renders otherwise, never a disabled card.
 */
export function HeroStackOffer({build, show}: {build: HeroBuild; show: boolean}) {
  const status = useProductStatusResolver();
  const comingSoon =
    useRouteLoaderData<RootLoader>('root')?.comingSoon ?? true;
  const stack = show ? heroStack(build) : null;
  if (!stack) return null;
  const sellable = (handle: string) => isPurchasableStatus(status(handle));
  const selection = heroBuildSelection(
    stack,
    new Set(stack.parts.map((part) => part.sku)),
    sellable,
    comingSoon,
  );
  if (!selection.available || selection.total === null || !selection.currency) return null;
  const ships = shortShipPromise(stack.parts[0].shipPromise)?.text;
  return (
    <section
      className="hero-build-guide hero-stack-offer"
      aria-label={copyFill('home.stack_aria', '{size}-inch stack', {size: build.size})}
    >
      <div className="hero-build-heading">
        <h2>
          {build.size}″ <Txt id="home.stack_title" />
        </h2>
        {ships ? <span className="hero-stack-ships">{ships}</span> : null}
      </div>
      <div className="hero-stack-parts">
        {stack.parts.map((part) => (
          <Link key={part.sku} className="hero-stack-part" to={part.url} prefetch="intent">
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
              ) : null}
            </span>
            <strong>{part.title}</strong>
          </Link>
        ))}
      </div>
      <div className="hero-build-buy">
        <AddToCartButton
          href={selection.href}
          product={`stack-${build.id}`}
          className="hero-build-add"
          compactError
          revenue={{amount: selection.total, currency: selection.currency}}
        >
          <ShoppingBag size={16} aria-hidden="true" />
          <Txt id="home.stack_add" />
          <span className="hero-build-total">
            {formatPrice(selection.total.toFixed(2), selection.currency)}
          </span>
        </AddToCartButton>
        <p className="hero-build-ship">
          <Txt id="home.stack_note" />
        </p>
      </div>
    </section>
  );
}
