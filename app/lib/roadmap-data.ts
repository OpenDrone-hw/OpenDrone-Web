/**
 * The roadmap's structure, lifted out of the route so other surfaces can
 * share it without importing a route module.
 *
 * Two consumers today: `app/routes/roadmap.tsx` renders the kanban from it,
 * and the cart ballot derives its candidate list from it, so "what you can
 * vote on" and "what the board shows" cannot drift apart. The product pages'
 * status chips were the third consumer this lift was originally asked for
 * (see the status-system note in CLAUDE.md).
 *
 * DATA RULE, unchanged from the route: every entry must be verifiable in
 * public, or be an explicit statement of intent (planned). No entry gets a
 * promised date; `added` records the past (when it was listed), never a plan.
 * The entry's name and its one-line note are copy in
 * `content/copy/roadmap.json`, keyed off `id`; everything here is structure.
 *
 * The status listed here is the static fallback. At request time the roadmap
 * loader overwrites it with the `status-*` topic on the linked GitHub repo,
 * which is the canonical carrier.
 */

export type ProductStatus =
  | 'launched'
  | 'beta'
  | 'alpha'
  | 'in-progress'
  | 'planned';

export type RoadmapItem = {
  /** Copy key stem: `item_<id>_name` and `item_<id>_note`. */
  id: string;
  status: ProductStatus;
  /** Product page on this site, when one exists. */
  productPath?: string;
  /** Public design source. Omit when nothing public exists. */
  link?: string;
  /**
   * GitHub repo name while the repo exists but is still private, so the
   * README status badge (`/api/status/<repo>.json`) can serve the static
   * status. Replace with `link` the day the repo goes public.
   */
  repo?: string;
  /** Board render for the kanban card, from public/boards/. */
  image?: string;
  /** Optional visual variants for one repository and one status identity. */
  variants?: {id: string; image?: string}[];
  /**
   * ISO date the entry joined this list. Shown on the vote standings so a
   * newcomer's low count reads as "new", not "unpopular". Set it when adding
   * an entry; the first six carry the date the ballot shipped.
   */
  added?: string;
};

export const ROADMAP: RoadmapItem[] = [
  {
    id: 'openfc_lite_30',
    status: 'alpha',
    productPath: '/products/openfc-lite',
    link: 'https://github.com/OpenDrone-hw/OpenFC-Lite',
    image: '/boards/openfc-lite/front.png',
  },
  {
    id: 'openfc_lite_mini_20',
    status: 'alpha',
    productPath: '/products/openfc-lite',
    link: 'https://github.com/OpenDrone-hw/OpenFC-Lite-Mini',
    image: '/boards/openfc-lite-mini/front.png',
  },
  {
    id: 'openesc_20',
    status: 'alpha',
    productPath: '/products/openesc',
    link: 'https://github.com/OpenDrone-hw/OpenESC-20x20',
    image: '/boards/openesc/front.png',
  },
  {
    id: 'openesc_30',
    status: 'alpha',
    productPath: '/products/openesc',
    link: 'https://github.com/OpenDrone-hw/OpenESC-30x30',
    image: '/boards/openesc-30x30/front.png',
  },
  {
    id: 'openrx_lite',
    status: 'alpha',
    productPath: '/products/openrx',
    link: 'https://github.com/OpenDrone-hw/OpenRX-Lite',
    image: '/boards/openrx-lite/front.png',
  },
  {
    id: 'openrx_lite_ufl',
    status: 'alpha',
    productPath: '/products/openrx',
    link: 'https://github.com/OpenDrone-hw/OpenRX-Lite-UFL',
    image: '/boards/openrx-lite-ufl/front.png',
  },
  {
    id: 'openrx_mono',
    status: 'alpha',
    productPath: '/products/openrx',
    link: 'https://github.com/OpenDrone-hw/OpenRX-Mono',
    image: '/boards/openrx-mono/front.png',
  },
  {
    id: 'openrx_gemini',
    status: 'alpha',
    productPath: '/products/openrx',
    link: 'https://github.com/OpenDrone-hw/OpenRX-Gemini',
    image: '/boards/openrx-gemini/front.png',
  },
  {
    id: 'openframe',
    added: '2026-08-11',
    // Samples ordered, nothing under test yet (2026-08-15).
    status: 'in-progress',
    productPath: '/products/openframe',
    // OpenDrone-hw/OpenFrame carries status-in-progress but is a private repo,
    // so it has no public link and its topic cannot be fetched. Add the link
    // the day the repo goes public; until then the static value IS the status.
    repo: 'OpenFrame',
  },
  {
    id: 'motors',
    added: '2026-08-11',
    // Samples ordered from the supplier, nothing under test yet.
    status: 'in-progress',
    productPath: '/products/openmotor',
  },
  {
    id: 'openvtx',
    added: '2026-08-11',
    status: 'planned',
    link: 'https://github.com/OpenDrone-hw/OpenVTX',
  },
  {
    id: 'openremoteid',
    added: '2026-08-11',
    status: 'planned',
    link: 'https://github.com/OpenDrone-hw/OpenRemoteID',
  },
  {
    id: 'openaio',
    added: '2026-08-11',
    status: 'planned',
    link: 'https://github.com/OpenDrone-hw/OpenAIO',
  },
  {
    id: 'charger',
    added: '2026-08-11',
    status: 'planned',
    link: 'https://github.com/OpenDrone-hw/Charger',
  },
];

