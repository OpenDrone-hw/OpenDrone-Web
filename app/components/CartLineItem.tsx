import type {CartLineUpdateInput} from '@shopify/hydrogen/storefront-api-types';
import type {CartLayout, LineItemChildrenMap} from '~/components/CartMain';
import {CartForm, Image, type OptimisticCartLine} from '@shopify/hydrogen';
import {useVariantUrl} from '~/lib/variants';
import {Link} from 'react-router';
import {ProductPrice} from './ProductPrice';
import {useAside} from './Aside';
import {Txt} from '~/components/Txt';
import {copyText, editAttrs} from '~/lib/copy';
import {PREORDER_ATTR_KEY} from '~/lib/preorder';
import type {
  CartApiQueryFragment,
  CartLineFragment,
} from 'storefrontapi.generated';

export type CartLine = OptimisticCartLine<CartApiQueryFragment>;

/** The ship promise the cart action stamped on a pre-order line (see
 *  stampPreorderLines), or undefined. Only this attribute is ever shown;
 *  optimistic lines carry no attributes until the server responds. */
export function preorderNoteOf(line: {
  attributes?: Array<{key: string; value?: string | null}> | null;
}): string | undefined {
  return (
    (line.attributes ?? []).find((a) => a.key === PREORDER_ATTR_KEY)?.value ??
    undefined
  );
}

function PreorderLine({note}: {note: string | undefined}) {
  if (!note) return null;
  return (
    <small className="cart-line-preorder">
      {copyText('cart.preorder_line_prefix') ?? 'Pre-order'} · {note}
    </small>
  );
}

/** Sum a line's discount allocations into one label + amount (the stack BXGY
 *  or a code). Shopify splits over-quantity lines itself, so a line either
 *  carries allocations or none. */
function lineDiscountOf(line: CartLine) {
  const allocs =
    (line as {discountAllocations?: Array<{
      discountedAmount?: {amount: string; currencyCode: string} | null;
      title?: string;
      code?: string;
    }>}).discountAllocations ?? [];
  const total = allocs.reduce(
    (sum, a) => sum + (a.discountedAmount ? parseFloat(a.discountedAmount.amount) : 0),
    0,
  );
  if (total <= 0) return null;
  const first = allocs.find((a) => a.title || a.code);
  return {
    label:
      first?.title ??
      first?.code ??
      copyText('cart.line_discount_fallback') ??
      'Discount',
    amount: {
      amount: total.toFixed(2),
      currencyCode: allocs[0]!.discountedAmount!.currencyCode,
    },
  };
}

/**
 * A single line item in the cart. It displays the product image, title, price.
 * It also provides controls to update the quantity or remove the line item.
 * If the line is a parent line that has child components (like warranties or gift wrapping), they are
 * rendered nested below the parent line.
 */
