/**
 * Editorial content per catalog product handle. Sourced from the real
 * product repos in iCloud (4in1ESC, 4in1ESC-30x30, OpenFC, OpenRX) -
 * NOT from the Shopify description field. Shopify owns price and
 * availability, the catalog policy owns the ship promise; this file owns
 * the story, and the two merge by handle.
 *
 * The data itself lives in `content/products/<handle>.json` and is loaded
 * below by `import.meta.glob({eager: true})`, the same way `app/lib/copy.ts`
 * loads `content/copy/*.json`. That is what makes it editable in the studio:
 * the Oxygen worker has no filesystem so the files have to be bundled rather
 * than read, and Vite tracks the glob as a real dependency, so saving a file
 * invalidates this module and hot-reloads the page. This file keeps the types
 * and the lifecycle helpers; it no longer keeps the words.
 *
 * When you add a new product: drop a `content/products/<handle>.json` named
 * after the catalog handle. Missing file = product renders with
 * `_fallback.json`.
 */

// Relative import on purpose: the node:test suites run this module without
// Vite, so the `~` alias is not available here.
import {
  isConceptHandle,
  isConceptStatus,
  statusForHandle,
  type ProductStatus as RoadmapStatus,
} from './roadmap-data.ts';
import type {CatalogAvailability} from './product-shapes.ts';

export type ChapterPin = {
  ref: string;
  part: string;
  cost?: string;
  /** Refdes (case-sensitive, e.g. "U2", "Card1") this pin points at on the
   *  board. Hovering/focusing the pin highlights these footprints in BoardArt,
   *  matched against `/boards/<handle>/components.json`. */
  refs?: string[];
  /** How to draw the highlight box(es). 'each' (default) outlines every refdes;
   *  'union' draws ONE box around the whole group - use for dense arrays like the
   *  bulk ceramic-cap grid where individual boxes look like noise. */
  box?: 'each' | 'union';
  /** Draw one union box PER subarray (e.g. ESC motor pads grouped by motor → 4
   *  boxes of 3 phases). `refs` stays the flat union for matching + spotlight. */
  boxGroups?: string[][];
  /** Render this pin as a single row of horizontal I/O "chips" instead of plain
   *  text - each chip highlights its own refs on hover (e.g. the FC's UART / I2C
   *  / LED / CAM / VTX / BUZZER solder-pad groups in one row). `refs` should be
   *  the union of all chips so side-grouping + connector lines still work. */
  chips?: Array<{label: string; refs: string[]}>;
};

/**
 * Physical item that ships in the box. `qty` is free text so entries
 * can read "1×" or "kit" or "set". Keep items factual - only list
 * things that genuinely ship. No speculative filler.
 */
export type BoxItem = {
  qty?: string;
  item: string;
  note?: string;
  /** Site path the note links to, e.g. the spare-parts page. */
  href?: string;
};

/**
 * The beginner chapter ("What does this do?"), rendered first on the PDP.
 * Written for someone who has never built a drone: what the part IS, what
 * else a first build needs before it flies, and where it sits in the whole
 * machine. A professional scrolls past without losing anything. Absent =
 * the chapter does not render (accessories, bundles until written).
 * Keep the copy tier-neutral on lines whose tiers share one file.
 */
export type WhatIsThis = {
  /** ~100 words of plain language: what this part is and does. */
  intro: string;
  /** "Before this flies you also need": one line per missing piece.
   *  Not rendered on the PDP (2026-08-12): reserved for the planned
   *  general FPV intro page. */
  needs: string[];
  /** One line: where the part sits in the drone's signal chain. Kept as
   *  data for the studio; the chapter now SHOWS the position via `chain`. */
  fit: string;
  /** Which signal-chain stage this product IS; the chapter's chain strip
   *  lights it. Stages: radio, rx, fc, esc, motors, frame. */
  chain?: 'radio' | 'rx' | 'fc' | 'esc' | 'motors' | 'frame';
  /** Optional hero-length line for the homepage walkthrough caption. When
   *  absent, the caption derives from `intro` (heroCaption below), so the
   *  hero and the PDP's What-does-this-do chapter cannot drift apart. */
  hero?: string;
};

/**
 * One plain line per spec row name, for buyers new to FPV: what the row
 * means, never a claim about a product. The PDP shows it behind a "?"
 * button next to the row name. Rows without an entry get no button.
 */
export const SPEC_HELP: Readonly<Record<string, string>> = {
  Mounting: 'Spacing of the mounting holes. A flight controller, ESC and frame stack together when they share it: 20 × 20 with 20 × 20, 30.5 × 30.5 with 30.5 × 30.5.',
  'Stack mounting': 'Hole patterns in the middle of the frame for the flight controller and ESC stack.',
  'Motor mounting': 'Bolt pattern at each arm tip. The base of your motors must match it.',
  'Frame fit': 'Frames this board bolts into: any frame with the same stack mounting holes. OpenDrone frames are named as examples.',
  Frame: 'The OpenDrone frame this motor is sized for.',
  Input: 'Battery voltage it accepts. "S" is the number of LiPo cells in series; one full cell is 4.2 V.',
  UARTs: 'Serial ports for add-ons such as the receiver, a GPS or a digital video system. More ports, more add-ons.',
  Firmware: 'The software that runs on it. Open source, and you can update it yourself.',
  MCU: 'The main processor chip.',
  IMU: 'The motion sensor: a gyroscope and accelerometer that tell the flight controller how the drone moves.',
  Barometer: 'Air-pressure sensor used for altitude hold.',
  Blackbox: 'Flight data logger, used to tune the drone and find problems.',
  OSD: 'On-screen display: flight data such as battery voltage drawn over your video feed.',
  'Motor outputs': 'Signal outputs to the ESC, one per motor.',
  RX: 'How a separate receiver connects.',
  BEC: 'On-board power supply for the camera, video transmitter and receiver.',
  'Current sense': 'Measures battery current, so you can see how much of the pack you have used.',
  Continuous: 'Current each motor channel carries without a break. Bigger motors and props draw more.',
  'ESC protocol': 'How the flight controller sends throttle to the ESC. Bidirectional DShot also reports motor speed back.',
  Telemetry: 'Data the ESC sends back to the flight controller, such as motor speed.',
  'FC connector': 'The plug that links the ESC to the flight controller.',
  MOSFETs: 'The power switches that drive each motor.',
  Band: 'Radio frequency of the control link. Your radio needs a transmitter on the same band.',
  Radio: 'The radio chip.',
  Antenna: 'Ceramic is built onto the board. U.FL is a socket for an external antenna, which usually gives more range.',
  'Telemetry power': 'Power the receiver uses to send data back to your radio.',
  Protocol: 'How the receiver talks to the flight controller.',
  Flashing: 'How you update the firmware.',
  Dimensions: 'Outside size of the board.',
  'Prop size': 'Propeller diameter in inches. It sets the class of the drone: a 3-inch or a 5-inch.',
  Wheelbase: 'Diagonal distance between two opposite motor centres.',
  'Max stack height': 'Tallest flight controller and ESC stack that fits between the plates.',
  'Camera width': 'Widest FPV camera the mounts take.',
  'Video systems': 'FPV camera systems the frame has mounts for.',
  Stator: 'Motor size as stator width × height in mm: a 1604 is 16 mm wide and 4 mm tall.',
  KV: 'Motor speed per volt with no load. Lower KV turns bigger props or runs on more cells.',
  'Sold as': 'What one price buys. A quadcopter needs four motors.',
};

