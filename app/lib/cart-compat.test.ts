import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {COMPAT_LOCALES, COMPAT_PARTS, COMPAT_RULES, COMPAT_UI, type CompatPart} from './cart-compat-data.ts';
import {cartCompatAlert, compatForLines, compatLocale, explainConflicts, findConflicts} from './cart-compat.ts';

const BUILDS = JSON.parse(fs.readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8')) as {
  builds: Array<{id: string; parts: Array<{sku: string}>}>;
  extras: Array<{sku: string; with: string[]}>;
};
const APP_CATALOG = JSON.parse(fs.readFileSync(new URL('../../test/fixtures/app-catalog.json', import.meta.url), 'utf8')) as {
  products: Array<{handle: string; variants: Array<{sku: string}>}>;
};

const rules = (skus: string[], country: string | null = 'BE') => findConflicts(skus, country).map((c) => c.rule);

/** A sold battery does not exist yet; tests add one as data. */
const WITH_BATTERIES: Record<string, CompatPart> = {
  ...COMPAT_PARTS,
  'TEST-BAT-6S-XT60': {kind: 'battery', name: '6S battery', handle: 'test-battery', cells: 6, plug: 'XT60'},
  'TEST-BAT-4S-XT60': {kind: 'battery', name: '4S battery', handle: 'test-battery', cells: 4, plug: 'XT60'},
  'TEST-BAT-8S-XT60': {kind: 'battery', name: '8S battery', handle: 'test-battery', cells: 8, plug: 'XT60'},
  'TEST-BAT-4S-XT30': {kind: 'battery', name: '4S XT30 battery', handle: 'test-battery-xt30', cells: 4, plug: 'XT30'},
};

describe('compat data', () => {
  it('names only SKUs the catalog sells, under their own product', () => {
    const handleOf = new Map(APP_CATALOG.products.flatMap((p) => p.variants.map((v) => [v.sku, p.handle] as const)));
    for (const [sku, part] of Object.entries(COMPAT_PARTS)) {
      assert.equal(handleOf.get(sku), part.handle, sku);
    }
  });

  it('words every rule in every locale, with the same placeholders', () => {
    for (const rule of COMPAT_RULES) {
      const en = rule.messages.en;
      for (const locale of COMPAT_LOCALES) {
        const m = rule.messages[locale];
        for (const key of ['problem', 'fix'] as const) {
          const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
          assert.ok(m[key].trim(), `${rule.id} ${locale} ${key}`);
          assert.equal(vars(m[key]), vars(en[key]), `${rule.id} ${locale} ${key}`);
        }
      }
    }
    for (const locale of COMPAT_LOCALES) assert.ok(COMPAT_UI[locale].heading && COMPAT_UI[locale].note);
  });

  it('has unique rule ids', () => {
    assert.equal(new Set(COMPAT_RULES.map((r) => r.id)).size, COMPAT_RULES.length);
  });
});

