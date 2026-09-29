import {fccConditionalSku} from './us-sales.ts';
import {promiseBatchMonth} from './preorder-campaign.ts';

/**
 * The one refund notice a US cart carries, once in the summary instead of on
 * every line. The short form names the batch when every line ships from the
 * same one; an FCC-gated line, a line without a batch month or a mix of
 * batches takes the general form. FCC-gated lines also keep their own FCC
 * paragraph.
 */
export function usCartNotice(
  lines: Array<{sku?: string | null; shipPromise?: string | null}>,
): {kind: 'general'} | {kind: 'batch'; batch: string} {
  if (lines.some((line) => fccConditionalSku(line.sku))) return {kind: 'general'};
  const months = new Set(lines.map((line) => promiseBatchMonth(line.shipPromise)));
  const [only] = months;
  return months.size === 1 && only ? {kind: 'batch', batch: only} : {kind: 'general'};
}