/**
 * The vocabulary and its column order. Deliberately a bare list of KEYS: each
 * status's label and legend are copy (`status_<key>_label` /
 * `status_<key>_legend`), so a studio edit can rename a status but cannot add,
 * drop or reorder one. The `status-*` topics on the repos are matched against
 * exactly this list.
 */
export const STATUS_ORDER: ProductStatus[] = [
  'launched',
  'beta',
  'alpha',
  'in-progress',
  'planned',
];

/**
 * The `status-*` topic on each public GitHub repo is the canonical status
 * (see hardware/README.md in the working container). This pulls the topics
 * at request time so every consumer (kanban, ballot, standings) mirrors the
 * repos; the static status in ROADMAP is the fallback for products without a
 * public repo and for API failures. In-memory cache, 10 minutes per worker
 * isolate: statuses now gate SALES (see docs/product-status.md), so a flip
 * must land within minutes, not an hour. With GITHUB_STATUS_TOKEN set the
 * rate budget is 5000/h; without it, stay aware that 11 repos every 10
 * minutes approaches the unauthenticated 60/h ceiling.
 *
 * FALLBACK DISCIPLINE: the static status in ROADMAP must LAG the repo
 * topic, never lead it. If the API is unreachable the static value stands
 * in, so a static status that is ahead of the repo (beta while the repo
 * says alpha) would leak prices on an API failure. When flipping a topic
 * up, update the static value in the release PR that follows, not before.
 */
let topicCache: {at: number; map: Record<string, ProductStatus>} | null = null;
// One fan-out at a time per isolate: concurrent cold callers (a link burst,
// or root + PDP loader inside one document request) share the same in-flight
// fetch instead of each firing the full per-repo fan-out - without this, four
// concurrent cold requests could burn the whole unauthenticated hourly budget
// in a second.
let topicInflight: Promise<Record<string, ProductStatus>> | null = null;

export function fetchStatusFlags(
  token?: string,
): Promise<Record<string, ProductStatus>> {
  if (topicCache && Date.now() - topicCache.at < 600_000) {
    return Promise.resolve(topicCache.map);
  }
  if (!topicInflight) {
    topicInflight = fetchStatusFlagsUncached(token).finally(() => {
      topicInflight = null;
    });
  }
  return topicInflight;
}

