import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {useFetcher} from 'react-router';
import {Check} from 'lucide-react';
import {useTurnstile} from '~/lib/use-turnstile';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

// Engineering Essentials - dual-purpose: product-release announcements and
// engineering content digest. Posts to app/routes/newsletter._index.tsx,
// which records SINGLE opt-in consent in Shopify, the consent owner. There is
// no confirmation step and the storefront sends no mail of its own: the
// address is on the list the moment the action returns.
//
// Bot protection: honeypot field + Cloudflare Turnstile. The Turnstile
// widget + script are lazy-loaded only after the visitor focuses the email
// input - the form lives in every page footer, so loading the script
// unconditionally would tax the main site bundle for visitors who never
// intend to subscribe.

type NewsletterActionData = {
  ok: boolean;
  message: string;
};

interface NewsletterSignupProps {
  variant?: 'compact' | 'wide' | 'footer';
  className?: string;
  /** Cloudflare Turnstile public site key - widget is skipped when null. */
  turnstileSiteKey?: string | null;
  /**
   * Coming-soon mode: "Notify me at launch" for one product. Posts the same
   * newsletter action with a hidden `product` field so the subscriber gets a
   * `notify-<handle>` tag on the Resend contact. Registering interest in
   * the SKU is the point, not the subscription itself.
   */
  notify?: {
    productHandle: string;
    productTitle: string;
    /** A sold-out product that already sold: "email me when it is back in
     *  stock" instead of the launch-list wording. */
    restock?: boolean;
  } | null;
}

