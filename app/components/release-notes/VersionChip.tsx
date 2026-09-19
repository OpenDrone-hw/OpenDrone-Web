/**
 * Reads from article tags. First tag matching /^v[\w.-]+$/ becomes the
 * chip. `rush-r1` and similar non-v-prefixed release codes are also
 * accepted via an optional fallback set so we don't have to retag old
 * articles. When no version is found the component returns null - the
 * row layout reserves space, the post page meta hides cleanly.
 */

const VERSION_PATTERN = /^v[\w.-]+$/i;
const KNOWN_RELEASE_CODES = /^(rush-r\d+|hf-r\d+)$/i;

export function pickVersionTag(tags: readonly string[]): string | null {
  for (const t of tags) {
    if (VERSION_PATTERN.test(t)) return t;
    if (KNOWN_RELEASE_CODES.test(t)) return t;
  }
  return null;
}

export function VersionChip({version}: {version: string | null | undefined}) {
  if (!version) return null;
  return <span className="rn-version">{version}</span>;
}
