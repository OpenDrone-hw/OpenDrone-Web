import {Form, Link, useFetcher, useNavigation} from 'react-router';
import {useEffect, useRef, useState} from 'react';
import {formatMoney} from '~/lib/commerce/app-api';
import {orderStatus, type Account, type AccountAddress, type AccountOrder} from '~/lib/commerce/app-account';

const REGION = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], {type: 'region'}) : null;
const countryName = (c: string) => REGION?.of(c) ?? c;
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'}) : '');

/** The frame of every account page: title, who is signed in, Orders and Addresses tabs, Sign out. */
export function AccountFrame({email, tab, children}: {email: string; tab: 'orders' | 'addresses'; children: React.ReactNode}) {
  return (
    <div className="page-shell app-shop acct">
      <header className="acct-head">
        <div>
          <h1 className="app-shop-title">My orders</h1>
          <p className="co-quiet">{email}</p>
        </div>
        <Form method="post" action="/account/logout">
          <button type="submit" className="acct-btn">Sign out</button>
        </Form>
      </header>
      <nav className="acct-tabs" aria-label="Account">
        <Link to="/account" aria-current={tab === 'orders' ? 'page' : undefined}>Orders</Link>
        <Link to="/account/addresses" aria-current={tab === 'addresses' ? 'page' : undefined}>Addresses</Link>
      </nav>
      {children}
    </div>
  );
}

function Address({a}: {a: Omit<AccountAddress, 'id' | 'saved'>}) {
  return (
    <address className="acct-address">
      {a.name}
      <br />
      {a.line1}
      {a.line2 ? <><br />{a.line2}</> : null}
      <br />
      {a.postal_code} {a.city}
      <br />
      {countryName(a.country)}
    </address>
  );
}

function OrderCard({o}: {o: AccountOrder}) {
  const status = orderStatus(o);
  const t = o.shipment;
  return (
    <article className="co-card acct-order">
      <header className="acct-order-head">
        <h2>Order {o.number}</h2>
        <span className={`acct-chip${status === 'Shipped' ? ' is-shipped' : ''}`}>{status}</span>
      </header>
      <p className="co-quiet">Placed {day(o.created)}</p>
      <ul className="acct-lines">
        {o.lines.map((l) => (
          <li key={`${l.title}|${l.variant_title}`}>
            <span>{[l.title, l.variant_title === 'Default Title' ? '' : l.variant_title].filter(Boolean).join(' ')} <span className="co-dim">x {l.qty}</span></span>
            <span className="co-num">{formatMoney(l.total_minor, o.quote.currency)}</span>
          </li>
        ))}
        <li className="acct-total"><span>Total</span><span className="co-num">{formatMoney(o.quote.total_minor, o.quote.currency)}</span></li>
      </ul>
      <div className="acct-order-foot">
        {o.ship_address ? <div><p className="co-quiet">Shipping to</p><Address a={o.ship_address} /></div> : null}
        <div>
          <p className="co-quiet">Tracking</p>
          {t?.tracking_number ? (
            <p className="acct-track">
              {t.carrier ? `${t.carrier}: ` : ''}
              {t.tracking_url ? <a href={t.tracking_url} rel="noreferrer noopener">{t.tracking_number}</a> : t.tracking_number}
              {t.eta ? <><br /><span className="co-dim">Expected {t.eta}</span></> : null}
            </p>
          ) : (
            <p className="co-dim">Not shipped yet. The tracking number shows here and in your shipping mail.</p>
          )}
        </div>
      </div>
      <div className="acct-actions acct-order-actions">
        {o.invoice ? (
          <a className="acct-btn" href={`/account/invoices/${encodeURIComponent(o.number)}`} target="_blank" rel="noreferrer">
            Invoice {o.invoice.number}
          </a>
        ) : null}
        <ReorderButton o={o} />
      </div>
    </article>
  );
}

