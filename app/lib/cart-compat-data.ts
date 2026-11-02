/**
 * Cart compatibility data: every part's fit attributes and every rule the
 * cart's mismatch alert checks, in one file. Edit here; `cart-compat.ts` only
 * runs what this file declares.
 *
 * Attributes come from the product pages (`content/products/*.json`,
 * `content/accessories.json`); where those leave a value out (`null` in the
 * product JSON) it stays out here too, and a rule that needs it is skipped
 * rather than guessed. `revision` is the part's hardware revision once one is
 * published; none is yet, so a rule never reads it.
 *
 * A rule pairs a part (`a`) with every cart part of a partner kind (`b`) and
 * reports only when no partner in the cart fits, so a cart holding two builds
 * is not flagged. `fits` answers `undefined` when it cannot tell.
 *
 * Bundler-free, no imports: the node:test suites load it directly.
 */

export const COMPAT_LOCALES = ['en', 'nl', 'fr'] as const;
export type CompatLocale = (typeof COMPAT_LOCALES)[number];

export type StackMount = '20x20' | '25.5x25.5' | '30.5x30.5';
export type MotorMount = '9x9' | '12x12' | '16x16';
/** Prop class in inches, as the frames and motors state it. */
export type PropSize = 3 | 5;
export type PropShaft = '1.5mm' | '5mm';
export type Band = '2.4GHz' | '868MHz' | '915MHz';
export type BatteryPlug = 'XT30' | 'XT60';
/** The FC to ESC harness: JST-SH 8-pin, VBAT GND CUR TLM/NC M1-M4. */
export type EscHarness = 'jst-sh-8-od';
export type EscProtocol = 'DShot' | 'PWM';
export type RxProtocol = 'CRSF' | 'SBUS';
/** Cell range, min to max, inclusive. */
export type Cells = readonly [number, number];

type Base = {name: string; handle: string; revision?: string};
export type FcPart = Base & {kind: 'fc'; mount: StackMount; cells: Cells; escHarness: EscHarness; motorProtocols: readonly EscProtocol[]; rxProtocols: readonly RxProtocol[]};
export type EscPart = Base & {kind: 'esc'; mount: StackMount; cells: Cells; fcHarness: EscHarness; protocol: EscProtocol; batteryPlug: BatteryPlug};
export type FramePart = Base & {kind: 'frame'; stackMounts: readonly StackMount[]; motorMounts: readonly MotorMount[]; propSize: PropSize};
export type MotorPart = Base & {kind: 'motor'; mount: MotorMount | null; ratedCells: number | null; shaft: PropShaft | null; propSize: PropSize};
export type PropsPart = Base & {kind: 'props'; size: PropSize; shaft: PropShaft};
export type RxPart = Base & {kind: 'rx'; protocol: RxProtocol; bands: readonly Band[]; antennaPlug: 'U.FL' | null};
export type AntennaPart = Base & {kind: 'antenna'; bands: readonly Band[]; plug: 'U.FL'};
/** `maxCells`: the highest pack the capacitor is shipped for on our own ESCs. */
export type CapacitorPart = Base & {kind: 'capacitor'; maxCells: number};
/** No battery is sold yet; the kind is here so one can be added as data. */
export type BatteryPart = Base & {kind: 'battery'; cells: number; plug: BatteryPlug};

export type CompatPart = FcPart | EscPart | FramePart | MotorPart | PropsPart | RxPart | AntennaPart | CapacitorPart | BatteryPart;
export type PartKind = CompatPart['kind'];
export type PartOf<K extends PartKind> = Extract<CompatPart, {kind: K}>;

const ESC_HARNESS: EscHarness = 'jst-sh-8-od';

