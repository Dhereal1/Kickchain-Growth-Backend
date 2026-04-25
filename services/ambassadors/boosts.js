const { isAmbassadorsEnabled } = require('../featureFlags');

function num(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

async function getActiveBoostMultiplier({ pool, ensureGrowthSchema, telegramId, boostType }) {
  if (!isAmbassadorsEnabled()) return 1;
  await ensureGrowthSchema();

  const tid = Number(telegramId);
  if (!Number.isFinite(tid) || !tid) return 1;
  const type = String(boostType || '').trim().toLowerCase();
  if (!type) return 1;

  const r = await pool.query(
    `
      SELECT b.multiplier, b.starts_at, b.ends_at
      FROM ambassadors a
      LEFT JOIN ambassador_boosts b
        ON b.telegram_id = a.telegram_id AND b.boost_type = $2
      WHERE a.telegram_id = $1 AND a.status = 'active'
      LIMIT 1
    `,
    [tid, type]
  );
  const row = r.rows[0] || null;
  if (!row || row.multiplier == null) return 1;

  const now = Date.now();
  const starts = row.starts_at ? new Date(row.starts_at).getTime() : null;
  const ends = row.ends_at ? new Date(row.ends_at).getTime() : null;
  if (starts != null && Number.isFinite(starts) && now < starts) return 1;
  if (ends != null && Number.isFinite(ends) && now > ends) return 1;

  const m = num(row.multiplier, 1);
  if (!Number.isFinite(m) || m <= 0) return 1;
  return Math.max(1, Math.min(10, m));
}

module.exports = {
  getActiveBoostMultiplier,
};

