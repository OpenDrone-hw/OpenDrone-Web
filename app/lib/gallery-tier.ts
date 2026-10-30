/**
 * Which tier (variant) a gallery image belongs to, from its filename and alt
 * text. A tier is named by its key ("5\" Freestyle", "Lite-UFL") and its
 * aliases ("5", "5in", "5-inch"). Long names match as a substring
 * (openesc-20x20-back.png); short names (3 characters or fewer, like "5" or
 * "3in") only as a whole filename token, so a digit inside a Shopify upload
 * hash (openframe-5-main_a37ee04e-3c83.png) never names a tier. The longest
 * matching name wins, so "lite" does not claim a "lite-ufl" image.
 * Returns null when the image names no tier (lifestyle shots stay on every tier).
 */
export type TierNames = Record<string, string[] | undefined>;

const norm = (v: string) => v.trim().toLowerCase().replace(/[×x]/g, 'x').replace(/\s+/g, '');
const loose = (v: string) => v.replace(/[-_]/g, '');

export function imageTier(url: string, altText: string | null | undefined, tiers: TierNames): string | null {
  const file = (url.split('?')[0].split('/').pop() ?? '').toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const tokens = new Set(file.split(/[-_.\s]+/).filter(Boolean));
  const fileLoose = loose(file);
  const alt = loose(norm(altText ?? ''));
  const altTokens = new Set((altText ?? '').toLowerCase().split(/[^a-z0-9"]+/).filter(Boolean));
  let best: {tier: string; len: number} | null = null;
  for (const [tier, aliases] of Object.entries(tiers)) {
    for (const raw of [tier, ...(aliases ?? [])]) {
      const name = norm(raw);
      if (!name) continue;
      const short = name.length <= 3;
      const hit = short
        ? tokens.has(name) || tokens.has(name.replace(/"$/, '')) || altTokens.has(name.replace(/"$/, ''))
        : file.includes(name) || fileLoose.includes(loose(name)) || alt.includes(loose(name));
      if (hit && (!best || name.length > best.len)) best = {tier, len: name.length};
    }
  }
  return best?.tier ?? null;
}