/** The help line for a spec row name, if there is one. */
export function specHelp(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(SPEC_HELP, key) ? SPEC_HELP[key] : undefined;
}

/**
 * The homepage hero caption for a product: `whatIsThis.hero` when set,
 * otherwise the intro's first two sentences (first one only when two run
 * past 200 characters, hero copy is a caption, not a chapter). One
 * derivation, used by the homepage loader, so the hero explainers are the
 * What-does-this-do words by construction (maintainer, 2026-08-15).
 */
/** DOM id of the "What does this do?" chapter on a product page; the
 *  homepage walkthrough links each part straight to it. */
export const WHAT_IS_THIS_ID = 'what-is-this';

/** `/products/<handle>#what-is-this`, when the product has that chapter. */
export function whatIsThisHref(handle: string): string | undefined {
  return PRODUCT_CONTENT[handle]?.whatIsThis
    ? `/products/${handle}#${WHAT_IS_THIS_ID}`
    : undefined;
}

export function heroCaption(handle: string): string | undefined {
  const wit = PRODUCT_CONTENT[handle]?.whatIsThis;
  if (!wit) return undefined;
  if (wit.hero) return wit.hero;
  // A sentence ends at . ! or ? followed by whitespace or the end of the
  // text, so a decimal point ("2.4 GHz") stays inside its sentence.
  const sentences = wit.intro.match(/(?:[^.!?]|[.!?](?!\s|$))+[.!?]+(?=\s|$)\s*/g);
  if (!sentences?.length) return wit.intro || undefined;
  const two = sentences.slice(0, 2).join('').trim();
  return two.length > 200 ? sentences[0].trim() : two;
}

/**
 * Downloadable asset rendered in the Downloads chapter. `kind` picks
 * the icon/label family; `href` can point anywhere - usually a file
 * in the product's GitHub repo (raw or releases), occasionally a
 * standalone CDN URL for heavy CAD.
 */
export type DownloadKind =
  | 'schematic'
  | 'step'
  | 'bom'
  | 'gerber'
  | 'manual'
  | 'wiring'
  | 'flash'
  | 'changelog'
  | 'sbom'
  /** EU Declaration of Conformity (GPSR/CE). Each SKU gets one `doc`
   *  download entry once CE conformity assessment closes - no files exist
   *  yet, the kind is reserved so the slot is first-class in the type. */
  | 'doc'
  | 'firmware_manifest'
  | 'other';

export type DownloadAsset = {
  kind: DownloadKind;
  label: string;
  href: string;
  note?: string;
  size?: string;
};

/**
 * "Complete the stack" cross-sell rendered inside the buy module. The
 * buyer clicks the offer and both SKUs go to the shop on one hand-off
 * link. Any discount is a Shopify discount applied at checkout, and it
 * discounts ONE board of the pair, never the whole pair, so copy must name
 * the discounted board. `discountPct` and `discountedHandle` are unset
 * today: nothing may advertise a percent Shopify will not apply.
 * `partners` is a list on purpose: one entry today renders as a fixed
 * line, several (e.g. a future OpenFC Pro next to OpenFC Lite) render
 * as a picker.
 */
export type StackConfig = {
  /** What the partner adds, for copy: 'flight controller', 'ESC'. */
  adds: string;
  /** Candidate partner products, by catalog handle. */
  partners: Array<{handle: string; label?: string}>;
  /** Option name matched between the two products' variants so the sizes
   *  pair up (20×20 FC with 20×20 ESC). Defaults to 'Model'. */
  matchOption?: string;
  /** Advertised discount percent. Display only: the real discount is the
   *  one configured in Shopify. Unset today. */
  discountPct?: number;
  /** Handle of the board the BXGY actually discounts (its "get Y" side).
   *  The pct is off THIS board only, not the pair. Surfaces use it to word
   *  the badge and to derive the discounted price they display. */
  discountedHandle?: string;
};

/**
 * Playful cross-sell card rendered under the buy strip. Use it to point
 * one product at another - e.g. OpenFC ↔ OpenESC both pointing at
 * OpenStack. Keep line copy short: it's a wink, not a paragraph.
 */
export type PairCta = {
  eyebrow: string;     // small uppercase line above (e.g. "PAIR WITH")
  title: string;       // main line (e.g. "OpenStack - FC + ESC, one solder-free stack")
  to: string;          // href to the paired product PDP
};

