/**
 * /learn - the FPV knowledge layer.
 *
 * The corpus in `app/content/learn/` is RESEARCH, not published prose: one
 * claim per bullet, each carrying its source URL(s) and a confidence tag
 * (`[verified]` = two independent sources or one primary; `[single]` = one
 * secondary source; `[lore]` = community-repeated, undocumented). The chapters
 * described in the lane plan get written FROM this material; until then the
 * route renders the research itself, with every source and tag visible, so the
 * page doubles as the review surface for deciding what is actually true.
 *
 * Because of that the route is draft-gated (see `learnDraftEnabled`) and
 * noindex. Nothing here is customer-facing copy yet.
 *
 * The parser is pure and file-system free so `node --test` can exercise it;
 * the corpus itself is reached through a LAZY glob so each dossier lands in its
 * own chunk. The bodies total ~1 MB, which must not sit in the worker's entry
 * bundle.
 */

export type Confidence = 'verified' | 'single' | 'lore' | 'untagged';

/** One researched claim: the sentence, where it came from, how well it stands up. */
export type Claim = {
  /**
   * Stable anchor within the dossier, `<section-id>-<n>`. A reviewer disputing
   * a single line needs a URL for that line, not for the section it sits in.
   * Assigned by `parseDossier`; `parseClaim` alone leaves it empty.
   */
  id: string;
  /** Claim text with the trailing `Source:` block and tag removed. */
  text: string;
  /** Every http(s) source cited on the bullet, in order, deduped. */
  sources: string[];
  confidence: Confidence;
  /** Whatever qualified the tag, e.g. `primary` from `[verified, primary]`. */
  note: string;
};

/** A non-claim block under a heading: narration, or a data table. */
export type Block =
  | {kind: 'prose'; text: string}
  | {kind: 'table'; head: string[]; rows: string[][]};

export type Section = {
  /** Markdown heading level, 2..6. */
  level: number;
  heading: string;
  /** Stable anchor id for deep links. */
  id: string;
  /** Everything under the heading that is not a claim, in order. */
  blocks: Block[];
  claims: Claim[];
};

export type Dossier = {
  slug: string;
  title: string;
  /** Paragraphs before the first `##`, usually the method note. */
  intro: string[];
  sections: Section[];
  counts: Record<Confidence, number>;
  /** Claims whose only citation is OpenBrain's own fact pool. */
  circular: number;
};

/** Index metadata. Order is the reading order, not the research file order. */
export type DossierMeta = {
  slug: string;
  title: string;
  /** One line, plain: what this dossier covers. */
  blurb: string;
  /**
   * Which chapter of the planned Field Guide this feeds. Kept explicit so the
   * gap between "research exists" and "chapter written" stays visible.
   */
  feeds: string;
};

export const LEARN_DOSSIERS: readonly DossierMeta[] = [
  {
    slug: 'loop-ladder',
    title: 'The control loop ladder',
    blurb:
      'The quantitative spine: every loop in a drone, from MOSFET switching at tens of kHz down to the human in the goggles at a few Hz.',
    feeds: 'Chapter 1, The map',
  },
  {
    slug: 'origins-analog-era',
    title: 'Origins and the analog era',
    blurb:
      'How FPV started, roughly 1989 to 2013: ham ATV experimenters, the first video downlinks, the forums that turned it into a hobby.',
    feeds: 'Chapter 0, History',
  },
  {
    slug: 'flight-controllers',
    title: 'Flight controllers',
    blurb:
      'The firmware family tree from MultiWii and Baseflight through Cleanflight to Betaflight and iNav, with the forks dated from commit history.',
    feeds: 'Chapter 4, The flight controller',
  },
  {
    slug: 'escs',
    title: 'ESCs',
    blurb:
      'Reflashable ESCs, tgy/SimonK, the BLHeli line and its 2024 shutdown, DShot, AM32, and what "sinusoidal" actually means.',
    feeds: 'Chapter 3, Motors and ESCs',
  },
  {
    slug: 'radio-links',
    title: 'Radio links',
    blurb:
      'From 27/35/72 MHz crystals and frequency pins to 2.4 GHz spread spectrum, LoRa and ExpressLRS.',
    feeds: 'Chapter 5, The radio link',
  },
  {
    slug: 'video-systems',
    title: 'Video systems',
    blurb:
      'Analog versus digital as an engineering tradeoff: latency, bandwidth, graceful degradation, DJI, HDZero, Walksnail.',
    feeds: 'Chapter 6, Video',
  },
  {
    slug: 'retail-manufacturers',
    title: 'Retail and manufacturers',
    blurb:
      'Who actually makes and sells this hardware, how the retail layer formed, and where the money goes.',
    feeds: 'Chapter 0, History',
  },
  {
    slug: 'racing-media',
    title: 'Racing and media',
    blurb:
      'Drone racing leagues, the freestyle scene, and the YouTube educators who became the hobby de-facto documentation.',
    feeds: 'Chapter 0, History',
  },
  {
    slug: 'regulation',
    title: 'Regulation',
    blurb:
      'EU, US and national rules: what changed, when, and which of it actually binds a hobbyist.',
    feeds: 'Chapter 0, History',
  },
  {
    slug: 'market-geopolitics',
    title: 'Market and geopolitics',
    blurb:
      'Market size estimates with their methodology attached, supply concentration, and the export-control pressure on the hobby.',
    feeds: 'Chapter 0, History',
  },
] as const;