export function NewsletterSignup({
  variant = 'compact',
  className = '',
  turnstileSiteKey = null,
  notify = null,
}: NewsletterSignupProps) {
  const fetcher = useFetcher<NewsletterActionData>();
  const formRef = useRef<HTMLFormElement>(null);
  const emailId = useId();
  const consentId = useId();
  const statusId = useId();
  const [clientError, setClientError] = useState<string | null>(null);
  const [interacted, setInteracted] = useState(false);
  const {containerRef: turnstileContainerRef, reset: resetTurnstile} =
    useTurnstile(turnstileSiteKey, interacted);

  // First-touch channel for the server-side growth ledger (Lane B).
  // Attribution lives in sessionStorage, so read it after hydration to
  // keep server and client markup identical.
  const [channel, setChannel] = useState('direct');
  useEffect(() => {
    setChannel(attributionSource());
  }, []);

  const isSubmitting = fetcher.state !== 'idle';
  const result = fetcher.data;
  const serverMessage = result?.message ?? null;
  const isSuccess = result?.ok === true;
  const isError = result?.ok === false;

  // Funnel event: one `Notify Signup` per successful submit. The ref guard
  // stops re-fires from unrelated re-renders while fetcher.data persists;
  // it re-arms when a new submit starts (isSuccess drops to false).
  const signupTracked = useRef(false);
  const notifyHandle = notify?.productHandle;
  useEffect(() => {
    if (!isSuccess) {
      signupTracked.current = false;
      return;
    }
    if (signupTracked.current) return;
    signupTracked.current = true;
    trackEvent('Notify Signup', {
      props: {
        product: notifyHandle ?? 'newsletter',
        source: attributionSource(),
      },
    });
  }, [isSuccess, notifyHandle]);

  // A Turnstile token is single-use: Cloudflare answers `timeout-or-duplicate`
  // the second time one is presented. Reset the widget on EVERY server answer,
  // not just a successful one, or a rejected submit leaves the spent token in
  // the form and every retry fails verification until the page is reloaded.
  // Only a success clears the fields.
  useEffect(() => {
    if (!result) return;
    if (isSuccess) {
      formRef.current?.reset();
      setClientError(null);
    }
    resetTurnstile();
  }, [result, isSuccess, resetTurnstile]);

  // The Turnstile script loads on the first interaction (useTurnstile):
  // the form is in every footer and most visitors never submit it.

  const markInteracted = useCallback(() => {
    if (!interacted) setInteracted(true);
  }, [interacted]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const email = (
      form.elements.namedItem('email') as HTMLInputElement | null
    )?.value.trim();
    const consent =
      (form.elements.namedItem('consent') as HTMLInputElement | null)
        ?.checked ?? false;

    if (!email) {
      event.preventDefault();
      setClientError(
        copyText('newsletter.signup_error_email') ??
          'Enter your email address.',
      );
      return;
    }
    if (!consent) {
      event.preventDefault();
      setClientError(
        copyText('newsletter.signup_error_consent') ??
          'Please confirm you want to receive updates.',
      );
      return;
    }
    setClientError(null);
  }

  const isWide = variant === 'wide';
  const isFooter = variant === 'footer';
  const isNotify = Boolean(notify);
  const isRestock = Boolean(notify?.restock);
  // Restock wording: copy keys with plain fallbacks until the copy file
  // carries them.
  const say = (key: string, fallback: string) =>
    copyText(`newsletter.${key}`) ?? fallback;
  // Notify mode never short-circuits to the subscribed panel: an existing
  // subscriber still needs to submit to get the per-product notify tag.
  const message = clientError ?? serverMessage;
  const messageTone = clientError
    ? 'error'
    : isSuccess
      ? 'success'
      : isError
        ? 'error'
        : null;

  return (
    <section
      aria-labelledby={`${emailId}-heading`}
      className={[
        'newsletter-signup',
        isWide
          ? 'border border-[var(--color-border)] bg-[var(--color-bg-card)] p-8 md:p-10 rounded-sm'
          : '',
        isFooter
          ? 'grid grid-cols-1 md:grid-cols-[1fr_minmax(0,28rem)] gap-4 md:gap-8 md:items-center'
          : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div>
        {isRestock ? (
          <p className="gold-tag font-mono text-[12px] uppercase tracking-[0.2em] text-[var(--color-gold-text)] mb-0.5">
            {say('signup_eyebrow_restock', 'Back in stock')}
          </p>
        ) : (
          <Txt
            id={
              isNotify
                ? 'newsletter.signup_eyebrow_notify'
                : 'newsletter.signup_eyebrow'
            }
            as="p"
            className={`font-mono text-[12px] uppercase tracking-[0.2em] mb-0.5 ${isFooter ? 'text-[var(--color-text-muted)]' : 'gold-tag text-[var(--color-gold-text)]'}`}
          />
        )}
        {/* The heading keeps its DOM id in code: `aria-labelledby` on the
            section points at it, and <Txt> spends its own `id` prop on the
            copy key. */}
        <h3
          id={`${emailId}-heading`}
          className={
            isWide
              ? 'font-display text-2xl md:text-3xl font-bold tracking-tight text-[var(--color-text)] mb-2'
              : 'font-display text-sm font-bold tracking-[0.04em] uppercase text-[var(--color-text)] mb-0.5'
          }
        >
          {isRestock ? (
            say('signup_title_restock', 'Email me when it can be ordered.')
          ) : (
            <Txt
              id={
                isNotify
                  ? 'newsletter.signup_title_notify'
                  : 'newsletter.signup_title'
              }
            />
          )}
        </h3>
        <p
          className={
            isWide
              ? 'text-sm text-[var(--color-text-muted)] mb-6 max-w-prose leading-relaxed'
              : 'text-[12px] text-[var(--color-text-muted)] leading-snug'
          }
        >
          {isRestock ? (
            say(
              'signup_lede_restock',
              'One email when {product} can be ordered again, plus occasional engineering notes. One click to leave, any time.',
            ).replace('{product}', notify!.productTitle)
          ) : isNotify ? (
            <>
              <Txt id="newsletter.signup_lede_notify_before" />{' '}
              {notify!.productTitle}{' '}
              <Txt id="newsletter.signup_lede_notify_after" />
            </>
          ) : (
            <Txt id="newsletter.signup_lede" />
          )}
        </p>
      </div>

      {isNotify && isSuccess ? (

        <div className="flex flex-col gap-1">
          <p
            role="status"
            className="gold-tag inline-flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.14em] text-[var(--color-gold-text)]"
          >
            <Check size={13} strokeWidth={2.5} aria-hidden="true" />
            {isRestock ? (
              say('signup_restock_badge', 'We will email you')
            ) : (
              <Txt id="newsletter.signup_notify_badge" />
            )}
          </p>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-snug">
            {isRestock
              ? say(
                  'signup_restock_done',
                  'You are on the list. We will email you when this product is back in stock.',
                )
              : serverMessage}
          </p>
        </div>
      ) : (
      <fetcher.Form
        ref={formRef}
        method="post"
        action="/newsletter"
        onSubmit={handleSubmit}
        className={
          isWide
            ? 'flex flex-col gap-3 md:max-w-xl'
            : 'flex flex-col gap-2'
        }
        noValidate
      >
        {notify ? (
          <input type="hidden" name="product" value={notify.productHandle} />
        ) : null}
        <input type="hidden" name="channel" value={channel} />

        {/* Honeypot - hidden from humans, visible to bots */}
        <label className="sr-only" aria-hidden="true">
          Website
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
          />
        </label>

        <div
          className={
            isWide || isFooter
              ? 'flex flex-col sm:flex-row gap-2'
              : 'flex flex-col gap-2'
          }
        >
          <Txt
            id="newsletter.signup_email_label"
            as="label"
            htmlFor={emailId}
            className="sr-only"
          />
          <input
            id={emailId}
            type="email"
            name="email"
            required
            autoComplete="email"
            inputMode="email"
            placeholder={copyText('newsletter.signup_email_placeholder')}
            disabled={isSubmitting}
            onFocus={markInteracted}
            onChange={markInteracted}
            aria-describedby={message ? statusId : undefined}
            aria-invalid={messageTone === 'error' || undefined}
            className={[
              'flex-1 bg-[var(--color-bg)] border border-[var(--color-border)]',
              'text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]',
              'font-mono text-sm px-3 py-2.5 min-h-[44px] rounded-sm',
              'focus:outline-none focus:border-[var(--color-gold)]',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            ].join(' ')}
          />
          <button
            type="submit"
            disabled={isSubmitting}
            className={[
              'font-mono text-xs uppercase tracking-[0.14em] font-bold',
              // The footer form sits under every page's own gold action, so
              // it takes a neutral outline: gold stays on the page's action.
              isFooter
                ? 'border border-[var(--color-border-strong)] text-[var(--color-text)] bg-transparent hover:border-[var(--color-text)]'
                : 'bg-[var(--color-gold-fill)] text-[var(--color-on-accent)] hover:bg-[var(--color-gold-fill-hover)]',
              'px-5 py-2.5 min-h-[44px] inline-flex items-center justify-center rounded-sm',
              'transition-colors',
              'disabled:opacity-60 disabled:cursor-not-allowed',
              isWide || isFooter ? 'sm:shrink-0' : '',
            ].join(' ')}
          >
            <Txt
              id={
                isNotify
                  ? isSubmitting
                    ? 'newsletter.signup_submit_notify_busy'
                    : 'newsletter.signup_submit_notify'
                  : isSubmitting
                    ? 'newsletter.signup_submit_busy'
                    : 'newsletter.signup_submit'
              }
            />
          </button>
        </div>

        <label
          htmlFor={consentId}
          className="flex items-start gap-2 text-[12px] text-[var(--color-text-muted)] leading-snug cursor-pointer select-none"
        >
          <input
            id={consentId}
            type="checkbox"
            name="consent"
            required
            disabled={isSubmitting}
            onChange={markInteracted}
            className="mt-0.5 accent-[var(--color-gold)] cursor-pointer"
          />
          <span>
            <Txt id="newsletter.signup_consent" />{' '}
            <a
              href="/privacy"
              className="underline underline-offset-2 hover:text-[var(--color-text)]"
            >
              <Txt id="newsletter.signup_consent_link" />
            </a>
            .
          </span>
        </label>

        {turnstileSiteKey && interacted ? (
          <div
            ref={turnstileContainerRef}
            className="mt-1"
            data-testid="newsletter-turnstile"
          />
        ) : null}

        {message ? (
          <p
            id={statusId}
            role={messageTone === 'error' ? 'alert' : 'status'}
            className={[
              'font-mono text-[12px] mt-1',
              messageTone === 'success'
                ? 'text-[var(--color-accent-light)]'
                : messageTone === 'error'
                  ? 'text-[var(--color-error)]'
                  : 'text-[var(--color-text-muted)]',
            ].join(' ')}
          >
            {message}
          </p>
        ) : null}
      </fetcher.Form>
      )}
    </section>
  );
}
