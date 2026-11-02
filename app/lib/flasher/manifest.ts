/**
 * Firmware release manifest: types, availability rules and file integrity.
 *
 * The manifest is PINNED: it is compiled into the page from
 * firmware-manifest.ts, so a firmware file can only be offered if a reviewed
 * commit put its size and SHA-256 here. Each file is fetched same-origin,
 * hashed with crypto.subtle (SHA-256) and compared before it is parsed,
 * handed to the user, or written.
 *
 * Placeholders: an entry with `published: false`, a missing URL, or a
 * SHA-256 that is not 64 lowercase hex characters is a placeholder. A
 * placeholder is never fetched, never passes verification, and the page says
 * "firmware not published yet".
 *
 * Pure module (WebCrypto only), so it runs under `node --test`.
 */

import {escTargetByName, targetByName, type EscTarget, type FlasherTarget} from './targets.ts';

export type FirmwareKind = 'betaflight-uf2' | 'am32-hex';

export type FirmwareRelease = {
  /** Allowlisted target name (Betaflight target or AM32 FILE_NAME). */
  target: string;
  kind: FirmwareKind;
  version: string;
  firmware: string;
  channel: 'stable' | 'beta';
  released: string;
  /** Same-origin path on opendrone.be, or null while not hosted. */
  url: string | null;
  size: number;
  sha256: string;
  /** False until the file is hosted at `url` and the hash was taken from that exact file. */
  published: boolean;
  notes?: string;
};

/** Marker for hashes that do not exist yet. Can never equal a hex digest. */
export const PLACEHOLDER_SHA256 = 'PLACEHOLDER-NOT-PUBLISHED';

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Thrown for placeholder entries; the page shows "firmware not published yet". */
export class FirmwareNotPublishedError extends ManifestError {
  constructor(release: FirmwareRelease) {
    super(`Firmware not published yet: ${release.target} ${release.version} has no verified release file.`);
    this.name = 'FirmwareNotPublishedError';
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_FILE = 4 * 1024 * 1024;

/** True only for a complete, published entry. Everything else is a placeholder. */
export function isPublished(r: FirmwareRelease): r is FirmwareRelease & {url: string} {
  return (
    r.published === true &&
    typeof r.url === 'string' &&
    r.url.startsWith('/') &&
    !r.url.startsWith('//') &&
    Number.isInteger(r.size) &&
    r.size > 0 &&
    r.size <= MAX_FILE &&
    SHA256_RE.test(r.sha256)
  );
}

export type ResolvedRelease =
  | {product: 'fc'; target: FlasherTarget; release: FirmwareRelease}
  | {product: 'esc'; target: EscTarget; release: FirmwareRelease};

/**
 * Bind a manifest entry to its allowlisted target and check the file kind
 * matches the product. Unknown targets and kind mismatches throw.
 */
export function resolveRelease(r: FirmwareRelease): ResolvedRelease {
  const fc = targetByName(r.target);
  if (fc) {
    if (r.kind !== 'betaflight-uf2') throw new ManifestError(`${r.target} is a flight controller but the entry is ${r.kind}.`);
    return {product: 'fc', target: fc, release: r};
  }
  const esc = escTargetByName(r.target);
  if (esc) {
    if (r.kind !== 'am32-hex') throw new ManifestError(`${r.target} is an ESC but the entry is ${r.kind}.`);
    return {product: 'esc', target: esc, release: r};
  }
  throw new ManifestError(`Manifest entry for unknown target ${r.target}.`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Copy into a fresh ArrayBuffer-backed view, which WebCrypto's BufferSource typing wants. */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bytes))));
}

/** Check bytes against a manifest entry. Placeholders always fail. */
export async function verifyFirmwareBytes(release: FirmwareRelease, bytes: Uint8Array): Promise<string> {
  if (!isPublished(release)) throw new FirmwareNotPublishedError(release);
  if (bytes.length !== release.size) {
    throw new ManifestError(`Firmware size ${bytes.length} does not match the pinned size (${release.size}).`);
  }
  const digest = await sha256Hex(bytes);
  if (digest !== release.sha256) throw new ManifestError('Firmware checksum does not match the pinned SHA-256.');
  return digest;
}

/** Download a release file (same origin only) and verify it. Placeholders are never fetched. */
export async function fetchVerifiedFirmware(
  release: FirmwareRelease,
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{bytes: Uint8Array; sha256: string}> {
  if (!isPublished(release)) throw new FirmwareNotPublishedError(release);
  const url = new URL(release.url, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new ManifestError('Firmware URL is not on this site.');
  const res = await fetcher(url.toString(), {cache: 'no-store'});
  if (!res.ok) throw new ManifestError(`Firmware download failed (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = await verifyFirmwareBytes(release, bytes);
  return {bytes, sha256};
}

export function releaseFileName(r: FirmwareRelease): string {
  const ext = r.kind === 'am32-hex' ? 'hex' : 'uf2';
  return r.url?.split('/').pop() ?? `${r.target}-${r.version}.${ext}`;
}