/**
 * A component of a bundle product (OpenStack et al). Each entry points
 * at an existing PDP and names the firmware that the component carries,
 * so the bundle PDP can render a "what's in the box" chapter without
 * duplicating editorial copy.
 */
export type BundleComponent = {
  title: string;
  handle: string;              // /products/<handle>
  firmware: string;            // "Betaflight", "AM32", etc.
  firmwareUrl?: string;
  blurb: string;               // one-liner used in the bundle card
};

/**
 * One tier in a product line. OpenRX (Lite/Lite-UFL/Mono/Gemini) and
 * OpenESC (20×20/30×30) are lines, not single products: the buyer picks
 * one tier on a comparison ladder that doubles as the variant selector.
 *
 * Editorial here is the source of truth for *which tiers exist and how
 * they differ*. The PDP cross-references the catalog product's option
 * values (matched by `optionAxis` name + the key of this map) to wire
 * each card to a real, purchasable variant - price, stock, add-to-cart.
 * Until those catalog variants exist the ladder still renders for preview
 * and the cart falls back to the single default variant.
 */
export type VariantContent = {
  /** Display name on the ladder card. Defaults to the variant key (which is
   *  what the catalog matches against); set this when the shown name should differ
   *  from the matched key (e.g. key "20×20" shown as "20×20 (mini)"). */
  label?: string;
  /** Per-tier GitHub repo, when a line splits its boards across separate repos
   *  (OpenFC-Lite vs OpenFC-Lite-Mini, OpenESC-20x20 vs OpenESC-30x30, or the
   *  four OpenRX boards). The PDP
   *  points the repo card, issues link and latest-commit card at this when the
   *  tier is selected; tiers without their own repo fall back to the product's
   *  `repoUrl`. */
  repoUrl?: string;
  /** The cells that differ between tiers, rendered as ONE dotted line under
   *  the tier name on every ladder card. Keep it to two short values: the
   *  line has to hold a single row in the hero column's 2-up grid, and the
   *  full matrix lives in the Datasheet chapter. */
  highlights: Array<[string, string]>;
  /** Extra catalog search words for this tier only ("mini" for 20x20). */
  keywords?: string[];
  /** Per-tier spec deltas merged over the shared `specs` by row key: a
   *  value replaces the base row, `null` hides it (a cost-down tier dropping
   *  a sensor), and an unknown key appends. See `mergeSpecs` in the PDP. */
  specs?: Array<[string, string | null]>;
  /** Box lines specific to this tier, appended to the shared inTheBox. */
  inTheBox?: BoxItem[];
  /** Per-tier layered board SVG (same shape as `teardown.boardArt`). When the
   *  ladder selects this tier the teardown swaps to this art; tiers without
   *  their own art fall back to `teardown.boardArt`. Generated by
   *  `scripts/export-board-art.mjs <kicad_pcb> <handle>` - one handle per
   *  physical PCB (see scripts/boards.config.json). */
  boardArt?: {
    src: string;
    /** KiCanvas deep-link to the board (`…/blob/<branch>/…/<board>.kicad_pcb`).
     *  Must point at a single `.kicad_pcb`/`.kicad_sch` file - KiCanvas's
     *  `?github=` param does NOT resolve a repo root, a directory, or a
     *  `.kicad_pro`. Drives the teardown "Inspect interactively" link. */
    inspectUrl?: string;
    /** KiCanvas deep-link to the root `.kicad_sch` - drives the schematic
     *  chapter's "Open schematic" link. Same single-file rule as `inspectUrl`. */
    schematicUrl?: string;
    layers?: Record<string, string>;
  };
  /** Per-tier teardown component list. Each board in a line has its own
   *  refdes layout, so the pin list + hover-highlight must follow the tier the
   *  same way `boardArt` does. When set, these override `teardown.pins` for the
   *  selected tier; tiers without their own pins fall back to `teardown.pins`.
   *  Keep the `refs` keyed to the tier's `/boards/<handle>/components.json`. */
  pins?: ChapterPin[];
  /** Per-tier exploded 3D model (same shape as `teardown.frameViewer`). The
   *  CAD analogue of `boardArt` for frames: the 3" and 5" tiers each carry
   *  their own GLB so the teardown viewer explodes the selected model. Tiers
   *  without their own model fall back to `teardown.frameViewer`. */
  frameViewer?: {src: string; inspectUrl?: string};
  /** When true the tier renders as a greyed, non-selectable "Coming soon"
   *  card: a designed model that is not yet a purchasable catalog variant.
   *  It shows on the ladder for line completeness but can't be added to cart. */
  comingSoon?: boolean;
  /** OSHWA open-source-hardware certification UID for this specific tier (each
   *  certified board has its own UID, e.g. "BE000026"). The PDP renders a
   *  certification chip linking to `certification.oshwa.org/<uid>.html` for the
   *  selected tier; falls back to the product-level `oshwaUid` when unset. */
  oshwaUid?: string;
  /** True when the Shopify SKU (and option value) names a spec that is not
   *  final, as OPENMOTOR-2207 does: the PDP then keeps the SKU off the page
   *  and out of the structured data. The SKU stays the internal ID. */
  internalSku?: boolean;
  /** One plain line shown under this variant's cart line: what is not final
   *  about it and what the buyer can do (OpenMotor 5": stator and KV). */
  cartNote?: string;
  /** One plain line on the model card saying who this version is for
   *  ("Also receives 900 MHz. Only useful if..."). Published facts only. */
  pickIf?: string;
  /**
   * A short tag on the version card for someone who does not know which to
   * pick, e.g. "Start here if unsure" or "Used in the 5-inch build". Plain
   * words that match content/builds.json, no specs.
   */
  tag?: string;
  /** Other spellings of this option value a link may carry (the visible
   *  label `5"`, `5in`). The PDP redirects them to the catalog value. */
  aliases?: string[];
  /** Per-tier connector and pin-order rows, appended to the product's
   *  `connectors`. Taken from the board repo's design notes. */
  connectors?: Array<[string, string]>;
  /** One short line over the gallery when this tier shows another tier's
   *  image, e.g. "Render of the 5-inch frame". */
  imageNote?: string;
};

