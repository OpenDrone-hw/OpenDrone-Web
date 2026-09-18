/**
 * The editorial series: the long-form pages in the order they are meant to
 * be read. The index rail on every editorial page renders this list, so
 * adding an entry here is what puts a page in the sequence.
 *
 * Wholesale is deliberately absent. It is an editorial page by layout but
 * it addresses shops, not the reader this series is written for, and
 * dropping it into the middle of the story breaks the through-line. The
 * preorder explainer is absent for the same reason: it is the page a buyer
 * is sent to from a product page, not a chapter of the project's story.
 *
 * `minutes` is a reading estimate at ~200 wpm, measured against the
 * rendered `.editorial-page` text. It is stored rather than derived
 * because the rail advertises every page's length, not just the one being
 * read, and the other pages' copy is not in memory. Re-measure when a page
 * gains or loses a chapter; a minute of drift is not worth chasing.
 */
export type EditorialEntry = {
  /** Route path without the leading slash. */
  slug: string;
  title: string;
  /** Why this one is worth a reader's time. One line, shown in the rail. */
  hook: string;
  minutes: number;
};

export const EDITORIAL_SERIES: EditorialEntry[] = [
  {
    slug: 'open-source',
    title: 'Open Source',
    hook: 'Who designs the boards, who sells them, and why those are two different jobs.',
    minutes: 4,
  },
  {
    slug: 'production',
    title: 'Production',
    hook: 'Where the boards are made today, and what we intend to make ourselves.',
    minutes: 3,
  },
  {
    slug: 'roadmap',
    title: 'Roadmap',
    hook: 'Every product\'s status, the community vote, and where the money goes.',
    minutes: 3,
  },
  {
    slug: 'timeline',
    title: 'Timeline',
    hook: 'Everything that has actually shipped, dated.',
    minutes: 2,
  },
  {
    slug: 'firmware-partners',
    title: 'Firmware partners',
    hook: 'The projects our boards run on, and how to support them.',
    minutes: 1,
  },
];

export const SERIES_MINUTES = EDITORIAL_SERIES.reduce(
  (total, entry) => total + entry.minutes,
  0,
);

/** The entry after `slug`, or null at the end of the series. */
export function nextInSeries(slug: string): EditorialEntry | null {
  const i = EDITORIAL_SERIES.findIndex((e) => e.slug === slug);
  if (i < 0 || i === EDITORIAL_SERIES.length - 1) return null;
  return EDITORIAL_SERIES[i + 1];
}