describe('findConflicts', () => {
  it('passes every published build and its extras', () => {
    for (const build of BUILDS.builds) {
      const skus = build.parts.map((p) => p.sku);
      assert.deepEqual(findConflicts(skus, 'BE'), [], build.id);
      for (const extra of BUILDS.extras.filter((e) => e.with.some((w) => skus.includes(w)))) {
        assert.deepEqual(findConflicts([...skus, extra.sku], 'BE'), [], `${build.id} + ${extra.sku}`);
      }
    }
  });

  it('is quiet for an empty cart, unknown SKUs and a lone part', () => {
    assert.deepEqual(findConflicts([], 'BE'), []);
    assert.deepEqual(findConflicts(['ACC-STRAP-20X220', 'NOPE'], 'BE'), []);
    assert.deepEqual(findConflicts(['OPENFC-LITE-3030'], 'BE'), []);
  });

  it('flags a stack the frame cannot take', () => {
    const [c] = findConflicts(['OPENFC-LITE-3030', 'OPENFRAME-3'], 'BE');
    assert.equal(c.rule, 'stack-frame');
    assert.equal(c.a, 'OPENFC-LITE-3030');
    assert.equal(c.b, 'OPENFRAME-3');
    assert.equal(c.alt, 'OPENFC-LITE-2020');
  });

  it('lets a 20x20 stack into the 5" frame', () => {
    assert.deepEqual(findConflicts(['OPENFC-LITE-2020', 'OPENESC-2020', 'OPENFRAME-5'], 'BE'), []);
  });

  it('flags a flight controller and ESC that do not stack', () => {
    const [c] = findConflicts(['OPENFC-LITE-3030', 'OPENESC-2020'], 'BE');
    assert.equal(c.rule, 'stack-pair');
    assert.equal(c.alt, 'OPENFC-LITE-2020');
  });

  it('stays quiet for two complete builds in one cart', () => {
    const skus = BUILDS.builds.flatMap((b) => b.parts.map((p) => p.sku));
    assert.deepEqual(findConflicts(skus, 'BE'), []);
  });

  it('flags motors whose bolt pattern or size the frame does not take', () => {
    assert.deepEqual(rules(['OPENMOTOR-1604', 'OPENFRAME-5']), ['motor-mount']);
    // The 2306 mount is unpublished, so the size rule speaks instead of a guessed mount.
    assert.deepEqual(rules(['OPENMOTOR-2306', 'OPENFRAME-3']), ['motor-size']);
  });

  it('flags props that do not fit the frame or the motor shaft', () => {
    assert.deepEqual(rules(['ACC-PROP-5-GF-51466', 'OPENFRAME-3']), ['prop-size']);
    const [c] = findConflicts(['ACC-PROP-3-HQ-T3X3X3', 'OPENMOTOR-2306'], 'BE');
    assert.equal(c.rule, 'prop-motor-size');
    assert.ok(c.alt?.startsWith('ACC-PROP-5-'));
    // Same size, wrong shaft: 1.5 mm T-mount props on a hypothetical 5 mm-shaft 1604.
    const shafted: Record<string, CompatPart> = {...COMPAT_PARTS, 'TEST-MOTOR': {...(COMPAT_PARTS['OPENMOTOR-1604'] as Extract<CompatPart, {kind: 'motor'}>), shaft: '5mm'}};
    assert.deepEqual(findConflicts(['ACC-PROP-3-HQ-T3X3X3', 'TEST-MOTOR'], 'BE', shafted).map((x) => x.rule), ['prop-shaft']);
    // An unpublished prop mount is not judged.
    assert.deepEqual(findConflicts(['ACC-PROP-3-GF-3020', 'TEST-MOTOR'], 'BE', shafted), []);
  });

  it('flags an antenna the receiver cannot take, and suggests a receiver that can', () => {
    const [c] = findConflicts(['ACC-ANT-T', 'OPENRX-LITE'], 'BE');
    assert.equal(c.rule, 'antenna-plug');
    assert.equal(c.alt, 'OPENRX-LITE-UFL');
  });

  it('flags a 2.4 GHz antenna as the spare for a dual-band receiver', () => {
    const [c] = findConflicts(['ACC-ANT-T', 'OPENRX-MONO'], 'BE');
    assert.equal(c.rule, 'antenna-band');
    assert.equal(c.alt, 'ACC-ANT-DUAL-T');
    assert.equal(c.bValue, 'sub-GHz');
    // A dual-band antenna on a 2.4 GHz receiver works.
    assert.deepEqual(findConflicts(['ACC-ANT-DUAL-T', 'OPENRX-LITE-UFL'], 'BE'), []);
  });

  it('checks motor cells against the boards', () => {
    const narrow: Record<string, CompatPart> = {
      ...COMPAT_PARTS,
      'TEST-ESC-4S': {kind: 'esc', name: 'Test ESC', handle: 'openesc', mount: '20x20', cells: [2, 4], fcHarness: 'jst-sh-8-od', protocol: 'DShot', batteryPlug: 'XT30'},
    };
    const [c] = findConflicts(['OPENMOTOR-1604', 'TEST-ESC-4S'], 'BE', narrow);
    assert.equal(c.rule, 'motor-cells');
    assert.equal(c.aValue, '6S');
    assert.equal(c.bValue, '2–4S');
    // The closest motor that fits: same size, 4S winding.
    assert.equal(c.alt, 'OPENMOTOR-1604-4S');
  });

  it('checks a battery against the boards, motors, capacitor and ESC lead', () => {
    const on = (skus: string[]) => findConflicts(skus, 'BE', WITH_BATTERIES);
    const [over] = on(['TEST-BAT-8S-XT60', 'OPENESC-2020']);
    assert.equal(over.rule, 'battery-cells');
    // A 6S XT60 pack would clash with the ESC's XT30 lead, so the swap is the XT30 pack.
    assert.equal(over.alt, 'TEST-BAT-4S-XT30');
    assert.deepEqual(on(['TEST-BAT-6S-XT60', 'OPENMOTOR-1604-4S']).map((c) => c.rule), ['battery-cells']);
    assert.deepEqual(on(['TEST-BAT-4S-XT60', 'OPENESC-2020']).map((c) => c.rule), ['battery-plug']);
    assert.deepEqual(on(['TEST-BAT-4S-XT30', 'OPENESC-2020']), []);
    assert.deepEqual(on(['TEST-BAT-8S-XT60', 'ACC-CAP-470UF-35V']).map((c) => c.rule), ['capacitor-cells']);
    assert.deepEqual(on(['TEST-BAT-8S-XT60', 'ACC-CAP-470UF-50V']), []);
  });

  it('checks the ESC and receiver protocols', () => {
    const odd: Record<string, CompatPart> = {
      ...COMPAT_PARTS,
      'TEST-ESC-PWM': {kind: 'esc', name: 'PWM ESC', handle: 'test-esc', mount: '30.5x30.5', cells: [2, 6], fcHarness: 'jst-sh-8-od', protocol: 'PWM', batteryPlug: 'XT60'},
      'TEST-RX-SBUS': {kind: 'rx', name: 'SBUS RX', handle: 'test-rx', protocol: 'SBUS', bands: ['2.4GHz'], antennaPlug: null},
    };
    assert.deepEqual(findConflicts(['TEST-ESC-PWM', 'OPENFC-LITE-3030'], 'BE', odd).map((c) => c.rule), ['esc-protocol']);
    // The FC reads SBUS too.
    assert.deepEqual(findConflicts(['TEST-RX-SBUS', 'OPENFC-LITE-3030'], 'BE', odd), []);
    const crsfOnly: Record<string, CompatPart> = {...odd, 'TEST-FC': {...(COMPAT_PARTS['OPENFC-LITE-3030'] as Extract<CompatPart, {kind: 'fc'}>), rxProtocols: ['CRSF']}};
    assert.deepEqual(findConflicts(['TEST-RX-SBUS', 'TEST-FC'], 'BE', crsfOnly).map((c) => c.rule), ['rx-protocol']);
  });

  it('checks a sub-GHz part against the ship-to country', () => {
    const regional: Record<string, CompatPart> = {
      ...COMPAT_PARTS,
      'TEST-RX-915': {kind: 'rx', name: '915 RX', handle: 'test-rx', protocol: 'CRSF', bands: ['2.4GHz', '915MHz'], antennaPlug: 'U.FL'},
      'TEST-RX-868': {kind: 'rx', name: '868 RX', handle: 'test-rx', protocol: 'CRSF', bands: ['2.4GHz', '868MHz'], antennaPlug: 'U.FL'},
    };
    const [c] = findConflicts(['TEST-RX-915'], 'be', regional);
    assert.equal(c.rule, 'rx-region');
    assert.equal(c.b, 'BE');
    assert.equal(c.alt, 'TEST-RX-868');
    assert.deepEqual(findConflicts(['TEST-RX-915'], 'US', regional), []);
    assert.deepEqual(findConflicts(['TEST-RX-915'], 'JP', regional), []);
    assert.deepEqual(findConflicts(['TEST-RX-915'], null, regional), []);
    // The catalog's dual-band receivers cover both bands.
    assert.deepEqual(findConflicts(['OPENRX-MONO', 'OPENRX-GEMINI', 'ACC-ANT-DUAL-T'], 'DE'), []);
    assert.deepEqual(findConflicts(['OPENRX-MONO'], 'US'), []);
  });
});

