/**
 * Verify a Shopify webhook signature.
 *
 * Shopify signs the raw request body with the webhook's shared secret and
 * sends the digest as `X-Shopify-Hmac-Sha256`. A request whose signature
 * does not match the body it arrived with is not from Shopify, so the
 * caller refuses it before reading or writing anything.
 */

/** Constant-time compare, so a wrong signature leaks no position. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyShopifyHmac(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!header?.trim()) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const digest = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return safeEqual(digest, header.trim());
}
