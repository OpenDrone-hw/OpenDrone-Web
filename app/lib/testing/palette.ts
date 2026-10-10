/**
 * Series colours for the testing workspace, one source for the canvas chart,
 * the static SVG and the download.
 *
 * One hue per quantity. Packs, motors and units of the same quantity differ by
 * shade, dash and marker shape, so the figure still reads in greyscale. Teal
 * is the Incutec identity and is never a series or a status colour. Every
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
    light: ['#1B6E34', '#2A7F45', '#437A56'],
    dark: ['#5FD08A', '#46B876', '#8FDDAC'],
  },
  voltage: {
    light: ['#B3261E', '#C8443C', '#9B4A45'],
    dark: ['#FF8A80', '#F26B60', '#FFB0A8'],
  },
  temperature: {
    light: ['#8A5100', '#A06312', '#7D5A24'],
    dark: ['#F5B84F', '#E0A238', '#FFD08A'],
  },
  rpm: {
    light: ['#1A56B0', '#3A70BF', '#4E6FA0'],
    dark: ['#7DB2FF', '#5E9BF2', '#A8CCFF'],
  },
  command: {
    light: ['#6234B8', '#7A50C6', '#7A64A3'],
    dark: ['#BCA4FF', '#A688F2', '#D3C4FF'],
  },
  aux: {
    light: ['#4A5056', '#5F666C', '#6B7177'],
    dark: ['#B7BDBD', '#9AA0A0', '#CFD3D3'],
  },
  thrust: {
    light: ['#A8196F', '#BF3A8A', '#94467A'],
    dark: ['#FF86C4', '#F264AF', '#FFB0D8'],
  },
};

/** Dash pattern per variant, in CSS px. */
export const DASHES: Array<number[]> = [[], [7, 4], [2, 3]];
export type MarkerShape = 'circle' | 'square' | 'diamond';
export const MARKERS: MarkerShape[] = ['circle', 'square', 'diamond'];

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

/** Domain tag colour (the 3 px bar over a product section and the chip dot). */
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
  return out;
}

export type SeriesStyle = {
  color: string;
  colorCss: string;
  variant: number;
  dash: number[];
  marker: MarkerShape;
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
  series: Array<{id: string; quantity: string; pack?: string; kind: string}>,
  theme: Theme,
): Record<string, SeriesStyle> {
  const seen: Record<string, string[]> = {};
  const out: Record<string, SeriesStyle> = {};
  series.forEach((s, i) => {
    const packs = (seen[s.quantity] ??= []);
    const key = s.pack ?? `#${i}`;
    let variant = packs.indexOf(key);
    if (variant < 0) variant = packs.push(key) - 1;
    const frames = s.kind === 'frames';
    out[s.id] = {
      color: seriesColor(s.quantity, variant, theme),
      colorCss: seriesColorCss(s.quantity, variant),
      variant: variant % 3,
      dash: DASHES[variant % 3]!,
      marker: MARKERS[variant % 3]!,
      width: frames ? 1.25 : 2,
      opacity: frames ? 0.7 : 1,
    };
  });
  return out;
}
