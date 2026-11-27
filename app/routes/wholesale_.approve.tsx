import type {ReactNode} from 'react';
import {data, Form, useActionData, useLoaderData, useNavigation, type ShouldRevalidateFunction} from 'react-router';
import type {Route} from './+types/wholesale_.approve';
import {sameOrigin} from '~/lib/accounts/config';
import {verifyApproval, type ApprovalPayload} from '~/lib/wholesale-approve-token';
import {approveApplication, approveWritesEnabled, planOnboarding, type ApproveResult, type OnboardPlan} from '~/lib/wholesale-approve';
import {adminClient, wholesaleConfigured} from '~/lib/wholesale-sync';

/**
 * Staff page behind the signed link in a wholesale application mail
 * (docs/wholesale.md "Onboard one retailer"). GET verifies the link and shows
 * the dry run; it never writes, since mail scanners open links. Only the
 * Approve POST (same origin, the same signed token in the body) writes.
 */
const NO_STORE = {'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow'};

export const headers: Route.HeadersFunction = () => NO_STORE;
export const meta: Route.MetaFunction = () => [
  {title: 'Wholesale approval | OpenDrone'},
  {name: 'robots', content: 'noindex, nofollow'},
  // The token is in the URL: never send it on as a referrer (the server sets a site-wide Referrer-Policy).
  {name: 'referrer', content: 'no-referrer'},
];

function denied(status: number): never {
  throw new Response(null, {status, headers: NO_STORE});
}

// After Approve the outcome is the page: a dry run re-read on top of it would
// call VIES again within a second (it refuses with MS_MAX_CONCURRENT_REQ) and
// show a stale refusal under "Approved".
export const shouldRevalidate: ShouldRevalidateFunction = ({formMethod, defaultShouldRevalidate}) =>
  formMethod === 'POST' ? false : defaultShouldRevalidate;

function application(p: ApprovalPayload) {
  return {email: p.email, country: p.country, vat: p.vat, company: p.company, contact: p.contact};
}

type Loaded = {token: string; payload: ApprovalPayload; plan: OnboardPlan | null; problem: string | null; writes: boolean};

export async function loader({request, context}: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get('t');
  const check = await verifyApproval(context.env.WHOLESALE_APPROVE_SECRET, token);
  if (!check.ok) denied(check.status);
  const env = context.env;
  const base = {token: token!, payload: check.payload, writes: approveWritesEnabled(env)};
  if (!wholesaleConfigured(env)) return data<Loaded>({...base, plan: null, problem: 'The Shopify Admin API is not configured.'}, {headers: NO_STORE});
  try {
    const plan = await planOnboarding(adminClient(env, fetch), application(check.payload), {fetcher: fetch, now: new Date()});
    return data<Loaded>({...base, plan, problem: null}, {headers: NO_STORE});
  } catch (error) {
    console.warn('[wholesale] approval plan failed', error instanceof Error ? error.message.slice(0, 200) : 'error');
    return data<Loaded>({...base, plan: null, problem: 'Shopify could not be read. Try again, or onboard by hand.'}, {headers: NO_STORE});
  }
}

type Acted = {result: ApproveResult | null; problem: string | null};

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST' || !sameOrigin(request)) denied(403);
  const urlToken = new URL(request.url).searchParams.get('t');
  const form = await request.formData();
  const token = form.get('t');
  if (typeof token !== 'string' || !urlToken || token !== urlToken) denied(403);
  const check = await verifyApproval(context.env.WHOLESALE_APPROVE_SECRET, token as string);
  if (!check.ok) denied(check.status);
  if (!wholesaleConfigured(context.env)) return data<Acted>({result: null, problem: 'The Shopify Admin API is not configured.'}, {headers: NO_STORE});
  try {
    const result = await approveApplication(context.env, application(check.payload));
    return data<Acted>({result, problem: null}, {headers: NO_STORE});
  } catch (error) {
    console.warn('[wholesale] approval failed', error instanceof Error ? error.message.slice(0, 200) : 'error');
    return data<Acted>({result: null, problem: `Stopped on a Shopify error: ${error instanceof Error ? error.message.slice(0, 200) : 'error'}. Approving again is safe: existing codes are kept.`}, {headers: NO_STORE});
  }
}

