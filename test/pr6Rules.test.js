const test = require('node:test');
const assert = require('node:assert/strict');

const { decidePr6Nudge } = require('../services/pr6/rules');

test('decidePr6Nudge follows priority order', () => {
  // Rule 1: churn + referral
  assert.deepEqual(decidePr6Nudge({ referralScore: 50, churnRisk: 70 }), {
    nudge_type: 'churn_referral',
    grant_bonus: true,
  });

  // Rule 2: referral only
  assert.deepEqual(decidePr6Nudge({ referralScore: 75, churnRisk: 0 }), {
    nudge_type: 'referral_boost',
    grant_bonus: true,
  });

  // Rule 3: churn only
  assert.deepEqual(decidePr6Nudge({ referralScore: 0, churnRisk: 70 }), {
    nudge_type: 'churn_play',
    grant_bonus: false,
  });

  // Below thresholds => no nudge
  assert.equal(decidePr6Nudge({ referralScore: 49, churnRisk: 69 }), null);
});

