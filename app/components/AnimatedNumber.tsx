import {useEffect, useRef, useState} from 'react';
import {useInView, useReducedMotion} from 'motion/react';

/**
 * Count-up for spec strings: every numeric run in the value sweeps 0 → final
 * the first time it scrolls into view, non-numeric text stays put. Handles
 * mixed values ("20×20 mm", "3–6S", "3,3 V") - each number animates, decimal
 * places and comma-vs-dot separators are preserved. Values with no digits
 * render as-is.
 *
 * This is the site's React Bits "Count Up" equivalent - reuse it, don't copy
 * another one in.
 *
 * Runs once per mount; later value changes (variant spec deltas) swap the
 * text without re-counting - a settled table shouldn't spin on every click.
 * The server renders the final value, so SEO/no-JS never see zeros. Pair
 * with `tabular-nums` on the container (spec-table already has it) so digits
 * don't wobble mid-count. Hand-rolled RAF, so reduced-motion is checked here
 * rather than relying on the global MotionConfig.
 */
type Seg = {text: string; num?: number; decimals?: number; comma?: boolean};

/** Part of an identifier token (part numbers, licence tags, BF targets). */
const IDENT = /[A-Za-z_-]/;

/**
 * True when a digit run is part of an identifier rather than a free-standing
 * quantity - sweeping it would display fake-but-plausible part numbers
 * ("AT32F398…") mid-count. Static cases:
 * - letter/underscore/ASCII-hyphen immediately before (AT32…, RP2354, M33,
 *   CERN-OHL-S-2.0, OPENFC_LITE_…). En-dash ranges ("3–6S") are not hyphens
 *   and still sweep.
 * - a letter after that continues into a longer token ("8U7") - a single
 *   trailing unit letter that ends the token ("6S", "5V") still sweeps.
 * - an extra dot/comma joining a further digit run - multi-part version
 *   strings ("3.5.0") beyond the one decimal separator the regex consumes.
 */
function isIdentifierRun(value: string, at: number, raw: string): boolean {
  const before = value[at - 1] ?? '';
  const after = value[at + raw.length] ?? '';
  const after2 = value[at + raw.length + 1] ?? '';
  if (IDENT.test(before)) return true;
  if (IDENT.test(after) && /[A-Za-z0-9_-]/.test(after2)) return true;
  if ((after === '.' || after === ',') && /\d/.test(after2)) return true;
  if ((before === '.' || before === ',') && /\d/.test(value[at - 2] ?? '')) {
    return true;
  }
  return false;
}

function parse(value: string): Seg[] {
  const segs: Seg[] = [];
  const re = /\d+(?:[.,]\d+)?/g;
  let last = 0;
  for (const m of value.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) segs.push({text: value.slice(last, at)});
    const raw = m[0];
    if (isIdentifierRun(value, at, raw)) {
      segs.push({text: raw});
    } else {
      const comma = raw.includes(',');
      const norm = raw.replace(',', '.');
      const dot = norm.indexOf('.');
      segs.push({
        text: raw,
        num: parseFloat(norm),
        decimals: dot === -1 ? 0 : norm.length - dot - 1,
        comma,
      });
    }
    last = at + raw.length;
  }
  if (last < value.length) segs.push({text: value.slice(last)});
  return segs;
}

function formatSeg(n: number, seg: Seg): string {
  let out = n.toFixed(seg.decimals ?? 0);
  if (seg.comma) out = out.replace('.', ',');
  // Odometer-pad to the final string's width so zero-padded figures ("04")
  // keep their leading zero mid-sweep and the column width never wobbles.
  if (out.length < seg.text.length) out = out.padStart(seg.text.length, '0');
  return out;
}

export function AnimatedNumber({
  value,
  className,
  duration = 800,
}: {
  value: string;
  className?: string;
  /** Count duration in ms. */
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();
  const inView = useInView(ref, {once: true, margin: '0px 0px -8% 0px'});
  const [display, setDisplay] = useState(value);
  const played = useRef(false);

  // Variant switches merge new spec deltas over the table - swap the text
  // silently instead of re-counting. Unconditional: under reduced motion the
  // count effect never runs (and never sets `played`), so gating this on
  // `played` would freeze the visible value at its mount text across variant
  // switches. `played` only exists to stop the count effect re-counting.
  useEffect(() => {
    setDisplay(value);
  }, [value]);

  useEffect(() => {
    if (!inView || reduceMotion || played.current) return;
    played.current = true;
    const segs = parse(value);
    if (!segs.some((s) => s.num !== undefined)) return;
    let raf = 0;
    let start: number | null = null;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);
    const frame = (now: number) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        setDisplay(value);
        return;
      }
      const p = easeOut(t);
      setDisplay(
        segs
          .map((s) => (s.num === undefined ? s.text : formatSeg(s.num * p, s)))
          .join(''),
      );
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [inView, reduceMotion, value, duration]);

  return (
    <span ref={ref} className={className}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true">{display}</span>
    </span>
  );
}
