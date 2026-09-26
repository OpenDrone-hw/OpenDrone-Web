import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {describe, it} from 'node:test';
import {DISCORD_API, discordApiBase} from './discord.ts';
import {devOverride} from './dev-overrides.ts';
import {adminEndpoint} from './shopify.ts';
import {storefrontEndpoint} from '../shopify-storefront.ts';

const SANDBOX = {
  SUPPORT_DEV_DISCORD_API: 'http://localhost:5196/discord',
  SUPPORT_DEV_SHOPIFY_ADMIN_URL: 'http://localhost:5196/shopify',
  SHOPIFY_STORE_DOMAIN: 'opendrone-test.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'shpat_test',
};

describe('sandbox overrides', () => {
  it('accept localhost URLs only', () => {
    assert.equal(devOverride('http://localhost:5196/discord/'), 'http://localhost:5196/discord');
    assert.equal(devOverride('http://127.0.0.1:5300/'), 'http://127.0.0.1:5300');
    assert.equal(devOverride('https://evil.example/discord'), null);
    assert.equal(devOverride('http://localhost.evil.example/x'), null);
    assert.equal(devOverride(undefined), null);
  });

  it('are ignored outside the Vite dev server', () => {
    assert.equal(discordApiBase(SANDBOX), DISCORD_API);
    assert.equal(adminEndpoint(SANDBOX)?.url, 'https://opendrone-test.myshopify.com/admin/api/2026-07/graphql.json');
    assert.equal(
      storefrontEndpoint({...SANDBOX, SUPPORT_DEV_STOREFRONT_URL: 'http://localhost:5196/storefront'} as never),
      'https://opendrone-test.myshopify.com/api/2026-07/graphql.json',
    );
  });

  // When a build exists (`npm run build`), the override variables must not
  // survive into the Worker bundle at all: Vite folds import.meta.env.DEV to
  // false and the minifier drops the branch.
  const serverDir = new URL('../../../dist/server/', import.meta.url);
  it('are compiled out of the production Worker bundle', {skip: existsSync(serverDir) ? false : 'no build in dist/'}, () => {
    const files = execFileSync('find', [serverDir.pathname, '-name', '*.js'], {encoding: 'utf8'}).trim().split('\n');
    assert.ok(files.length > 0 && readdirSync(serverDir).length > 0);
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      assert.doesNotMatch(code, /SUPPORT_DEV_DISCORD_API|SUPPORT_DEV_SHOPIFY_ADMIN_URL|SUPPORT_DEV_STOREFRONT_URL/, f);
    }
  });
});
