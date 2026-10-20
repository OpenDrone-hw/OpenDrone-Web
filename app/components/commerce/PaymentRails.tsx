const RAILS = [
  {id: 'mollie', label: 'Bancontact, iDEAL or card', note: 'Pay with your bank app or card', logos: ['visa', 'master']},
  {id: 'stripe', label: 'Card or wallet', note: 'Visa, Mastercard, Apple Pay, Google Pay', logos: ['visa', 'master', 'apple_pay', 'google_pay']},
  {id: 'paypal', label: 'PayPal', note: 'Pay with your PayPal balance, bank or card', logos: []},
  {id: 'bank_transfer', label: 'Bank transfer', note: 'We show our account details next. We ship when the money is in.', logos: []},
] as const;

/** The rails as selectable cards (radio inputs underneath, so keyboard and forms work as before). */
export function PaymentRails({defaultRail = 'mollie'}: {defaultRail?: string}) {
  return (
    <fieldset className="co-rails">
      <legend className="co-h">Payment</legend>
      {RAILS.map((r) => (
        <label key={r.id} className="co-rail">
          <input type="radio" name="rail" value={r.id} defaultChecked={r.id === defaultRail} required />
          <span className="co-rail-text">
            <span className="co-rail-label">{r.label}</span>
            <span className="co-dim">{r.note}</span>
          </span>
          <span className="co-rail-logos" aria-hidden="true">
            {r.logos.map((n) => (
              <img key={n} src={`/payments/${n}.svg`} alt="" height={22} />
            ))}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
