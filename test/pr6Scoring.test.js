const test = require('node:test');
const assert = require('node:assert/strict');

const { computeReferralScore, computeChurnRisk } = require('../services/pr6/scoring');

test('computeReferralScore is deterministic and clamps to 0..100', () => {
  const a = computeReferralScore({
    referralsTotal: 0,
    winsLast30d: 0,
    winStreak: 0,
    dailyStreak: 0,
  });
  assert.equal(a, 0);

  const b = computeReferralScore({
    referralsTotal: 999,
    winsLast30d: 999,
    winStreak: 999,
    dailyStreak: 999,
  });
  assert.equal(b, 100);

  const c1 = computeReferralScore({ referralsTotal: 5, winsLast30d: 3, winStreak: 2, dailyStreak: 7 });
  const c2 = computeReferralScore({ referralsTotal: 5, winsLast30d: 3, winStreak: 2, dailyStreak: 7 });
  assert.equal(c1, c2);
  assert.ok(c1 >= 0 && c1 <= 100);
});

test('computeChurnRisk follows the days-based clamp formula', () => {
  const now = Date.UTC(2026, 0, 16, 0, 0, 0);

  // Same-day activity => 0 risk.
  assert.equal(computeChurnRisk({ lastActiveAtMs: now, nowMs: now }), 0);

  // 1 day inactivity => 0 risk (days=1 => (1-1)/14=0).
  assert.equal(computeChurnRisk({ lastActiveAtMs: now - 1 * 86400_000, nowMs: now }), 0);

  // 15 days inactivity => 100 risk (clamped).
  assert.equal(computeChurnRisk({ lastActiveAtMs: now - 15 * 86400_000, nowMs: now }), 100);
});