/** Reorder fills the cart with the lines of this order that can still be bought, then opens the cart. */
function ReorderButton({o}: {o: AccountOrder}) {
  const open = o.reorder.lines.filter((l) => l.available).length;
  const gone = o.reorder.lines.length - open;
  return (
    <Form method="post" action="/account/reorder" className="acct-reorder">
      <input type="hidden" name="number" value={o.number} />
      <button type="submit" className="acct-btn is-primary" disabled={!open}>Reorder</button>
      {gone ? <span className="co-dim">{open ? `${gone} of ${o.reorder.lines.length} items are no longer available and are left out.` : 'These items are no longer available.'}</span> : null}
    </Form>
  );
}

export function AccountOrders({account}: {account: Account}) {
  return (
    <AccountFrame email={account.email} tab="orders">
      {account.orders.length ? (
        <div className="acct-list">{account.orders.map((o) => <OrderCard key={o.number} o={o} />)}</div>
      ) : (
        <p className="app-shop-note">No orders yet with this email address. <Link to="/products">Browse the products</Link>.</p>
      )}
    </AccountFrame>
  );
}

function AddressField({a, label, name, optional, ...rest}: {a?: AccountAddress; label: string; name: string; optional?: boolean} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="co-field"><span>{label}{optional ? <em> (optional)</em> : null}</span><input name={name} required={!optional} defaultValue={String(a?.[name as keyof AccountAddress] ?? '')} {...rest} /></label>
  );
}

