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

import {stagingBenchEnabled} from './staging.ts';
import {escTargetByName, targetByName, type EscTarget, type FlasherTarget} from './targets.ts';

/** am32-bin: a raw app binary that starts at the AM32 app address (staging bench build only). */
export type FirmwareKind = 'betaflight-uf2' | 'am32-hex' | 'am32-bin';

/** GPL source for a pinned build: the exact firmware and config commits. */
export type FirmwareSource = {firmwareUrl: string; configUrl: string; configRef: string; buildTarget: string};

/** A second pinned file that belongs to a release (the ESC EEPROM v4 defaults). */
export type PinnedAsset = {url: string; size: number; sha256: string};

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
  /** AM32 only: the pinned EEPROM v4 defaults written after the app. Must itself be a valid pinned asset. */
  eepromDefaults?: PinnedAsset;
  /** GPL source links for this build. */
  source?: FirmwareSource;
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

/**
 * Published same-origin files: a relative path /firmware/<board>/<file>,
 * shipped in public/firmware/ (Workers assets). Covered by connect-src 'self';
 * resolveUrl also checks the resolved origin equals the page's.
 * Not to be confused with the bench-only /firmware-staging/ (below).
 */
export function isSameOriginFirmwareUrl(raw: unknown): raw is string {
  return typeof raw === 'string' && /^\/firmware\/[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(raw);
}

/**
 * Same-origin bench files, ONLY while the staging bench switch is on
 * (staging.ts). A relative path under /firmware-staging/ with a plain file
 * name. With the switch off this is always false, so production stays on
 * isAllowedFirmwareUrl (GitHub release assets) alone.
 */
export function isStagingFirmwareUrl(raw: unknown): raw is string {
  return stagingBenchEnabled() && typeof raw === 'string' && /^\/firmware-staging\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(raw);
}

const urlOk = (raw: unknown): raw is string => isAllowedFirmwareUrl(raw) || isSameOriginFirmwareUrl(raw) || isStagingFirmwareUrl(raw);

function assetOk(a: PinnedAsset | undefined): boolean {
  return !!a && urlOk(a.url) && Number.isInteger(a.size) && a.size > 0 && a.size <= MAX_FILE && SHA256_RE.test(a.sha256);
}

/** True only for a complete, published entry. Everything else is a placeholder. */
export function isPublished(r: FirmwareRelease): r is FirmwareRelease & {url: string} {
  return (
    r.published === true &&
    urlOk(r.url) &&
    // F8 (review 3): a raw AM32 .bin is a staging bench file only; a public pin ships Intel HEX.
    (r.kind !== 'am32-bin' || isStagingFirmwareUrl(r.url)) &&
    (r.eepromDefaults === undefined || assetOk(r.eepromDefaults)) &&
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
    if (r.kind !== 'am32-hex' && r.kind !== 'am32-bin') throw new ManifestError(`${r.target} is an ESC but the entry is ${r.kind}.`);
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

function checkBytes(what: string, size: number, sha256: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length !== size) throw new ManifestError(`${what} size ${bytes.length} does not match the pinned size (${size}).`);
  return sha256Hex(bytes).then((digest) => {
    if (digest !== sha256) throw new ManifestError(`${what} checksum does not match the pinned SHA-256.`);
    return digest;
  });
}

/** Check bytes against a manifest entry. Placeholders always fail. */
export async function verifyFirmwareBytes(release: FirmwareRelease, bytes: Uint8Array): Promise<string> {
  if (!isPublished(release)) throw new FirmwareNotPublishedError(release);
  return checkBytes('Firmware', release.size, release.sha256, bytes);
}

/** Allowlisted https URL; a published same-origin /firmware/ path; a staging path only when the switch is on and it stays on the page's own origin. */
function resolveUrl(raw: string, baseUrl: string): URL {
  if (isSameOriginFirmwareUrl(raw) || isStagingFirmwareUrl(raw)) {
    const base = new URL(baseUrl);
    const u = new URL(raw, base);
    if (u.origin !== base.origin) throw new ManifestError('Firmware must come from the same origin as this page.');
    return u;
  }
  const u = new URL(raw, baseUrl);
  if (!isAllowedFirmwareUrl(u.href)) throw new ManifestError('Firmware URL is not an allowlisted release URL.');
  return u;
}

async function download(url: URL, fetcher: typeof fetch): Promise<Uint8Array> {
  const res = await fetcher(url.toString(), {cache: 'no-store'});
  if (!res.ok) throw new ManifestError(`Firmware download failed (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Download a release file (allowlisted URL only) and verify it. Placeholders are never fetched. */
export async function fetchVerifiedFirmware(
  release: FirmwareRelease,
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{bytes: Uint8Array; sha256: string; eeprom: Uint8Array | null}> {
  if (!isPublished(release)) throw new FirmwareNotPublishedError(release);
  const bytes = await download(resolveUrl(release.url, baseUrl), fetcher);
  const sha256 = await verifyFirmwareBytes(release, bytes);
  let eeprom: Uint8Array | null = null;
  const e = release.eepromDefaults;
  if (e) {
    eeprom = await download(resolveUrl(e.url, baseUrl), fetcher);
    await checkBytes('EEPROM defaults', e.size, e.sha256, eeprom);
  }
  return {bytes, sha256, eeprom};
}

export function releaseFileName(r: FirmwareRelease): string {
  const ext = r.kind === 'am32-hex' ? 'hex' : r.kind === 'am32-bin' ? 'bin' : 'uf2';
  return r.url?.split('/').pop() ?? `${r.target}-${r.version}.${ext}`;
}
