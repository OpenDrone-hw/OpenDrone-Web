import {Form, Link, useLocation} from 'react-router';
import {useEffect, useRef, type ReactNode} from 'react';

/**
 * The header's account entry in app mode: signed out, a "Sign in" link with the account icon; signed in, the icon
 * opens a small menu (My account and its sections, Sign out). Shown on every width, next to the cart.
 */
export function AccountMenu({signedIn, signInUrl, icon}: {signedIn: boolean; signInUrl: string; icon: ReactNode}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const {pathname} = useLocation();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (d?.open && !(e.target instanceof Node && d.contains(e.target))) d.open = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  if (!signedIn) {
    return (
      <a href={signInUrl} className="site-header-icon site-header-account site-header-account-app" aria-label="Sign in" title="Sign in">
        {icon}
      </a>
    );
  }
  return (
    <details ref={ref} className="acct-menu">
      <summary className="site-header-icon site-header-account site-header-account-app is-signed-in" aria-label="Your account" title="Your account">
        {icon}
        <span className="acct-dot" aria-hidden="true" />
      </summary>
      <div className="acct-menu-panel">
        <Link to="/account">My account</Link>
        <Link to="/account#orders">Orders</Link>
        <Link to="/account#addresses">Addresses</Link>
        <Link to="/account#profile">Profile</Link>
        <Form method="post" action="/account/logout">
          <button type="submit">Sign out</button>
        </Form>
      </div>
    </details>
  );
}
