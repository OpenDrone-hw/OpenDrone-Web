/**
 * `content/preorders.json` as data, for modules that read one fact from it
 * without parsing the campaign: read the way `email-shell.ts` reads it, so
 * Vite and node:test agree.
 */

type CampaignFile = {confirmed?: boolean; shipsBy?: string};

function load(): CampaignFile {
  if (import.meta.env) {
    const files = import.meta.glob<{default: CampaignFile}>('/content/preorders.json', {eager: true});
    const file = Object.values(files)[0]?.default;
    if (file) return file;
  }
  const fs = (
    globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}
  ).process?.getBuiltinModule?.('node:fs') as {readFileSync: (url: URL, encoding: string) => string} | undefined;
  if (!fs) return {};
  // A joined path, so Vite does not emit the raw file as a public asset.
  return JSON.parse(fs.readFileSync(new URL(['..', '..', 'content', 'preorders.json'].join('/'), import.meta.url), 'utf8')) as CampaignFile;
}

/**
 * The shop's campaign is confirmed (`confirmed` in `content/preorders.json`,
 * founder 2026-11-11, terms 2.9): a promise text that still names a target,
 * as orders placed before the confirmation carry it, reads as the confirmed
 * batch wherever only the text is at hand (cart line, account, mail).
 */
const FILE = load();

export const CAMPAIGN_CONFIRMED: boolean = FILE.confirmed === true;

/**
 * The pre-order batch's ship-by day, YYYY-MM-DD (`shipsBy` in
 * `content/preorders.json`): the one place the date is typed. Lines that name
 * it (the availability bar, /markets) read it from here.
 */
export const CAMPAIGN_SHIPS_BY: string = FILE.shipsBy ?? '';
