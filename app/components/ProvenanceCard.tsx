import {CONTRIBUTING_URL} from '~/lib/company';
import {Link} from 'react-router';
import {Txt} from './Txt';
import {copyText} from '~/lib/copy';

/**
 * Provenance card - the honest where-is-this-made line. Designed in
 * Belgium, assembled in Shenzhen.
 * Kept static for now; the batch ID on the build card is the live link
 * between a given unit and its factory.
 */
export function ProvenanceCard() {
  return (
    <section
      className="provenance-card"
      aria-label={copyText('product-chrome.provenance_aria')}
    >
      <Txt id="product-chrome.provenance_label" as="p" className="provenance-label" />
      <ul className="provenance-rows">
        <li>
          <Txt
            id="product-chrome.provenance_designed_label"
            as="span"
            className="provenance-row-label"
          />
          <span className="provenance-row-value">
            {copyText('product-chrome.provenance_designed_value')}
          </span>
        </li>
        <li>
          <Txt
            id="product-chrome.provenance_assembled_label"
            as="span"
            className="provenance-row-label"
          />
          <span className="provenance-row-value">
            {copyText('product-chrome.provenance_assembled_value')}
          </span>
        </li>
      </ul>
      {/* The card states the facts; these carry the reader to the story
          behind them: the production page and how to join in. */}
      <p className="provenance-links">
        <Link prefetch="viewport" to="/production">
          <Txt id="product-chrome.provenance_link_production" />
        </Link>
        <a href={CONTRIBUTING_URL} target="_blank" rel="noopener noreferrer">
          <Txt id="product-chrome.provenance_link_contribute" />
        </a>
      </p>
    </section>
  );
}
