/**
 * Ticket attachments: what the form accepts and the one check both the
 * browser (before upload) and the Worker (before Discord) run. Files are
 * forwarded to the ticket's Discord thread and never stored by the site.
 *
 * Limits stay under Discord's 10 MB per-file cap so an upload never fails
 * after the customer waited for it. No SVG or HTML: Discord serves
 * attachments with the declared type, and those can carry script.
 */
import type {OutboundFile} from './discord.ts';

export const MAX_FILES = 5;
export const MAX_PER_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/x-log',
  'text/tab-separated-values',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'application/json',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/octet-stream',
]);
const ALLOWED_MIME_PREFIXES = ['image/', 'audio/'];

export const ALLOWED_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp',
  'pdf', 'txt', 'log', 'md', 'csv', 'tsv', 'json',
  'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mov', 'webm',
  'zip', 'tar', 'gz', 'tgz', '7z',
  'bin', 'hex', 'elf', 'uf2', 'dfu', 'fw', 'bbl', 'bfl',
];
const EXT_SET = new Set(ALLOWED_EXTENSIONS);

/** The file input's `accept` attribute. */
export const ACCEPT = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',');

export type FileProblem = 'too_many' | 'too_big' | 'total_too_big' | 'type';

export type FileLike = {name: string; size: number; type: string};

/** First problem with a set of files, or null. `file` names the culprit. */
export function checkFiles(files: FileLike[]): {problem: FileProblem; file?: string} | null {
  if (files.length > MAX_FILES) return {problem: 'too_many'};
  let total = 0;
  for (const f of files) {
    if (f.size > MAX_PER_FILE_BYTES) return {problem: 'too_big', file: f.name};
    total += f.size;
    if (total > MAX_TOTAL_BYTES) return {problem: 'total_too_big'};
    const type = (f.type || 'application/octet-stream').toLowerCase();
    // image/svg+xml passes the prefix; the extension list refuses it.
    const mimeOk = ALLOWED_MIME.has(type) || ALLOWED_MIME_PREFIXES.some((p) => type.startsWith(p));
    const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    if (!mimeOk || !EXT_SET.has(ext) || type === 'image/svg+xml') return {problem: 'type', file: f.name};
  }
  return null;
}

export type ExtractedFiles =
  | {ok: true; files: OutboundFile[]}
  | {ok: false; problem: FileProblem; file?: string};

/** Read and validate the `files` fields of a multipart form. */
export async function extractAttachments(form: FormData, field = 'files'): Promise<ExtractedFiles> {
  const raw = form.getAll(field).filter((x): x is File => typeof x === 'object' && x !== null && 'arrayBuffer' in x && (x as File).size > 0);
  const problem = checkFiles(raw.map((f) => ({name: f.name, size: f.size, type: f.type})));
  if (problem) return {ok: false, ...problem};
  const files: OutboundFile[] = [];
  for (const f of raw) {
    files.push({name: f.name || 'file', type: (f.type || 'application/octet-stream').toLowerCase(), data: await f.arrayBuffer()});
  }
  return {ok: true, files};
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
