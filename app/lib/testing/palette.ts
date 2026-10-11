/**
 * Series colours for the testing workspace, one source for the canvas chart,
 * the static SVG and the download.
 *
 * Restrained, like the exported reports: the report teal, grey and one
 * teal-green. Packs, motors and units of one figure differ by shade, dash and
 * marker shape, so the figure reads in greyscale. Every
 * colour here is at least 4.5:1 against the surface it is drawn on, in both
 * themes; `palette.test.ts` checks that.
 */

export type Theme = 'light' | 'dark';

/** The card and chart surface (`--color-background-surface`). */
export const SURFACE: Record<Theme, string> = {light: '#FFFFFF', dark: '#131313'};
/** The page canvas behind the cards. */
export const CANVAS: Record<Theme, string> = {light: '#FBFBFA', dark: '#0A0A0A'};
export const INK: Record<Theme, string> = {light: '#14171A', dark: '#F5F5F5'};
export const MUTED: Record<Theme, string> = {light: '#5B6166', dark: '#9AA0A0'};

export const QUANTITIES = [
  'current',
  'voltage',
  'temperature',
  'rpm',
  'command',
  'aux',
  'thrust',
] as const;
export type Quantity = (typeof QUANTITIES)[number];

/** Three shades per quantity, strongest first. */
const SHADES: Record<Quantity, Record<Theme, [string, string, string]>> = {
  current: {
    light: ['#0F4C5C', '#5B6166', '#1E7F74'],
    dark: ['#4DD0C4', '#9AA0A0', '#8FD8CF'],
  },
  voltage: {
    light: ['#0F4C5C', '#5B6166', '#1E7F74'],
    dark: ['#4DD0C4', '#9AA0A0', '#8FD8CF'],
  },
  temperature: {
    light: ['#0F4C5C', '#5B6166', '#1E7F74'],
    dark: ['#4DD0C4', '#9AA0A0', '#8FD8CF'],
  },
  rpm: {
    light: ['#0F4C5C', '#5B6166', '#1E7F74'],
    dark: ['#4DD0C4', '#9AA0A0', '#8FD8CF'],
  },
  command: {
    light: ['#0F4C5C', '#5B6166', '#1E7F74'],
    dark: ['#4DD0C4', '#9AA0A0', '#8FD8CF'],
  },
  aux: {
    light: ['#0F4C5C', '#5B6166', '#1E7F74'],
    dark: ['#4DD0C4', '#9AA0A0', '#8FD8CF'],
  },
  thrust: {
    light: ['#0F4C5C', '#5B6166', '#1E7F74'],
    dark: ['#4DD0C4', '#9AA0A0', '#8FD8CF'],
  },
};

/**
 * Runs, packs and units of one quantity in one figure: when a quantity has more
 * than one of them the figure colours them by identity, the same way on every
 * figure; dash and marker shape carry the difference too, and the legend,
 * markers and end labels name each one. Each is at
 * least 4.5:1 on both surfaces.
 */
export const IDENTITY: Record<Theme, string[]> = {
  light: ['#0F4C5C', '#5B6166', '#1E7F74', '#14171A', '#8A5A00', '#B42318'],
  dark: ['#4DD0C4', '#B7BDBD', '#8FD8CF', '#F5F5F5', '#D9A441', '#F0605D'],
};
const N_ID = 6;

/** Dash pattern per variant, in CSS px. */
export const DASHES: Array<number[]> = [[], [7, 4], [2, 3], [9, 3, 2, 3], [4, 3], [1, 3]];
export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle';
/** One marker shape for every series: runs are told apart by colour, dash and a hollow or filled marker, not by shape. */
export const MARKERS: MarkerShape[] = ['circle', 'circle', 'circle', 'circle', 'circle', 'circle'];
/** The emphasised series of a figure with several runs, and the grey of the rest. */
export const EMPHASIS: Record<Theme, {primary: string; rest: string}> = {
  light: {primary: '#0F4C5C', rest: '#5B6166'},
  dark: {primary: '#4DD0C4', rest: '#B7BDBD'},
};

/** The one chart spec: line weight and hold-marker size in css px, shared by canvas, SVG and download. */
export const LINE_PX = 1.25;
export const HOLD_LINE_PX = 1.25;

export function isQuantity(q: string): q is Quantity {
  return (QUANTITIES as readonly string[]).includes(q);
}

export function seriesColor(quantity: string, variant: number, theme: Theme): string {
  const q: Quantity = isQuantity(quantity) ? quantity : 'aux';
  return SHADES[q][theme][variant % 3]!;
}

/** The same colour for both themes, as one CSS value that follows `color-scheme`. */
export function seriesColorCss(quantity: string, variant: number): string {
  return `light-dark(${seriesColor(quantity, variant, 'light')}, ${seriesColor(quantity, variant, 'dark')})`;
}