/** Keyed by SKU. Parts not listed (straps, frame spares) are never checked. */
export const COMPAT_PARTS: Record<string, CompatPart> = {
  'OPENFC-LITE-2020': {kind: 'fc', name: 'OpenFC Lite 20×20', handle: 'openfc-lite', mount: '20x20', cells: [3, 6], escHarness: ESC_HARNESS, motorProtocols: ['DShot'], rxProtocols: ['CRSF', 'SBUS']},
  'OPENFC-LITE-3030': {kind: 'fc', name: 'OpenFC Lite 30×30', handle: 'openfc-lite', mount: '30.5x30.5', cells: [3, 8], escHarness: ESC_HARNESS, motorProtocols: ['DShot'], rxProtocols: ['CRSF', 'SBUS']},
  'OPENESC-2020': {kind: 'esc', name: 'OpenESC 20×20', handle: 'openesc', mount: '20x20', cells: [2, 6], fcHarness: ESC_HARNESS, protocol: 'DShot', batteryPlug: 'XT30'},
  'OPENESC-3030': {kind: 'esc', name: 'OpenESC 30×30', handle: 'openesc', mount: '30.5x30.5', cells: [2, 8], fcHarness: ESC_HARNESS, protocol: 'DShot', batteryPlug: 'XT60'},
  'OPENFRAME-3': {kind: 'frame', name: 'OpenFrame 3"', handle: 'openframe', stackMounts: ['25.5x25.5', '20x20'], motorMounts: ['9x9', '12x12'], propSize: 3},
  'OPENFRAME-5': {kind: 'frame', name: 'OpenFrame 5"', handle: 'openframe', stackMounts: ['30.5x30.5', '20x20'], motorMounts: ['16x16'], propSize: 5},
  'OPENMOTOR-1604': {kind: 'motor', name: 'OpenMotor 1604 6S', handle: 'openmotor', mount: '9x9', ratedCells: 6, shaft: '1.5mm', propSize: 3},
  'OPENMOTOR-1604-4S': {kind: 'motor', name: 'OpenMotor 1604 4S', handle: 'openmotor', mount: '9x9', ratedCells: 4, shaft: '1.5mm', propSize: 3},
  // The 2306's mount is not published yet (null on the product page). Its shaft is 5 mm: it ships with an M5 prop nut.
  'OPENMOTOR-2306': {kind: 'motor', name: 'OpenMotor 2306 6S', handle: 'openmotor', mount: null, ratedCells: 6, shaft: '5mm', propSize: 5},
  'OPENMOTOR-2306-4S': {kind: 'motor', name: 'OpenMotor 2306 4S', handle: 'openmotor', mount: null, ratedCells: 4, shaft: '5mm', propSize: 5},
  'OPENRX-LITE': {kind: 'rx', name: 'OpenRX Lite', handle: 'openrx', protocol: 'CRSF', bands: ['2.4GHz'], antennaPlug: null},
  'OPENRX-LITE-UFL': {kind: 'rx', name: 'OpenRX Lite-UFL', handle: 'openrx', protocol: 'CRSF', bands: ['2.4GHz'], antennaPlug: 'U.FL'},
  'OPENRX-MONO': {kind: 'rx', name: 'OpenRX Mono', handle: 'openrx', protocol: 'CRSF', bands: ['2.4GHz', '868MHz', '915MHz'], antennaPlug: 'U.FL'},
  'OPENRX-GEMINI': {kind: 'rx', name: 'OpenRX Gemini', handle: 'openrx', protocol: 'CRSF', bands: ['2.4GHz', '868MHz', '915MHz'], antennaPlug: 'U.FL'},
  'ACC-ANT-T': {kind: 'antenna', name: '2.4 GHz T antenna', handle: 'elrs-antenna-24', bands: ['2.4GHz'], plug: 'U.FL'},
  'ACC-ANT-DUAL-T': {kind: 'antenna', name: '868/915 MHz + 2.4 GHz T antenna', handle: 'elrs-868-915-mhz-2-4-ghz-u-fl-t-style-antenna', bands: ['2.4GHz', '868MHz', '915MHz'], plug: 'U.FL'},
  // 35 V ships with the 2–6S OpenESC 20×20, 50 V with the 2–8S OpenESC 30×30.
  'ACC-CAP-470UF-35V': {kind: 'capacitor', name: '470 µF 35 V capacitor', handle: 'capacitor-470uf-35v-low-esr', maxCells: 6},
  'ACC-CAP-470UF-50V': {kind: 'capacitor', name: '470 µF 50 V capacitor', handle: 'capacitor-470uf-50v-low-esr', maxCells: 8},
  'ACC-PROP-3-HQ-T3X3X3': {kind: 'props', name: '3" T-mount props (3×3×3)', handle: 'hqprop-t3x3x3-propeller-set-3-inch-t-mount', size: 3, shaft: '1.5mm'},
  'ACC-PROP-3-HQ-T3X2X3-DUR': {kind: 'props', name: '3" T-mount props (3×2×3, durable)', handle: 'hqprop-durable-t3x2x3-propeller-set-3-inch-t-mount', size: 3, shaft: '1.5mm'},
  'ACC-PROP-3-GF-3020': {kind: 'props', name: '3" T-mount props (3020)', handle: 'gemfan-3020-3-propeller-set-3-inch-t-mount', size: 3, shaft: '1.5mm'},
  'ACC-PROP-5-HQ-5X43X3-V2S': {kind: 'props', name: '5" props (5×4.3×3)', handle: 'hqprop-5x4-3x3-v2s-propeller-set-5-inch', size: 5, shaft: '5mm'},
  'ACC-PROP-5-HQ-J37': {kind: 'props', name: '5" props (J37)', handle: 'hqprop-juicy-j37-propeller-set-5-inch', size: 5, shaft: '5mm'},
  'ACC-PROP-5-GF-51466': {kind: 'props', name: '5" props (51466)', handle: 'gemfan-hurricane-51466-v2-propeller-set-5-inch', size: 5, shaft: '5mm'},
};

