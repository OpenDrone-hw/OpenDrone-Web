import {useEffect, useState} from 'react';
import {type ExpressConfig, type ExpressResult, fromPaymentResponse} from '~/lib/commerce/payment-provider';

/**
 * Wallet buttons above the form (Payment Request API, so Apple Pay on Safari and Google Pay on Chrome appear as the
 * browser offers them). A tap opens the wallet sheet for name, email, phone and shipping address and hands them to
 * `onFill`, which fills the form. Rendered only when the server passes a config and the browser can pay.
 * Nothing is drawn without a configured provider.
 */
export function ExpressCheckout({config, total, currency, countries, onFill}: {
  config: ExpressConfig | null;
  total: number;
  currency: string;
  countries: string[];
  onFill: (r: ExpressResult) => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!config || typeof PaymentRequest === 'undefined') return;
    let live = true;
    new PaymentRequest(config.methods, details(total, currency))
      .canMakePayment()
      .then((ok) => live && setReady(ok))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [config, total, currency]);
  if (!config || !ready) return null;

  async function pay() {
    try {
      const req = new PaymentRequest(config!.methods, details(total, currency), {requestPayerName: true, requestPayerEmail: true, requestPayerPhone: true, requestShipping: true});
      req.onshippingaddresschange = (e) => {
        const ok = countries.includes(String(req.shippingAddress?.country ?? '').toUpperCase());
        (e as Event & {updateWith(p: Promise<unknown>): void}).updateWith(Promise.resolve({...details(total, currency), ...(ok ? {} : {error: 'We do not ship to this country'})}));
      };
      const res = await req.show();
      onFill(fromPaymentResponse(res));
      // The sheet only hands over details here; the charge is taken by the provider step once the app accepts wallet tokens.
      await res.complete('unknown');
    } catch {
      /* the visitor closed the sheet */
    }
  }

  return (
    <section className="co-express" aria-label="Express checkout">
      <button type="button" className="co-express-btn" onClick={() => void pay()}>
        Pay with Google Pay or Apple Pay
      </button>
      <p className="co-or">or enter your details</p>
    </section>
  );
}

function details(total: number, currency: string) {
  return {total: {label: 'Total', amount: {currency, value: (total / 100).toFixed(2)}}};
}
