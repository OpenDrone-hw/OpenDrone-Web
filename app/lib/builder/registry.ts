/**
 * Drone-builder parts registry - single source of truth for the slot/part
 * system the homepage hero (and later the /builder route) renders and sells.
 *
 * Follows the `product-content.ts` precedent: the REPO holds identity,
 * compatibility facts, and editorial data, keyed by Shopify handle; Shopify
 * stays authoritative ONLY for price/stock/variant ids, resolved at load time
 * (see buildHeroStacks in routes/_index.tsx). The registry therefore NEVER
 * stores variant GIDs - only `handle` + option values - so a future storefront
 * swap replaces the resolver, not this data.
 *
 * The legacy hero registry (`app/lib/hero-airframes.ts`) is now a DERIVED view
 * over this file - its exports (HERO_AIRFRAMES / HERO_BOARDS / …) are computed
 * from AIRFRAMES / SLOTS / PART_CATALOG below, so every existing hero consumer
 * keeps working unchanged while the builder grows.
 *
 * ── Adding a SKU to the hero (checklist) ─────────────────────────────────────
 *  1. SlotDef in SLOTS (if it's a new slot) - `order` slots it into the scroll
 *     choreography; the reveal windows + scroll stops are GENERATED from the
 *     slot count (see heroRevealWindows / heroScrollStops below).
 *  2. PartDef in PART_CATALOG - handle + option values (never variant GIDs),
 *     one GLB path per supported size in `models`.
 *  3. Reference it from HERO_DEFAULT_BUILDS for each size that shows it.
 *  4. Ship the GLBs (meshopt-compressed - NOT Draco; Hydrogen's CSP
 *     `worker-src` blocks DRACOLoader's blob worker, see HeroScene.tsx).
 *  5. Matching Shopify variants named on the `Model` axis convention
 *     (mount-named for FC/ESC: `20×20` / `30×30`).
 */

/**
 * Dev-only invariant gate. In the Vite dev server (and dev SSR) this is true,
 * so a violated registry invariant throws loudly at first import. In the
 * production worker bundle `import.meta.env.DEV` is statically `false`, so a
 * bad data edit degrades (fallbacks below) instead of 500ing every route at
 * boot - server.ts statically imports the route graph, which imports this
 * module. CI executes the same asserts via `npm run check:registry`
 * (scripts/check-registry.mjs → assertBuilderRegistry()).
 */
const DEV: boolean =
  typeof import.meta.env !== 'undefined' && Boolean(import.meta.env.DEV);

/** Airframe size class. Extends HERO_AIRFRAMES' key space. */
export type SizeClass = '3' | '5';

/** Stack mounting patterns (mm). Matches the Shopify "Model" axis values
 *  already in use (HERO_VARIANT_AXIS) - 20×20 ↔ '20x20', 30×30 ↔ '30x30'. */
export type MountPattern =
  | '20x20'
  | '25x25'
  | '30x30'
  | 'm9'
  | 'm12'
  | 'm16'
  | 'm19';

export type Connector =
  | 'jst-sh-8'
  | 'uart-pads'
  | 'xt30'
  | 'xt60'
  | 'mipi'
  | 'analog-cam';

export type SlotId =
  | 'frame'
  | 'fc'
  | 'esc'
  | 'rx'
  | 'video'
  | 'battery'
  | 'motors'
  | 'props'
  | 'mount'; // AirTag/buzzer mount

export type SlotDef = {
  id: SlotId;
  /** "Receiver", "Video system", … */
  label: string;
  /** frame/fc/esc/motors yes; mount no. */
  required: boolean;
  /** Reveal + spotlight order - generalizes HERO_BOARDS' array order. The
   *  hero's reveal windows and scroll stops are generated from this ordering
   *  (see heroRevealWindows / heroScrollStops). */
  order: number;
  /** Parts rendered as N instances (motors/props ×4). */
  instances?: number;
  /** Hero-scene material treatment: 'carbon' = the translucent dark-carbon
   *  frame material (scene-owned, animated per frame); 'pcb' = keep the GLB's
   *  own board materials (upgraded to PBR, merged by material). */
  finish?: 'carbon' | 'pcb';
  /** Hero choreography: X tilt while this slot holds the scroll spotlight
   *  (radians). Only meaningful for non-final slots - the final slot's beat is
   *  the camera pull-back, not a tilt. */
  focusTiltX?: number;
  /** The slot whose model defines the airframe's bounds - the whole assembly
   *  is fit-scaled and centered on THIS slot's GLB (the frame). Exactly one
   *  hero slot must set it. */
  fitAnchor?: boolean;
};

