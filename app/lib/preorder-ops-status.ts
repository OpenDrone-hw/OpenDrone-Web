/**
 * The last outcome of each preorder background job in this Worker isolate:
 * the paid-count read, the price step sync and the preorder hold sync.
 *
 * Cloudflare runs the scheduled reconcile, the webhook and a status request
 * in whichever isolate is free, so this is a best-effort trace, never the
 * record: `/api/status/campaign` also checks the live state. Messages are
 * the libraries' own error text, never a token or a request body.
 */

export type OpsJob = 'paidCounts' | 'priceSync' | 'holdSync';

export type OpsRun = {
  at: string;
  ok: boolean;
  /** Short error text when `ok` is false. */
  error?: string;
  /** What the run changed, e.g. SKUs stepped or orders held. */
  detail?: string;
};

export type OpsStatus = Partial<Record<OpsJob, {last: OpsRun; lastOk: string | null; lastError: OpsRun | null}>>;

const state: OpsStatus = {};

function clean(message: string): string {
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

export function recordOps(job: OpsJob, outcome: {error?: unknown; detail?: string} = {}): void {
  const at = new Date().toISOString();
  const previous = state[job];
  const error =
    outcome.error === undefined
      ? undefined
      : clean(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
  const run: OpsRun = {at, ok: error === undefined, ...(error ? {error} : {}), ...(outcome.detail ? {detail: clean(outcome.detail)} : {})};
  state[job] = {
    last: run,
    lastOk: run.ok ? at : previous?.lastOk ?? null,
    lastError: run.ok ? previous?.lastError ?? null : run,
  };
}

export function opsStatus(): OpsStatus {
  return structuredClone(state);
}

/** Test seam. */
export function resetOpsStatus(): void {
  for (const key of Object.keys(state) as OpsJob[]) delete state[key];
}
