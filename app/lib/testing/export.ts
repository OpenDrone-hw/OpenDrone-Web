import {fmtValue} from './scale.ts';
import type {Fig, RunInfo} from './types.ts';

const cell = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return '';
  const t = String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * The plotted numbers of one figure as CSV: one row per point, with the 25th
 * and 75th percentile of a hold where there is one. Comment lines name the
 * figure, the run and the setup, so the file stands on its own.
 */
export function figureCsv(fig: Fig, run?: RunInfo): string {
  const lines = [`# ${fig.title}`, `# Incutec testing, run ${fig.runId}${run?.date ? `, ${run.date}` : ''}`];
  for (const s of run?.setup ?? []) lines.push(`# ${s}`);
  if (fig.reduction) lines.push(`# ${fig.reduction}`);
  const xh = `${fig.axes.x.label} (${fig.axes.x.unit})`;
  lines.push(['series', 'kind', xh, `${fig.axes.y.label} (${fig.axes.y.unit})`, 'y_q25', 'y_q75'].map(cell).join(','));
  for (const s of fig.series) {
    for (let i = 0; i < s.x.length; i++) {
      lines.push([s.label, s.kind, s.x[i], s.y[i], s.lo?.[i], s.hi?.[i]].map(cell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Rows for the on-page table; null when the figure is a long trace. */
export function tableRows(fig: Fig): Array<{series: string; x: string; y: string; band: string}> | null {
  const live = fig.series.filter((s) => s.kind !== 'frames');
  if (live.reduce((n, s) => n + s.x.length, 0) > 40) return null;
  return live.flatMap((s) =>
    s.x.map((x, i) => ({
      series: s.label,
      x: x === null ? '' : fmtValue(x),
      y: s.y[i] === null || s.y[i] === undefined ? '' : fmtValue(s.y[i]!),
      band: s.lo?.[i] != null && s.hi?.[i] != null ? `${fmtValue(s.lo[i]!)} to ${fmtValue(s.hi[i]!)}` : '',
    })),
  );
}
