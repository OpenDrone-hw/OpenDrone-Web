import {useEffect, useRef, useState} from 'react';
import {useLocation} from 'react-router';

/**
 * Client-side navigation is invisible to assistive tech: the URL and title
 * change but focus stays on the (possibly unmounted) link. After a pathname
 * change this moves focus to <main> (tabindex -1, so it is not a Tab stop) and
 * announces the new page title in a polite live region. It does nothing on the
 * initial load, and nothing for hash-only or query-only navigations (anchors,
 * filters, variant pickers), which keep their own focus handling.
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
      const main = document.getElementById('main-content');
      if (main) {
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        main.focus({preventScroll: true});
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