/** The sub-GHz band a buyer's country uses, by ISO country code. Countries not listed are not checked. */
const EU_EEA = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'CH', 'GB'];
export const SUB_GHZ_BY_COUNTRY: Record<string, Band> = {
  ...Object.fromEntries(EU_EEA.map((c) => [c, '868MHz' as const])),
  US: '915MHz',
  CA: '915MHz',
  AU: '915MHz',
  NZ: '915MHz',
};

// ---- How values read in a message (locale-neutral technical notation) ----

const MOUNT_TEXT: Record<StackMount | MotorMount, string> = {
  '20x20': '20 × 20 mm',
  '25.5x25.5': '25.5 × 25.5 mm',
  '30.5x30.5': '30.5 × 30.5 mm',
  '9x9': '9 × 9 mm',
  '12x12': '12 × 12 mm',
  '16x16': '16 × 16 mm',
};
const BAND_TEXT: Record<Band, string> = {'2.4GHz': '2.4 GHz', '868MHz': '868 MHz', '915MHz': '915 MHz'};
const SHAFT_TEXT: Record<PropShaft, string> = {'1.5mm': '1.5 mm (T-mount)', '5mm': '5 mm'};
const HARNESS_TEXT: Record<EscHarness, string> = {'jst-sh-8-od': 'JST-SH 8-pin'};

const mount = (m: StackMount | MotorMount) => MOUNT_TEXT[m];
const mounts = (ms: readonly (StackMount | MotorMount)[]) => ms.map(mount).join(' / ');
const bands = (bs: readonly Band[]) => bs.map((b) => BAND_TEXT[b]).join(' + ');
const cellRange = (c: Cells) => `${c[0]}–${c[1]}S`;
const cells = (n: number) => `${n}S`;
const within = (c: Cells, n: number) => n >= c[0] && n <= c[1];

// ---- Rules ----

export type Message = {
  /** The conflict. `{a}`/`{b}` are part names, `{aValue}`/`{bValue}` the clashing values. */
  problem: string;
  /** The fix when no single swap is known. A known swap uses `COMPAT_UI.swap`. */
  fix: string;
};

export type CompatRule = {
  id: string;
  a: readonly PartKind[];
  /** Partner kinds; `region` checks `a` against the buyer's country instead of a part. */
  b: readonly PartKind[] | 'region';
  fits: (a: CompatPart, b: CompatPart | Band) => boolean | undefined;
  values: (a: CompatPart, b: CompatPart | Band) => {aValue: string; bValue: string};
  messages: Record<CompatLocale, Message>;
};

