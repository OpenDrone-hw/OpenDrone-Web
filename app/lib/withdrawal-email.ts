/**
 * Transactional email for the online withdrawal function (CRD Art. 11 bis /
 * Art. VI.49/1 WER): one notice to the shop, one receipt confirmation to the
 * consumer on a durable medium. Sent via Resend. Without RESEND_API_KEY
 * nothing is sent and both results are false, so the form never tells a
 * consumer their withdrawal reached the shop when it did not.
 *
 * The receipt is sent only after the shop notice was accepted: a receipt
 * saying "we have received your withdrawal" must not go out for a notice
 * that never arrived.
 */

const RESEND_API = 'https://api.resend.com/emails';

type Env = {
  RESEND_API_KEY?: string;
  SUPPORT_FROM_EMAIL?: string;
  PUBLIC_COMPANY_NAME?: string;
  PUBLIC_COMPANY_EMAIL?: string;
};

export type WithdrawalNotice = {
  name: string;
  email: string;
  orderNumber: string;
  products: string;
  receivedOn: string;
  remarks: string;
  locale: 'nl' | 'en' | 'fr';
  /** ISO timestamp of submission, set by the action; echoed in both mails. */
  submittedAt: string;
};

const CONFIRM_SUBJECT: Record<WithdrawalNotice['locale'], string> = {
  nl: 'Ontvangstbevestiging van uw herroeping',
  en: 'Confirmation of receipt of your withdrawal',
  fr: 'Confirmation de réception de votre rétractation',
};

const CONFIRM_BODY: Record<WithdrawalNotice['locale'], string> = {
  nl: 'Wij hebben uw herroeping ontvangen en behandelen ze binnen 14 dagen. Stuur de producten terug naar het adres in de algemene voorwaarden; de terugbetaling volgt uiterlijk 14 dagen na ontvangst van de producten of het bewijs van terugzending.',
  en: 'We have received your withdrawal and will process it within 14 days. Return the products to the address in the terms and conditions; the refund follows at the latest 14 days after we receive the products or proof of return shipment.',
  fr: 'Nous avons bien reçu votre rétractation et la traiterons sous 14 jours. Renvoyez les produits à l’adresse indiquée dans les conditions générales ; le remboursement intervient au plus tard 14 jours après réception des produits ou de la preuve de leur renvoi.',
};

export type WithdrawalSendResult = {
  /** The notice to the shop inbox was accepted by the mail provider. */
  shopNotified: boolean;
  /** The receipt to the consumer was accepted by the mail provider. */
  receiptSent: boolean;
};

async function send(
  env: Env,
  opts: {to: string; subject: string; text: string; replyTo?: string},
  fetcher: typeof fetch,
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('[withdrawal/email] RESEND_API_KEY not set - would have sent', {
      subject: opts.subject,
    });
    return false;
  }
  const from = env.SUPPORT_FROM_EMAIL || 'support@opendrone.be';
  const fromDisplay = env.PUBLIC_COMPANY_NAME
    ? `${env.PUBLIC_COMPANY_NAME} <${from}>`
    : from;
  let res: Response;
  try {
    res = await fetcher(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromDisplay,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        ...(opts.replyTo ? {reply_to: opts.replyTo} : {}),
      }),
    });
  } catch (error) {
    console.error('[withdrawal/email] send failed', error instanceof Error ? error.message : error);
    return false;
  }
  if (!res.ok) {
    console.error('[withdrawal/email] send failed', res.status, await res.text());
  }
  return res.ok;
}

/** Notify the shop, then confirm receipt to the consumer once the shop
 * notice was accepted. */
export async function sendWithdrawalNotice(
  env: Env,
  notice: WithdrawalNotice,
  fetcher: typeof fetch = fetch,
): Promise<WithdrawalSendResult> {
  const shopTo = env.PUBLIC_COMPANY_EMAIL || 'contact@opendrone.be';
  const lines = [
    `Herroeping via het onlineformulier (${notice.locale})`,
    '',
    `Naam:         ${notice.name}`,
    `E-mail:       ${notice.email}`,
    `Bestelnummer: ${notice.orderNumber}`,
    `Producten:    ${notice.products}`,
    `Ontvangen op: ${notice.receivedOn}`,
    `Opmerkingen:  ${notice.remarks || '(geen)'}`,
    '',
    `Ingediend: ${notice.submittedAt}`,
  ].join('\n');

  const shopNotified = await send(
    env,
    {
      to: shopTo,
      subject: `Herroeping: bestelling ${notice.orderNumber}`,
      text: lines,
      replyTo: notice.email,
    },
    fetcher,
  );
  if (!shopNotified) return {shopNotified: false, receiptSent: false};

  const receiptSent = await send(
    env,
    {
      to: notice.email,
      subject: CONFIRM_SUBJECT[notice.locale],
      text: [
        CONFIRM_BODY[notice.locale],
        '',
        `Submitted / Ingediend / Envoyé: ${notice.submittedAt}`,
        `Name: ${notice.name}`,
        `Email: ${notice.email}`,
        `Order: ${notice.orderNumber}`,
        `Products: ${notice.products}`,
        `Received on: ${notice.receivedOn || '-'}`,
        `Remarks: ${notice.remarks || '-'}`,
        '',
        'Incutec BV, Stapelhuisstraat 15, 3000 Leuven, Belgium',
        'contact@opendrone.be',
      ].join('\n'),
    },
    fetcher,
  );
  return {shopNotified, receiptSent};
}