/** A plain link printed under the hero lead or the model picker. */
export type ContentLink = {label: string; href: string};

export type ProductContent = {
  fileNumber: string;           // "01" etc - shown in the eyebrow
  family: string;               // Category shown next to file number
  hero: {
    line1: string;
    line2Italic: string;        // middle line rendered in gold italic
    line3: string;
    lead: string;               // subhead paragraph in mono
  };
  firmware: {
    project: string;            // "AM32" / "Betaflight" / "ExpressLRS" / null
    projectUrl?: string;
    /** Optional project wordmark shown in the firmware chapter media slot
     *  (public path, e.g. `/logos/betaflight.svg`). Falls back to the
     *  geometric placeholder glyph when unset. */
    logo?: string;
    /** Set when the wordmark is white-on-transparent (e.g. AM32) so it gets
     *  rendered on a fixed dark tile that reads in both light and dark themes,
     *  instead of the transparent slot a multi-colour mark uses. */
    logoDark?: boolean;
  };
  repoUrl: string;
  /** Who developed this product, in the order the contributor wall lists them,
   *  by GitHub login. The first is the maintainer and their tile says so.
   *  Authored, not derived: commit counts credit whoever churned the most
   *  files, which on OpenRX put the docs ahead of the boards. Logins not in
   *  the roster are ignored; contributors not listed here follow, so a new
   *  name still appears without an edit. Unset means the API's own order. */
  credits?: string[];
  /** A "build video" for the product - the JustFPV teardown films. When set, the
   *  "Open for learning" chapter swaps its second card from the GitHub-issues
   *  bubble to a Watch card (real YouTube thumbnail + in-page lightbox player).
   *  Only products that actually have a film carry this; the rest fall back to
   *  the issues card. `title`/`channel` come from the video's oEmbed metadata. */
  video?: {id: string; title: string; channel?: string};
  teardown?: {
    pins: ChapterPin[];
    /** Optional layered SVG of the board, generated by
     *  `scripts/export-board-art.mjs <kicad_pcb> <handle>`. The component
     *  fetches `/boards/<handle>/board.svg`, inlines it, and reveals
     *  layers on scroll. Set `inspectUrl` to link out to KiCanvas's
     *  hosted viewer for users who want pan/zoom. */
    /** `layers` maps a copper-layer slug (`f`, `in1`…`in4`, `b`) to a short
     *  function blurb shown beside its name in the layer rail (e.g. "Ground
     *  plane", "Signal · 5V"). Optional - {@link BoardArt} falls back to a
     *  position-based guess (outer = signal+components, second = ground plane,
     *  middle = signal+power) when a slug is unset. */
    boardArt?: {
      src: string;
      /** KiCanvas deep-link to the `.kicad_pcb` (single file only - a repo
       *  root, directory, or `.kicad_pro` will NOT load). Teardown layers link. */
      inspectUrl?: string;
      /** KiCanvas deep-link to the root `.kicad_sch` (single file only).
       *  Schematic chapter link. */
      schematicUrl?: string;
      layers?: Record<string, string>;
    };
    /** Optional exploded 3D model - the CAD analogue of `boardArt`, for
     *  products that are an OnShape assembly rather than a KiCad board
     *  (the frame, later motors). `src` is a public GLB whose nodes follow
     *  the top/base/arm naming the {@link FrameViewer} explodes by; set
     *  `inspectUrl` to the public OnShape document. When present the
     *  teardown renders FrameViewer instead of BoardArt. */
    frameViewer?: {src: string; inspectUrl?: string};
  };
  /** Beginner orientation chapter. See {@link WhatIsThis}. */
  whatIsThis?: WhatIsThis;
  inTheBox: BoxItem[];          // physical items shipped
  /** Schematic PDFs, STEP files, manuals, etc. Each SKU also carries its
   *  EU Declaration of Conformity here (kind: 'doc') once CE closes -
   *  don't add DoC entries before the signed PDF exists. */
  downloads: DownloadAsset[];
  /** Spec rows in display order. A row renders only when it is set, so a
   *  value that is not on file stays off the page. Use these row names for
   *  the common FPV rows once a measured or supplier value exists:
   *  "Weight", "Mount", "Shaft", "Rated cells", "Max current". */
  specs: Array<[string, string]>;
  footnote?: string;            // appears under the spec table
  /** Spec row names shown in the "At a glance" box beside the buy module,
   *  in order. Each must be a row of the merged (variant) spec table; a
   *  name the selected variant lacks is skipped, so nothing is invented. */
  glance?: string[];
  /** Extra words the catalog search matches for this product, the terms FPV
   *  buyers type that the name does not carry ("stack", "4in1"). */
  keywords?: string[];
  /** When set, the PDP renders a comparison-ladder selector. `optionAxis`
   *  is the catalog option NAME that carries the line's variants
   *  (standardised to "Model"); `variants` is keyed by the option VALUE. See
   *  {@link VariantContent}. */
  optionAxis?: string;
  variants?: Record<string, VariantContent>;
  /** OSHWA certification UID for a single-board product (no per-tier split).
   *  Lines whose tiers each carry their own UID set it on the variant instead. */
  oshwaUid?: string;
  pairCta?: PairCta;            // playful cross-sell under the buy strip
  stack?: StackConfig;          // "complete the stack" cross-sell in the buy box
  bundle?: {                    // when set, the PDP renders as a bundle
    components: BundleComponent[];
  };
  /** Per-product coming-soon override. Unset = follow the global
   *  PUBLIC_COMING_SOON flag. `false` unlocks this SKU for sale while the
   *  global flag is still on; `true` keeps teasing it after the flag drops.
   *  Superseded by `status`; kept while existing callers migrate. */
  comingSoon?: boolean;
  /** Lifecycle status. 'idea': a published concept with no hardware yet -
   *  not purchasable, the PDP invites people to help design it.
   *  'development': designed, launch pending - notify-at-launch signup
   *  (the classic coming-soon UX). 'preorder': purchasable at full price
   *  ahead of stock; the order ships when the batch lands (the buy module
   *  shows the ship promise and the whole order is held until every line
   *  is on hand).
   *  Rendered as 'development' while the global PUBLIC_COMING_SOON flag
   *  is on. 'live': purchasable; the catalog's availability decides in
   *  stock vs sold out. Unset = the catalog's availability when the shop
   *  carries the product, else the global PUBLIC_COMING_SOON flag
   *  ('development' while set, 'live' once cleared), or the legacy
   *  `comingSoon` boolean when present. */
  status?: ProductStatus;
  /** `false` marks a resold product (motors, other OEM parts) that has a
   *  content file for its status and copy but is NOT open hardware: no
   *  CERN-OHL-S claim, no "Open for learning" or contributors chapter.
   *  Unset = editorial (every OpenDrone board). */
  editorial?: boolean;
  /** One line shown next to the status on the PDP buy module: "Restock
   *  expected late August", "First prototypes at the mill". Free text,
   *  keep it current fact only. */
  statusNote?: string;
  /** What one unit of the price buys, printed after the price on the PDP
   *  and the cards: "per motor" for a product sold singly that buyers
   *  expect in sets of four. Unset prints nothing. */
  priceUnit?: string;
  /** The product images are CAD renders, not photos: cards and the
   *  gallery set them on the paper tone of the board photos and label them
   *  "Render". */
  imagesAreRenders?: boolean;
  /** Units one build uses, when the product is sold singly (4 motors per
   *  quad). The PDP starts the quantity there and the cart says so when a
   *  line is not a whole set. */
  setOf?: number;
  /** One line under the hero lead, with optional links (the RX's DJI note). */
  heroNote?: {text: string; links?: ContentLink[]};
  /** One plain line under the model picker for a buyer unsure which
   *  version to take. Facts already on the page only. */
  pickNote?: string;
  /** Extra "At a glance" rows that are not spec rows (spare arms). */
  glanceExtra?: Array<{label: string; value: string; href?: string}>;
  /** Connector and pin-order rows shown under the spec table, from the
   *  board repo's design notes. Not part of the README-mirrored `specs`. */
  connectors?: Array<[string, string]>;
  /** One line under `connectors`. */
  connectorsNote?: string;
};

