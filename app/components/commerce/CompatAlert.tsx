import {Link} from 'react-router';
import {TriangleAlert} from 'lucide-react';
import type {CompatAlert as Alert} from '~/lib/cart-compat';

/**
 * The cart's mismatch warning (`app/lib/cart-compat.ts`). Advisory only: it
 * never disables checkout. The live region is always rendered so a conflict
 * that appears after a quantity change or removal is announced politely.
 */
export function CompatAlert({alert}: {alert: Alert}) {
  return (
    <div role="status" aria-live="polite" className="co-compat-live">
      {alert.issues.length ? (
        <section className="co-compat" aria-labelledby="co-compat-title" lang={alert.locale}>
          <h2 id="co-compat-title" className="co-compat-title">
            <TriangleAlert aria-hidden="true" size={18} strokeWidth={2} />
            {alert.heading}
          </h2>
          <ul className="co-compat-list">
            {alert.issues.map((i) => (
              <li key={i.key}>
                <p>{i.problem}</p>
                <p>
                  {i.fix}{' '}
                  <Link to={i.link.href} prefetch="intent">
                    {i.link.label}
                  </Link>
                </p>
              </li>
            ))}
          </ul>
          <p className="co-compat-note">{alert.note}</p>
        </section>
      ) : null}
    </div>
  );
}