/** Commerce nature of a part - drives card UI + cart eligibility. */
export type PartCommerce =
  | {
      kind: 'shopify';
      /** e.g. 'openrx' */
      handle: string;
      /** Option-axis values selecting the variant, e.g. {Model: '30×30'}.
       *  Resolved against live variants case-insensitively, exactly like
       *  buildHeroStacks(). Absent ⇒ the base product (single-SKU parts). */
      options?: Record<string, string>;
    }
  | {kind: 'external'; url?: string; note: string} // third-party, link out
  | {kind: 'info'; note: string}; // purely informational

export type PartDef = {
  /** 'openfc-lite-30x30', 'battery-4s-1300', 'video-o4' */
  id: string;
  slot: SlotId;
  label: string;
  commerce: PartCommerce;
  /** GLB per size class it supports; absent size ⇒ not offered there.
   *  Doubles as the size-compatibility rule and the loader manifest. */
  models: Partial<Record<SizeClass, string>>;
  /** Compatibility facts - consumed by the (future) rule set. */
  mounts?: MountPattern[]; // what it bolts to (boards: its own pattern)
  provides?: Connector[]; // e.g. ESC provides 'jst-sh-8'
  requires?: Connector[]; // e.g. FC requires 'jst-sh-8' from ESC
  weightGrams?: Partial<Record<SizeClass, number>>;
  /** Battery only - feeds the flight-time estimate (Phase 4). */
  cell?: {s: number; mAh: number};
  /** Per-part placement tweak if the GLB origin isn't the mounted pose. */
  transform?: {position?: [number, number, number]; rotationY?: number};
};

/** partId per slot (null = slot empty). */
export type BuildState = Record<SlotId, string | null>;

/** The Shopify option axis FC/ESC size variants are named on (mount-named). */
export const HERO_VARIANT_AXIS = 'Model';

// ─── Airframes ────────────────────────────────────────────────────────────────

/** One entry per airframe size the hero offers, in slider order. */
export type AirframeDef = {
  size: SizeClass;
  /** Size-slider label. */
  label: string;
  /** The Shopify "Model" option value this size maps to - mount-named
   *  (`20×20`/`30×30`, × = U+00D7), the SAME axis for both the FC and the ESC.
   *  Matched case-insensitively against live variant option values. */
  shopifyModel: string;
};

export const AIRFRAMES: AirframeDef[] = [
  {size: '5', label: '5″ Freestyle', shopifyModel: '30×30'},
  {size: '3', label: '3″ Freestyle', shopifyModel: '20×20'},
];

// ─── Slots ───────────────────────────────────────────────────────────────────

/**
 * All defined slots. Today: exactly the hero's three boards. Phase 1 proper
 * adds rx + battery; the choreography (reveal windows, scroll stops) is
 * generated from this list's length + order, so growing it is a data change.
 */
export const SLOTS: SlotDef[] = [
  {
    id: 'fc',
    label: 'Flight controller',
    required: true,
    order: 0,
    finish: 'pcb',
    // FC reads from a slight downward front angle.
    focusTiltX: 0.32,
  },
  {
    id: 'esc',
    label: 'ESC',
    required: true,
    order: 1,
    finish: 'pcb',
    // ESC sits beneath the FC - steeper look-down so the FC doesn't cover it.
    focusTiltX: 0.62,
  },
  {
    id: 'frame',
    label: 'Frame',
    required: true,
    order: 2,
    finish: 'carbon',
    fitAnchor: true,
  },
];

/** The slots that appear on the homepage hero (Phase 1 adds rx + battery). */
const HERO_SLOT_IDS = ['fc', 'esc', 'frame'] as const;
export type HeroSlotId = (typeof HERO_SLOT_IDS)[number];
export type HeroSlotDef = SlotDef & {id: HeroSlotId};

function isHeroSlot(s: SlotDef): s is HeroSlotDef {
  return (HERO_SLOT_IDS as readonly SlotId[]).includes(s.id);
}

/** The hero's slots in reveal/spotlight order (SlotDef.order ascending). */
export const HERO_SLOTS: HeroSlotDef[] = SLOTS.filter(isHeroSlot).sort(
  (a, b) => a.order - b.order,
);

