import {Form, Link, useFetcher} from 'react-router';
import type {Account} from '~/lib/commerce/app-account';
import type {ManageResult} from '~/lib/commerce/app-account-manage';
import type {HistoryNotice} from '~/lib/accounts/rights';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'}) : '');

const NOTICE: Record<HistoryNotice, string> = {
  deleted: 'Your ChatFPV history is deleted.',
  unavailable: 'ChatFPV did not answer. Nothing changed; try again later.',
  confirm: 'Tick the box to confirm the delete.',
};

/** Preferences: product news and offers, with the date of the customer's answer; a link to the Discord role of a preorder. */
export function PreferencesSection({account}: {account: Account}) {
  const f = useFetcher<ManageResult>();
  const m = account.marketing;
  const busy = f.state !== 'idle';
  return (
    <div className="acct-list">
      <f.Form method="post" action="/account/preferences" className="co-card acct-form">
        <input type="hidden" name="intent" value="marketing" />
        <input type="hidden" name="marketing" value={m.granted ? 'no' : 'yes'} />
        <h3 className="acct-card-title">Product news and offers</h3>
        <p className="co-quiet">
          {m.granted ? `You agreed on ${day(m.at)}. You can withdraw at any time.` : m.at ? `You withdrew on ${day(m.at)}.` : 'You have not agreed to receive product news and offers.'}
        </p>
        {f.data?.problem ? <p role="alert" className="app-shop-problem">{f.data.problem}</p> : null}
        <div><button type="submit" className={`acct-btn${m.granted ? '' : ' is-primary'}`} disabled={busy}>{busy ? 'Saving...' : m.granted ? 'Withdraw' : 'Agree to receive them'}</button></div>
      </f.Form>
      <div className="co-card">
        <h3 className="acct-card-title">Discord Early Bird role</h3>
        <p className="co-quiet">A paid preorder unlocks the Early Bird role and #early-birds on the OpenDrone Discord.</p>
        <div><Link to="/early-bird" className="acct-btn acct-btn-link">Claim on Discord</Link></div>
      </div>
    </div>
  );
}

/** Privacy: ChatFPV history, the owners map, and the request to delete the account's data (a request: the team deletes). */
export function PrivacySection({account, chatfpv, pilotMap}: {account: Account; chatfpv: {connected: boolean; notice: HistoryNotice | null}; pilotMap: boolean}) {
  const f = useFetcher<ManageResult>();
  const busy = f.state !== 'idle';
  const asked = account.erasure?.requested_at ?? (f.state === 'idle' && f.data?.intent === 'erasure' && f.data.ok ? new Date().toISOString() : null);
  return (
    <div className="acct-list">
      <div className="co-card acct-form">
        <h3 className="acct-card-title">ChatFPV history</h3>
        {chatfpv.connected ? (
          <>
            <p className="co-quiet">Your chatfpv.com conversations made while signed in to this account. Export them as JSON, or delete them for good.</p>
            {chatfpv.notice ? <p role="status" className="co-quiet">{NOTICE[chatfpv.notice]}</p> : null}
            <Form method="post" action="/account/chatfpv-history"><input type="hidden" name="intent" value="export" /><button type="submit" className="acct-btn">Export ChatFPV history</button></Form>
            <Form method="post" action="/account/chatfpv-history" className="acct-form">
              <input type="hidden" name="intent" value="delete" />
              <label className="acct-check"><input type="checkbox" name="confirm" value="yes" required /> Delete every ChatFPV conversation of this account</label>
              <div><button type="submit" className="acct-btn">Delete ChatFPV history</button></div>
            </Form>
          </>
        ) : (
          <p className="co-quiet">ChatFPV is not connected to this shop yet, so there is no ChatFPV history to export or delete here.</p>
        )}
      </div>
      {pilotMap ? (
        <div className="co-card">
          <h3 className="acct-card-title">Pilot map</h3>
          <p className="co-quiet">Find pilots near you. Optional: you choose whether to appear.</p>
          <div><Link to="/owners#pilots" className="acct-btn acct-btn-link">Open the pilot map</Link></div>
        </div>
      ) : null}
      <div className="co-card acct-form">
        <h3 className="acct-card-title">Delete my data</h3>
        {asked ? (
          <p role="status">Requested on {day(asked)}. We will process it.</p>
        ) : (
          <f.Form method="post" action="/account/privacy" className="acct-form">
            <input type="hidden" name="intent" value="erasure" />
            <p className="co-quiet">Ask us to delete your account and the data we hold about you. We handle each request ourselves, so it is not instant.</p>
            <label className="acct-check"><input type="checkbox" name="confirm" value="yes" required /> I want my data deleted</label>
            {f.data?.problem ? <p role="alert" className="app-shop-problem">{f.data.problem}</p> : null}
            <div><button type="submit" className="acct-btn is-primary" disabled={busy}>{busy ? 'Sending...' : 'Request deletion'}</button></div>
          </f.Form>
        )}
      </div>
      <p className="co-quiet">Questions? <Link to="/support">Open a ticket</Link> or <Link to="/support/find">find your ticket</Link>.</p>
    </div>
  );
}
