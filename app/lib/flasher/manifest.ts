/**
 * Firmware release manifest: types, availability rules and file integrity.
 *
 * The manifest is PINNED: it is compiled into the page from
 * firmware-manifest.ts, so a firmware file can only be offered if a reviewed
 * commit put its URL, size and SHA-256 there. Each file is fetched only from
 * an allowlisted release URL (FIRMWARE_URL_ALLOWLIST), hashed with
 * crypto.subtle (SHA-256) and compared before it is parsed, handed to the
 * user, or written.
 *
 * Placeholders: an entry with `published: false`, a URL that is not on the
 * allowlist, a size that is not a positive integer, or a SHA-256 that is not
 * 64 lowercase hex characters is a placeholder. A placeholder is never
 * fetched, never passes verification, and the page says "firmware not
 * published yet".
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
  /** Release channel. Anything but 'stable' is labelled as a pre-release on /flash (F11). */
  channel: 'stable' | 'beta' | 'alpha';
  released: string;
  /** Allowlisted release-asset URL (isAllowedFirmwareUrl), or null while not pinned. */
  url: string | null;
  size: number;
  sha256: string;
  /** True only for an entry built from a non-null pin (firmware-manifest.ts PINNED). */
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

/**
 * Where pinned firmware may come from. Only GitHub release assets of the
 * OpenDrone-hw organisation: https://github.com/OpenDrone-hw/<repo>/releases/download/<tag>/<file>.
 * Add another host only as an explicit entry here, in a reviewed PR.
 * NOTE: the site CSP (app/lib/csp.ts connect-src) must allow the host, and
 * the host must answer a browser fetch with CORS, before a pin can download.
 */
export const FIRMWARE_URL_ALLOWLIST: readonly {host: string; path: RegExp}[] = [
  {host: 'github.com', path: /^\/OpenDrone-hw\/[A-Za-z0-9._-]+\/releases\/download\/[A-Za-z0-9._+-]+\/[A-Za-z0-9._+-]+$/},
];

/** Structural URL check: https, allowlisted host + path, no credentials, port, query, fragment or dot segments. */
export function isAllowedFirmwareUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw.startsWith('https://')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return false;
  if (u.href !== raw) return false; // no normalisation tricks (case, dot segments, encodings)
  if (u.pathname.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  return FIRMWARE_URL_ALLOWLIST.some((a) => u.hostname === a.host && a.path.test(u.pathname));
}

/** True only for a complete, published entry. Everything else is a placeholder. */
export function isPublished(r: FirmwareRelease): r is FirmwareRelease & {url: string} {
  return (
    r.published === true &&
    isAllowedFirmwareUrl(r.url) &&
    typeof r.version === 'string' &&
    r.version.trim().length > 0 &&
    (r.channel === 'stable' || r.channel === 'beta' || r.channel === 'alpha') &&
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

/** Download a release file (allowlisted URL only) and verify it. Placeholders are never fetched. */
export async function fetchVerifiedFirmware(
  release: FirmwareRelease,
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{bytes: Uint8Array; sha256: string}> {
  if (!isPublished(release)) throw new FirmwareNotPublishedError(release);
  const url = new URL(release.url, baseUrl);
  if (!isAllowedFirmwareUrl(url.href)) throw new ManifestError('Firmware URL is not an allowlisted release URL.');
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
