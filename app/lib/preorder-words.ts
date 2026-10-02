/**
 * The words of `content/copy/preorder.json` for server code that cannot use
 * the studio-aware `copyText` (cart action, line properties): the same file,
 * read the way `us-sales.ts` reads its data, so Vite and node:test agree.
 */

import type {Words} from './availability.ts';

type CopyFile = Record<string, unknown>;

function load(): CopyFile {
  if (import.meta.env) {
    const files = import.meta.glob<{default: CopyFile}>('/content/copy/preorder.json', {eager: true});
    return Object.values(files)[0]?.default ?? {};
  }
  const fs = (
    globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}
  ).process?.getBuiltinModule?.('node:fs') as {readFileSync: (url: URL, encoding: string) => string} | undefined;
  // A joined path, so Vite does not emit the raw file as a public asset.
  return fs ? (JSON.parse(fs.readFileSync(new URL(['..', '..', 'content', 'copy', 'preorder.json'].join('/'), import.meta.url), 'utf8')) as CopyFile) : {};
}

const COPY = load();

/** Lookup for `availability.ts`: the copy value, else the English fallback. */
export const serverPreorderWords: Words = (key, fallback, vars = {}) => {
  const value = COPY[key];
  return (typeof value === 'string' ? value : fallback).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
};