describe('explainConflicts', () => {
  it('says what clashes and how to fix it', () => {
    const alert = cartCompatAlert(['OPENFC-LITE-3030', 'OPENFRAME-3'], 'BE', 'en');
    assert.equal(alert.issues.length, 1);
    const [i] = alert.issues;
    assert.equal(i.problem, 'The OpenFC Lite 30×30 has a 30.5 × 30.5 mm mount, but the OpenFrame 3" only takes 25.5 × 25.5 mm / 20 × 20 mm stacks.');
    assert.equal(i.fix, 'Choose the OpenFC Lite 20×20 instead.');
    assert.deepEqual(i.link, {href: '/products/openfc-lite?Model=20%C3%9720', label: 'See the OpenFC Lite 20×20'});
    assert.match(alert.note, /still check out/);
  });

  it('names a swap, or falls back to the rule fix when none is known', () => {
    const swap = explainConflicts(findConflicts(['TEST-BAT-4S-XT60', 'OPENESC-2020'], 'BE', WITH_BATTERIES), 'en', WITH_BATTERIES).issues[0];
    assert.equal(swap.problem, 'This battery has an XT60 plug, but the OpenESC 20×20 comes with an XT30 lead.');
    assert.equal(swap.fix, 'Choose the 4S XT30 battery instead.');
    assert.deepEqual(swap.link, {href: '/products/test-battery-xt30', label: 'See the 4S XT30 battery'});
    const bare = Object.fromEntries(Object.entries(WITH_BATTERIES).filter(([sku]) => sku !== 'TEST-BAT-4S-XT30' && sku !== 'OPENESC-3030'));
    const [i] = explainConflicts(findConflicts(['TEST-BAT-4S-XT60', 'OPENESC-2020'], 'BE', bare), 'en', bare).issues;
    assert.equal(i.fix, 'Choose a battery with an XT30 plug, or fit a matching lead.');
    assert.deepEqual(i.link, {href: '/products/test-battery', label: 'See the 4S battery'});
  });

  it('words the alert in Dutch and French with no placeholder left', () => {
    for (const locale of ['nl', 'fr'] as const) {
      const alert = cartCompatAlert(['OPENFC-LITE-3030', 'OPENESC-2020', 'OPENFRAME-3', 'ACC-ANT-T', 'OPENRX-LITE'], 'BE', locale);
      assert.equal(alert.locale, locale);
      assert.ok(alert.issues.length >= 2);
      for (const i of alert.issues) assert.doesNotMatch(`${i.problem} ${i.fix} ${i.link.label}`, /\{\w+\}/);
    }
    assert.match(cartCompatAlert(['OPENFC-LITE-3030', 'OPENFRAME-3'], 'BE', 'nl').issues[0].fix, /^Kies/);
  });

  it('reads an unknown locale as English', () => {
    assert.equal(compatLocale('de'), 'en');
    assert.equal(compatLocale(null), 'en');
    assert.equal(compatLocale('fr'), 'fr');
  });
});

describe('/cart (Shopify cart route)', () => {
  const line = (sku: string) => ({id: sku, sku, handle: 'x', quantity: 1});
  it('alerts for an incompatible combo, in the visitor language', () => {
    const a = compatForLines([line('OPENFC-LITE-2020'), line('OPENESC-3030')], 'BE', 'nl');
    assert.ok(a.issues.length > 0);
    assert.equal(a.locale, 'nl');
    assert.ok(a.heading);
  });
  it('stays silent for a compatible build and for lines without a SKU', () => {
    assert.equal(compatForLines([line('OPENFC-LITE-2020'), line('OPENESC-2020')], 'BE', 'en').issues.length, 0);
    assert.equal(compatForLines([{sku: null}], 'BE', 'en').issues.length, 0);
  });
  it('is wired into the route loader and page', () => {
    const src = fs.readFileSync(new URL('../routes/cart.$.tsx', import.meta.url), 'utf8');
    assert.match(src, /compatForLines\(cart\?\.lines/);
    assert.match(src, /<CompatAlert alert=\{compat\}/);
  });
});
