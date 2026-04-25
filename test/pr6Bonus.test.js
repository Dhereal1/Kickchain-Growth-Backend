const test = require('node:test');
const assert = require('node:assert/strict');

const { applyReferralBonusOnSignup } = require('../services/pr6/referralBonus');

test('applyReferralBonusOnSignup applies bonus and decrements remaining conversions', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('UPDATE pr6_referral_bonuses') && String(sql).includes('RETURNING')) {
        return { rowCount: 1, rows: [{ bonus_xp: 80, remaining_conversions: 1 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const out = await applyReferralBonusOnSignup({ pool, telegramId: 123 });
  assert.equal(out.ok, true);
  assert.equal(out.applied, true);
  assert.equal(out.bonus_xp, 80);
  assert.equal(out.remaining_conversions, 1);
  assert.ok(!queries.some((q) => q.sql.includes('DELETE FROM pr6_referral_bonuses WHERE telegram_id = $1') && q.params[0] === 123));
});

test('applyReferralBonusOnSignup deletes the bonus row when conversions hit zero', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('UPDATE pr6_referral_bonuses') && String(sql).includes('RETURNING')) {
        return { rowCount: 1, rows: [{ bonus_xp: 80, remaining_conversions: 0 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const out = await applyReferralBonusOnSignup({ pool, telegramId: 123 });
  assert.equal(out.applied, true);
  assert.equal(out.remaining_conversions, 0);
  assert.ok(queries.some((q) => q.sql.includes('DELETE FROM pr6_referral_bonuses') && q.params[0] === 123));
});

test('applyReferralBonusOnSignup no-ops when no active bonus exists', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('UPDATE pr6_referral_bonuses') && String(sql).includes('RETURNING')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const out = await applyReferralBonusOnSignup({ pool, telegramId: 123 });
  assert.equal(out.ok, true);
  assert.equal(out.applied, false);
  assert.equal(out.bonus_xp, 0);
  assert.ok(queries.some((q) => q.sql.includes('DELETE FROM pr6_referral_bonuses') && q.params[0] === 123));
});

