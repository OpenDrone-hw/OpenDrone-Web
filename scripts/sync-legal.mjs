#!/usr/bin/env node
// Sync legal Markdown snapshots from a maintained source directory into
// app/content/legal/. The committed storefront snapshot remains buildable
// when that authoring source is unavailable.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const SRC_ROOT = process.env.COMPLIANCE_SRC;

// { destBasename: relative path inside COMPLIANCE_SRC }
const FILES = {
  'algemene-voorwaarden.md': 'webshop/algemene-voorwaarden.md',
  'privacy-policy.md': 'webshop/privacy-policy.md',
  'cookie-policy.md': 'webshop/cookie-policy.md',
  'herroepingsformulier.md': 'webshop/herroepingsformulier.md',
  // NOT synced: vulnerability-handling-policy.md and end-use-policy.md.
  // Their compliance-repo masters are ENGLISH; the files in
  // app/content/legal/nl/ are hand-translated Dutch (like en/ and fr/).
  // A blind sync clobbers the translation with English — happened
  // 2026-06-10, restored from git. Sync them only if the master ever
  // becomes the Dutch source of truth.
};

// NL is the authoritative source synced from the compliance repo.
// EN translations live in app/content/legal/en/ and are hand-authored.
const destDir = path.join(repoRoot, 'app/content/legal/nl');

async function main() {
  await fs.mkdir(destDir, {recursive: true});

  if (!SRC_ROOT) {
    console.warn(
      '[sync-legal] COMPLIANCE_SRC is not set. Existing snapshots in app/content/legal/ are preserved.',
    );
    return;
  }

  const srcAvailable = await fs
    .stat(SRC_ROOT)
    .then(() => true)
    .catch(() => false);

  if (!srcAvailable) {
    console.warn(
      `[sync-legal] Source not found: ${SRC_ROOT}\n` +
        `[sync-legal] Skipping. Existing snapshot in app/content/legal/ is preserved.`,
    );
    return;
  }

  let copied = 0;
  let missing = 0;

  for (const [destName, relSrc] of Object.entries(FILES)) {
    const src = path.join(SRC_ROOT, relSrc);
    const dest = path.join(destDir, destName);
    try {
      const content = await fs.readFile(src, 'utf8');
      await fs.writeFile(dest, content, 'utf8');
      copied++;
      console.warn(`[sync-legal] ${destName}`);
    } catch (err) {
      missing++;
      console.warn(`[sync-legal] missing ${relSrc} (${err.code || err.message})`);
    }
  }

  console.warn(`[sync-legal] done. copied=${copied} missing=${missing}`);
}

main().catch((err) => {
  console.error('[sync-legal] error:', err);
  process.exit(1);
});