/** Quantity colour of a figure's domain, for the small dot beside a figure's run line. */
export const DOMAIN_QUANTITY: Record<string, Quantity> = {
  THR: 'thrust',
  PWR: 'current',
  THM: 'temperature',
  RF: 'rpm',
};
export function domainColor(domain: string, theme: Theme): string {
  return seriesColor(DOMAIN_QUANTITY[domain] ?? 'aux', 0, theme);
}
export function domainColorCss(domain: string): string {
  return seriesColorCss(DOMAIN_QUANTITY[domain] ?? 'aux', 0);
}

export function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every colour the figures can draw, for the contrast check. */
export function allSeriesColors(): Array<{quantity: Quantity; variant: number; theme: Theme; color: string}> {
  const out: Array<{quantity: Quantity; variant: number; theme: Theme; color: string}> = [];
  for (const quantity of QUANTITIES) {
    for (const theme of ['light', 'dark'] as Theme[]) {
      for (let variant = 0; variant < 3; variant++) {
        out.push({quantity, variant, theme, color: seriesColor(quantity, variant, theme)});
      }
    }
  }
  for (const theme of ['light', 'dark'] as Theme[]) {
    IDENTITY[theme].forEach((color, variant) => out.push({quantity: 'aux', variant, theme, color}));
  }
  return out;
}

export type SeriesStyle = {
  color: string;
  colorCss: string;
  variant: number;
  dash: number[];
  marker: MarkerShape;
  /** Drawn as an open circle: the earliest of the grey runs. */
  hollow: boolean;
  /** Line width in px. Dense frames are thinner and dimmer than traces. */
  width: number;
  opacity: number;
};

/**
 * One style per series. The variant is the order of the pack within its
 * quantity (first seen first), so a trace and the hold markers of the same
 * pack share colour and dash.
 */
export function assignStyles(
  series: Array<{id: string; quantity: string; pack?: string; kind: string; axis?: string; primary?: boolean}>,
  theme: Theme,
): Record<string, SeriesStyle> {
  const seen: Record<string, string[]> = {};
  const variants: number[] = [];
  series.forEach((s, i) => {
    const packs = (seen[s.quantity] ??= []);
    const key = s.pack ?? `#${i}`;
    let variant = packs.indexOf(key);
    if (variant < 0) variant = packs.push(key) - 1;
    variants.push(variant);
  });
  // A two-axis figure names its two quantities by identity colour, blue and
  // orange, so the axis titles and the lines match on every card.
  const dual = series.some((s) => s.axis === 'y2');
  const order: string[] = [];
  const out: Record<string, SeriesStyle> = {};
  // One run is emphasised in dark teal and the others are grey; the earliest grey run is dashed with open markers.
  const emphasised = !dual && series.some((s) => s.primary);
  const rest: string[] = [];
  if (emphasised) for (const s of series) if (!s.primary && !rest.includes(`${s.quantity}/${s.pack ?? s.id}`)) rest.push(`${s.quantity}/${s.pack ?? s.id}`);
  series.forEach((s, i) => {
    const frames = s.kind === 'frames';
    let variant = variants[i]!;
    let identity = (seen[s.quantity]?.length ?? 0) > 1;
    if (dual) {
      const key = `${s.quantity}/${s.pack ?? ''}/${s.axis ?? ''}`;
      if (!order.includes(key)) order.push(key);
      variant = order.indexOf(key);
      identity = true;
    }
    const v = variant % N_ID;
    if (emphasised) {
      const grey = rest.indexOf(`${s.quantity}/${s.pack ?? s.id}`);
      const first = s.primary ? false : grey % 2 === 0;
      const hex = EMPHASIS[theme][s.primary ? 'primary' : 'rest'];
      out[s.id] = {
        color: hex,
        colorCss: `light-dark(${EMPHASIS.light[s.primary ? 'primary' : 'rest']}, ${EMPHASIS.dark[s.primary ? 'primary' : 'rest']})`,
        variant: s.primary ? 0 : 1 + (grey % 2),
        dash: first ? [5, 3] : [],
        marker: 'circle',
        hollow: first,
        width: frames ? 1 : s.kind === 'hold' ? HOLD_LINE_PX : LINE_PX,
        opacity: frames ? (theme === 'dark' ? 0.7 : 0.6) : 1,
      };
      return;
    }
    const color = identity ? IDENTITY[theme][v]! : seriesColor(s.quantity, variant, theme);
    out[s.id] = {
      color,
      colorCss: identity
        ? `light-dark(${IDENTITY.light[v]}, ${IDENTITY.dark[v]})`
        : seriesColorCss(s.quantity, variant),
      variant: v,
      dash: dual ? [] : DASHES[v]!,
      marker: MARKERS[v]!,
      hollow: false,
      width: frames ? 1 : s.kind === 'hold' ? HOLD_LINE_PX : LINE_PX,
      // Raw frames are quiet but seen: the dot stays at 3:1 or more on both surfaces.
      opacity: frames ? (theme === 'dark' ? 0.7 : 0.6) : 1,
    };
  });
  return out;
}
