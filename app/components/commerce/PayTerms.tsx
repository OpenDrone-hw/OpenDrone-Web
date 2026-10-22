import {Link} from 'react-router';
import {Txt} from '~/components/Txt';
import {legalHref, useLegalLocale} from '~/components/LangToggle';
import {payTermLinks} from '~/lib/commerce/pay-terms';

/** Terms, withdrawal, privacy (and preorder conditions) in a compact row under the Pay button. */
export function PayTerms({hasPreorder}: {hasPreorder: boolean}) {
  const locale = useLegalLocale();
  return (
    <nav className="co-terms" aria-label="Terms before you pay">
      {payTermLinks(hasPreorder).map((l) => (
        <Link key={l.to} to={legalHref(l.to, locale)} target="_blank" rel="noreferrer">
          <Txt id={l.copy} />
        </Link>
      ))}
    </nav>
  );
}
