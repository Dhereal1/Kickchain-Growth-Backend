const test = require('node:test');
const assert = require('node:assert/strict');

const { runPr6ReferralOptimizer } = require('../services/pr6/referralOptimizer');

function restoreEnv(prev) {
  for (const k of Object.keys(process.env)) {
    if (!(k in prev)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(prev)) {
    process.env[k] = v;
  }
}

test('PR6 optimizer respects max nudges per user / 7d cap (dry run)', async () => {
  const prev = { ...process.env };
  process.env.PR6_MAX_NUDGES_PER_RUN = '50';
  process.env.PR6_MAX_NUDGES_PER_USER_7D = '1';
  process.env.PR6_REFERRAL_SCORE_THRESHOLD = '0';
  process.env.PR6_CHURN_RISK_THRESHOLD = '0';

  const pool = {
    async query(sql) {
      const s = String(sql);
      if (s.includes("SELECT (NOW() AT TIME ZONE 'UTC')::date AS day")) {
        return { rows: [{ day: '2026-04-25' }] };
      }
      if (s.includes('WITH referral_counts AS') && s.includes('FROM users u')) {
        return {
          rows: [
            {
              telegram_id: 123,
              username: 'alice',
              referral_code: 'KC123',
              referrals_total: 25,
              wins_30d: 20,
              win_streak: 10,
              daily_streak: 14,
              last_active_at: '2026-04-25T00:00:00.000Z',
              last_pr6_nudge_at: null,
              pr6_nudges_7d: 1,
              pr6_bonus_xp_30d: 0,
            },
          ],
        };
      }
      if (s.includes('INSERT INTO pr6_user_scores_daily')) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  try {
    const out = await runPr6ReferralOptimizer({
      pool,
      ensureGrowthSchema: async () => {},
      dryRun: true,
    });
    assert.equal(out.ok, true);
    assert.equal(out.dry_run, true);
    assert.deepEqual(out.would_nudge, []);
    assert.ok(out.distributions?.referral_score?.buckets_10?.length === 10);
  } finally {
    restoreEnv(prev);
  }
});

test('PR6 optimizer blocks bonus grant when 30d bonus cap would be exceeded (dry run)', async () => {
  const prev = { ...process.env };
  process.env.PR6_MAX_NUDGES_PER_RUN = '50';
  process.env.PR6_MAX_NUDGES_PER_USER_7D = '10';
  process.env.PR6_MAX_BONUS_XP_PER_USER_30D = '200';
  process.env.PR6_BONUS_XP = '80';
  process.env.PR6_BONUS_CONVERSIONS = '3'; // potential 240, should be blocked by 200 cap
  process.env.PR6_REFERRAL_SCORE_THRESHOLD = '0';
  process.env.PR6_CHURN_RISK_THRESHOLD = '0';

  const pool = {
    async query(sql) {
      const s = String(sql);
      if (s.includes("SELECT (NOW() AT TIME ZONE 'UTC')::date AS day")) {
        return { rows: [{ day: '2026-04-25' }] };
      }
      if (s.includes('WITH referral_counts AS') && s.includes('FROM users u')) {
        return {
          rows: [
            {
              telegram_id: 456,
              username: 'bob',
              referral_code: 'KC456',
              referrals_total: 25,
              wins_30d: 20,
              win_streak: 10,
              daily_streak: 14,
              last_active_at: '2026-04-25T00:00:00.000Z',
              last_pr6_nudge_at: null,
              pr6_nudges_7d: 0,
              pr6_bonus_xp_30d: 0,
            },
          ],
        };
      }
      if (s.includes('INSERT INTO pr6_user_scores_daily')) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  try {
    const out = await runPr6ReferralOptimizer({
      pool,
      ensureGrowthSchema: async () => {},
      dryRun: true,
    });
    assert.equal(out.ok, true);
    assert.equal(out.dry_run, true);
    assert.equal(out.would_nudge.length, 1);
    assert.equal(out.would_nudge[0].telegram_id, 456);
    assert.equal(out.would_nudge[0].grant_bonus, false);
    assert.equal(out.would_nudge[0].bonus_capped, true);
  } finally {
    restoreEnv(prev);
  }
});

test('PR6 optimizer canaries by deterministic percent (dry run)', async () => {
  const prev = { ...process.env };
  process.env.PR6_CANARY_PERCENT = '0';
  process.env.PR6_CANARY_SALT = 'x';
  process.env.PR6_MAX_NUDGES_PER_RUN = '50';
  process.env.PR6_REFERRAL_SCORE_THRESHOLD = '0';
  process.env.PR6_CHURN_RISK_THRESHOLD = '0';

  const pool = {
    async query(sql) {
      const s = String(sql);
      if (s.includes("SELECT (NOW() AT TIME ZONE 'UTC')::date AS day")) {
        return { rows: [{ day: '2026-04-25' }] };
      }
      if (s.includes('WITH referral_counts AS') && s.includes('FROM users u')) {
        return {
          rows: [
            {
              telegram_id: 999,
              username: 'z',
              referral_code: 'KC999',
              referrals_total: 25,
              wins_30d: 20,
              win_streak: 10,
              daily_streak: 14,
              last_active_at: '2026-04-25T00:00:00.000Z',
              last_pr6_nudge_at: null,
              pr6_nudges_7d: 0,
              pr6_bonus_xp_30d: 0,
            },
          ],
        };
      }
      if (s.includes('INSERT INTO pr6_user_scores_daily')) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  try {
    const out = await runPr6ReferralOptimizer({
      pool,
      ensureGrowthSchema: async () => {},
      dryRun: true,
    });
    assert.equal(out.ok, true);
    assert.equal(out.dry_run, true);
    assert.equal(out.canary_percent, 0);
    assert.deepEqual(out.would_nudge, []);
    assert.equal(out.skipped.canary, 1);
  } finally {
    restoreEnv(prev);
  }
});