async function fetchStatusFlagsUncached(
  token?: string,
): Promise<Record<string, ProductStatus>> {
  const map: Record<string, ProductStatus> = {};
  await Promise.all(
    ROADMAP.filter((r) => r.link).map(async (r) => {
      try {
        const name = (r.link as string).replace('https://github.com/', '');
        const res = await fetch(`https://api.github.com/repos/${name}/topics`, {
          headers: {
            'User-Agent': 'opendrone-store-roadmap',
            Accept: 'application/vnd.github+json',
            // 60 req/h unauthenticated vs 5000 with a token; set
            // GITHUB_STATUS_TOKEN (read-only, public repos) in Oxygen.
            ...(token ? {Authorization: `Bearer ${token}`} : {}),
          },
          // A wedged GitHub connection must never wedge the page.
          signal: AbortSignal.timeout(3500),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {names?: string[]};
        const flag = data.names
          ?.find((t) => t.startsWith('status-'))
          ?.slice('status-'.length);
        if (flag && (STATUS_ORDER as string[]).includes(flag)) {
          map[r.link as string] = flag as ProductStatus;
        }
      } catch {
        // Unreachable API: the static status stands in.
      }
    }),
  );
  topicCache = {at: Date.now(), map};
  return map;
}

/**
 * The page-speed variant: never blocks a loader for more than `ms`.
 *
 * Cache warm (the normal case) resolves instantly. Cache cold, the caller
 * gets the static statuses after the deadline while the fetch keeps running
 * and fills the cache for the next request. A roadmap that is milliseconds
 * fresh beats one that is seconds slow: the statuses move on the scale of
 * weeks.
 *
 * PASS `waitUntil` FROM LOADERS (context.waitUntil). On Oxygen, work still
 * pending when the response finishes is cancelled unless it is registered
 * with waitUntil - without it, the losing fetch here dies with the
 * response, the cache never fills, and every sequential request re-pays
 * the deadline plus the whole GitHub fan-out.
 */
export async function fetchStatusFlagsFast(
  token?: string,
  ms = 600,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Record<string, ProductStatus>> {
  const fetchPromise = fetchStatusFlags(token).catch(
    () => ({}) as Record<string, ProductStatus>,
  );
  waitUntil?.(fetchPromise);
  const deadline = new Promise<Record<string, ProductStatus>>((resolve) =>
    setTimeout(() => resolve({}), ms),
  );
  return Promise.race([fetchPromise, deadline]);
}

/** ROADMAP with the live topic statuses applied over the static fallbacks. */
export function resolveRoadmap(
  flags: Record<string, ProductStatus>,
): RoadmapItem[] {
  return ROADMAP.map((r) =>
    r.link && flags[r.link] ? {...r, status: flags[r.link]} : r,
  );
}

/**
 * The status a PRODUCT PAGE should carry, keyed by its Shopify handle. The
 * relation runs through `productPath` and is many-to-one (both OpenFC-Lite
 * boards share one page, both ESCs share one page), so the page shows the
 * furthest-along status among its boards: a page whose 30x30 is beta while
 * the 20x20 is still alpha is a beta page.
 */
export function statusForHandle(
  handle: string,
  flags: Record<string, ProductStatus> = {},
): ProductStatus | undefined {
  const path = `/products/${handle}`;
  const items = resolveRoadmap(flags).filter((r) => r.productPath === path);
  if (!items.length) return undefined;
  return items.reduce(
    (best, r) =>
      STATUS_ORDER.indexOf(r.status) < STATUS_ORDER.indexOf(best)
        ? r.status
        : best,
    items[0].status,
  );
}

/**
 * What the community can vote on: everything not yet buyable and not already
 * on the home straight. Alpha is excluded on purpose, a product with community
 * testers is being finished regardless of the vote.
 *
 * Pass a live-resolved roadmap (resolveRoadmap) where possible so a project
 * graduating out of `planned` leaves the ballot on its own; the no-argument
 * form falls back to the static statuses.
 */
const VOTABLE: ReadonlySet<ProductStatus> = new Set<ProductStatus>([
  'in-progress',
  'planned',
]);

export function voteCandidates(roadmap: RoadmapItem[] = ROADMAP): RoadmapItem[] {
  return roadmap.filter((r) => VOTABLE.has(r.status));
}

/**
 * Ids a vote may reference: EVERY roadmap id, not just today's candidates.
 * A ballot cast minutes before its project graduated must still validate and
 * still count; the standings then show it under "already moving" instead.
 */
export function votableIds(): string[] {
  return ROADMAP.map((r) => r.id);
}

/**
 * Planned and in-progress products have no settled design, so the shop
 * shows them a concept plate instead of a product page. Alpha and beyond
 * get the full page (docs/product-status.md).
 */
export function isConceptStatus(
  status: ProductStatus | null | undefined,
): status is 'planned' | 'in-progress' {
  return status === 'planned' || status === 'in-progress';
}

/** Whether a handle is a concept product (planned / in-progress) under the
 *  given live flags: hidden from every listing surface (catalog, header
 *  pods, related, feeds), reachable only via /roadmap and its plate. */
export function isConceptHandle(
  handle: string,
  flags: Record<string, ProductStatus> = {},
): boolean {
  return isConceptStatus(statusForHandle(handle, flags));
}

/**
 * The status chip a product page and a card show while the selected variant
 * sells in a preorder campaign, in place of the roadmap word. The roadmap
 * word describes the design (alpha: testers fly it), not what a buyer gets
 * for their money now, and "alpha" reads as "cannot be bought" on a page that
 * takes full payment. The campaign says what the order is:
 *
 * - `first-batch`: the next unit comes out of a paid production batch with
 *   its own ship date (FC and ESC batch 1).
 * - `funding`: the next unit counts toward a funding target; the supplier
 *   order is placed once it is reached (receivers, frames, motors).
 * - `funded`: the target is reached and the next unit fills the batch after it.
 *
 * Null outside a campaign: the roadmap chip stands.
 */
export type CampaignChip = 'first-batch' | 'funding' | 'funded';

export function campaignChip(
  campaign:
    | {paidStock: boolean; target: number | null; targetReached: boolean}
    | null
    | undefined,
): CampaignChip | null {
  if (!campaign) return null;
  if (campaign.paidStock) return 'first-batch';
  if (campaign.target !== null && !campaign.targetReached) return 'funding';
  return 'funded';
}