/*
 * Provenance and open items.
 *
 * These notes used to sit as comments next to the values they describe. JSON
 * carries no comments, so they live here. Verify a note against the design
 * files before trusting it, and update it when you edit `content/products/`.
 *
 * All products
 * - `specs` is a buyer-facing summary, deliberately not a BOM: no part
 *   numbers, no build targets. The teardown viewer and the repo carry those.
 * - The shared `specs` list holds the default tier's value for every row a
 *   tier later replaces, purely so the merged table keeps this row order. The
 *   active tier's value always wins.
 * - Pin `refs` are case-sensitive refdes keyed to the
 *   `/boards/<handle>/components.json` of the board that tier renders.
 *
 * openesc
 * - Base `teardown.pins` are the 20x20 board; the 30x30 tier overrides them,
 *   keyed to /boards/openesc-30x30/components.json.
 * - Motor pads draw one union box per motor: 3 phases, 2 pads each.
 * - Battery pads are the two big PTH lugs. CSA+ is the post-shunt B+
 *   terminal, GND_1 the B- terminal, +BATT the raw pre-shunt rail tap. The
 *   four corner mounting holes are NOT battery pads (an old, wrong highlight).
 * - Signal pads: CURR is the current-sense output, M1-M4 per-motor telemetry,
 *   GND_2 the small signal-row ground. Not the +BATT rail, not the CSA+ lug.
 * - 30x30 MOSFETs sit 10 on the front and 14 on the back. All 24 are listed;
 *   the viewer shows each side's subset on its own face.
 * - The 30x30 hides `Dimensions` (null) until a verified outline value is
 *   available from its repo.
 * - Specs come from the OpenESC repos (KiCad files + production BOMs). Field
 *   order follows FPV retail convention: firmware,
 *   current, input, protocol, silicon, sensing, connector, physical. Weight
 *   rows land once boards are weighed.
 * - The stack BXGY discounts the ESC itself when the FC joins the cart.
 * - Launching with 20x20 and 30x30. Pro (higher-current) variants land later
 *   as further values on the same "Model" axis.
 * - Download cards stay omitted until their corresponding release artifacts
 *   exist. KiCanvas and the GitHub link remain the current design sources.
 *
 * openfc-lite
 * - The shipping cost-down flight controller: one design, two mount sizes
 *   sharing nearly the whole BOM. The catalog product (handle
 *   `openfc-lite`, Model "20x20"/"30x30") is the one that sells; the old
 *   `openfc` is a concept page only.
 * - `boardArt` is supplied per variant, so the layer reveal follows the ladder.
 * - Buck pins use one enlarged box per region, IC plus inductor plus in/out
 *   caps, so it reads as the whole buck rather than just the chip.
 * - The 20x20 (Mini) is its own repo and its own refdes layout: RP2354A
 *   QFN-60, no op-amp in the OSD front end.
 * - Specs come from the OpenFC-Lite / OpenFC-Lite-Mini repos (KiCad files and
 *   production BOMs). The shipping IMU is BMI270. The LGA-14 footprint also takes the LSM6DSV16X the
 *   rev2 build used, which is why the KiCad value, and so the teardown
 *   viewer, still reads LSM6DSV16X on the 30x30.
 * - The stack BXGY discounts the added ESC, not this FC and not the pair.
 * - Download cards stay omitted until their corresponding repository release
 *   artifacts exist.
 *
 * openrx
 * - Base `teardown.pins` match the Lite tier; every variant overrides them.
 *   The Wi-Fi antenna and the ELRS link antenna are SEPARATE: AE1 is on the
 *   /WIFI net to the ESP32-C3, the link path is AE2 or U.FL.
 * - Downloads point only at artifacts the repository currently publishes.
 * - Specs come from the four OpenRX board repos (KiCad boards, release BOMs
 *   and firmware target JSON): bands rather than radio part
 *   numbers, no flash targets.
 *
 * openframe
 * - Frame content is a planned-product fallback. It does not claim a public
 *   CAD source, measured weight, or material grade.
 * - `repoUrl` is empty while OpenFrame-5F and OpenFrame-3F are private
 *   repositories: an empty repoUrl drops the Open Source chip, the licence
 *   card and the contributor wall on the PDP. Set it the day a repo is
 *   public.
 *
 * openmotor
 * - Not open hardware (`editorial: false`). Specs come only from the
 *   sourcing records (`sourcing/comparisons/openmotor.md` and the T-Motor
 *   sales contract YB-2026070103): the 1604 is ordered at KV2850. The stator
 *   rows restate the size in the model name. The 5-inch motor sells under
 *   the legacy SKU OPENMOTOR-2207 (option value "2207", shown as 5"), but
 *   no 2207 is chosen: the ordered 5-inch sample is a 2306.5 at KV1950. Its
 *   stator and KV read "To be confirmed" until the founder confirms them.
 *   Weight, shaft, mount pattern and cell count are not on file and stay
 *   off the page until they are.
 * - `teardown.frameViewer` is the fallback when a tier defines none. Both
 *   tiers override it and it seeds the viewer's preload set, so it points at
 *   a current model (the 5") rather than the stale generic frame.glb.
 * - Teardown and variant copy is intentionally limited to the known 5 mm-arm
 *   and 30.5 x 30.5 mm-pattern facts. `inspectUrl` and download links remain
 *   omitted until a public source and real artifacts exist.
 */