const cell = 'border-t border-[var(--color-border)] py-2 pr-4 align-top text-[13px]';
const head = `${cell} w-40 text-[var(--color-text-muted)]`;

function Row({k, children}: {k: string; children: ReactNode}) {
  return <tr><th scope="row" className={`${head} text-left font-normal`}>{k}</th><td className={cell}>{children}</td></tr>;
}

function viesText(plan: OnboardPlan): string {
  const v = plan.vies;
  if (!v) return 'no VAT number given';
  if (v.kind === 'error') return v.error;
  if (v.kind === 'skipped') return v.skipped;
  return `${v.queried}: ${v.valid ? 'valid' : 'not valid'}${v.userError && v.userError !== 'VALID' ? ` (${v.userError})` : ''}${v.name && v.name !== '---' ? `, ${v.name}` : ''}`;
}

function PlanView({plan}: {plan: OnboardPlan}) {
  const input = plan.customerInput as {tags?: string[]; taxExemptions?: string[]; note?: string} | null;
  return (
    <>
      <table className="mt-6 w-full border-collapse">
        <tbody>
          <Row k="VIES">{viesText(plan)}</Row>
          <Row k="Tax exemption">{plan.exempt ? 'SET EU_REVERSE_CHARGE_EXEMPTION_RULE' : 'NOT set'} ({plan.why})</Row>
          <Row k="Customer">{plan.customer ? `found ${plan.customer.id} (tags ${plan.customer.tags.join(', ') || 'none'})` : 'will be created'}</Row>
          {input ? <Row k="Tags">{(input.tags ?? []).join(', ')}</Row> : null}
          {input?.note !== undefined ? <Row k="Note"><pre className="m-0 whitespace-pre-wrap font-mono text-[12px]">{input.note}</pre></Row> : null}
          {plan.metafields.length ? <Row k="Metafields">{plan.metafields.map((m) => `wholesale.${m.key} = ${m.value}`).join('; ')}</Row> : null}
          {plan.priceBase ? <Row k="Price base">{plan.priceBase}; 25% off, {plan.groupCount} price group(s)</Row> : null}
        </tbody>
      </table>
      {plan.slots.length ? (
        <table className="mt-6 w-full border-collapse">
          <thead>
            <tr>{['Slot', 'Code', 'Action', 'Off', 'Worst cent', 'Variants'].map((h) => <th key={h} scope="col" className={`${head} w-auto text-left font-normal`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {plan.slots.map((s) => (
              <tr key={s.code}>
                <td className={cell}>{s.slot}</td>
                <td className={`${cell} font-mono`}>{s.code}</td>
                <td className={cell}>{s.action}</td>
                <td className={cell}>{s.pct === null ? 'no group' : `${(s.pct * 100).toFixed(2)}%`}</td>
                <td className={cell}>{s.pct === null ? '' : `${s.unitCents.toFixed(2)} unit, ${s.lineCents.toFixed(1)} line`}</td>
                <td className={`${cell} font-mono text-[11px]`}>{s.variants.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <h2 className="mt-8 text-base font-medium">Welcome mail</h2>
      <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">To {plan.mail.to}, reply-to and bcc the company inbox. Subject: {plan.mail.subject}</p>
      <pre className="mt-3 whitespace-pre-wrap rounded-[var(--r-xs)] border border-[var(--color-border)] p-4 font-mono text-[12px] leading-relaxed">{plan.mail.text}</pre>
    </>
  );
}

function Outcome({acted}: {acted: Acted}) {
  if (acted.problem) return <p role="alert" className="mt-6 text-sm text-[var(--od-pcb-copper)]">{acted.problem}</p>;
  const r = acted.result!;
  if (r.status === 'disabled') return <p role="status" className="mt-6 text-sm">Writes are off (WHOLESALE_APPROVE_WRITE_ENABLED is not <code>1</code>). Nothing was written and no mail was sent.</p>;
  if (r.status === 'refused') return <p role="alert" className="mt-6 text-sm text-[var(--od-pcb-copper)]">Refused, nothing written: {r.reason}</p>;
  const b = r.readBack;
  const mail = {sent: 'Welcome mail sent.', not_configured: 'Welcome mail NOT sent: Resend is not configured. Send the text below by hand.', failed: 'Welcome mail NOT sent: Resend refused or did not answer. Send the text below by hand.', held: 'Welcome mail held until the read back is clean.'}[r.mail];
  return (
    <div role="status" className="mt-6">
      <h2 className="m-0 text-xl font-medium">{r.status === 'approved' ? 'Approved' : 'Read back MISMATCH'}</h2>
      <table className="mt-4 w-full border-collapse">
        <tbody>
          <Row k="Customer">{b.customerId}</Row>
          <Row k="Tags">{b.tags.join(', ')}</Row>
          <Row k="Tax exemptions">{b.taxExemptions.join(', ') || 'none'}</Row>
          <Row k="Metafields">wholesale.vat_number = {b.vatNumber ?? 'none'}; wholesale.company = {b.company ?? 'none'}</Row>
          {b.slots.map((s) => <Row key={s.code} k={s.code}>{s.ok ? 'OK' : 'MISMATCH'}</Row>)}
          <Row k="Mail">{mail}</Row>
        </tbody>
      </table>
    </div>
  );
}

export default function WholesaleApprove() {
  const {token, payload, plan, problem, writes} = useLoaderData<typeof loader>() as Loaded;
  const acted = useActionData<Acted>();
  const busy = useNavigation().state !== 'idle';
  const done = acted?.result?.status === 'approved' || acted?.result?.status === 'mismatch';
  const blocked = !plan || Boolean(plan.refusal) || !writes;
  return (
    <div className="page-shell">
      <div className="mx-auto max-w-[860px] pb-12">
        <h1 className="page-title">Wholesale approval</h1>
        <p className="text-[13px] text-[var(--color-text-muted)]">Staff only. Opening this page writes nothing; Approve runs the onboarding of docs/wholesale.md and mails the retailer.</p>
        <table className="mt-6 w-full border-collapse">
          <tbody>
            <Row k="Company">{payload.company}</Row>
            <Row k="Contact">{payload.contact}</Row>
            <Row k="Email">{payload.email}</Row>
            <Row k="Country">{payload.country}</Row>
            <Row k="VAT">{payload.vat || 'not given'}</Row>
          </tbody>
        </table>
        {acted ? <Outcome acted={acted} /> : null}
        {done ? null : <>
        {problem ? <p role="alert" className="mt-6 text-sm text-[var(--od-pcb-copper)]">{problem}</p> : null}
        {plan?.refusal ? <p role="alert" className="mt-6 text-sm text-[var(--od-pcb-copper)]">Approve will refuse: {plan.refusal}</p> : null}
        {!writes ? <p className="mt-6 text-sm text-[var(--color-text-muted)]">Writes are off (WHOLESALE_APPROVE_WRITE_ENABLED is not <code>1</code>): this is a dry run only.</p> : null}
        </>}
        {acted?.result && acted.result.status !== 'disabled' && acted.result.status !== 'refused' ? null : plan ? <PlanView plan={plan} /> : null}
        {acted?.result?.status === 'approved' || acted?.result?.status === 'mismatch' ? (
          <pre className="mt-6 whitespace-pre-wrap rounded-[var(--r-xs)] border border-[var(--color-border)] p-4 font-mono text-[12px] leading-relaxed">{acted.result.plan.mail.text}</pre>
        ) : (
          <Form method="post" action={`?t=${encodeURIComponent(token)}`} className="mt-8">
            <input type="hidden" name="t" value={token} />
            <button type="submit" disabled={blocked || busy} className="od-btn od-btn-primary">{busy ? 'Approving...' : 'Approve'}</button>
          </Form>
        )}
      </div>
    </div>
  );
}
