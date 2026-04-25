const { isTournamentOrchestrationEnabled } = require('../featureFlags');
const { isAmbassadorsEnabled } = require('../featureFlags');
const { generateSingleElimBracket } = require('./bracket');

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function getTournamentState({ pool, ensureGrowthSchema, tournamentId }) {
  if (!pool) throw new Error('pool is required');
  if (!ensureGrowthSchema) throw new Error('ensureGrowthSchema is required');
  await ensureGrowthSchema();

  const id = Number(tournamentId);
  if (!Number.isFinite(id) || !id) throw new Error('tournament_id is required');

  const tRes = await pool.query('SELECT * FROM tournaments WHERE id = $1 LIMIT 1', [id]);
  const tournament = tRes.rows[0] || null;
  if (!tournament) return { tournament: null, participants: [], bracket: [] };

  const pRes = await pool.query(
    `
      SELECT tournament_id, telegram_id, seed, status, joined_at
      FROM tournament_participants
      WHERE tournament_id = $1
      ORDER BY joined_at ASC, telegram_id ASC
    `,
    [id]
  );
  const participants = pRes.rows || [];

  const bRes = await pool.query(
    `
      SELECT *
      FROM tournament_bracket_matches
      WHERE tournament_id = $1
      ORDER BY round ASC, slot ASC
    `,
    [id]
  );
  const bracket = bRes.rows || [];

  return { tournament, participants, bracket };
}

async function joinTournament({ pool, ensureGrowthSchema, tournamentId, telegramId }) {
  if (!isTournamentOrchestrationEnabled()) return { ok: false, error: 'disabled' };
  await ensureGrowthSchema();

  const id = Number(tournamentId);
  const tid = Number(telegramId);
  if (!Number.isFinite(id) || !id) throw new Error('tournament_id is required');
  if (!Number.isFinite(tid) || !tid) throw new Error('telegram_id is required');

  const tRes = await pool.query('SELECT * FROM tournaments WHERE id = $1 LIMIT 1', [id]);
  const t = tRes.rows[0] || null;
  if (!t) return { ok: false, error: 'not_found' };
  if (String(t.status || 'upcoming') !== 'upcoming') return { ok: false, error: 'not_joinable' };

  const rules = t.rules && typeof t.rules === 'object' ? t.rules : {};
  const ambassadorOnly = rules && rules.ambassador_only === true;
  if (ambassadorOnly && isAmbassadorsEnabled()) {
    const a = await pool.query(
      `SELECT telegram_id FROM ambassadors WHERE telegram_id = $1 AND status = 'active' LIMIT 1`,
      [tid]
    );
    if (!a.rowCount) return { ok: false, error: 'ambassador_only' };
  }

  const maxP = Math.max(2, Math.min(256, Number(t.max_participants || 16) || 16));
  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM tournament_participants WHERE tournament_id = $1',
    [id]
  );
  const n = Number(countRes.rows[0]?.n || 0);
  if (n >= maxP) return { ok: false, error: 'full' };

  await pool.query(
    `
      INSERT INTO tournament_participants (tournament_id, telegram_id, status, joined_at)
      VALUES ($1, $2, 'joined', NOW())
      ON CONFLICT (tournament_id, telegram_id) DO NOTHING
    `,
    [id, tid]
  );

  return { ok: true };
}

async function startTournament({ pool, ensureGrowthSchema, tournamentId }) {
  if (!isTournamentOrchestrationEnabled()) return { ok: false, error: 'disabled' };
  await ensureGrowthSchema();

  const id = Number(tournamentId);
  if (!Number.isFinite(id) || !id) throw new Error('tournament_id is required');

  const tRes = await pool.query('SELECT * FROM tournaments WHERE id = $1 LIMIT 1', [id]);
  const t = tRes.rows[0] || null;
  if (!t) return { ok: false, error: 'not_found' };
  if (String(t.status || 'upcoming') !== 'upcoming') return { ok: false, error: 'already_started' };

  const pRes = await pool.query(
    `
      SELECT tournament_id, telegram_id, joined_at
      FROM tournament_participants
      WHERE tournament_id = $1
      ORDER BY joined_at ASC, telegram_id ASC
    `,
    [id]
  );
  const participants = pRes.rows || [];
  if (participants.length < 2) return { ok: false, error: 'not_enough_participants' };

  const bracket = generateSingleElimBracket(participants, { maxParticipants: t.max_participants || 16 });

  // Assign seeds deterministically
  for (let i = 0; i < Math.min(participants.length, Number(t.max_participants || 16) || 16); i += 1) {
    const pid = Number(participants[i].telegram_id);
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `UPDATE tournament_participants SET seed = $3 WHERE tournament_id = $1 AND telegram_id = $2`,
      [id, pid, i + 1]
    );
  }

  const stake = num(t.entry_stake_amount || 0);

  // Insert bracket matches; create underlying matches only for round 1 when both players are known.
  for (const m of bracket.matches) {
    let matchId = null;
    let status = 'pending';
    let winnerId = null;

    // Byes: auto-complete with player_a as winner when player_b is null.
    if (m.round === 1 && m.player_a && !m.player_b) {
      status = 'completed';
      winnerId = Number(m.player_a);
    } else if (m.round === 1 && m.player_a && m.player_b) {
      status = 'active';
      const created = await pool.query(
        `
          INSERT INTO matches (challenger_id, opponent_id, status, winner_id, stake_amount, is_fun_mode)
          VALUES ($1, $2, 'active', NULL, $3, FALSE)
          RETURNING id
        `,
        [Number(m.player_a), Number(m.player_b), stake]
      );
      matchId = created.rows[0]?.id || null;
    }

    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `
        INSERT INTO tournament_bracket_matches (
          tournament_id, round, slot, player_a, player_b, match_id, winner_id, status, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
        ON CONFLICT (tournament_id, round, slot)
        DO UPDATE SET
          player_a = COALESCE(EXCLUDED.player_a, tournament_bracket_matches.player_a),
          player_b = COALESCE(EXCLUDED.player_b, tournament_bracket_matches.player_b),
          match_id = COALESCE(EXCLUDED.match_id, tournament_bracket_matches.match_id),
          winner_id = COALESCE(EXCLUDED.winner_id, tournament_bracket_matches.winner_id),
          status = EXCLUDED.status,
          updated_at = NOW()
      `,
      [id, m.round, m.slot, m.player_a, m.player_b, matchId, winnerId, status]
    );
  }

  await pool.query(
    `UPDATE tournaments
     SET status = 'active', start_date = COALESCE(start_date, NOW())
     WHERE id = $1`,
    [id]
  );

  // Apply bye propagation once on start.
  await recomputeTournamentProgress({ pool, ensureGrowthSchema, tournamentId: id });

  return { ok: true, bracket: { size: bracket.size, rounds: bracket.rounds } };
}

