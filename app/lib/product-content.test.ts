import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {
  PRODUCT_CONTENT,
  PRODUCT_CONTENT_FALLBACK,
  hiddenWhileSoldOut,
  isInternalSku,
  variantDisplayName,
  lineDisplayName,
  variantCartNote,
  type BoxItem,
  type ChapterPin,
  type DownloadAsset,
  type ProductContent,
  type VariantContent,
} from './product-content.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/product-content.test.ts
//
// Pins the JSON loading in `product-content.ts`. The editorial data moved to
// `content/products/*.json` so the studio can edit it, which means a typo in a
// file the compiler no longer reads can now reach a product page. These tests
// are that compiler.

const CONTENT_DIR = new URL('../../content/products/', import.meta.url);

/** Handles with a file on disk, `_fallback` excluded: it is not a product. */
const HANDLES_ON_DISK = readdirSync(CONTENT_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .filter((handle) => handle !== '_fallback');

const DOWNLOAD_KINDS = new Set([
  'schematic',
  'step',
  'bom',
  'gerber',
  'manual',
  'wiring',
  'flash',
  'changelog',
  'sbom',
  'doc',
  'firmware_manifest',
  'other',
]);

function assertSpecRows(
  rows: Array<[string, string | null]>,
  where: string,
  nullable: boolean,
) {
  assert.ok(Array.isArray(rows), `${where}: specs must be an array`);
  for (const [i, row] of rows.entries()) {
    assert.ok(Array.isArray(row), `${where}: specs[${i}] must be a pair`);
    assert.equal(row.length, 2, `${where}: specs[${i}] must have 2 cells`);
    const [label, value] = row;
    assert.equal(typeof label, 'string', `${where}: specs[${i}] label`);
    assert.notEqual(label, '', `${where}: specs[${i}] label is empty`);
    if (nullable && value === null) continue;
    assert.equal(typeof value, 'string', `${where}: specs[${i}] value`);
  }
}

function assertBoxItems(items: BoxItem[], where: string) {
  for (const [i, item] of items.entries()) {
    assert.equal(typeof item.item, 'string', `${where}: inTheBox[${i}].item`);
    assert.notEqual(item.item, '', `${where}: inTheBox[${i}].item is empty`);
  }
}

function assertDownloads(downloads: DownloadAsset[], where: string) {
  for (const [i, asset] of downloads.entries()) {
    assert.ok(
      DOWNLOAD_KINDS.has(asset.kind),
      `${where}: downloads[${i}].kind "${asset.kind}" is not a DownloadKind`,
    );
    assert.notEqual(asset.label, '', `${where}: downloads[${i}].label`);
    assert.match(asset.href, /^https?:\/\/|^\//, `${where}: downloads[${i}].href`);
  }
}

function assertPins(pins: ChapterPin[], where: string) {
  for (const [i, pin] of pins.entries()) {
    assert.equal(typeof pin.ref, 'string', `${where}: pins[${i}].ref`);
    assert.equal(typeof pin.part, 'string', `${where}: pins[${i}].part`);
    assert.notEqual(pin.part, '', `${where}: pins[${i}].part is empty`);
    if (pin.box !== undefined) {
      assert.ok(
        pin.box === 'each' || pin.box === 'union',
        `${where}: pins[${i}].box "${pin.box}"`,
      );
    }
    // `chips` is a subdivision of `refs`, and BoardArt matches the union for
    // spotlighting, so a chip ref that is not in `refs` silently never lights.
    for (const chip of pin.chips ?? []) {
      for (const ref of chip.refs) {
        assert.ok(
          pin.refs?.includes(ref),
          `${where}: pins[${i}] chip "${chip.label}" ref ${ref} missing from refs`,
        );
      }
    }
  }
}

function assertVariant(variant: VariantContent, where: string) {
  assert.ok(Array.isArray(variant.highlights), `${where}: highlights`);
  for (const [i, row] of variant.highlights.entries()) {
    assert.equal(row.length, 2, `${where}: highlights[${i}] must be a pair`);
    assert.equal(typeof row[0], 'string', `${where}: highlights[${i}] label`);
    assert.equal(typeof row[1], 'string', `${where}: highlights[${i}] value`);
  }
  if (variant.specs) assertSpecRows(variant.specs, where, true);
  if (variant.inTheBox) assertBoxItems(variant.inTheBox, where);
  if (variant.pins) assertPins(variant.pins, where);
}

/** The fields {@link ProductContent} declares without `?`. */
function assertRequiredFields(content: ProductContent, where: string) {
  assert.equal(typeof content.fileNumber, 'string', `${where}: fileNumber`);
  assert.equal(typeof content.family, 'string', `${where}: family`);
  assert.notEqual(content.family, '', `${where}: family is empty`);
  for (const key of ['line1', 'line2Italic', 'line3', 'lead'] as const) {
    assert.equal(typeof content.hero[key], 'string', `${where}: hero.${key}`);
  }
  assert.equal(typeof content.firmware.project, 'string', `${where}: firmware`);
  assert.equal(typeof content.repoUrl, 'string', `${where}: repoUrl`);
  assert.ok(Array.isArray(content.inTheBox), `${where}: inTheBox`);
  assert.ok(Array.isArray(content.downloads), `${where}: downloads`);
  assert.ok(Array.isArray(content.specs), `${where}: specs`);
}

describe('product content loading', () => {
  it('loads every file in content/products', () => {
    assert.ok(HANDLES_ON_DISK.length > 0, 'no product JSON files found');
    assert.deepEqual(
      Object.keys(PRODUCT_CONTENT).sort(),
      [...HANDLES_ON_DISK].sort(),
    );
  });

  it('has no empty or reserved handle', () => {
    for (const handle of Object.keys(PRODUCT_CONTENT)) {
      assert.notEqual(handle, '', 'empty product handle');
      assert.ok(
        !handle.startsWith('_'),
        `"${handle}" is reserved: leading _ marks a non-product file`,
      );
    }
  });

  it('orders entries by fileNumber, not by filename', () => {
    const numbers = Object.values(PRODUCT_CONTENT).map((c) => c.fileNumber);
    assert.deepEqual(numbers, [...numbers].sort());
  });

  it('loads the fallback', () => {
    assertRequiredFields(PRODUCT_CONTENT_FALLBACK, '_fallback');
    assert.equal(PRODUCT_CONTENT_FALLBACK.family, 'Product');
    assert.deepEqual(PRODUCT_CONTENT_FALLBACK.specs, []);
  });
});

describe('product content shape', () => {
  for (const handle of HANDLES_ON_DISK) {
    describe(handle, () => {
      const content = PRODUCT_CONTENT[handle];

      it('has every required field', () => {
        assertRequiredFields(content, handle);
      });

      it('has specs as [label, value] string pairs', () => {
        assertSpecRows(content.specs, handle, false);
      });

      it('has usable inTheBox and downloads entries', () => {
        assertBoxItems(content.inTheBox, handle);
        assertDownloads(content.downloads, handle);
      });

      it('has a complete whatIsThis when present', () => {
        const wit = content.whatIsThis;
        if (!wit) return;
        assert.equal(typeof wit.intro, 'string', `${handle}: whatIsThis.intro`);
        assert.notEqual(wit.intro, '', `${handle}: whatIsThis.intro is empty`);
        assert.equal(typeof wit.fit, 'string', `${handle}: whatIsThis.fit`);
        assert.notEqual(wit.fit, '', `${handle}: whatIsThis.fit is empty`);
        assert.ok(
          Array.isArray(wit.needs) && wit.needs.length > 0,
          `${handle}: whatIsThis.needs must be a non-empty array`,
        );
        for (const [i, line] of wit.needs.entries()) {
          assert.equal(typeof line, 'string', `${handle}: needs[${i}]`);
          assert.notEqual(line, '', `${handle}: needs[${i}] is empty`);
        }
      });

      it('has a coherent teardown', () => {
        if (!content.teardown) return;
        assertPins(content.teardown.pins, handle);
      });

      it('has a variant ladder wired to an option axis', () => {
        if (!content.variants) return;
        assert.equal(
          typeof content.optionAxis,
          'string',
          `${handle}: variants without an optionAxis never match a catalog option`,
        );
        for (const [key, variant] of Object.entries(content.variants)) {
          assert.notEqual(key, '', `${handle}: empty variant key`);
          assertVariant(variant, `${handle}/${key}`);
        }
      });
    });
  }
});

describe('hiddenWhileSoldOut', () => {
  const card = (handle: string, open: boolean[]) => ({
    handle,
    variants: {nodes: open.map((availableForSale) => ({availableForSale}))},
  });
  it('hides a sold-out part with no editorial file', () => {
    assert.equal(hiddenWhileSoldOut(card('battery-strap', [false])), true);
  });
  it('lists that part once a variant can be bought', () => {
    assert.equal(hiddenWhileSoldOut(card('openframe-spares', [false, true])), false);
  });
  it('keeps an editorial product listed when sold out', () => {
    assert.equal(hiddenWhileSoldOut(card('openmotor', [false, false])), false);
  });
});

describe('openmotor 5-inch variant', () => {
  it('claims no stator size or KV that sourcing has not confirmed', () => {
    const v = PRODUCT_CONTENT.openmotor?.variants?.['2207'];
    assert.ok(v);
    const specs = new Map(v.specs ?? []);
    assert.equal(specs.get('Stator'), 'To be confirmed');
    assert.equal(specs.get('KV'), 'To be confirmed');
    assert.ok(!JSON.stringify(PRODUCT_CONTENT.openmotor).includes('22 × 7'));
  });
  it('shows the option value "2207" as 5" and keeps its SKU internal', () => {
    assert.equal(variantDisplayName('openmotor', '2207'), '5"');
    assert.equal(isInternalSku('openmotor', '2207'), true);
    assert.equal(isInternalSku('openmotor', '1604'), false);
    assert.equal(variantDisplayName('openesc', '30×30'), '30×30');
    assert.equal(variantDisplayName(null, 'Lite'), 'Lite');
  });

  it('never names the 5" motor 2207 in a cart line name or note', () => {
    assert.equal(lineDisplayName('openmotor', 'OpenMotor', '2207'), 'OpenMotor 5"');
    assert.equal(lineDisplayName('openesc', 'OpenESC', 'Default Title'), 'OpenESC');
    assert.ok(!/2207/.test(variantCartNote('openmotor', '2207') ?? '2207'));
    assert.equal(variantCartNote('openmotor', '1604'), null);
  });
});