const BY_SLUG = new Map(LEARN_DOSSIERS.map((d) => [d.slug, d]));

export function dossierMeta(slug: string): DossierMeta | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Lazy glob: each dossier compiles to its own chunk and is fetched only when
 * its route is hit. Absent under `node --test`, where `import.meta.env` is
 * undefined - same guarded-glob pattern as `app/lib/votes.ts`.
 */
const BODIES = import.meta.env
  ? import.meta.glob<string>('/app/content/learn/*.md', {
      query: '?raw',
      import: 'default',
    })
  : {};

/** Raw markdown for one dossier, or null when the slug is unknown. */
export async function loadDossierSource(slug: string): Promise<string | null> {
  if (!BY_SLUG.has(slug)) return null;
  const load = BODIES[`/app/content/learn/${slug}.md`];
  if (!load) return null;
  return await load();
}

// ---- parsing -------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** The `|---|:--:|` line that separates a table header from its body. */
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
const BULLET = /^-\s+(.*)$/;
const RULE = /^-{3,}\s*$/;
const TAG = /\[(verified|single|lore)\b([^\]]*)\]/gi;
/**
 * A URL, without the sentence punctuation that follows it. The last character
 * may not be `.,;:)]` - those belong to the prose, and swallowing a closing
 * paren both breaks the link and strands its opening half in the claim text.
 */
const URL_RE = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:)\]]/g;

/**
 * Separators a lifted URL or tag leaves dangling. Deliberately excludes `.`:
 * the claim's own full stop is part of the sentence, not the citation.
 */
const DANGLING = /[\s,;]+$/;

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*_]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'section'
  );
}

/**
 * Split one bullet into its claim, its citations and its confidence.
 *
 * The corpus is not perfectly uniform: the tag may sit mid-bullet or at the
 * end, sources may be introduced by `Source:` or dropped in bare, and a bullet
 * may carry several URLs. Everything cited is lifted out, and what remains is
 * the sentence a reader should actually read.
 */
