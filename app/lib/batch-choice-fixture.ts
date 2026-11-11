/**
 * A Storefront catalog response with the boards as Shopify will hold them
 * once each has a `Batch` option: `<Model> / Pre-order` (today's variant)
 * and `<Model> / Buy now` (retail, tracked stock), both with the board's one
 * SKU. Test data only: the prices are the ones on the product pages on
 * 2026-11-11 and the variant ids are made up.
 */

type Money = {amount: string; currencyCode: string};
type VariantNode = {
  id: string;
  title: string;
  sku: string | null;
  availableForSale: boolean;
  image: null;
  price: Money;
  compareAtPrice: Money | null;
  selectedOptions: Array<{name: string; value: string}>;
};
type ProductNode = {
  handle: string;
  title: string;
  description: string;
  productType: string;
  vendor: string | null;
  featuredImage: null;
  images: {nodes: never[]};
  rating: null;
  ratingCount: null;
  variants: {pageInfo: {hasNextPage: boolean}; nodes: VariantNode[]};
};

const eur = (amount: number): Money => ({amount: amount.toFixed(2), currencyCode: 'EUR'});

/** Board SKU: model, pre-order price, retail price. */
const BOARDS: Array<{handle: string; title: string; type: string; variants: Array<[string, string, number, number]>}> = [
  {handle: 'openfc-lite', title: 'OpenFC Lite', type: 'OpenFC', variants: [['OPENFC-LITE-2020', '20×20', 26.1, 29], ['OPENFC-LITE-3030', '30×30', 39, 39]]},
  {handle: 'openesc', title: 'OpenESC', type: 'OpenESC', variants: [['OPENESC-2020', '20×20', 44.1, 49], ['OPENESC-3030', '30×30', 59, 59]]},
];

const OTHERS: Array<[string, string, string, string, number, number | null]> = [
  ['openmotor', 'OpenMotor', 'OPENMOTOR-1604', '1604', 14.4, 18],
  ['openframe', 'OpenFrame', 'OPENFRAME-3', '3 inch', 31.5, 35],
];

const id = (name: string) => `gid://shopify/ProductVariant/${name}`;

export const CHOICE_IDS: Record<string, {preorder: string; buyNow: string}> = Object.fromEntries([
  ...BOARDS.flatMap((b) => b.variants.map(([sku]) => [sku, {preorder: id(`${sku}-preorder`), buyNow: id(`${sku}-buynow`)}])),
  ...OTHERS.map(([, , sku]) => [sku, {preorder: id(sku), buyNow: ''}]),
]);

export const CHOICE_POLICY: Record<string, {saleMode: string; shipPromise: null}> = Object.fromEntries(
  Object.keys(CHOICE_IDS).map((sku) => [sku, {saleMode: 'preorder', shipPromise: null}]),
);

export function choiceCatalogData(options: {withChoice?: boolean; buyNowAvailable?: boolean; extraSku?: string} = {}): {
  products: {pageInfo: {hasNextPage: boolean}; nodes: ProductNode[]};
} {
  const withChoice = options.withChoice ?? true;
  const product = (handle: string, title: string, type: string, nodes: VariantNode[]): ProductNode => ({
    handle, title, description: '', productType: type, vendor: 'OpenDrone', featuredImage: null,
    images: {nodes: []}, rating: null, ratingCount: null, variants: {pageInfo: {hasNextPage: false}, nodes},
  });
  const boards = BOARDS.map((board) => product(board.handle, board.title, board.type, [
    ...board.variants.map(([sku, model, price, retail]): VariantNode => ({
      id: CHOICE_IDS[sku].preorder,
      title: withChoice ? `${model} / Pre-order` : model,
      sku,
      availableForSale: true,
      image: null,
      price: eur(price),
      compareAtPrice: price < retail ? eur(retail) : null,
      selectedOptions: [{name: 'Model', value: model}, ...(withChoice ? [{name: 'Batch', value: 'Pre-order'}] : [])],
    })),
    ...(withChoice
      ? board.variants.map(([sku, model, , retail]): VariantNode => ({
          id: CHOICE_IDS[sku].buyNow,
          title: `${model} / Buy now`,
          sku,
          availableForSale: options.buyNowAvailable ?? true,
          image: null,
          price: eur(retail),
          compareAtPrice: null,
          selectedOptions: [{name: 'Model', value: model}, {name: 'Batch', value: 'Buy now'}],
        }))
      : []),
  ]));
  const others = OTHERS.map(([handle, title, sku, model, price, retail]) => product(handle, title, title, [{
    id: CHOICE_IDS[sku].preorder, title: model, sku, availableForSale: true, image: null,
    price: eur(price), compareAtPrice: retail === null ? null : eur(retail), selectedOptions: [{name: 'Model', value: model}],
  }]));
  const extra = options.extraSku
    ? [product('mystery', 'Mystery', 'Other', [{id: id('mystery'), title: 'Default Title', sku: options.extraSku, availableForSale: true, image: null, price: eur(1), compareAtPrice: null, selectedOptions: []}])]
    : [];
  return {products: {pageInfo: {hasNextPage: false}, nodes: [...boards, ...others, ...extra]}};
}
