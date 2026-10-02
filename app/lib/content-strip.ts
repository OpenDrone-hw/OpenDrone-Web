/**
 * Authoring-only parts of the `content/` JSON: `$comment` (and
 * `$comment_<key>`) notes for editors
 * and entries marked `hidden: true` (a goal kept in the studio but not
 * shown). The production build drops both at import time
 * (`contentStripPlugin` in vite.config.ts), so neither reaches a client or
 * Worker bundle. The source files keep them.
 */
export function stripContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter(
        (entry) =>
          !(
            entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            (entry as {hidden?: unknown}).hidden === true
          ),
      )
      .map(stripContent);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('$comment'))
        .map(([key, entry]) => [key, stripContent(entry)]),
    );
  }
  return value;
}

/** Whether a module id is a JSON file under the repository `content/`. */
export function isContentJson(id: string): boolean {
  return /\/content\/.+\.json$/.test(id.split('?')[0]);
}