export function CartLineItem({
  layout,
  line,
  childrenMap,
}: {
  layout: CartLayout;
  line: CartLine;
  childrenMap: LineItemChildrenMap;
}) {
  const {id, merchandise} = line;
  const {product, title, image, selectedOptions} = merchandise;
  const lineItemUrl = useVariantUrl(product.handle, selectedOptions);
  const {close} = useAside();
  const lineDiscount = lineDiscountOf(line);
  const preorderNote = preorderNoteOf(line);
  // What the line would cost undiscounted, for the strikethrough.
  const preDiscountTotal =
    lineDiscount && line.cost?.totalAmount
      ? ({
          amount: (
            parseFloat(line.cost.totalAmount.amount) +
            parseFloat(lineDiscount.amount.amount)
          ).toFixed(2),
          currencyCode: line.cost.totalAmount.currencyCode,
        } as (typeof line.cost)['totalAmount'])
      : undefined;
  const lineItemChildren = childrenMap[id];
  const childrenLabelId = `cart-line-children-${id}`;

  const childrenRows = lineItemChildren ? (
    <div>
      {/* Needs a real DOM id for aria-labelledby, and the product name is
          Shopify data, so the prefix is read as a string. */}
      <p
        id={childrenLabelId}
        className="sr-only"
        {...editAttrs('cart.line_children_sr_prefix')}
      >
        {copyText('cart.line_children_sr_prefix') ?? 'Line items with'}{' '}
        {product.title}
      </p>
      <ul aria-labelledby={childrenLabelId} className="cart-line-children">
        {lineItemChildren.map((childLine) => (
          <CartLineItem
            childrenMap={childrenMap}
            key={childLine.id}
            line={childLine}
            layout={layout}
          />
        ))}
      </ul>
    </div>
  ) : null;

  // /cart page — "build sheet" row: fixed mono columns (item · qty · total)
  // under the hairline-ruled header CartMain renders. The drawer keeps the
  // compact stacked layout below; only the DOM shape differs, every control
  // (qty forms, remove, discount badges) is the same machinery.
  if (layout === 'page') {
    return (
      <li key={id} className="cart-line cart-line--sheet">
        <div className="cart-sheet-row">
          {image && (
            <Image
              alt={title}
              aspectRatio="1/1"
              data={image}
              height={56}
              loading="lazy"
              width={56}
            />
          )}
          <div className="cart-sheet-item">
            <Link prefetch="viewport" to={lineItemUrl}>
              <p>
                <strong>{product.title}</strong>
              </p>
            </Link>
            <ul>
              {selectedOptions
                .filter(
                  (option) =>
                    !(
                      option.name === 'Title' &&
                      option.value === 'Default Title'
                    ),
                )
                .map((option) => (
                  <li key={option.name}>
                    <small>
                      {option.name}: {option.value}
                    </small>
                  </li>
                ))}
            </ul>
            <PreorderLine note={preorderNote} />
            {lineDiscount ? (
              <span className="cart-line-discount-badge">
                {lineDiscount.label} −
                <ProductPrice
                  price={
                    lineDiscount.amount as NonNullable<
                      (typeof line.cost)['totalAmount']
                    >
                  }
                />
              </span>
            ) : null}
          </div>
          <div className="cart-sheet-qty">
            <CartLineQuantity line={line} sheet />
          </div>
          <div className="cart-sheet-total">
            <ProductPrice price={line?.cost?.totalAmount} />
            {lineDiscount ? (
              <s className="cart-line-compare">
                <ProductPrice price={preDiscountTotal} />
              </s>
            ) : null}
          </div>
        </div>
        {childrenRows}
      </li>
    );
  }

  return (
    <li key={id} className="cart-line">
      <div className="cart-line-inner">
        {image && (
          <Image
            alt={title}
            aspectRatio="1/1"
            data={image}
            height={100}
            loading="lazy"
            width={100}
          />
        )}

        <div>
          <Link
            prefetch="viewport"
            to={lineItemUrl}
            onClick={() => {
              if (layout === 'aside') {
                close();
              }
            }}
          >
            <p>
              <strong>{product.title}</strong>
            </p>
          </Link>
          <span className="cart-line-price">
            <ProductPrice price={line?.cost?.totalAmount} />
            {lineDiscount ? (
              <>
                <s className="cart-line-compare">
                  <ProductPrice price={preDiscountTotal} />
                </s>
                <span className="cart-line-discount-badge">
                  {lineDiscount.label} −
                  <ProductPrice
                    price={
                      lineDiscount.amount as NonNullable<
                        (typeof line.cost)['totalAmount']
                      >
                    }
                  />
                </span>
              </>
            ) : null}
          </span>
          <ul>
            {selectedOptions
              .filter(
                (option) =>
                  !(option.name === 'Title' && option.value === 'Default Title'),
              )
              .map((option) => (
                <li key={option.name}>
                  <small>
                    {option.name}: {option.value}
                  </small>
                </li>
              ))}
          </ul>
          <PreorderLine note={preorderNote} />
          <CartLineQuantity line={line} />
        </div>
      </div>

      {childrenRows}
    </li>
  );
}

/**
 * Provides the controls to update the quantity of a line item in the cart.
 * These controls are disabled when the line item is new, and the server
 * hasn't yet responded that it was successfully added to the cart.
 */
