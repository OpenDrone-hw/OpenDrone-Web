/**
 * Validation + extraction of file uploads from a multipart form body.
 * Both /api/support/start and /api/support/send accept attachments and
 * forward them to Discord; this is the single point where we decide
 * what's allowed and what isn't.
 *
 * Caps are intentionally below Discord's free-tier 10 MB per file so we
 * never get a "Request entity too large" from the API after the user
 * already waited for an upload.
 */

import type {OutboundFile} from './discord';

export const MAX_FILES = 5;
export const MAX_PER_FILE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024; // 24 MB

// Explicit allowlist - no broad `text/` prefix. Discord serves attachments
// from its own CDN with the Content-Type we declare, so admitting
// `text/html` or `text/javascript` would give an attacker a free XSS
// hosted on a domain with user trust ("attachments from support"). Keep
// this list to inert plaintext families and known binary formats that
// actually show up in drone-firmware support tickets.
const ALLOWED_MIME_TYPES = new Set([
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
  'application/octet-stream', // .bin, .hex, .elf, logs without type
]);
const ALLOWED_MIME_PREFIXES = ['image/', 'audio/'];

// Browser-declared MIME types can be spoofed, so pair the MIME check with
// an extension allowlist. Doubles as a sanity check when the browser
// sends `application/octet-stream` for files it doesn't recognise.
const ALLOWED_EXTENSIONS = new Set([
  // images - note: no 'svg'. SVG can carry inline <script>; drone support
  // never needs it, so we don't lean on the CSP being the only thing that
  // stops a stored-XSS-by-attachment. image/svg+xml passes the `image/`
  // MIME prefix but is rejected here at the extension gate.
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp',
  // docs / text
  'pdf', 'txt', 'log', 'md', 'csv', 'tsv', 'json',
  // audio / video
  'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mov', 'webm',
  // archives
  'zip', 'tar', 'gz', 'tgz', '7z',
  // firmware / logs
  'bin', 'hex', 'elf', 'uf2', 'dfu', 'fw', 'bbl', 'bfl',
]);

export type ExtractedFiles =
  | {ok: true; files: OutboundFile[]}
  | {ok: false; message: string};

export async function extractAttachments(
  form: FormData,
  field = 'files',
): Promise<ExtractedFiles> {
  const raw = form.getAll(field).filter((x): x is File => x instanceof File && x.size > 0);
  if (!raw.length) return {ok: true, files: []};
  if (raw.length > MAX_FILES) {
    return {ok: false, message: `Too many files (max ${MAX_FILES}).`};
  }

  let total = 0;
  const out: OutboundFile[] = [];
  for (const f of raw) {
    if (f.size > MAX_PER_FILE_BYTES) {
      return {
        ok: false,
        message: `${f.name} is over the 8 MB limit.`,
      };
    }
    total += f.size;
    if (total > MAX_TOTAL_BYTES) {
      return {ok: false, message: 'Total attachment size exceeds 24 MB.'};
    }
    const type = (f.type || 'application/octet-stream').toLowerCase();
    const mimeOk =
      ALLOWED_MIME_TYPES.has(type) ||
      ALLOWED_MIME_PREFIXES.some((p) => type.startsWith(p));
    if (!mimeOk) {
      return {
        ok: false,
        message: `${f.name}: file type ${type} is not allowed.`,
      };
    }
    const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        message: `${f.name}: extension not allowed.`,
      };
    }
    out.push({
      name: f.name || 'file',
      type,
      data: await f.arrayBuffer(),
    });
  }
  return {ok: true, files: out};
}