async function recomputeTournamentProgress({ pool, ensureGrowthSchema, tournamentId }) {
  await ensureGrowthSchema();
  const id = Number(tournamentId);
  const bRes = await pool.query(
    `
      SELECT *
      FROM tournament_bracket_matches
      WHERE tournament_id = $1
      ORDER BY round ASC, slot ASC
    `,
    [id]
  );
  const bracket = bRes.rows || [];
  if (!bracket.length) return { ok: true, updated: 0 };

  // Map for quick lookup
  const key = (round, slot) => `${round}:${slot}`;
  const map = new Map();
  for (const m of bracket) map.set(key(Number(m.round), Number(m.slot)), m);

  let updated = 0;

  for (const m of bracket) {
    const round = Number(m.round);
    const slot = Number(m.slot);
    const winner = m.winner_id != null ? Number(m.winner_id) : null;
    const status = String(m.status || '').toLowerCase();
    if (!winner || status !== 'completed') continue;

    const nextRound = round + 1;
    const nextSlot = Math.floor(slot / 2);
    const target = map.get(key(nextRound, nextSlot));
    if (!target) continue;

    const isLeft = slot % 2 === 0;
    const field = isLeft ? 'player_a' : 'player_b';
    const otherField = isLeft ? 'player_b' : 'player_a';
    const currentVal = target[field] != null ? Number(target[field]) : null;
    if (currentVal === winner) continue;

    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `
        UPDATE tournament_bracket_matches
        SET ${field} = $4, updated_at = NOW()
        WHERE tournament_id = $1 AND round = $2 AND slot = $3
      `,
      [id, nextRound, nextSlot, winner]
    );
    updated += 1;

    // If next match now has both players and no match_id, create a match.
    const refreshed = await pool.query(
      `
        SELECT *
        FROM tournament_bracket_matches
        WHERE tournament_id = $1 AND round = $2 AND slot = $3
        LIMIT 1
      `,
      [id, nextRound, nextSlot]
    );
    const nm = refreshed.rows[0] || null;
    if (nm && nm.match_id == null && nm.player_a && nm.player_b) {
      const tRes = await pool.query('SELECT entry_stake_amount FROM tournaments WHERE id = $1', [id]);
      const stake = num(tRes.rows[0]?.entry_stake_amount || 0);
      const created = await pool.query(
        `
          INSERT INTO matches (challenger_id, opponent_id, status, winner_id, stake_amount, is_fun_mode)
          VALUES ($1, $2, 'active', NULL, $3, FALSE)
          RETURNING id
        `,
        [Number(nm.player_a), Number(nm.player_b), stake]
      );
      const matchId = created.rows[0]?.id || null;
      await pool.query(
        `
          UPDATE tournament_bracket_matches
          SET match_id = $4, status = 'active', updated_at = NOW()
          WHERE tournament_id = $1 AND round = $2 AND slot = $3
        `,
        [id, nextRound, nextSlot, matchId]
      );
      updated += 1;
    }
  }

  // If final match completed, mark tournament completed.
  const last = bracket[bracket.length - 1];
  if (last && Number(last.round) > 0 && String(last.status || '').toLowerCase() === 'completed' && last.winner_id) {
    await pool.query(`UPDATE tournaments SET status='completed' WHERE id=$1 AND status <> 'completed'`, [id]);
  }

  return { ok: true, updated };
}

async function applyMatchResultToTournament({ pool, ensureGrowthSchema, matchId, winnerId }) {
  if (!isTournamentOrchestrationEnabled()) return { ok: true, skipped: true, reason: 'disabled' };
  await ensureGrowthSchema();
  const mid = Number(matchId);
  const wid = Number(winnerId);
  if (!Number.isFinite(mid) || !Number.isFinite(wid)) return { ok: true, skipped: true, reason: 'invalid' };

  const r = await pool.query(
    `
      SELECT tournament_id, round, slot, status
      FROM tournament_bracket_matches
      WHERE match_id = $1
      LIMIT 1
    `,
    [mid]
  );
  const row = r.rows[0] || null;
  if (!row) return { ok: true, skipped: true, reason: 'not_tournament_match' };

  await pool.query(
    `
      UPDATE tournament_bracket_matches
      SET winner_id = $2, status = 'completed', updated_at = NOW()
      WHERE match_id = $1
    `,
    [mid, wid]
  );

  const tournamentId = Number(row.tournament_id);
  await recomputeTournamentProgress({ pool, ensureGrowthSchema, tournamentId });
  return { ok: true, tournament_id: tournamentId };
}

module.exports = {
  getTournamentState,
  joinTournament,
  startTournament,
  recomputeTournamentProgress,
  applyMatchResultToTournament,
};
