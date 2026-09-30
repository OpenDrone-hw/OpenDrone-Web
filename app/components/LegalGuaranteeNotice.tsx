import {useEffect, useRef, useState} from 'react';
import {useLocation} from 'react-router';
import {useLegalLocale} from './LangToggle';
import type {Locale} from '~/lib/i18n';
import {LEGAL_GUARANTEE_NOTICE} from '../lib/legal-guarantee-notice.ts';

const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  nl: 'Nederlands',
  fr: 'Français',
};

/** Shop-level reminder; the complete prescribed notice opens on one click. */
export function LegalGuaranteeNotice({isHomepage = false}: {isHomepage?: boolean}) {
  const pageLocale = useLegalLocale();
  const {pathname} = useLocation();
  const [locale, setLocale] = useState<Locale>(pageLocale);
  const [fit, setFit] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const notice = LEGAL_GUARANTEE_NOTICE[locale];

  useEffect(() => {
    dialog.current?.close();
  }, [pathname]);

  return (
    <div className={isHomepage
      ? 'absolute inset-x-0 top-[calc(var(--header-height)+1.25rem)] z-20 mx-auto flex w-[var(--rail-width)] justify-end'
      : 'mx-auto flex w-[var(--rail-width)] justify-end'}>
      <a
        href={LEGAL_GUARANTEE_NOTICE[pageLocale].assetPath}
        className={`inline-flex min-h-11 items-center px-2 text-sm underline underline-offset-4 hover:text-[var(--color-gold-text)]${isHomepage ? ' rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3' : ''}`}
        lang={pageLocale}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.preventDefault();
          setLocale(pageLocale);
          setFit(false);
          dialog.current?.showModal();
        }}
      >
        {LEGAL_GUARANTEE_NOTICE[pageLocale].reminder}
      </a>
      <dialog
        ref={dialog}
        lang={locale}
        aria-labelledby="legal-guarantee-title"
        className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-1rem)] max-w-[640px] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[var(--color-text)] shadow-2xl backdrop:bg-black/60"
      >
        <header className="mb-3 flex items-center justify-between gap-3">
          <h2 id="legal-guarantee-title" className="text-lg font-semibold">
            {notice.title}
          </h2>
          <button
            type="button"
            className="min-h-11 px-3 underline underline-offset-4"
            onClick={() => dialog.current?.close()}
          >
            {notice.close}
          </button>
        </header>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label={notice.language} className="flex flex-wrap gap-1">
            {(['en', 'nl', 'fr'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                lang={lang}
                aria-pressed={locale === lang}
                className={`min-h-11 rounded-md px-2 text-sm ${locale === lang ? 'bg-[var(--color-surface)] font-semibold underline underline-offset-4' : ''}`}
                onClick={() => setLocale(lang)}
              >
                {LANGUAGE_NAMES[lang]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="min-h-11 px-2 text-sm underline underline-offset-4"
            onClick={() => setFit((value) => !value)}
          >
            {fit ? notice.readable : notice.fit}
          </button>
        </div>
        {!fit ? <p className="mb-2 text-sm sm:hidden">{notice.scroll}</p> : null}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus is needed to scroll the full notice with the arrow keys. */}
        <div role="region" aria-label={notice.viewer} tabIndex={0} className="overflow-x-auto bg-white">
          <img
            src={notice.assetPath}
            alt={notice.image}
            width={595.28}
            height={841.89}
            loading="lazy"
            style={{width: fit ? '100%' : 600, maxWidth: fit ? '100%' : 'none', height: 'auto'}}
          />
        </div>
        <p className="my-3 text-sm">
          <a href={notice.url} className="underline underline-offset-4">{notice.more}</a>
        </p>
        <section className="text-base" aria-labelledby="legal-guarantee-text-title">
          <h3 id="legal-guarantee-text-title" className="font-semibold">
            {notice.textVersion}
          </h3>
          {notice.text.map((paragraph) => <p key={paragraph} className="my-3">{paragraph}</p>)}
        </section>
      </dialog>
    </div>
  );
}
