import {Link} from 'react-router';
import type {Route} from './+types/account.verify';
import {requireAppAccounts, verifyRoute} from '~/lib/commerce/app-account';

export const meta: Route.MetaFunction = () => [{title: 'Sign in'}, {name: 'robots', content: 'noindex, nofollow'}];

/** The page a sign-in link opens: signs in and goes on to the page the link came from. */
export async function loader({request, context}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  return verifyRoute(request, context.env);
}

export default function AccountVerify() {
  return (
    <div className="page-shell app-shop">
      <h1 className="app-shop-title">This link does not work</h1>
      <p className="app-shop-note">A sign-in link works once and expires after 15 minutes. Enter your email and we mail you a new code.</p>
      <p><Link to="/account/login" className="acct-btn is-primary acct-btn-link">Get a new code</Link></p>
      <p className="co-quiet"><Link to="/shop/cart">Back to checkout</Link></p>
    </div>
  );
}
