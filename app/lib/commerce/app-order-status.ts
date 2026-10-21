/**
 * The order status page in app mode: which proof it sends to `storefront.order_status`, and what it may link.
 *
 * | Visit | Proof |
 * |---|---|
 * | `/shop/order?order=<number>&key=<key>` (the link in an order mail, any device) | the mail key, kept out of the cookie |
 * | `/shop/order` on the device that ordered | the number and status token of the signed `od_app_order` cookie |
 *
 * A key in the address wins over the cookie; the cookie is used only when its order is the one asked for. Pure, so node:test
 * loads it directly.
 */
export type StatusProof =
  {number: string; token: string} | {number: string; key: string};

const NUMBER = /^[A-Za-z0-9-]{1,20}$/;
const KEY = /^[0-9a-f]{16,64}$/;

export function statusProof(
  search: URLSearchParams,
  saved: {number?: string; token?: string} | null,
): StatusProof | null {
  const asked = search.get('order');
  const key = search.get('key');
  if (key !== null)
    return asked && NUMBER.test(asked) && KEY.test(key)
      ? {number: asked, key}
      : null;
  if (!saved?.number || !saved.token || (asked && asked !== saved.number))
    return null;
  return {number: saved.number, token: saved.token};
}

/** A tracking link the app gave us, only when it is a plain http(s) address. */
export function safeTrackingUrl(url: string | null | undefined): string | null {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'https:' || u.protocol === 'http:'
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}
