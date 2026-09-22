import {data, useLoaderData, Form, useActionData, useNavigation} from 'react-router';
import type {Route} from './+types/herroepingsrecht';
import {LegalPage} from '~/components/LegalPage';
import {alternateLocaleTags, legalLabels, resolveLegalLoader, seoLocaleTag} from '~/lib/i18n';
import {buildSeoMeta} from '~/lib/seo';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';
import {sendWithdrawalNotice, type WithdrawalNotice} from '~/lib/withdrawal-email';

export const meta: Route.MetaFunction = ({data: loaderData}) => {
  const locale = loaderData?.locale ?? 'en';
  const labels = legalLabels('herroepingsrecht', locale);
  return buildSeoMeta({
    title: labels.title,
    description: labels.description,
    locale: seoLocaleTag(locale),
    alternateLocales: alternateLocaleTags(locale),
    canonical: loaderData?.canonicalUrl,
    hreflang: loaderData?.hreflang,
  });
};

export async function loader({request}: Route.LoaderArgs) {
  return resolveLegalLoader(
    request,
    'herroepingsformulier',
    'herroepingsrecht',
  );
}

type WithdrawResult = {
  ok: boolean;
  message?: string;
  submittedAt?: string;
  receiptSent?: boolean;
  /** The notice did not reach the shop: nothing is recorded. */
  notSent?: boolean;
};

/**
 * Online withdrawal function (Directive (EU) 2023/2673, new CRD Art. 11a,
 * applicable from 19 June 2026 to all distance contracts with a statutory
 * withdrawal right; Belgian transposition pending, so no WER article is cited
 * here). The action records the statement, emails the shop and sends the
 * consumer an acknowledgement of receipt with the full content and timestamp.
 * The shop notice is the record: if it cannot be sent, the page says the
 * withdrawal did not reach the shop and asks the consumer to email it,
 * keeping what they typed. If only the acknowledgement fails, the page says
 * so and shows the timestamp instead of pretending a receipt is on its way.
 */
export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<WithdrawResult>({ok: false, message: 'Method not allowed.'}, {status: 405});
  }
  const env = context.env as unknown as Record<string, string | undefined>;
  const form = await request.formData();

  // Honeypot: real users never fill this hidden field. Reject explicitly
  // rather than fake a success, so a false positive is visible to the user.
  if (String(form.get('website') || '') !== '') {
    return data<WithdrawResult>(
      {ok: false, message: 'Submission rejected. Please email contact@opendrone.be.'},
      {status: 400},
    );
  }

  const ip = clientIp(request);
  const emailKey = String(form.get('email') || '').trim().toLowerCase().slice(0, 200);
  const limited = checkRateLimit(`withdraw:${ip}:${emailKey}`, 10, 60 * 60 * 1000);
  if (!limited.allowed) {
    return data<WithdrawResult>(
      {ok: false, message: 'Too many submissions. Please try again later or email contact@opendrone.be.'},
      {status: 429},
    );
  }

  const locale = (['nl', 'en', 'fr'] as const).find(
    (l) => l === String(form.get('locale') || ''),
  ) ?? 'en';
  const notice: WithdrawalNotice = {
    name: String(form.get('name') || '').trim().slice(0, 200),
    email: String(form.get('email') || '').trim().slice(0, 200),
    orderNumber: String(form.get('order') || '').trim().slice(0, 100),
    products: String(form.get('products') || '').trim().slice(0, 1000),
    receivedOn: String(form.get('received') || '').trim().slice(0, 40),
    remarks: String(form.get('remarks') || '').trim().slice(0, 2000),
    locale,
    submittedAt: new Date().toISOString(),
  };

  if (!notice.name || !notice.email.includes('@') || !notice.orderNumber || !notice.products) {
    return data<WithdrawResult>(
      {ok: false, message: 'Please fill in name, email, order number and products.'},
      {status: 400},
    );
  }

  const {shopNotified, receiptSent} = await sendWithdrawalNotice(env, notice);
  if (!shopNotified) {
    console.error('[withdrawal] shop notice not sent', {
      order: notice.orderNumber,
      submittedAt: notice.submittedAt,
    });
    return data<WithdrawResult>(
      {ok: false, notSent: true, submittedAt: notice.submittedAt},
      {status: 503},
    );
  }
  if (!receiptSent) {
    console.error('[withdrawal] receipt email not sent', {
      order: notice.orderNumber,
      submittedAt: notice.submittedAt,
    });
  }
  return data<WithdrawResult>({ok: true, submittedAt: notice.submittedAt, receiptSent});
}

