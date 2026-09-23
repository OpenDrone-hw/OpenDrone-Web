import {Link} from 'react-router';
import {copyText} from '~/lib/copy';
import {Txt} from '~/components/Txt';
import {partnerForProject} from '~/lib/firmware-partners';

/**
 * The PDP firmware chapter body: name the project the board runs, link its
 * source, and put its donation page one click away.
 *
 * This replaced the €1-per-board price-split block (cancelled 2026-08-11,
 * financially it did not carry). The support story now is exposure: our
 * product pages send buyers straight to the projects, donations go direct
 * with no middleman, and Incutec pays the certification sums and makes
 * occasional public donations on its own.
 */
export function FirmwareSupport({
  firmwareProject,
  firmwareUrl,
}: {
  firmwareProject?: string;
  firmwareUrl?: string;
}) {
  if (!firmwareProject) return null;
  const partner = partnerForProject(firmwareProject);
  const sourceUrl = firmwareUrl ?? partner?.repoUrl;

  // One editable sentence; the project name is data, so the copy marks its
  // slot with `{project}` and the sentence is split around it here.
  const bodyParts = (
    copyText('product-chrome.firmware_support_body') ?? ''
  ).split('{project}');

  return (
    <section
      className="firmware-support"
      aria-label={copyText('product-chrome.firmware_support_aria')}
    >
      <p className="chapter-body">
        {bodyParts[0]}
        <strong>{firmwareProject}</strong>
        {bodyParts[1]}
      </p>
      <p className="firmware-support-links">
        {partner?.donationUrl ? (
          <a
            href={partner.donationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="firmware-support-donate"
          >
            <Txt id="product-chrome.firmware_support_donate" />
          </a>
        ) : (
          <Txt
            id="product-chrome.firmware_support_no_donate"
            as="span"
            className="firmware-support-nodonate"
          />
        )}
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
            <Txt id="product-chrome.firmware_support_source" />
          </a>
        ) : null}
        <Link prefetch="viewport" to="/firmware-partners">
          <Txt id="product-chrome.firmware_support_all" />
        </Link>
      </p>
    </section>
  );
}
