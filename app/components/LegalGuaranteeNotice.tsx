import type {Locale} from '~/lib/i18n';
import {LEGAL_GUARANTEE_NOTICE} from '../lib/legal-guarantee-notice.ts';

/** The official notice is part of the terms page, in its active language. */
export function LegalGuaranteeNotice({locale}: {locale: Locale}) {
  const notice = LEGAL_GUARANTEE_NOTICE[locale];

  return (
    <section id="legal-guarantee" lang={locale} aria-labelledby="legal-guarantee-title" className="mb-10 scroll-mt-24">
      <h2 id="legal-guarantee-title" className="mb-3 text-lg font-semibold">
        {notice.title}
      </h2>
      <a href={notice.assetPath} className="block w-full max-w-[600px] bg-white">
        <img
          src={notice.assetPath}
          alt={notice.image}
          width={595.28}
          height={841.89}
          className="h-auto w-full"
        />
      </a>
      <details className="my-4 text-base">
        <summary className="cursor-pointer underline underline-offset-4">
          {notice.textVersion}
        </summary>
        {notice.text.map((paragraph) => <p key={paragraph} className="my-3">{paragraph}</p>)}
      </details>
      <p className="text-sm">
        <a href={notice.url} className="underline underline-offset-4">{notice.more}</a>
      </p>
    </section>
  );
}