function AddressForm({a, countries, onDone}: {a?: AccountAddress; countries: string[]; onDone?: () => void}) {
  const f = useFetcher<{problem: string | null}>();
  const busy = f.state !== 'idle';
  useEffect(() => {
    if (f.state === 'idle' && f.data && f.data.problem === null) onDone?.();
  }, [f.state, f.data, onDone]);
  return (
    <f.Form method="post" action="/account/addresses" className="acct-form">
      <input type="hidden" name="id" value={a?.id ?? ''} />
      {f.data?.problem ? <p role="alert" className="app-shop-problem">{f.data.problem}</p> : null}
      <label className="co-field">
        <span>Country</span>
        <select name="country" defaultValue={a?.country ?? countries[0]} autoComplete="country">
          {countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
        </select>
      </label>
      <AddressField a={a} label="Full name" name="name" autoComplete="name" />
      <AddressField a={a} label="Address" name="line1" autoComplete="address-line1" />
      <AddressField a={a} label="Apartment, suite, etc." name="line2" autoComplete="address-line2" optional />
      <div className="co-row"><AddressField a={a} label="Postal code" name="postal_code" autoComplete="postal-code" /><AddressField a={a} label="City" name="city" autoComplete="address-level2" /></div>
      <AddressField a={a} label="Phone" name="phone" type="tel" autoComplete="tel" optional />
      <div className="acct-actions">
        <button type="submit" className="acct-btn is-primary" disabled={busy}>{busy ? 'Saving...' : 'Save address'}</button>
        {onDone ? <button type="button" className="acct-btn" onClick={onDone}>Cancel</button> : null}
      </div>
    </f.Form>
  );
}

function AddressCard({a, countries}: {a: AccountAddress; countries: string[]}) {
  const [editing, setEditing] = useState(false);
  const f = useFetcher();
  if (editing) return <div className="co-card"><h2>Edit address</h2><AddressForm a={a} countries={countries} onDone={() => setEditing(false)} /></div>;
  return (
    <article className="co-card">
      <Address a={a} />
      {a.phone ? <p className="co-quiet">{a.phone}</p> : null}
      <p className="co-quiet">{a.saved ? 'Saved address' : 'From an order'}</p>
      <div className="acct-actions">
        <button type="button" className="acct-btn" onClick={() => setEditing(true)}>Edit</button>
        <f.Form method="post" action="/account/addresses">
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="id" value={a.id} />
          <button type="submit" className="acct-btn" disabled={f.state !== 'idle'}>Remove</button>
        </f.Form>
      </div>
    </article>
  );
}

export function AccountAddresses({account, countries}: {account: Account; countries: string[]}) {
  const [adding, setAdding] = useState(false);
  return (
    <AccountFrame email={account.email} tab="addresses">
      <div className="acct-list">
        {account.addresses.map((a) => <AddressCard key={a.id} a={a} countries={countries} />)}
        {!account.addresses.length && !adding ? <p className="app-shop-note">No addresses yet. They appear here after your first order, or add one now.</p> : null}
        {adding ? <div className="co-card"><h2>New address</h2><AddressForm countries={countries} onDone={() => setAdding(false)} /></div>
          : <div><button type="button" className="acct-btn is-primary" onClick={() => setAdding(true)}>Add an address</button></div>}
      </div>
    </AccountFrame>
  );
}

/** Six digits: numeric keypad, the mail app's code suggestion, paste of "123 456", and the form goes as soon as the sixth digit is in. */
function CodeInput() {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const take = (raw: string) => setValue(raw.replace(/\D/g, '').slice(0, 6));
  useEffect(() => ref.current?.focus(), []);
  // Once the sixth digit is drawn the field carries all six, so the form can go.
  useEffect(() => {
    if (value.length === 6) ref.current?.form?.requestSubmit();
  }, [value]);
  return (
    <input
      ref={ref}
      name="code"
      value={value}
      onChange={(e) => take(e.target.value)}
      onPaste={(e) => {
        e.preventDefault();
        take(e.clipboardData.getData('text'));
      }}
      className="acct-code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={12}
      aria-label="6-digit code"
      placeholder="000000"
      required
    />
  );
}

/** Sign in, no account to make: the email, then the six digits of the mail (or its link). Same flow behind the header icon. */
export function SignInForm({returnTo, sent, email, problem, intro}: {returnTo: string; sent: boolean; email: string; problem: string | null; intro?: string}) {
  const busy = useNavigation().state !== 'idle';
  return (
    <div className="page-shell app-shop acct">
      <h1 className="app-shop-title">{sent ? 'Check your mail' : 'See your orders'}</h1>
      {sent ? (
        <section className="co-card acct-form" role="status">
          <p className="co-quiet">We sent a 6-digit code and a link to <strong>{email}</strong>. The code works for 10 minutes, the link for 15. Enter the code here, or open the link.</p>
          <Form method="post" className="acct-form">
            <input type="hidden" name="intent" value="code" />
            <input type="hidden" name="return_to" value={returnTo} />
            <input type="hidden" name="email" value={email} />
            {problem ? <p role="alert" className="app-shop-problem">{problem}</p> : null}
            <div className="co-field"><span>Code</span><CodeInput /></div>
            <button type="submit" className="co-pay" disabled={busy}>{busy ? 'Checking...' : 'Continue'}</button>
          </Form>
          <div className="acct-actions">
            <Form method="post">
              <input type="hidden" name="return_to" value={returnTo} />
              <input type="hidden" name="email" value={email} />
              <button type="submit" className="acct-btn" disabled={busy}>Send a new code</button>
            </Form>
            <Link to={`/account/login?return_to=${encodeURIComponent(returnTo)}`} className="acct-btn acct-btn-link">Use another email</Link>
          </div>
        </section>
      ) : (
        <Form method="post" className="co-card acct-form">
          <p className="co-quiet">{intro ?? 'Enter the email you ordered with. We mail you a code to see your orders, tracking and invoices. No password, nothing to set up.'}</p>
          {problem ? <p role="alert" className="app-shop-problem">{problem}</p> : null}
          <input type="hidden" name="return_to" value={returnTo} />
          <label className="co-field"><span>Email</span><input name="email" type="email" required autoComplete="email" inputMode="email" defaultValue={email} /></label>
          <button type="submit" className="co-pay" disabled={busy}>{busy ? 'Sending...' : 'Email me a code'}</button>
        </Form>
      )}
      <p className="co-quiet"><Link to="/shop/cart">Back to checkout</Link></p>
    </div>
  );
}
