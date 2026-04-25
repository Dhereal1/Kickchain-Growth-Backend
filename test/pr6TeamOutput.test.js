const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../services/pr6/referralOptimizer');

test('formatPr6TeamOutput renders key fields', () => {
  const out = {
    ok: true,
    dry_run: true,
    day: '2026-04-25',
    canary_percent: 100,
    distributions: {
      referral_score: { percentiles: { p50: 10, p90: 80, p99: 99 } },
      churn_risk: { percentiles: { p50: 5, p90: 70, p99: 100 } },
    },
    projections: {
      nudges_selected: 3,
      nudges_by_type: { churn_play: 1, referral_boost: 2 },
      allocated_bonus_xp: 480,
    },
    caps: { cap_hit_rate: 0.25 },
    skipped: { canary: 0, cooldown: 1, nudge_cap_7d: 2 },
    selected_signals: {
      referrals_total: { percentiles: { p50: 1, p90: 10, p99: 25 } },
      wins_30d: { percentiles: { p50: 0, p90: 5, p99: 20 } },
    },
    whale_concentration: { referrals_total_top10_share: 0.6 },
    day_over_day: {
      referral_score: { delta_percentiles: { p50: 1, p90: -2, p99: 0 } },
      churn_risk: { delta_percentiles: { p50: 0, p90: 3, p99: 5 } },
    },
  };

  const text = _internals.formatPr6TeamOutput(out);
  assert.ok(text.includes('PR6 Referral Optimizer'));
  assert.ok(text.includes('Day: 2026-04-25'));
  assert.ok(text.includes('Dry-run: yes'));
  assert.ok(text.includes('Canary: 100%'));
  assert.ok(text.includes('Projected nudges: 3'));
  assert.ok(text.includes('Allocated bonus XP: 480'));
  assert.ok(text.includes('Cap hit rate'));
  assert.ok(text.includes('Selected referrals_total'));
  assert.ok(text.includes('Whale share'));
  assert.ok(text.includes('DoD Δ referral'));
  assert.ok(text.includes('DoD Δ churn'));
});
