import {Form, Link, useActionData, useNavigation} from 'react-router';
import type {Route} from './+types/account.verify';
import {requireAppAccounts, sendLinkAction, verifyRoute} from '~/lib/commerce/app-account';

export const meta: Route.MetaFunction = () => [{title: 'Sign in'}, {name: 'robots', content: 'noindex, nofollow'}];

/** The page a sign-in link opens: signs in and goes on to the page the link came from. */
export async function loader({request, context}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  return verifyRoute(request, context.env);
}

export async function action({request, context}: Route.ActionArgs) {
  requireAppAccounts(context.env);
  return sendLinkAction(request, context.env, import.meta.env.DEV);
}

export default function AccountVerify() {
  const done = useActionData<typeof action>();
  const busy = useNavigation().state !== 'idle';
  return (
    <div className="page-shell app-shop">
      <h1 className="app-shop-title">This link does not work</h1>
      <p className="app-shop-note">A sign-in link works once and expires after 15 minutes. Enter your email and we send a new one.</p>
      {done?.sent ? (
        <p className="app-shop-note" role="status">Check your inbox: a new link is on its way to {done.email}.</p>
      ) : (
        <Form method="post" className="acct-form">
          {done?.problem ? <p role="alert" className="app-shop-problem">{done.problem}</p> : null}
          <label className="co-field">
            <span>Email</span>
            <input name="email" type="email" required autoComplete="email" defaultValue={done?.email ?? ''} />
          </label>
          <button type="submit" className="co-pay" disabled={busy}>{busy ? 'Sending...' : 'Email me a sign-in link'}</button>
        </Form>
      )}
      <p className="co-quiet"><Link to="/shop/cart">Back to checkout</Link></p>
    </div>
  );
}
