import {useEffect, useRef, useState} from 'react';
import {useLocation} from 'react-router';

/**
 * Client-side navigation is invisible to assistive tech: the URL and title
 * change but focus stays on the (possibly unmounted) link. After a pathname
 * change this either moves focus to <main> (tabindex -1, so it is not a Tab
 * stop), or, when focus is inside an open dialog (the ChatFPV panel), leaves
 * focus there and announces the new page title in a polite live region: one
 * or the other, never both, so the page is not announced twice. It does
 * nothing on the initial load, and nothing for hash-only or query-only
 * navigations (anchors, filters, variant pickers), which keep their own focus
 * handling.
 */
export function RouteAnnouncer() {
  const {pathname} = useLocation();
  const previous = useRef(pathname);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (previous.current === pathname) return undefined;
    previous.current = pathname;
    // The title is set by the new route's meta after this render commits.
    const timer = setTimeout(() => {
      const inDialog = document.activeElement?.closest('[role="dialog"], dialog');
      const main = document.getElementById('main-content');
      if (!inDialog && main) {
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        main.focus({preventScroll: true});
        setMessage('');
        return;
      }
      setMessage(document.title);
    }, 150);
    return () => clearTimeout(timer);
  }, [pathname]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

export default RouteAnnouncer;