function CartLineQuantity({line, sheet}: {line: CartLine; sheet?: boolean}) {
  if (!line || typeof line?.quantity === 'undefined') return null;
  const {id: lineId, quantity, isOptimistic} = line;
  const prevQuantity = Number(Math.max(0, quantity - 1).toFixed(0));
  const nextQuantity = Number((quantity + 1).toFixed(0));

  // Build-sheet variant (/cart page): a tight − n + cluster with the count
  // as a mono tabular figure between the steppers (the column header names
  // the quantity, so no "Quantity:" label), remove below.
  if (sheet) {
    return (
      <div className="cart-line-quantity cart-line-quantity--sheet">
        <div className="cart-sheet-stepper">
          <CartLineUpdateButton lines={[{id: lineId, quantity: prevQuantity}]}>
            <button
              aria-label={copyText('cart.line_decrease_aria') ?? 'Decrease quantity'}
              disabled={quantity <= 1 || !!isOptimistic}
              name="decrease-quantity"
              value={prevQuantity}
            >
              <span>&#8722;</span>
            </button>
          </CartLineUpdateButton>
          <span className="cart-sheet-qty-value" aria-label={`Quantity ${quantity}`}>
            {quantity}
          </span>
          <CartLineUpdateButton lines={[{id: lineId, quantity: nextQuantity}]}>
            <button
              aria-label={copyText('cart.line_increase_aria') ?? 'Increase quantity'}
              name="increase-quantity"
              value={nextQuantity}
              disabled={!!isOptimistic}
            >
              <span>&#43;</span>
            </button>
          </CartLineUpdateButton>
        </div>
        <CartLineRemoveButton lineIds={[lineId]} disabled={!!isOptimistic} />
      </div>
    );
  }

  return (
    <div className="cart-line-quantity">
      <small>
        <Txt id="cart.line_quantity_label" /> {quantity} &nbsp;&nbsp;
      </small>
      <CartLineUpdateButton lines={[{id: lineId, quantity: prevQuantity}]}>
        <button
          aria-label={copyText('cart.line_decrease_aria') ?? 'Decrease quantity'}
          disabled={quantity <= 1 || !!isOptimistic}
          name="decrease-quantity"
          value={prevQuantity}
        >
          <span>&#8722; </span>
        </button>
      </CartLineUpdateButton>
      &nbsp;
      <CartLineUpdateButton lines={[{id: lineId, quantity: nextQuantity}]}>
        <button
          aria-label={copyText('cart.line_increase_aria') ?? 'Increase quantity'}
          name="increase-quantity"
          value={nextQuantity}
          disabled={!!isOptimistic}
        >
          <span>&#43;</span>
        </button>
      </CartLineUpdateButton>
      &nbsp;
      <CartLineRemoveButton lineIds={[lineId]} disabled={!!isOptimistic} />
    </div>
  );
}

/**
 * A button that removes a line item from the cart. It is disabled
 * when the line item is new, and the server hasn't yet responded
 * that it was successfully added to the cart.
 */
function CartLineRemoveButton({
  lineIds,
  disabled,
}: {
  lineIds: string[];
  disabled: boolean;
}) {
  return (
    <CartForm
      fetcherKey={getUpdateKey(lineIds)}
      route="/cart"
      action={CartForm.ACTIONS.LinesRemove}
      inputs={{lineIds}}
    >
      <button disabled={disabled} type="submit">
        <Txt id="cart.line_remove" />
      </button>
    </CartForm>
  );
}

function CartLineUpdateButton({
  children,
  lines,
}: {
  children: React.ReactNode;
  lines: CartLineUpdateInput[];
}) {
  const lineIds = lines.map((line) => line.id);

  return (
    <CartForm
      fetcherKey={getUpdateKey(lineIds)}
      route="/cart"
      action={CartForm.ACTIONS.LinesUpdate}
      inputs={{lines}}
    >
      {children}
    </CartForm>
  );
}

/**
 * Returns a unique key for the update action. This is used to make sure actions modifying the same line
 * items are not run concurrently, but cancel each other. For example, if the user clicks "Increase quantity"
 * and "Decrease quantity" in rapid succession, the actions will cancel each other and only the last one will run.
 * @param lineIds - line ids affected by the update
 * @returns
 */
function getUpdateKey(lineIds: string[]) {
  return [CartForm.ACTIONS.LinesUpdate, ...lineIds].join('-');
}
