import {Form, useFetcher} from 'react-router';
import {useEffect, useRef, useState} from 'react';
import type {Account} from '~/lib/commerce/app-account';
import type {ManageResult} from '~/lib/commerce/app-account-manage';
import type {HistoryNotice} from '~/lib/accounts/rights';
import {AddressesSection, OrdersSection} from './AccountPages';
import {PreferencesSection, PrivacySection} from './AccountPrivacy';

/** The sections of My account, in the order they are drawn; the nav links to each by its id. */
export const SECTIONS = [
  {id: 'orders', title: 'Orders'},
  {id: 'addresses', title: 'Addresses'},
  {id: 'profile', title: 'Profile'},
  {id: 'preferences', title: 'Preferences'},
  {id: 'privacy', title: 'Privacy'},
] as const;

function Section({id, title, children}: {id: string; title: string; children: React.ReactNode}) {
  return (
    <section id={id} className="acct-section" aria-labelledby={`acct-${id}-title`}>
      <h2 id={`acct-${id}-title`} className="acct-section-title">{title}</h2>
      {children}
    </section>
  );
}

/** The name on the account (optional): shown in the page header, kept on the shop customer record. */
function NameForm({name}: {name: string}) {
  const f = useFetcher<ManageResult>();
  const busy = f.state !== 'idle';
  const saved = f.state === 'idle' && f.data?.intent === 'name' && f.data.ok;
  return (
    <f.Form method="post" action="/account/profile" className="co-card acct-form">
      <input type="hidden" name="intent" value="name" />
      <label className="co-field"><span>Name <em>(optional)</em></span><input name="name" defaultValue={name} maxLength={120} autoComplete="name" /></label>
      {f.data?.intent === 'name' && f.data.problem ? <p role="alert" className="app-shop-problem">{f.data.problem}</p> : null}
      <div className="acct-actions">
        <button type="submit" className="acct-btn is-primary" disabled={busy}>{busy ? 'Saving...' : 'Save name'}</button>
        {saved ? <span role="status" className="co-quiet">Saved.</span> : null}
      </div>
    </f.Form>
  );
}

/** Change the address: a code goes to the new one, and nothing changes until it comes back. */
function EmailChange({email, aliases}: {email: string; aliases: string[]}) {
  const f = useFetcher<ManageResult>();
  const [open, setOpen] = useState(false);
  const code = useRef<HTMLInputElement>(null);
  const busy = f.state !== 'idle';
  const d = f.data;
  const step = open && d?.step === 'code' ? 'code' : 'start';
  const done = f.state === 'idle' && d?.intent === 'email-confirm' && d.ok;
  useEffect(() => {
    if (step === 'code') code.current?.focus();
  }, [step]);
  return (
    <div className="co-card acct-form">
      <div>
        <p className="co-quiet">Email address</p>
        <p className="acct-email">{email}</p>
        {aliases.length ? <p className="co-quiet">Orders placed with {aliases.join(', ')} stay in your list.</p> : null}
      </div>
      {done && !open ? <p role="status" className="co-quiet">Your email address is changed.</p> : null}
      {!open ? (
        <div><button type="button" className="acct-btn" onClick={() => setOpen(true)}>Change email address</button></div>
      ) : (
        <f.Form method="post" action="/account/profile" className="acct-form">
          <input type="hidden" name="intent" value={step === 'code' ? 'email-confirm' : 'email'} />
          {step === 'code' ? (
            <>
              <input type="hidden" name="new_email" value={d?.email ?? ''} />
              <p className="co-quiet">We sent a 6-digit code to <strong>{d?.email}</strong>. It works for 10 minutes.</p>
              <label className="co-field"><span>Code</span><input ref={code} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required /></label>
            </>
          ) : (
            <label className="co-field"><span>New email address</span><input name="new_email" type="email" required autoComplete="email" inputMode="email" defaultValue={d?.email ?? ''} /></label>
          )}
          {d?.problem ? <p role="alert" className="app-shop-problem">{d.problem}</p> : null}
          <div className="acct-actions">
            <button type="submit" className="acct-btn is-primary" disabled={busy}>{busy ? 'Working...' : step === 'code' ? 'Confirm new address' : 'Send a code'}</button>
            <button type="button" className="acct-btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </f.Form>
      )}
    </div>
  );
}

/** My account: one page, a section for each thing the customer can see or change, reached from the header icon. */
export function MyAccount({account, countries, chatfpv, pilotMap}: {account: Account; countries: string[]; chatfpv: {connected: boolean; notice: HistoryNotice | null}; pilotMap: boolean}) {
  return (
    <div className="page-shell app-shop acct">
      <header className="acct-head">
        <div>
          <h1 className="app-shop-title">My account</h1>
          <p className="co-quiet">{account.name ? `${account.name} · ` : ''}{account.email}</p>
        </div>
        <Form method="post" action="/account/logout" reloadDocument>
          <button type="submit" className="acct-btn">Sign out</button>
        </Form>
      </header>
      <nav className="acct-tabs acct-sections" aria-label="My account sections">
        {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
      </nav>
      <Section id="orders" title="Orders"><OrdersSection account={account} /></Section>
      <Section id="addresses" title="Addresses"><AddressesSection account={account} countries={countries} /></Section>
      <Section id="profile" title="Profile">
        <div className="acct-list">
          <NameForm name={account.name} />
          <EmailChange email={account.email} aliases={account.aliases} />
        </div>
      </Section>
      <Section id="preferences" title="Preferences"><PreferencesSection account={account} /></Section>
      <Section id="privacy" title="Privacy"><PrivacySection account={account} chatfpv={chatfpv} pilotMap={pilotMap} /></Section>
    </div>
  );
}