/** Narrow a rule's arguments; a kind the rule did not declare reads as "cannot tell". */
function pair<A extends PartKind, B extends PartKind>(
  a: readonly A[],
  b: readonly B[],
  fits: (a: PartOf<A>, b: PartOf<B>) => boolean | undefined,
  values: (a: PartOf<A>, b: PartOf<B>) => {aValue: string; bValue: string},
): Pick<CompatRule, 'a' | 'b' | 'fits' | 'values'> {
  const is = (x: CompatPart | Band, kinds: readonly PartKind[]) => typeof x !== 'string' && kinds.includes(x.kind);
  return {
    a,
    b,
    fits: (x, y) => (is(x, a) && is(y, b) ? fits(x as PartOf<A>, y as PartOf<B>) : undefined),
    values: (x, y) => values(x as PartOf<A>, y as PartOf<B>),
  };
}

/** Cell rating of a partner board or motor, as a range. */
function cellsOf(p: EscPart | FcPart | MotorPart): Cells | null {
  if (p.kind === 'motor') return p.ratedCells == null ? null : [1, p.ratedCells];
  return p.cells;
}
function cellsText(p: EscPart | FcPart | MotorPart): string {
  if (p.kind === 'motor') return p.ratedCells == null ? '' : `${cells(p.ratedCells)} max`;
  return cellRange(p.cells);
}