/** Minimal structural view of the two `node:fs` calls the disk fallback uses. */
type NodeFs = {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: 'utf8'): string;
};

/** One loaded `content/products/*.json`, as the glob hands it over. */
type ProductFile = {default: ProductContent};

/** `_fallback.json` holds {@link PRODUCT_CONTENT_FALLBACK}, not a product. */
const FALLBACK_HANDLE = '_fallback';

// Path of the content directory relative to this module, assembled rather
// than written as a literal: Vite rewrites `new URL('<literal>',
// import.meta.url)` into an asset reference, which is not what we want here.
const CONTENT_DIR = ['..', '..', 'content', 'products', ''].join('/');

/**
 * Bundler-free fallback so the node:test suites can import this module: they
 * run the TypeScript directly, with no Vite and so no `import.meta.glob`.
 * `node:fs` is reached through `process.getBuiltinModule` instead of an import
 * statement so that no bundler ever sees a Node builtin in the module graph.
 * In the worker build this branch is dead, because `import.meta.env` is always
 * truthy there, and both paths read the same files, so both see the same data.
 */
function readProductsFromDisk(): Record<string, ProductFile> {
  const fs = (
    globalThis as unknown as {
      process?: {getBuiltinModule?: (id: string) => NodeFs};
    }
  ).process?.getBuiltinModule?.('node:fs');
  if (!fs) return {};
  const dir = new URL(CONTENT_DIR, import.meta.url);
  const files: Record<string, ProductFile> = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    files[`/content/products/${name}`] = {
      // ts-reset types JSON.parse as unknown; the shape is asserted by
      // app/lib/product-content.test.ts, which is what this branch exists for.
      default: JSON.parse(
        fs.readFileSync(new URL(name, dir), 'utf8'),
      ) as ProductContent,
    };
  }
  return files;
}

// Absolute-from-repo-root glob. `content/` sits outside `app/`, so the `~`
// alias cannot reach it; Vite resolves a leading slash against the project
// root. Guarded on `import.meta.env` exactly as `app/lib/copy.ts` is.
const FILES: Record<string, ProductFile> = import.meta.env
  ? import.meta.glob<ProductFile>('/content/products/*.json', {eager: true})
  : readProductsFromDisk();

/** `/content/products/openesc.json` -> `openesc` */
function handleOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1, -'.json'.length);
}

const LOADED: Array<[string, ProductContent]> = [];
let loadedFallback: ProductContent | undefined;
for (const [filePath, mod] of Object.entries(FILES)) {
  const handle = handleOf(filePath);
  if (handle === FALLBACK_HANDLE) {
    loadedFallback = mod.default;
  } else if (handle) {
    LOADED.push([handle, mod.default]);
  }
}

/**
 * Ordered by `fileNumber`, the number the PDP prints in its eyebrow and the
 * order the line-up reads in. Glob keys come back alphabetical by path, which
 * would put OpenFrame (04) ahead of OpenRX (03); products without a number
 * sort last. Handle breaks ties so the order never depends on the filesystem.
 */
LOADED.sort(([handleA, a], [handleB, b]) => {
  if (a.fileNumber !== b.fileNumber) return a.fileNumber < b.fileNumber ? -1 : 1;
  if (handleA !== handleB) return handleA < handleB ? -1 : 1;
  return 0;
});

export const PRODUCT_CONTENT: Record<string, ProductContent> =
  Object.fromEntries(LOADED);

/**
 * The name a buyer sees for one variant (option value) of a product: the
 * variant's content `label` when set, else the value itself. The Shopify
 * option value stays the key for links and the cart; only the shown text
 * changes. OpenMotor's value "2207" is shown as 5" because no 2207 is
 * chosen.
 */
export function variantDisplayName(handle: string | null | undefined, value: string): string {
  if (!handle) return value;
  return PRODUCT_CONTENT[handle]?.variants?.[value]?.label ?? value;
}

/** A cart line's name as the buyer reads it: the product title plus the
 *  variant's display name, never a raw legacy option value ("2207"). */
export function lineDisplayName(handle: string | null | undefined, title: string, variantTitle: string | null | undefined): string {
  return variantTitle && variantTitle !== 'Default Title'
    ? `${title} ${variantDisplayName(handle, variantTitle)}`
    : title;
}