/** The slot the assembly is fit-scaled/centered on (the frame).
 *  Exactly-one-anchor is asserted in assertBuilderRegistry() (dev + CI); in
 *  production a mis-tagged registry falls back to the first tagged slot, or
 *  the last hero slot (the frame position), rather than throwing at import. */
export const HERO_ANCHOR_SLOT: HeroSlotDef = (() => {
  const anchors = HERO_SLOTS.filter((s) => s.fitAnchor);
  return anchors[0] ?? HERO_SLOTS[HERO_SLOTS.length - 1];
})();

// ─── Parts ───────────────────────────────────────────────────────────────────

/**
 * Every part the hero can render/sell. Commerce is handle + option values
 * ONLY (no variant GIDs - see the header). `models` carries one GLB per
 * supported size; a part offered at both sizes as one SKU (the frame) lists
 * both, a per-size variant part (FC/ESC) is one PartDef per variant.
 */
export const PART_CATALOG: PartDef[] = [
  {
    id: 'openfc-lite-30x30',
    slot: 'fc',
    label: 'OpenFC Lite 30×30',
    commerce: {
      kind: 'shopify',
      handle: 'openfc-lite',
      options: {[HERO_VARIANT_AXIS]: '30×30'},
    },
    models: {'5': '/models/fc5.glb'},
    mounts: ['30x30'],
  },
  {
    id: 'openfc-lite-20x20',
    slot: 'fc',
    label: 'OpenFC Lite 20×20',
    commerce: {
      kind: 'shopify',
      handle: 'openfc-lite',
      options: {[HERO_VARIANT_AXIS]: '20×20'},
    },
    models: {'3': '/models/fc3.glb'},
    mounts: ['20x20'],
  },
  {
    id: 'openesc-30x30',
    slot: 'esc',
    label: 'OpenESC 30×30',
    commerce: {
      kind: 'shopify',
      handle: 'openesc',
      options: {[HERO_VARIANT_AXIS]: '30×30'},
    },
    models: {'5': '/models/esc5.glb'},
    mounts: ['30x30'],
  },
  {
    id: 'openesc-20x20',
    slot: 'esc',
    label: 'OpenESC 20×20',
    commerce: {
      kind: 'shopify',
      handle: 'openesc',
      options: {[HERO_VARIANT_AXIS]: '20×20'},
    },
    models: {'3': '/models/esc3.glb'},
    mounts: ['20x20'],
  },
  {
    // One SKU across sizes - the 3D model differs per size, the product
    // doesn't (no `options`, card links to the base PDP).
    id: 'openframe',
    slot: 'frame',
    label: 'OpenFrame',
    commerce: {kind: 'shopify', handle: 'openframe'},
    models: {'3': '/models/frame3.glb', '5': '/models/frame5.glb'},
  },
];

export function findPart(id: string): PartDef | undefined {
  return PART_CATALOG.find((p) => p.id === id);
}

// ─── Hero default builds ─────────────────────────────────────────────────────

/**
 * The one blessed stack the hero shows per size (no configuration UI yet -
 * that's the /builder route). partId per hero slot.
 */
export const HERO_DEFAULT_BUILDS: Record<
  SizeClass,
  Record<HeroSlotId, string>
> = {
  '5': {fc: 'openfc-lite-30x30', esc: 'openesc-30x30', frame: 'openframe'},
  '3': {fc: 'openfc-lite-20x20', esc: 'openesc-20x20', frame: 'openframe'},
};

/** The PartDef filling a hero slot for a given size. Throws on registry
 *  inconsistency (unknown size/part) - these are compile-time-adjacent data
 *  bugs, not runtime conditions. */
export function heroPartFor(slotId: HeroSlotId, sizeKey: string): PartDef {
  const build = HERO_DEFAULT_BUILDS[sizeKey as SizeClass];
  if (!build) throw new Error(`registry: unknown hero size "${sizeKey}"`);
  const part = findPart(build[slotId]);
  if (!part) {
    throw new Error(
      `registry: hero build for size "${sizeKey}" references missing part "${build[slotId]}"`,
    );
  }
  return part;
}

/** GLB url for a hero slot at a given size. */
export function heroModelUrl(slotId: HeroSlotId, sizeKey: string): string {
  const part = heroPartFor(slotId, sizeKey);
  const url = part.models[sizeKey as SizeClass];
  if (!url) {
    throw new Error(
      `registry: part "${part.id}" has no model for size "${sizeKey}"`,
    );
  }
  return url;
}

