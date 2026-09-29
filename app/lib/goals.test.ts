import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {AUTO_PCT_STEP, computeAutoPct, normalizeGoal, type Goal} from './goals.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/goals.test.ts

describe('normalizeGoal', () => {
  it('passes a well-formed goal through', () => {
    const g = normalizeGoal({
      id: 'pick-and-place',
      status: 'current',
      title: 'A pick and place machine',
      body: 'First step to EU assembly.',
      target_label: 'about €30k',
      progress_pct: 33,
    });
    assert.equal(g?.progress_pct, 33);
    assert.equal(g?.status, 'current');
  });

  it('keeps the hidden flag only when true', () => {
    assert.equal(normalizeGoal({id: 'x', hidden: true})?.hidden, true);
    assert.equal(normalizeGoal({id: 'x', hidden: 'yes'})?.hidden, undefined);
  });

  it('clamps progress into 0-100 and rounds', () => {
    assert.equal(normalizeGoal({id: 'x', progress_pct: 140})?.progress_pct, 100);
    assert.equal(normalizeGoal({id: 'x', progress_pct: -5})?.progress_pct, 0);
    assert.equal(normalizeGoal({id: 'x', progress_pct: 12.6})?.progress_pct, 13);
  });

  it('defaults junk fields instead of failing the page', () => {
    const g = normalizeGoal({id: 'x', status: 'someday', progress_pct: 'lots'});
    assert.equal(g?.status, 'next');
    assert.equal(g?.progress_pct, 0);
    assert.equal(g?.title, '');
  });

  it('rejects records without an id', () => {
    assert.equal(normalizeGoal({title: 'no id'}), null);
    assert.equal(normalizeGoal(null), null);
    assert.equal(normalizeGoal('goal'), null);
  });

  it('defaults the auto-mode fields', () => {
    const g = normalizeGoal({id: 'x'});
    assert.equal(g?.mode, 'manual');
    assert.equal(g?.target_eur, null);
    assert.equal(g?.allocation_pct, 100);
    assert.equal(g?.since, '');
  });
});

const AUTO_GOAL: Goal = {
  id: 'pnp',
  status: 'current',
  title: '',
  body: '',
  target_label: '',
  progress_pct: 0,
  mode: 'auto',
  target_eur: 30000,
  allocation_pct: 20,
  since: '2026-08-11',
};

describe('computeAutoPct', () => {
  it('applies allocation, divides by target, floors to 5% steps', () => {
    // 30k gross * 20% = 6k counted of 30k = 20%.
    assert.equal(computeAutoPct(30000, AUTO_GOAL), 20);
    // 34.4k gross * 20% = 6.88k = 22.9%, floors into the 20% band.
    assert.equal(computeAutoPct(34400, AUTO_GOAL), 20);
    // Just under a band boundary stays below it: no false progress.
    assert.equal(computeAutoPct(37499, AUTO_GOAL), 20);
    assert.equal(computeAutoPct(37500, AUTO_GOAL), 25);
  });

  it('clamps at 100 and never goes negative', () => {
    assert.equal(computeAutoPct(10_000_000, AUTO_GOAL), 100);
    assert.equal(computeAutoPct(-500, AUTO_GOAL), 0);
  });

  it('returns null for manual goals and missing targets', () => {
    assert.equal(computeAutoPct(1000, {...AUTO_GOAL, mode: 'manual'}), null);
    assert.equal(computeAutoPct(1000, {...AUTO_GOAL, target_eur: null}), null);
  });
});

describe('update script mirror', () => {
  // scripts/update-goals.mjs cannot import this TS module, so it restates
  // the formula. This fails when the two drift.
  const script = fs.readFileSync(
    path.join(import.meta.dirname, '../../scripts/update-goals.mjs'),
    'utf8',
  );

  it('uses the same step and formula shape', () => {
    assert.ok(script.includes(`AUTO_PCT_STEP = ${AUTO_PCT_STEP}`));
    assert.ok(
      script.includes(
        'Math.min(100, Math.floor(raw / AUTO_PCT_STEP) * AUTO_PCT_STEP)',
      ),
    );
    assert.ok(
      script.includes(
        'Math.max(0, grossEur) * (goal.allocation_pct / 100)',
      ),
    );
  });
});
