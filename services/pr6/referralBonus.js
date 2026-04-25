function num(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

async function upsertReferralBonus({
  pool,
  telegramId,
  bonusXp,
  remainingConversions,
  ttlHours,
} = {}) {
  if (!pool) throw new Error('pool is required');
  const tid = Number(telegramId);
  if (!Number.isFinite(tid) || !tid) throw new Error('telegram_id is required');

  const xp = Math.max(0, Math.trunc(num(bonusXp, 0)));
  const remaining = Math.max(0, Math.trunc(num(remainingConversions, 0)));
  const hours = Math.max(1, num(ttlHours, 48));
  if (xp <= 0 || remaining <= 0) return { ok: true, skipped: true, reason: 'no_bonus_config' };

  const r = await pool.query(
    `
      INSERT INTO pr6_referral_bonuses (
        telegram_id, bonus_xp, remaining_conversions, expires_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, NOW() + ($4::numeric * INTERVAL '1 hour'), NOW(), NOW())
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        bonus_xp = EXCLUDED.bonus_xp,
        remaining_conversions = EXCLUDED.remaining_conversions,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      WHERE pr6_referral_bonuses.expires_at < NOW()
         OR pr6_referral_bonuses.remaining_conversions <= 0
      RETURNING telegram_id
    `,
    [tid, xp, remaining, hours]
  );

  return { ok: true, granted: !!r.rowCount };
}

async function applyReferralBonusOnSignup({ pool, telegramId } = {}) {
  if (!pool) throw new Error('pool is required');
  const tid = Number(telegramId);
  if (!Number.isFinite(tid) || !tid) return { ok: true, bonus_xp: 0, applied: false };

  // Decrement atomically if active.
  const dec = await pool.query(
    `
      UPDATE pr6_referral_bonuses
      SET remaining_conversions = remaining_conversions - 1,
          updated_at = NOW()
      WHERE telegram_id = $1
        AND remaining_conversions > 0
        AND expires_at > NOW()
      RETURNING bonus_xp, remaining_conversions
    `,
    [tid]
  );

  if (!dec.rowCount) {
    // Best-effort cleanup for expired/empty rows.
    await pool.query(
      `DELETE FROM pr6_referral_bonuses WHERE telegram_id = $1 AND (expires_at <= NOW() OR remaining_conversions <= 0)`,
      [tid]
    );
    return { ok: true, bonus_xp: 0, applied: false };
  }

  const row = dec.rows[0] || {};
  const bonusXp = Math.max(0, Math.trunc(num(row.bonus_xp, 0)));
  const remaining = Math.max(0, Math.trunc(num(row.remaining_conversions, 0)));

  if (remaining <= 0) {
    await pool.query(`DELETE FROM pr6_referral_bonuses WHERE telegram_id = $1`, [tid]);
  }

  return { ok: true, bonus_xp: bonusXp, applied: bonusXp > 0, remaining_conversions: remaining };
}

module.exports = {
  upsertReferralBonus,
  applyReferralBonusOnSignup,
};

