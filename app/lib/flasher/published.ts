/**
 * Small read-only views of the firmware manifest for display: which PDP tier
 * has a published file, and the short "version, SHA-256 abc1234" label the
 * firmware page shows next to an offered file. No write decision reads these.
 */

import {FIRMWARE_MANIFEST} from './firmware-manifest.ts';
import {isPublished, type FirmwareRelease} from './manifest.ts';

/** PDP handle -> board size (leading digits of the tier, "20" for "20×20") -> manifest target. */
const PDP_TIER_TARGETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'openfc-lite': {'20': 'OPENFC_LITE_MINI_RP2350A', '30': 'OPENFC_LITE_RP2350B'},
  openesc: {'20': 'OPENESC_20_F421', '30': 'OPENESC_30X30'},
};

/** The manifest target behind a PDP tier, or null when the product/tier has no flasher target. */
export function tierFirmwareTarget(handle: string, tier: string): string | null {
  const size = /^(\d+)/.exec(tier.trim())?.[1];
  return (size && PDP_TIER_TARGETS[handle]?.[size]) || null;
}

/** True when that tier's firmware is published (isPublished) in the manifest (production by default). */
export function tierFirmwarePublished(
  handle: string,
  tier: string,
  manifest: readonly FirmwareRelease[] = FIRMWARE_MANIFEST,
): boolean {
  const target = tierFirmwareTarget(handle, tier);
  return !!target && manifest.some((r) => r.target === target && isPublished(r));
}

/** "2026.12.0-alpha, SHA-256 cf94838": each part only when the release carries it; '' when neither. */
export function firmwareIdText(r: Pick<FirmwareRelease, 'version' | 'sha256'>): string {
  const version = typeof r.version === 'string' ? r.version.trim() : '';
  const sha = typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256) ? `SHA-256 ${r.sha256.slice(0, 7)}` : '';
  return [version, sha].filter(Boolean).join(', ');
}