const FORM_COPY = {
  nl: {
    heading: 'Herroeping online indienen',
    intro: 'Vul dit formulier in om uw herroeping rechtstreeks via de website in te dienen. U ontvangt per e-mail een ontvangstbevestiging.',
    name: 'Naam',
    email: 'E-mailadres',
    order: 'Bestelnummer',
    products: 'Product(en) waarop de herroeping betrekking heeft',
    received: 'Ontvangen op (datum)',
    remarks: 'Opmerkingen (optioneel)',
    submit: 'Herroeping bevestigen',
    submitting: 'Versturen…',
    done: 'Uw herroeping is ingediend. U ontvangt binnen enkele minuten een ontvangstbevestiging per e-mail.',
    noReceipt: 'Uw herroeping is geregistreerd, maar de bevestigingsmail kon niet worden verzonden. Bewaar deze pagina (schermafbeelding) als bewijs of mail contact@opendrone.be met het tijdstip hieronder.',
    stamp: 'Geregistreerd op',
    notSent: 'Uw herroeping kon niet worden verzonden en is dus niet bij ons aangekomen. Mail ze naar contact@opendrone.be met uw naam, bestelnummer en de producten. Een herroeping per e-mail geldt evenzeer.',
  },
  en: {
    heading: 'Submit your withdrawal online',
    intro: 'Use this form to submit your withdrawal directly through the website. You will receive a confirmation of receipt by email.',
    name: 'Name',
    email: 'Email address',
    order: 'Order number',
    products: 'Product(s) the withdrawal concerns',
    received: 'Received on (date)',
    remarks: 'Remarks (optional)',
    submit: 'Confirm withdrawal',
    submitting: 'Sending…',
    done: 'Your withdrawal has been submitted. A confirmation of receipt will arrive by email within a few minutes.',
    noReceipt: 'Your withdrawal was recorded, but the confirmation email could not be sent. Keep this page (screenshot) as proof or email contact@opendrone.be quoting the timestamp below.',
    stamp: 'Recorded at',
    notSent: 'Your withdrawal could not be sent, so it has not reached us. Email it to contact@opendrone.be with your name, order number and the products. A withdrawal by email counts just the same.',
  },
  fr: {
    heading: 'Exercer votre rétractation en ligne',
    intro: 'Utilisez ce formulaire pour exercer votre rétractation directement via le site. Vous recevrez une confirmation de réception par courriel.',
    name: 'Nom',
    email: 'Adresse électronique',
    order: 'Numéro de commande',
    products: 'Produit(s) concerné(s) par la rétractation',
    received: 'Reçu le (date)',
    remarks: 'Remarques (facultatif)',
    submit: 'Confirmer la rétractation',
    submitting: 'Envoi…',
    done: 'Votre rétractation a été envoyée. Une confirmation de réception vous parviendra par courriel dans quelques minutes.',
    noReceipt: 'Votre rétractation a été enregistrée, mais le courriel de confirmation n’a pas pu être envoyé. Conservez cette page (capture d’écran) comme preuve ou écrivez à contact@opendrone.be en citant l’horodatage ci-dessous.',
    stamp: 'Enregistrée le',
    notSent: 'Votre rétractation n’a pas pu être envoyée et ne nous est donc pas parvenue. Envoyez-la à contact@opendrone.be avec votre nom, votre numéro de commande et les produits. Une rétractation par courriel est tout aussi valable.',
  },
} as const;

function WithdrawalForm({locale}: {locale: 'nl' | 'en' | 'fr'}) {
  const copy = FORM_COPY[locale];
  const result = useActionData<WithdrawResult>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';

  if (result?.ok) {
    return (
      <div id="withdraw" className="rich-content mt-10 rounded border border-[var(--color-border)] p-6">
        <p>{result.receiptSent ? copy.done : copy.noReceipt}</p>
        {result.submittedAt ? (
          <p className="font-mono text-xs">
            {copy.stamp}: {result.submittedAt}
          </p>
        ) : null}
      </div>
    );
  }

  const field =
    'w-full rounded border border-[var(--color-border)] bg-transparent px-3 py-2 text-[var(--color-text)]';
  return (
    <Form method="post" id="withdraw" className="mt-10 max-w-xl space-y-4">
      <h2 className="font-mono text-[13px] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
        {copy.heading}
      </h2>
      <p className="text-sm text-[var(--color-text-muted)]">{copy.intro}</p>
      {result?.notSent ? (
        <p className="text-sm text-red-500" role="alert">{copy.notSent}</p>
      ) : result?.message ? (
        <p className="text-sm text-red-500" role="alert">{result.message}</p>
      ) : null}
      <input type="hidden" name="locale" value={locale} />
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
      <label className="block text-sm">
        {copy.name}
        <input required name="name" className={field} autoComplete="name" />
      </label>
      <label className="block text-sm">
        {copy.email}
        <input required type="email" name="email" className={field} autoComplete="email" />
      </label>
      <label className="block text-sm">
        {copy.order}
        <input required name="order" className={field} />
      </label>
      <label className="block text-sm">
        {copy.products}
        <input required name="products" className={field} />
      </label>
      <label className="block text-sm">
        {copy.received}
        <input type="date" name="received" className={field} />
      </label>
      <label className="block text-sm">
        {copy.remarks}
        <textarea name="remarks" rows={3} className={field} />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-[var(--color-accent)] px-5 py-2 font-mono text-[13px] uppercase tracking-[0.15em] text-[var(--color-on-accent)] disabled:opacity-50"
      >
        {busy ? copy.submitting : copy.submit}
      </button>
    </Form>
  );
}

export default function HerroepingsrechtRoute() {
  const {html, locale} = useLoaderData<typeof loader>();
  const labels = legalLabels('herroepingsrecht', locale);
  return (
    <LegalPage
      eyebrow={labels.eyebrow}
      title={labels.title}
      html={html}
      locale={locale}
    >
      <WithdrawalForm locale={locale} />
    </LegalPage>
  );
}
