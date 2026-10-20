import {Link, useFetcher} from 'react-router';

/** On the order status page: the email is the account, so one click mails a code and link to this order's address. */
export function OrdersLinkCard({signedIn}: {signedIn: boolean}) {
  const f = useFetcher<{sent: boolean}>();
  if (signedIn) {
    return (
      <section className="co-card">
        <h2>All your orders</h2>
        <p className="co-quiet">This order is in My orders, with its tracking once it ships.</p>
        <div><Link to="/account" className="acct-btn is-primary" style={{display: 'inline-flex', alignItems: 'center', textDecoration: 'none'}}>My orders</Link></div>
      </section>
    );
  }
  return (
    <section className="co-card">
      <h2>See all your orders</h2>
      {f.data?.sent ? (
        <p className="co-quiet" role="status">Check your inbox: we sent a code and a link to the email address of this order. Use either to open your orders.</p>
      ) : (
        <>
          <p className="co-quiet">Follow this order, see its tracking and invoice, and order again. No password: we mail a code to the email address of this order.</p>
          {f.data && !f.data.sent ? <p role="alert" className="app-shop-problem">We could not send the mail. Try again in a minute.</p> : null}
          <f.Form method="post">
            <input type="hidden" name="intent" value="create_account" />
            <button type="submit" className="acct-btn is-primary" disabled={f.state !== 'idle'}>{f.state !== 'idle' ? 'Sending...' : 'See all your orders'}</button>
          </f.Form>
        </>
      )}
    </section>
  );
}
