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

export type FileProblem = 'too_many' | 'too_big' | 'total_too_big' | 'type' | 'empty';

export type FileLike = {name: string; size: number; type: string};

/** First problem with a set of files, or null. `file` names the culprit. */
export function checkFiles(files: FileLike[]): {problem: FileProblem; file?: string} | null {
  if (files.length > MAX_FILES) return {problem: 'too_many'};
  let total = 0;
  for (const f of files) {
    if (f.size === 0) return {problem: 'empty', file: f.name};
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
  // An empty file input submits one nameless, empty part: that is "no file".
  const raw = form
    .getAll(field)
    .filter((x): x is File => typeof x === 'object' && x !== null && 'arrayBuffer' in x)
    .filter((f) => f.size > 0 || f.name !== '');
  const problem = checkFiles(raw.map((f) => ({name: f.name, size: f.size, type: f.type})));
  if (problem) return {ok: false, ...problem};
  const files: OutboundFile[] = [];
  for (const f of raw) {
    const data = await f.arrayBuffer();
    if (!contentMatchesExtension(f.name, new Uint8Array(data, 0, Math.min(16, data.byteLength)))) {
      return {ok: false, problem: 'type', file: f.name};
    }
    files.push({name: f.name || 'file', type: (f.type || 'application/octet-stream').toLowerCase(), data});
  }
  return {ok: true, files};
}

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * Images, video and PDFs must start like what their extension says: an
 * .exe renamed .jpg is refused. Other allowed types (logs, firmware,
 * archives) have no reliable signature and pass on extension alone.
 */
export function contentMatchesExtension(name: string, head: Uint8Array): boolean {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'png':
      return head[0] === 0x89 && ascii(head, 1, 'PNG');
    case 'gif':
      return ascii(head, 0, 'GIF8');
    case 'webp':
      return ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP');
    case 'bmp':
      return ascii(head, 0, 'BM');
    case 'heic':
    case 'heif':
    case 'mp4':
    case 'mov':
    case 'm4a':
      return ascii(head, 4, 'ftyp') || (ext === 'mov' && (ascii(head, 4, 'moov') || ascii(head, 4, 'wide') || ascii(head, 4, 'mdat')));
    case 'webm':
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case 'pdf':
      return ascii(head, 0, '%PDF');
    default:
      return true;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