/** The cart-line note for one variant, if its content sets one. See
 *  {@link VariantContent.cartNote}. */
/** Units one build uses for a product sold singly (4 motors), or null. */
export function setSize(handle: string | null | undefined): number | null {
  if (!handle) return null;
  const n = PRODUCT_CONTENT[handle]?.setOf;
  return n && n > 1 ? n : null;
}

/**
 * The catalog option value a link means, when it carries an alias
 * (`?Model=5"` for the value `2207`). Case, spaces and inch marks are
 * ignored. Null when the value is already canonical or unknown.
 */
export function canonicalOptionValue(
  handle: string | null | undefined,
  value: string | null | undefined,
): string | null {
  if (!handle || !value) return null;
  const variants = PRODUCT_CONTENT[handle]?.variants;
  if (!variants || value in variants) return null;
  const norm = (v: string) => v.toLowerCase().replace(/["”″\s-]|inch|in$/g, '');
  const wanted = norm(value);
  for (const [key, v] of Object.entries(variants)) {
    if (norm(key) === wanted) return key;
    if (v.aliases?.some((a) => norm(a) === wanted)) return key;
  }
  return null;
}

export function variantCartNote(handle: string | null | undefined, value: string | null | undefined): string | null {
  if (!handle || !value) return null;
  return PRODUCT_CONTENT[handle]?.variants?.[value]?.cartNote ?? null;
}

/**
 * A spec value as the page shows it. The spec arrays mirror the board
 * READMEs (npm run sync:specs), so plain-words clarifications are added
 * here at render time instead of in the mirrored data:
 * - a current-sense range ("On-board, 165 A") says it is a measuring range,
 *   so it does not read as a burst rating;
 * - a mounting row names the screw size of the soft-mount grommets in the
 *   box ("20 × 20 mm, 3.0 mm holes, M2 with included grommets").
 */
export function displaySpecValue(
  key: string,
  value: string,
  box: readonly BoxItem[] = [],
): string {
  if (key === 'Current sense' && /\d+\s*A\b/.test(value)) {
    return `${value.replace(/(\d+\s*A)\b/, 'reads up to $1')} (measuring range, not a current rating)`;
  }
  if (key === 'Mounting') {
    const grommet = box.find((b) => /grommet/i.test(b.item));
    const screw = grommet ? /\b(M\d)\b/.exec(grommet.item)?.[1] : undefined;
    if (screw && !value.includes(screw)) return `${value}, ${screw} with included grommets`;
  }
  return value;
}

/**
 * A ship promise as one short line for a cart row or a dialog row. A
 * funding-target promise ("ships about 10 weeks after its target is
 * reached: by 11 March 2027 if the target is reached by 31 December 2026,
 * otherwise ...") becomes a label plus "ships by 11 March 2027 if reached";
 * a dated promise ("ships late October 2026") keeps its words. The full
 * condition is stated once elsewhere, see {@link fundingTargetTerms}.
 */
export type ShortShipPromise = {kind: 'target' | 'date'; label: string | null; text: string};

const TARGET_PROMISE = /by (\d{1,2} [A-Z][a-z]+ \d{4}) if the target is reached by (\d{1,2} [A-Z][a-z]+ \d{4})/;

export function shortShipPromise(promise: string | null | undefined): ShortShipPromise | null {
  const text = promise?.trim();
  if (!text) return null;
  const target = TARGET_PROMISE.exec(text);
  if (target) return {kind: 'target', label: 'Funding target', text: `ships by ${target[1]} if reached`};
  if (/after its target/i.test(text)) return {kind: 'target', label: 'Funding target', text: 'ships after its target is reached'};
  return {kind: 'date', label: null, text: text.charAt(0).toUpperCase() + text.slice(1)};
}

/**
 * The full funding-target condition, stated once per surface (cart summary,
 * added-to-cart dialog) instead of on every line. Null when the promise is
 * not a funding-target promise with both dates in it.
 */
export function fundingTargetTerms(promise: string | null | undefined): string | null {
  const target = promise ? TARGET_PROMISE.exec(promise) : null;
  if (!target) return null;
  const weeks = /about (\d+) weeks/.exec(promise ?? '')?.[1];
  const after = weeks ? `about ${weeks} weeks after their target is reached` : 'after their target is reached';
  return `Funding-target items ship ${after}: by ${target[1]} if it is reached by ${target[2]}. If a target is missed, you choose a refund for that item or to keep waiting.`;
}

/** Whether a variant's SKU stays off customer-facing pages. See
 *  {@link VariantContent.internalSku}. */
export function isInternalSku(handle: string | null | undefined, value: string | null | undefined): boolean {
  if (!handle || !value) return false;
  return PRODUCT_CONTENT[handle]?.variants?.[value]?.internalSku === true;
}

/** Product lifecycle. See {@link ProductContent.status}. */
export type ProductStatus = 'idea' | 'development' | 'preorder' | 'live';

/**
 * Whether a status puts a price and an add-to-cart on the page. 'live'
 * ships from stock; 'preorder' takes the order now and ships later. Every
 * "can this be bought" decision goes through here, never `=== 'live'`.
 */
export function isPurchasableStatus(status: ProductStatus): boolean {
  return status === 'live' || status === 'preorder';
}

/**
 * Whether the content file declares a status that sells ('preorder' or
 * 'live'). Such a product is a product page, not a concept, whatever its
 * roadmap word says: the frame is 'in-progress' on the roadmap while it
 * takes pre-orders. The roadmap word stays on the chip as display
 * vocabulary; only the concept gate (plate, listings, feeds) is lifted.
 */
export function hasExplicitPurchasableStatus(
  handle: string | null | undefined,
): boolean {
  const s = handle ? PRODUCT_CONTENT[handle]?.status : undefined;
  return s !== undefined && isPurchasableStatus(s);
}

/**
 * A resold part with no editorial file (antenna, strap, spare parts) stays
 * out of the catalog grid and the Related strip while none of its variants
 * can be bought: a launched store does not lead with sold-out placeholders.
 * Editorial products stay listed when sold out, with their badge.
 */
export function hiddenWhileSoldOut(p: {
  handle: string;
  variants: {nodes: Array<{availableForSale: boolean}>};
}): boolean {
  return !PRODUCT_CONTENT[p.handle] && !p.variants.nodes.some((v) => v.availableForSale);
}

/**
 * The concept gate for a handle with a resolved roadmap word (client
 * surfaces, which hold the root loader's live map): planned / in-progress
 * hides the product from listings and shows the plate, unless the content
 * file declares a purchasable status. See {@link hasExplicitPurchasableStatus}.
 */
export function isConceptFor(
  handle: string | null | undefined,
  roadmapWord: RoadmapStatus | null | undefined,
): boolean {
  return isConceptStatus(roadmapWord) && !hasExplicitPurchasableStatus(handle);
}

/**
 * The same gate for server loaders that carry the fetched topic flags
 * (feeds), resolving the roadmap word itself.
 */
export function isConceptProduct(
  handle: string,
  flags: Record<string, RoadmapStatus> = {},
): boolean {
  return isConceptHandle(handle, flags) && !hasExplicitPurchasableStatus(handle);
}

/**
 * Whether ANY content file declares a pre-order product. Guards the
 * pre-order stamping in the cart action so a shop without pre-orders pays
 * nothing for the feature.
 */
export function anyPreorderProducts(): boolean {
  return Object.values(PRODUCT_CONTENT).some((c) => c.status === 'preorder');
}

/**
 * The roadmap's five-stage vocabulary collapsed to the page tri-state:
 * launched and beta sell, alpha and in-progress present a locked page,
 * planned presents the concept plate. Undefined for handles that are not
 * on the roadmap (accessories).
 */
export function roadmapTriState(
  handle: string,
  flags: Record<string, RoadmapStatus> = {},
): ProductStatus | undefined {
  const s = statusForHandle(handle, flags);
  if (!s) return undefined;
  if (s === 'launched' || s === 'beta') return 'live';
  if (s === 'planned') return 'idea';
  return 'development';
}

/**
 * Resolve a product's lifecycle status.
 *
 * Precedence: an explicit per-product `status` in content JSON (the manual
 * kill-switch) > the legacy `comingSoon` boolean > the ROADMAP status (the
 * `status-*` GitHub topic over the static list - pass `flags` from
 * fetchStatusFlags* where the caller can) > the global flag.
 *
 * The roadmap status is the truth in BOTH directions: status-beta means
 * the price is on the page and the board can be ordered (the catalog's
 * availability permitting), whatever PUBLIC_COMING_SOON says; status-alpha means the
 * waitlist, even on an open shop. The topics are admin-only on the repos,
 * so "flip to beta" is a deliberate release act by a maintainer, and the
 * global flag remains only the default for products with no roadmap entry
 * (accessories) plus the per-product JSON kill-switch above it.
 *
 * The one exception to "explicit status wins": 'preorder' only opens once
 * the shop itself is open (global flag off). Until then it renders as
 * 'development', so a pre-order status can sit in the content files
 * before launch day without taking orders on the production site.
 *
 * `availability` is the catalog's word for the product: the SKU's sale
 * policy, denied by Shopify's availableForSale. The catalog decides which
 * products are orderable, so it sits above the roadmap topic and the
 * global default. It does NOT outrank the two switches above it: a local
 * 'idea' or 'development' status is the storefront saying the product is
 * not for sale at all, and PUBLIC_COMING_SOON is the kill switch, so a
 * product the catalog calls in stock before launch day still renders as
 * coming soon.
 */
export function resolveStatus(
  handle: string | null | undefined,
  globalFlag: boolean,
  flags: Record<string, RoadmapStatus> = {},
  availability?: CatalogAvailability,
): ProductStatus {
  const content = handle ? PRODUCT_CONTENT[handle] : undefined;
  if (content?.status === 'idea' || content?.status === 'development') {
    return content.status;
  }
  if (content?.status === 'live') return 'live';
  if (availability) {
    if (globalFlag) return 'development';
    return availability === 'preorder' ? 'preorder' : 'live';
  }
  if (content?.status === 'preorder') {
    return globalFlag ? 'development' : 'preorder';
  }
  if (content?.status) return content.status;
  if (content?.comingSoon !== undefined) {
    return content.comingSoon ? 'development' : 'live';
  }
  const fromRoadmap = handle ? roadmapTriState(handle, flags) : undefined;
  if (fromRoadmap) return fromRoadmap;
  return globalFlag ? 'development' : 'live';
}

/**
 * Whether a product renders as not-yet-purchasable (no prices, no
 * add-to-cart). True for both 'idea' and 'development'; the buy module
 * differentiates the two via {@link resolveStatus}. 'preorder' is
 * purchasable, so it is NOT coming soon.
 */
export function isComingSoon(
  handle: string | null | undefined,
  globalFlag: boolean,
  flags: Record<string, RoadmapStatus> = {},
  availability?: CatalogAvailability,
): boolean {
  return !isPurchasableStatus(
    resolveStatus(handle, globalFlag, flags, availability),
  );
}

/**
 * Fallback when a handle has no editorial content yet. Edited as
 * `content/products/_fallback.json`; the literal below is only reached if that
 * file is deleted, and is deliberately blank rather than a second copy of it.
 */
export const PRODUCT_CONTENT_FALLBACK: ProductContent = loadedFallback ?? {
  fileNumber: '',
  family: '',
  hero: {line1: '', line2Italic: '', line3: '', lead: ''},
  firmware: {project: ''},
  repoUrl: '',
  inTheBox: [],
  downloads: [],
  specs: [],
};

/** Whether a product's images are CAD renders rather than photos. */
export function imagesAreRenders(handle: string | null | undefined): boolean {
  return Boolean(handle && PRODUCT_CONTENT[handle]?.imagesAreRenders);
}