/** Shopify product handle behind a hero slot (same across sizes - asserted
 *  by the HERO_BOARDS derivation in hero-airframes.ts). */
export function heroSlotHandle(slotId: HeroSlotId): string {
  const part = heroPartFor(slotId, AIRFRAMES[0].size);
  if (part.commerce.kind !== 'shopify') {
    throw new Error(`registry: hero slot "${slotId}" is not a shopify part`);
  }
  return part.commerce.handle;
}

// ─── Hero scroll choreography (generated) ────────────────────────────────────
//
// The reveal windows (per-card pop + matching 3D spotlight) and the wheel-step
// controller's stops used to be hand-maintained literals in TWO files
// (routes/_index.tsx and HeroScene.tsx's smoothstep calls) that had to move in
// lockstep. They are now generated here from the hero slot list, so adding a
// slot updates both sides structurally. (scope doc §7 "Choreography coupling")

/** First window opens at this progress - a beat after the scroll starts. */
const REVEAL_FIRST_START = 0.08;
/** Widest a window may span (reveal duration per card) - the 3-slot value. */
const REVEAL_MAX_WIDTH = 0.22;
/** Last window closes here - leaves a settle beat before progress hits 1. */
const REVEAL_LAST_END = 0.94;
/** Minimum dead beat between one window's close and the next one's open -
 *  keeps reveals reading as discrete pops even when windows shrink to fit. */
const REVEAL_MIN_GAP = 0.06;

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Evenly space `count` reveal windows between REVEAL_FIRST_START and
 * REVEAL_LAST_END. Width is DERIVED from the count: as wide as possible up to
 * REVEAL_MAX_WIDTH while keeping at least REVEAL_MIN_GAP between consecutive
 * windows - so any slot count yields non-overlapping windows instead of the
 * fixed width colliding at n≥4. For the current 3 slots this reproduces the
 * historical literals EXACTLY (asserted in assertBuilderRegistry):
 * [0.08, 0.3], [0.4, 0.62], [0.72, 0.94].
 */
export function heroRevealWindows(
  count: number,
): ReadonlyArray<readonly [number, number]> {
  if (count <= 0) return Object.freeze([]);
  const span = REVEAL_LAST_END - REVEAL_FIRST_START;
  const width =
    count === 1
      ? Math.min(REVEAL_MAX_WIDTH, span)
      : Math.min(
          REVEAL_MAX_WIDTH,
          (span - (count - 1) * REVEAL_MIN_GAP) / count,
        );
  const spacing = count === 1 ? 0 : (span - width) / (count - 1);
  return Object.freeze(
    Array.from({length: count}, (_, i) => {
      const start = round2(REVEAL_FIRST_START + i * spacing);
      return Object.freeze([start, round2(start + width)] as const);
    }),
  );
}

/**
 * Scroll stops: rest position 0 plus one stop per slot - evenly spaced,
 * rounded UP to 2 decimals, and floored at the matching window's close so
 * each stop rests on a fully-revealed card at ANY slot count (the invariant
 * assertBuilderRegistry verifies). For 3 slots this reproduces the historical
 * [0, 0.34, 0.67, 1.0] exactly.
 */
export function heroScrollStops(count: number): readonly number[] {
  const windows = heroRevealWindows(count);
  return Object.freeze([
    0,
    ...windows.map(([, close], i) =>
      Math.max(Math.ceil(((i + 1) * 100) / count) / 100, close),
    ),
  ]);
}

/** Per-card / per-board reveal windows, index-aligned with HERO_SLOTS. */
export const HERO_REVEAL_WINDOWS: ReadonlyArray<readonly [number, number]> =
  heroRevealWindows(HERO_SLOTS.length);

/** Wheel-step controller stops (routes/_index.tsx). */
export const HERO_SCROLL_STOPS: readonly number[] = heroScrollStops(
  HERO_SLOTS.length,
);

// ─── Invariants (dev import + CI) ────────────────────────────────────────────

