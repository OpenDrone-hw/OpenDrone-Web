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
  'bin', 'hex', 'uf2', 'dfu', 'fw', 'bbl', 'bfl',
];
const EXT_SET = new Set(ALLOWED_EXTENSIONS);

/** The file input's `accept` attribute. */
export const ACCEPT = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',');

export type FileProblem = 'too_many' | 'too_big' | 'total_too_big' | 'type' | 'empty' | 'program' | 'mismatch';

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
    const content = inspectContent(f.name, new Uint8Array(data, 0, Math.min(16, data.byteLength)));
    if (!content.ok) return {ok: false, problem: content.problem, file: f.name};
    files.push({name: f.name || 'file', type: content.type ?? (f.type || 'application/octet-stream').toLowerCase(), data});
  }
  return {ok: true, files};
}

/**
 * The content check the browser runs on each chosen file before anything
 * uploads (it reads only the first 16 bytes), the same one the Worker runs.
 */
export async function checkFileContent(file: Blob & {name: string}): Promise<{problem: FileProblem; file: string} | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const content = inspectContent(file.name, head);
  return content.ok ? null : {problem: content.problem, file: file.name};
}

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const bytes = (b: Uint8Array, at: number, sig: number[]) => sig.every((x, i) => b[at + i] === x);

/** The image format a file starts with, whatever its name says. */
export function sniffImage(head: Uint8Array): string | null {
  if (bytes(head, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (head[0] === 0x89 && ascii(head, 1, 'PNG')) return 'image/png';
  if (ascii(head, 0, 'GIF8')) return 'image/gif';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'image/webp';
  if (ascii(head, 0, 'BM')) return 'image/bmp';
  if (ascii(head, 4, 'ftyp') && ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif'].some((b) => ascii(head, 8, b))) return 'image/heic';
  return null;
}

/**
 * Executables: Windows (MZ), Linux (ELF) and macOS (Mach-O, fat binaries).
 * This protects staff from a mislabelled file; it is not a security
 * boundary (a zip can still carry anything, and Discord serves files as
 * downloads).
 */
export function isProgram(head: Uint8Array): boolean {
  return (
    ascii(head, 0, 'MZ') ||
    bytes(head, 0, [0x7f, 0x45, 0x4c, 0x46]) ||
    [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((sig) =>
      bytes(head, 0, sig),
    )
  );
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif']);

/**
 * What a file's first bytes say, against its extension. Programs are
 * refused under any name. An image may be any real image format (a PNG
 * saved as .jpg is fine; its real type is passed on). Video and PDFs must
 * start like their extension says. Logs, firmware and archives have no
 * reliable signature and pass on extension alone.
 */
export function inspectContent(name: string, head: Uint8Array): {ok: true; type?: string} | {ok: false; problem: 'program' | 'mismatch'} {
  if (isProgram(head)) return {ok: false, problem: 'program'};
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    const type = sniffImage(head);
    return type ? {ok: true, type} : {ok: false, problem: 'mismatch'};
  }
  const fits = (() => {
    switch (ext) {
      case 'mp4':
      case 'mov':
      case 'm4a':
        return ascii(head, 4, 'ftyp') || (ext === 'mov' && (ascii(head, 4, 'moov') || ascii(head, 4, 'wide') || ascii(head, 4, 'mdat')));
      case 'webm':
        return bytes(head, 0, [0x1a, 0x45, 0xdf, 0xa3]);
      case 'pdf':
        return ascii(head, 0, '%PDF');
      default:
        return true;
    }
  })();
  return fits ? {ok: true} : {ok: false, problem: 'mismatch'};
}

/** True when the content passes `inspectContent`. */
export function contentMatchesExtension(name: string, head: Uint8Array): boolean {
  return inspectContent(name, head).ok;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
