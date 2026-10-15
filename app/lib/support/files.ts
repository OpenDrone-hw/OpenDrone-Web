/**
 * Ticket attachments in the R2 bucket `SUPPORT_FILES`, key "<ref>/<id>".
 * They live only as long as the ticket: `deleteTicketFiles` runs with the
 * 24-month retention job (tickets.ts `cleanupExpired`). Discord is never
 * given a file, only the name and size in a line of text.
 */
import {sanitizeFilename, type OutboundFile} from './discord.ts';
import type {StoredAttachment} from './store.ts';

export const R2_ID = /^r2_[a-f0-9]{20}$/;

export const isR2Attachment = (a: Pick<StoredAttachment, 'id'>) => R2_ID.test(a.id);

const SAFE_TYPE = /^(image|video)\/[a-z0-9.+-]+$|^application\/pdf$/;

export async function storeFiles(bucket: R2Bucket, ref: string, files: OutboundFile[]): Promise<StoredAttachment[]> {
  const out: StoredAttachment[] = [];
  for (const f of files) {
    const id = `r2_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    await bucket.put(`${ref}/${id}`, data, {httpMetadata: {contentType: SAFE_TYPE.test(f.type) ? f.type : 'application/octet-stream'}});
    out.push({id, filename: sanitizeFilename(f.name), size: data.byteLength});
  }
  return out;
}

/** The object as a download response; null when it is gone. Always an attachment, never sniffed. */
export async function fileResponse(bucket: R2Bucket, ref: string, att: StoredAttachment): Promise<Response | null> {
  if (!isR2Attachment(att)) return null;
  const obj = await bucket.get(`${ref}/${att.id}`);
  if (!obj) return null;
  const name = att.filename.replace(/[^\w. -]/g, '_');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function deleteTicketFiles(bucket: R2Bucket, ref: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({prefix: `${ref}/`, limit: 500, cursor});
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** The line a legacy Discord thread gets instead of files. */
export function fileLine(files: StoredAttachment[]): string {
  return files.length ? `*${files.length} attachment${files.length === 1 ? '' : 's'} stored in the CRM: ${files.map((f) => `${f.filename} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join(', ')}*` : '';
}
