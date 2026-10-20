import {useFetcher} from 'react-router';
import {useId, useRef, useState} from 'react';

/**
 * The Contact step of the app checkout. Without accounts: the email field and the guest note it always had.
 * With accounts (ACCOUNTS_ENABLED=1): "Continue as guest" (default) or "Sign in" (a mailed link that returns here with
 * the cart; no password), and the signed-in buyer's address filled in. The email input is uncontrolled and named
 * `email` (the express checkout fills it by name).
 */
export function ContactSection({accounts, accountEmail}: {accounts: boolean; accountEmail: string | null}) {
  const [mode, setMode] = useState<'guest' | 'signin'>('guest');
  const f = useFetcher<{sent: boolean; email: string; problem: string | null}>();
  const input = useRef<HTMLInputElement>(null);
  const group = useId();
  const busy = f.state !== 'idle';
  const send = () => {
    const el = input.current;
    if (!el || !el.reportValidity()) return;
    void f.submit({email: el.value, return_to: '/shop/cart'}, {method: 'post', action: '/account/login'});
  };
  return (
    <section className="co-section">
      <h2 className="co-h">Contact</h2>
      {accounts && !accountEmail ? (
        <div className="acct-choice" role="radiogroup" aria-label="How to check out">
          <label><input type="radio" name={`${group}-mode`} checked={mode === 'guest'} onChange={() => setMode('guest')} />Continue as guest</label>
          <label><input type="radio" name={`${group}-mode`} checked={mode === 'signin'} onChange={() => setMode('signin')} />Sign in</label>
        </div>
      ) : null}
      <label className="co-field">
        <span>Email</span>
        <input ref={input} name="email" type="email" required autoComplete="email" inputMode="email" defaultValue={accountEmail ?? ''} />
      </label>
      {accountEmail ? (
        <p className="co-quiet">
          Signed in. Your order joins your account.{' '}
          <button type="submit" formAction="/account/logout" formNoValidate className="co-remove">Not you? Sign out</button>
          <input type="hidden" name="return_to" value="/shop/cart" />
        </p>
      ) : mode === 'signin' && accounts ? (
        <div className="acct-inline">
          {f.data?.sent ? (
            <p className="co-quiet" role="status">Check your inbox: we sent a sign-in link to {f.data.email}. It brings you back here with your cart.</p>
          ) : (
            <>
              {f.data?.problem ? <p role="alert" className="app-shop-problem">{f.data.problem}</p> : null}
              <button type="button" className="acct-btn is-primary" onClick={send} disabled={busy}>{busy ? 'Sending...' : 'Email me a sign-in link'}</button>
              <p className="co-quiet">No password. If you have no account yet, the link creates one.</p>
            </>
          )}
        </div>
      ) : (
        <p className="co-quiet">
          {accounts ? 'Checking out as a guest. You can create an account after your order, with one click.' : 'Checking out as a guest. Accounts are optional.'}
        </p>
      )}
    </section>
  );
}
