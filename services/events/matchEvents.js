const { isMatchHypeEventsEnabled } = require('../featureFlags');

async function queueMatchHypeEvent({ pool, ensureGrowthSchema, match, winnerId, loserId, stakeAmount, hypeText }) {
  if (!isMatchHypeEventsEnabled()) return { ok: true, skipped: true, reason: 'disabled' };
  if (!pool) throw new Error('pool is required');
  if (!ensureGrowthSchema) throw new Error('ensureGrowthSchema is required');

  const matchId = Number(match?.id ?? match?.match_id);
  if (!Number.isFinite(matchId) || !matchId) return { ok: true, skipped: true, reason: 'invalid_match_id' };

  const text = String(hypeText || '').trim();
  if (!text) return { ok: true, skipped: true, reason: 'no_text' };

  await ensureGrowthSchema();

  const r = await pool.query(
    `
      INSERT INTO match_hype_events (
        match_id, winner_id, loser_id, stake_amount, hype_text, status, attempts, created_at
      )
      VALUES ($1,$2,$3,$4,$5,'queued',0,NOW())
      ON CONFLICT (match_id) DO NOTHING
      RETURNING id
    `,
    [
      matchId,
      Number(winnerId),
      Number(loserId),
      Number(stakeAmount || 0) || 0,
      text.slice(0, 3900),
    ]
  );

  return { ok: true, queued: !!r.rowCount, id: r.rows[0]?.id || null };
}

module.exports = {
  queueMatchHypeEvent,
};