export function parseClaim(bullet: string): Claim {
  let text = bullet.trim();

  let confidence: Confidence = 'untagged';
  let note = '';
  for (const m of text.matchAll(TAG)) {
    confidence = m[1].toLowerCase() as Confidence;
    note = m[2].replace(/^[\s,:;]+/, '').trim();
  }
  text = text.replace(TAG, ' ');

  const sources = [...new Set(text.match(URL_RE) ?? [])];
  text = text.replace(URL_RE, ' ');

  // Drop the citation apparatus itself. `Source:` (and its plural) introduces
  // the block we just emptied; a lone parenthetical left behind by a lifted URL
  // is noise, but a parenthetical with words in it is the researcher's own
  // qualifier and stays.
  text = text
    .replace(/\(\s*[,;.\s]*\)/g, ' ')
    .replace(/\s*\bSources?\s*:\s*(?=(\s|$))/gi, ' ')
    .replace(/\s*\bSources?\s*:\s*$/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(DANGLING, '');

  // A bullet that was nothing but its citation has no claim to show.
  return {id: '', text, sources, confidence, note};
}

/**
 * A claim whose only support is OpenBrain's own pool is circular: it came out
 * of the fact pool, so feeding it back in would manufacture corroboration for
 * a fact that is its own source. Flagged here, dropped at ingest.
 */
export function isCircular(claim: Claim): boolean {
  return claim.sources.length === 0 && /\bopenbrain\b/i.test(claim.text);
}

export function parseDossier(slug: string, src: string): Dossier {
  const meta = BY_SLUG.get(slug);
  const lines = src.split(/\r?\n/);

  let title = meta?.title ?? slug;
  let sawTitle = false;
  const intro: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  let bullet: string | null = null;
  let para: string[] = [];
  let table: string[] = [];

  const target = () => (current ? current.claims : null);

  const flushBullet = () => {
    if (bullet === null) return;
    const claim = parseClaim(bullet);
    bullet = null;
    if (!claim.text) return;
    const t = target();
    if (!t) {
      intro.push(claim.text);
      return;
    }
    claim.id = `${current!.id}-${t.length + 1}`;
    t.push(claim);
  };
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(' ').trim();
    para = [];
    if (current) current.blocks.push({kind: 'prose', text});
    else intro.push(text);
  };

  const cells = (row: string) =>
    row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  /** A table needs a header, a `|---|` separator and one body row to be one. */
  const flushTable = () => {
    const buf = table;
    table = [];
    if (!buf.length) return;
    if (!current || buf.length < 3 || !TABLE_SEP.test(buf[1])) {
      for (const line of buf) current?.blocks.push({kind: 'prose', text: line});
      return;
    }
    current.blocks.push({
      kind: 'table',
      head: cells(buf[0]),
      rows: buf.slice(2).map(cells),
    });
  };

  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      flushBullet();
      flushTable();
      flushPara();
      const level = h[1].length;
      const heading = h[2].trim();
      if (level === 1 && !sawTitle) {
        title = heading;
        sawTitle = true;
        continue;
      }
      current = {
        level,
        heading,
        id: slugifyHeading(heading),
        blocks: [],
        claims: [],
      };
      sections.push(current);
      continue;
    }

    if (RULE.test(line)) {
      flushBullet();
      flushTable();
      flushPara();
      continue;
    }

    // A table is an unbroken run of pipe rows inside a section. Anything else
    // ends the run, and `flushTable` decides whether what was collected was
    // really a table or just prose that happened to contain pipes.
    if (current && bullet === null && TABLE_ROW.test(line)) {
      flushPara();
      table.push(line);
      continue;
    }
    if (table.length) flushTable();

    const b = BULLET.exec(line);
    if (b) {
      flushBullet();
      flushPara();
      bullet = b[1];
      continue;
    }

    if (!line.trim()) {
      flushBullet();
      flushPara();
      continue;
    }

    // Indented continuation belongs to the open bullet; anything at column 0
    // is prose.
    if (bullet !== null && /^\s+\S/.test(line)) {
      bullet += ' ' + line.trim();
      continue;
    }
    flushBullet();
    para.push(line.trim());
  }
  flushBullet();
  flushTable();
  flushPara();

  const counts: Record<Confidence, number> = {
    verified: 0,
    single: 0,
    lore: 0,
    untagged: 0,
  };
  let circular = 0;
  for (const s of sections) {
    for (const c of s.claims) {
      counts[c.confidence]++;
      if (isCircular(c)) circular++;
    }
  }

  return {slug, title, intro, sections, counts, circular};
}

/** Total claims across every section. */
export function claimCount(d: Dossier): number {
  return d.sections.reduce((n, s) => n + s.claims.length, 0);
}

/** Host shown on a source chip, e.g. `github.com`. Falls back to the raw URL. */
export function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ---- the draft gate ------------------------------------------------------

/**
 * `/learn` is unreviewed research. It renders in dev always, and in a deployed
 * build only when `PUBLIC_LEARN_DRAFT=1` is set, so nothing reaches a customer
 * before the fact-check pass the lane plan requires. Production without the
 * flag gets a 404, not a redirect: an unlisted page should not advertise that
 * it exists.
 */
export function learnDraftEnabled(env?: {PUBLIC_LEARN_DRAFT?: string}): boolean {
  if (import.meta.env?.DEV) return true;
  return env?.PUBLIC_LEARN_DRAFT === '1';
}
