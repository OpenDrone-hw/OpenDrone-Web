import {useState} from 'react';
import {AddressFields} from '~/components/commerce/AddressFields';
import {BILLING_PREFIX} from '~/lib/commerce/billing';

type Country = {code: string; name: string};

/**
 * The Billing section of the checkout: the delivery address bills unless "Billing address is different" is ticked, which
 * reveals the same address fields (country kept in local state: it does not change the quote). Company and VAT number
 * are optional; the app checks the VAT number by format only.
 */
export function BillingSection({country, countries, suggest}: {country: string; countries: Country[]; suggest: boolean}) {
  const [different, setDifferent] = useState(false);
  const [billingCountry, setBillingCountry] = useState(country);
  return (
    <section className="co-section">
      <h2 className="co-h">Billing</h2>
      <label className="co-field">
        <span>Company<em> (optional)</em></span>
        <input name="company" autoComplete="organization" maxLength={100} />
      </label>
      <label className="co-field">
        <span>VAT number<em> (optional)</em></span>
        <input name="vat_number" autoComplete="off" maxLength={20} placeholder="BE0123456789" pattern="[A-Za-z]{2}[A-Za-z0-9 .\-]{2,17}" title="Two letters of the country, then the number, for example BE0123456789" />
      </label>
      <div className="co-pickup">
        <label>
          <input type="checkbox" name="billing_different" value="1" checked={different} onChange={(e) => setDifferent(e.target.checked)} />
          <span>Billing address is different</span>
        </label>
      </div>
      {different ? (
        <AddressFields country={billingCountry} countries={countries} suggest={suggest} fill={null} prefix={BILLING_PREFIX} section="billing"
          phone={false} onCountry={setBillingCountry} />
      ) : null}
    </section>
  );
}
