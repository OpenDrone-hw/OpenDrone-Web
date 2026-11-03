import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {
  devicePolicyFor,
  FLASH_PATH,
  flashRedirectTarget,
  isFlashHref,
  LEGACY_FLASH_PATHS,
} from './flash-path.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('web flasher lives at /guides/flash', () => {
  it('is a sibling of the guides', () => {
    assert.equal(FLASH_PATH, '/guides/flash');
  });

  it('the old URLs and their locale variants redirect there, keeping the query', () => {
    assert.deepEqual([...LEGACY_FLASH_PATHS], ['/flash', '/en/flash', '/nl/flash', '/fr/flash']);
    assert.equal(flashRedirectTarget('https://opendrone.be/flash'), '/guides/flash');
    assert.equal(flashRedirectTarget('https://opendrone.be/flash?board=openfc-lite&x=1'), '/guides/flash?board=openfc-lite&x=1');
    assert.equal(flashRedirectTarget('https://opendrone.be/nl/flash/?esc=1'), '/guides/flash?esc=1');
  });

  it('routes.ts mounts the 301 on every legacy path, outside app/routes', () => {
    const routes = read('../routes.ts');
    assert.match(routes, /LEGACY_FLASH_PATHS\.map\(\(path\) =>\s*route\(path, 'redirects\/flash\.tsx'/);
    assert.match(routes, /\.\.\.flashRedirects\]/);
    const redirect = read('../redirects/flash.tsx');
    assert.match(redirect, /redirect\(flashRedirectTarget\(request\.url\), 301\)/);
    assert.throws(() => read('../routes/flash.tsx'), /ENOENT/, 'app/routes/flash.tsx must be gone, or flatRoutes serves /flash twice');
    assert.ok(read('../routes/guides.flash.tsx').includes('<FcFlasher'));
  });
});

describe('USB/serial Permissions-Policy', () => {
  it('is allowed on /guides/flash only', () => {
    for (const p of ['/guides/flash', '/guides/flash/', '/guides/flash//']) {
      assert.equal(devicePolicyFor(p), 'serial=(self), usb=(self)', p);
    }
    for (const p of [
      '/',
      '/flash',
      '/flash/',
      '/nl/flash',
      '/guides',
      '/guides/',
      '/guides/flashx',
      '/guides/flash/x',
      '/guides/flash-openfc/flash',
      '/guides/flash-openesc/flash',
      '/support',
      '/products/openfc-lite',
    ]) {
      assert.equal(devicePolicyFor(p), 'serial=(), usb=()', p);
    }
  });

  it('entry.server.tsx uses devicePolicyFor, not a hard-coded path', () => {
    const entry = read('../entry.server.tsx');
    assert.match(entry, /const devicePolicy = devicePolicyFor\(new URL\(request\.url\)\.pathname\);/);
    assert.doesNotMatch(entry, /=== '\/flash'/);
  });
});

describe('links to the flasher', () => {
  it('isFlashHref matches the page and its fragments/queries only', () => {
    for (const h of ['/guides/flash', '/guides/flash#esc', '/guides/flash?x=1', '/guides/flash/']) assert.ok(isFlashHref(h), h);
    for (const h of ['/flash', '/guides', '/guides/flash-openfc/flash', '/guides/flashx']) assert.ok(!isFlashHref(h), h);
  });

  const files = [
    '../components/Header.tsx',
    '../components/Footer.tsx',
    './header-menu.ts',
    '../routes/support.tsx',
    '../routes/products.$handle.tsx',
    '../routes/guides._index.tsx',
    '../routes/guides.$family.$step.tsx',
    '../routes/[llms.txt].tsx',
    './guides.ts',
  ];

  it('no page links to the old /flash URL', () => {
    for (const f of files) {
      const src = read(f);
      assert.doesNotMatch(src, /(?:to|href|url)[=:]\s*["'{]?\s*["']\/flash["'/#?]/, f);
      assert.doesNotMatch(src, /\]\(\/flash[)#?]/, f);
      assert.doesNotMatch(src, /\$\{origin\}\/flash\b/, f);
    }
  });

  it('the footer, support tile, PDP and guides point at /guides/flash with a full document load', () => {
    // The header menu and phone drawer no longer list the firmware page (header-menu.test.ts).
    const footer = read('../components/Footer.tsx');
    assert.match(footer, /\{to: '\/guides\/flash', copy: 'nav_flash'\}/);
    assert.match(footer, /reloadDocument=\{to === '\/guides\/flash'\}/);
    assert.match(footer, /\{to: '\/guides', copy: 'nav_guides'\}/, 'footer "Firmware guides" still points at the index');
    assert.match(read('../routes/support.tsx'), /<Link to="\/guides\/flash" reloadDocument/);
    assert.match(read('../routes/products.$handle.tsx'), /reloadDocument to="\/guides\/flash">/);
    assert.match(read('../routes/guides.$family.$step.tsx'), /<a href="\/guides\/flash" /);
    assert.match(read('../components/GuideText.tsx'), /if \(isFlashHref\(n\.href\)\)/);
  });

  it('the guides index lists the flasher above the guide families', () => {
    const index = read('../routes/guides._index.tsx');
    const entry = index.indexOf('<a href="/guides/flash"');
    assert.ok(entry > 0);
    assert.ok(entry < index.indexOf('GUIDE_FAMILIES.map'), 'flasher entry comes before the families');
  });

  it('the flasher page carries the guide back link and breadcrumb', () => {
    const page = read('../routes/guides.flash.tsx');
    assert.match(page, /<Link prefetch="intent" to="\/guides">/);
    assert.match(page, /\{name: 'Update firmware', path: '\/guides\/flash'\}/);
  });
});
