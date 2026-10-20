import {Link, useFetcher} from 'react-router';

/** On the order status page: one click to create an account for the order's email (a mailed link, no password). */
export function CreateAccountCard({signedIn}: {signedIn: boolean}) {
  const f = useFetcher<{sent: boolean}>();
  if (signedIn) {
    return (
      <section className="co-card">
        <h2>Your account</h2>
        <p className="co-quiet">This order is in your account, with its tracking once it ships.</p>
        <div><Link to="/account" className="acct-btn is-primary" style={{display: 'inline-flex', alignItems: 'center', textDecoration: 'none'}}>View your orders</Link></div>
      </section>
    );
  }
  return (
    <section className="co-card">
      <h2>Create an account</h2>
      {f.data?.sent ? (
        <p className="co-quiet" role="status">Check your inbox: we sent a link to the email address of this order. Open it to finish.</p>
      ) : (
        <>
          <p className="co-quiet">Follow this order, see its tracking and keep your addresses. No password: we email you a sign-in link.</p>
          {f.data && !f.data.sent ? <p role="alert" className="app-shop-problem">We could not send the link. Try again in a minute.</p> : null}
          <f.Form method="post">
            <input type="hidden" name="intent" value="create_account" />
            <button type="submit" className="acct-btn is-primary" disabled={f.state !== 'idle'}>{f.state !== 'idle' ? 'Sending...' : 'Create an account'}</button>
          </f.Form>
        </>
      )}
    </section>
  );
}
