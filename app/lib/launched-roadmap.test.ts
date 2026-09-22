import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {launchedStatusFlags, ROADMAP_SKUS} from './launched-roadmap.ts';
import {ROADMAP, resolveRoadmap} from './roadmap-data.ts';
import {parseCampaignConfig} from './preorder-campaign.ts';

const config = parseCampaignConfig(
  JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')),
);

const status = (flags: Record<string, never> | ReturnType<typeof launchedStatusFlags>, id: string) =>
  resolveRoadmap(flags).find((r) => r.id === id)?.status;

describe('launchedStatusFlags', () => {
  it('files the boards with a paid first batch under beta on an open shop', () => {
    const flags = launchedStatusFlags({}, true, config);
    for (const id of ['openfc_lite_30', 'openfc_lite_mini_20', 'openesc_20', 'openesc_30']) {
      assert.equal(status(flags, id), 'beta', id);
    }
  });

  it('leaves funding-target boards and unlisted entries alone', () => {
    const flags = launchedStatusFlags({}, true, config);
    for (const id of ['openrx_lite', 'openrx_gemini', 'openframe', 'motors']) {
      assert.equal(status(flags, id), ROADMAP.find((r) => r.id === id)?.status, id);
    }
  });

  it('changes nothing while the shop is closed', () => {
    assert.deepEqual(launchedStatusFlags({}, false, config), {});
  });

  it('never lowers a status the topics already give', () => {
    const link = ROADMAP.find((r) => r.id === 'openesc_30')!.link!;
    const flags = launchedStatusFlags({[link]: 'launched'}, true, config);
    assert.equal(flags[link], 'launched');
  });

  it('maps every SKU to a campaign SKU', () => {
    for (const sku of Object.values(ROADMAP_SKUS)) {
      assert.ok(config.skus[sku], sku);
    }
  });
});