/** In check order: when two rules hit the same pair of parts, only the first is shown. */
export const COMPAT_RULES: readonly CompatRule[] = [
  {
    id: 'stack-frame',
    ...pair(['fc', 'esc'] as const, ['frame'] as const, (a, b) => b.stackMounts.includes(a.mount), (a, b) => ({aValue: mount(a.mount), bValue: mounts(b.stackMounts)})),
    messages: {
      en: {problem: 'The {a} has a {aValue} mount, but the {b} only takes {bValue} stacks.', fix: 'Choose a frame that takes {aValue}.'},
      nl: {problem: '{a} heeft een montage van {aValue}, maar {b} past alleen stacks van {bValue}.', fix: 'Kies een frame voor {aValue}.'},
      fr: {problem: '{a} se monte en {aValue}, mais {b} n’accepte que des stacks en {bValue}.', fix: 'Choisissez un châssis qui accepte {aValue}.'},
    },
  },
  {
    id: 'stack-pair',
    ...pair(['fc'] as const, ['esc'] as const, (a, b) => a.mount === b.mount, (a, b) => ({aValue: mount(a.mount), bValue: mount(b.mount)})),
    messages: {
      en: {problem: 'The {a} has a {aValue} mount and the {b} a {bValue} mount, so they do not stack.', fix: 'Choose a flight controller and ESC with the same mount.'},
      nl: {problem: '{a} heeft een montage van {aValue} en {b} een van {bValue}, dus ze passen niet op elkaar.', fix: 'Kies een vluchtcontroller en ESC met dezelfde montage.'},
      fr: {problem: '{a} se monte en {aValue} et {b} en {bValue} : ils ne s’empilent pas.', fix: 'Choisissez un contrôleur de vol et un ESC au même entraxe.'},
    },
  },
  {
    id: 'esc-connector',
    ...pair(['esc'] as const, ['fc'] as const, (a, b) => a.fcHarness === b.escHarness, (a, b) => ({aValue: HARNESS_TEXT[a.fcHarness], bValue: HARNESS_TEXT[b.escHarness]})),
    messages: {
      en: {problem: 'The {a} has a {aValue} flight-controller plug, but the {b} expects {bValue}.', fix: 'Choose an ESC and flight controller with the same plug, or make an adapter cable.'},
      nl: {problem: '{a} heeft een {aValue}-stekker naar de vluchtcontroller, maar {b} verwacht {bValue}.', fix: 'Kies een ESC en vluchtcontroller met dezelfde stekker, of maak een verloopkabel.'},
      fr: {problem: '{a} a une prise {aValue} vers le contrôleur de vol, mais {b} attend {bValue}.', fix: 'Choisissez un ESC et un contrôleur de vol avec la même prise, ou faites un câble adaptateur.'},
    },
  },
  {
    id: 'esc-protocol',
    ...pair(['esc'] as const, ['fc'] as const, (a, b) => b.motorProtocols.includes(a.protocol), (a, b) => ({aValue: a.protocol, bValue: b.motorProtocols.join(' / ')})),
    messages: {
      en: {problem: 'The {a} takes {aValue}, but the {b} sends {bValue}.', fix: 'Choose an ESC that takes {bValue}.'},
      nl: {problem: '{a} verwacht {aValue}, maar {b} stuurt {bValue}.', fix: 'Kies een ESC die {bValue} ondersteunt.'},
      fr: {problem: '{a} attend du {aValue}, mais {b} envoie du {bValue}.', fix: 'Choisissez un ESC compatible {bValue}.'},
    },
  },
  {
    id: 'rx-protocol',
    ...pair(['rx'] as const, ['fc'] as const, (a, b) => b.rxProtocols.includes(a.protocol), (a, b) => ({aValue: a.protocol, bValue: b.rxProtocols.join(' / ')})),
    messages: {
      en: {problem: 'The {a} sends {aValue}, but the {b} reads {bValue}.', fix: 'Choose a receiver that sends {bValue}.'},
      nl: {problem: '{a} stuurt {aValue}, maar {b} leest {bValue}.', fix: 'Kies een ontvanger die {bValue} stuurt.'},
      fr: {problem: '{a} envoie du {aValue}, mais {b} lit du {bValue}.', fix: 'Choisissez un récepteur qui envoie du {bValue}.'},
    },
  },
  {
    id: 'battery-cells',
    ...pair(['battery'] as const, ['esc', 'fc', 'motor'] as const, (a, b) => {
      const c = cellsOf(b);
      return c ? within(c, a.cells) : undefined;
    }, (a, b) => ({aValue: cells(a.cells), bValue: cellsText(b)})),
    messages: {
      en: {problem: 'This battery is {aValue}, but the {b} is rated {bValue}.', fix: 'Choose a battery within {bValue}.'},
      nl: {problem: 'Deze batterij is {aValue}, maar {b} is geschikt voor {bValue}.', fix: 'Kies een batterij binnen {bValue}.'},
      fr: {problem: 'Cette batterie est en {aValue}, mais {b} est prévu pour {bValue}.', fix: 'Choisissez une batterie dans la plage {bValue}.'},
    },
  },
  {
    id: 'motor-cells',
    ...pair(['motor'] as const, ['esc', 'fc'] as const, (a, b) => (a.ratedCells == null ? undefined : within(b.cells, a.ratedCells)), (a, b) => ({aValue: cells(a.ratedCells ?? 0), bValue: cellRange(b.cells)})),
    messages: {
      en: {problem: 'The {a} is wound for {aValue}, but the {b} is rated {bValue}.', fix: 'Choose motors and boards rated for the same pack.'},
      nl: {problem: '{a} is gewikkeld voor {aValue}, maar {b} is geschikt voor {bValue}.', fix: 'Kies motoren en borden voor hetzelfde aantal cellen.'},
      fr: {problem: '{a} est bobiné pour du {aValue}, mais {b} est prévu pour {bValue}.', fix: 'Choisissez des moteurs et des cartes pour le même nombre de cellules.'},
    },
  },
  {
    id: 'capacitor-cells',
    ...pair(['capacitor'] as const, ['battery', 'motor'] as const, (a, b) => {
      const n = b.kind === 'battery' ? b.cells : b.ratedCells;
      return n == null ? undefined : n <= a.maxCells;
    }, (a, b) => ({aValue: cells(a.maxCells), bValue: cells((b.kind === 'battery' ? b.cells : b.ratedCells) ?? 0)})),
    messages: {
      en: {problem: 'The {a} is meant for packs up to {aValue}, but the {b} runs on {bValue}.', fix: 'Choose a capacitor rated for {bValue}.'},
      nl: {problem: '{a} is bedoeld voor packs tot {aValue}, maar {b} draait op {bValue}.', fix: 'Kies een condensator voor {bValue}.'},
      fr: {problem: '{a} est prévu pour des packs jusqu’à {aValue}, mais {b} fonctionne en {bValue}.', fix: 'Choisissez un condensateur prévu pour {bValue}.'},
    },
  },
  {
    id: 'battery-plug',
    ...pair(['battery'] as const, ['esc'] as const, (a, b) => a.plug === b.batteryPlug, (a, b) => ({aValue: a.plug, bValue: b.batteryPlug})),
    messages: {
      en: {problem: 'This battery has an {aValue} plug, but the {b} comes with an {bValue} lead.', fix: 'Choose a battery with an {bValue} plug, or fit a matching lead.'},
      nl: {problem: 'Deze batterij heeft een {aValue}-stekker, maar {b} wordt geleverd met een {bValue}-aansluiting.', fix: 'Kies een batterij met een {bValue}-stekker, of soldeer een passende aansluiting.'},
      fr: {problem: 'Cette batterie a une prise {aValue}, mais {b} est livré avec une prise {bValue}.', fix: 'Choisissez une batterie avec une prise {bValue}, ou montez une prise adaptée.'},
    },
  },
  {
    id: 'motor-mount',
    ...pair(['motor'] as const, ['frame'] as const, (a, b) => (a.mount == null ? undefined : b.motorMounts.includes(a.mount)), (a, b) => ({aValue: a.mount ? mount(a.mount) : '', bValue: mounts(b.motorMounts)})),
    messages: {
      en: {problem: 'The {a} has a {aValue} bolt pattern, but the {b} arms take {bValue}.', fix: 'Choose motors with a {bValue} bolt pattern.'},
      nl: {problem: '{a} heeft een gatenpatroon van {aValue}, maar de armen van {b} passen {bValue}.', fix: 'Kies motoren met een gatenpatroon van {bValue}.'},
      fr: {problem: '{a} a un entraxe de {aValue}, mais les bras de {b} acceptent {bValue}.', fix: 'Choisissez des moteurs à l’entraxe {bValue}.'},
    },
  },
  {
    id: 'motor-size',
    ...pair(['motor'] as const, ['frame'] as const, (a, b) => a.propSize === b.propSize, (a, b) => ({aValue: `${a.propSize}"`, bValue: `${b.propSize}"`})),
    messages: {
      en: {problem: 'The {a} is sized for {aValue} props, but the {b} is a {bValue} frame.', fix: 'Choose motors for {bValue} props.'},
      nl: {problem: '{a} is bedoeld voor {aValue}-propellers, maar {b} is een {bValue}-frame.', fix: 'Kies motoren voor {bValue}-propellers.'},
      fr: {problem: '{a} est prévu pour des hélices de {aValue}, mais {b} est un châssis {bValue}.', fix: 'Choisissez des moteurs pour hélices de {bValue}.'},
    },
  },
  {
    id: 'prop-size',
    ...pair(['props'] as const, ['frame'] as const, (a, b) => a.size === b.propSize, (a, b) => ({aValue: `${a.size}"`, bValue: `${b.propSize}"`})),
    messages: {
      en: {problem: 'The {a} are {aValue}, but the {b} is built for {bValue} props.', fix: 'Choose {bValue} props.'},
      nl: {problem: '{a} zijn {aValue}, maar {b} is gebouwd voor {bValue}-propellers.', fix: 'Kies {bValue}-propellers.'},
      fr: {problem: '{a} font {aValue}, mais {b} est conçu pour des hélices de {bValue}.', fix: 'Choisissez des hélices de {bValue}.'},
    },
  },
  {
    id: 'prop-shaft',
    ...pair(['props'] as const, ['motor'] as const, (a, b) => (b.shaft == null ? undefined : a.shaft === b.shaft), (a, b) => ({aValue: SHAFT_TEXT[a.shaft], bValue: b.shaft ? SHAFT_TEXT[b.shaft] : ''})),
    messages: {
      en: {problem: 'The {a} fit a {aValue} shaft, but the {b} has a {bValue} shaft.', fix: 'Choose props for a {bValue} shaft.'},
      nl: {problem: '{a} passen op een as van {aValue}, maar {b} heeft een as van {bValue}.', fix: 'Kies propellers voor een as van {bValue}.'},
      fr: {problem: '{a} se montent sur un axe de {aValue}, mais {b} a un axe de {bValue}.', fix: 'Choisissez des hélices pour un axe de {bValue}.'},
    },
  },
  {
    id: 'antenna-plug',
    ...pair(['antenna'] as const, ['rx'] as const, (a, b) => b.antennaPlug === a.plug, (a) => ({aValue: a.plug, bValue: ''})),
    messages: {
      en: {problem: 'The {a} needs a {aValue} connector, but the {b} has a built-in antenna and no connector.', fix: 'Choose a receiver with a {aValue} connector.'},
      nl: {problem: '{a} heeft een {aValue}-aansluiting nodig, maar {b} heeft een ingebouwde antenne en geen aansluiting.', fix: 'Kies een ontvanger met een {aValue}-aansluiting.'},
      fr: {problem: '{a} demande un connecteur {aValue}, mais {b} a une antenne intégrée et aucun connecteur.', fix: 'Choisissez un récepteur avec un connecteur {aValue}.'},
    },
  },
  {
    id: 'antenna-band',
    ...pair(['antenna'] as const, ['rx'] as const, (a, b) => (b.antennaPlug == null ? undefined : b.bands.every((x) => a.bands.includes(x))), (a, b) => ({aValue: bands(a.bands), bValue: bands(b.bands.filter((x) => !a.bands.includes(x)))})),
    messages: {
      en: {problem: 'The {a} covers {aValue} only, but the {b} also uses {bValue}.', fix: 'Choose an antenna that also covers {bValue}.'},
      nl: {problem: '{a} dekt alleen {aValue}, maar {b} gebruikt ook {bValue}.', fix: 'Kies een antenne die ook {bValue} dekt.'},
      fr: {problem: '{a} ne couvre que {aValue}, mais {b} utilise aussi {bValue}.', fix: 'Choisissez une antenne qui couvre aussi {bValue}.'},
    },
  },
  {
    id: 'rx-region',
    a: ['rx', 'antenna'],
    b: 'region',
    fits: (a, band) => {
      if (typeof band !== 'string' || (a.kind !== 'rx' && a.kind !== 'antenna')) return undefined;
      const subGhz = a.bands.filter((x) => x !== '2.4GHz');
      return subGhz.length ? subGhz.includes(band) : undefined;
    },
    values: (a, band) => ({aValue: a.kind === 'rx' || a.kind === 'antenna' ? bands(a.bands.filter((x) => x !== '2.4GHz')) : '', bValue: typeof band === 'string' ? BAND_TEXT[band] : ''}),
    messages: {
      en: {problem: 'The {a} works on {aValue}, but the sub-GHz band where you ship to is {bValue}.', fix: 'Choose a {bValue} version, or use the 2.4 GHz band.'},
      nl: {problem: '{a} werkt op {aValue}, maar de sub-GHz-band in je leveringsland is {bValue}.', fix: 'Kies een versie voor {bValue}, of gebruik de 2,4 GHz-band.'},
      fr: {problem: '{a} fonctionne en {aValue}, mais la bande sub-GHz du pays de livraison est {bValue}.', fix: 'Choisissez une version {bValue}, ou utilisez la bande 2,4 GHz.'},
    },
  },
];

/** The alert's own words. */
export const COMPAT_UI: Record<CompatLocale, {heading: string; note: string; swap: string; see: string}> = {
  en: {heading: 'Check these parts work together', note: 'This is a heads-up only: you can still check out.', swap: 'Choose the {alt} instead.', see: 'See the {name}'},
  nl: {heading: 'Controleer of deze onderdelen samenwerken', note: 'Dit is alleen een waarschuwing: je kunt gewoon afrekenen.', swap: 'Kies in plaats daarvan {alt}.', see: 'Bekijk {name}'},
  fr: {heading: 'Vérifiez que ces pièces vont ensemble', note: 'Ceci n’est qu’un avertissement : vous pouvez quand même commander.', swap: 'Choisissez plutôt {alt}.', see: 'Voir {name}'},
};