function assertChoreography(count: number): void {
  const windows = heroRevealWindows(count);
  const stops = heroScrollStops(count);
  if (windows.length !== count || stops.length !== count + 1) {
    throw new Error(`registry: wrong choreography lengths for count=${count}`);
  }
  if (stops[stops.length - 1] !== 1) {
    throw new Error(`registry: last scroll stop must be 1 (count=${count})`);
  }
  for (let i = 0; i < windows.length; i++) {
    const [open, close] = windows[i];
    if (!(open > 0 && close > open && close <= REVEAL_LAST_END)) {
      throw new Error(
        `registry: reveal window ${i} [${open}, ${close}] out of range (count=${count})`,
      );
    }
    // Stop i+1 rests at-or-after window i's close - the card is fully
    // revealed at its stop.
    if (stops[i + 1] < close) {
      throw new Error(
        `registry: scroll stop ${i + 1} (${stops[i + 1]}) precedes reveal window ${i} close (${close}) (count=${count})`,
      );
    }
    if (stops[i + 1] <= stops[i]) {
      throw new Error(
        `registry: scroll stops not strictly increasing at ${i + 1} (count=${count})`,
      );
    }
    if (i > 0 && windows[i][0] <= windows[i - 1][1]) {
      throw new Error(
        `registry: reveal windows ${i - 1} and ${i} overlap (count=${count})`,
      );
    }
  }
}

/**
 * Every deterministic registry invariant, in one callable place. Runs on
 * import in dev only (see the DEV gate at the top - a violated invariant must
 * never 500 the production worker at boot), and in CI via
 * `npm run check:registry` (scripts/check-registry.mjs), so the asserts
 * actually EXECUTE somewhere on every PR even though lint/tsc/build never
 * evaluate module bodies.
 */
export function assertBuilderRegistry(): void {
  // ── Slot / anchor shape ──
  if (HERO_SLOTS.length !== HERO_SLOT_IDS.length) {
    throw new Error('registry: a HERO_SLOT_IDS entry is missing from SLOTS');
  }
  const anchors = HERO_SLOTS.filter((s) => s.fitAnchor);
  if (anchors.length !== 1) {
    throw new Error(
      `registry: expected exactly one fitAnchor hero slot, got ${anchors.length}`,
    );
  }

  // ── Hero build data: every slot × size resolves to a purchasable part with
  //    a GLB, one product handle per slot, and variant options that agree
  //    with the airframe's Model value (buildHeroStacks matches the
  //    AIRFRAME's value against live variants - a disagreeing part would
  //    silently link the wrong variant). ──
  for (const slot of HERO_SLOTS) {
    const handles = new Set<string>();
    for (const airframe of AIRFRAMES) {
      const part = heroPartFor(slot.id, airframe.size); // throws if missing
      heroModelUrl(slot.id, airframe.size); // throws if no GLB for the size
      if (part.commerce.kind !== 'shopify') {
        throw new Error(
          `registry: hero slot "${slot.id}" part "${part.id}" is not purchasable`,
        );
      }
      handles.add(part.commerce.handle);
      const opt = part.commerce.options?.[HERO_VARIANT_AXIS];
      if (opt && opt !== airframe.shopifyModel) {
        throw new Error(
          `registry: part "${part.id}" selects ${HERO_VARIANT_AXIS}="${opt}" but airframe "${airframe.size}" maps to "${airframe.shopifyModel}"`,
        );
      }
    }
    if (handles.size !== 1) {
      throw new Error(
        `registry: hero slot "${slot.id}" mixes product handles across sizes`,
      );
    }
  }

  // ── Choreography ──
  // 1. Behavior-identical guarantee for the generator refactor: with three
  //    hero slots the generated values MUST equal the previous literals.
  const legacyWindows = JSON.stringify([
    [0.08, 0.3],
    [0.4, 0.62],
    [0.72, 0.94],
  ]);
  const legacyStops = JSON.stringify([0, 0.34, 0.67, 1.0]);
  if (JSON.stringify(heroRevealWindows(3)) !== legacyWindows) {
    throw new Error(
      `registry: generated reveal windows ${JSON.stringify(heroRevealWindows(3))} != legacy ${legacyWindows}`,
    );
  }
  if (JSON.stringify(heroScrollStops(3)) !== legacyStops) {
    throw new Error(
      `registry: generated scroll stops ${JSON.stringify(heroScrollStops(3))} != legacy ${legacyStops}`,
    );
  }
  // 2. Structural invariants - for the live slot count AND the next counts
  //    Phase 1 grows into (rx, battery), so "add a slot" can't reintroduce
  //    overlapping windows or stops that undercut them.
  for (const count of new Set([HERO_SLOTS.length, 1, 2, 3, 4, 5, 6])) {
    assertChoreography(count);
  }
}

if (DEV) assertBuilderRegistry();
