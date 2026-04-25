const test = require('node:test');
const assert = require('node:assert/strict');

const { computeAmbassadorEligibility } = require('../services/ambassadors/eligibility');

test('computeAmbassadorEligibility becomes eligible at thresholds', () => {
  const a = computeAmbassadorEligibility({ userStats: { total_referrals: 0, wins: 0, level: 1 } });
  assert.equal(a.eligible, false);

  const b = computeAmbassadorEligibility({ userStats: { total_referrals: 10, wins: 0, level: 1 } });
  assert.equal(b.eligible, true);
});

