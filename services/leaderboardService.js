const pool = require('../db/pool');

async function getTopReferrers(limit = 10) {
  const result = await pool.query(
    `
      SELECT
        u.username,
        u.referral_code,
        COUNT(r.id)::int AS referral_count
      FROM users u
      LEFT JOIN users r
        ON r.referred_by = u.referral_code
      GROUP BY u.id
      ORDER BY referral_count DESC
      LIMIT $1;
    `,
    [limit]
  );

  return result.rows;
}

async function getTopWinners(limit = 10) {
  try {
    const result = await pool.query(
      `
        SELECT
          username,
          COALESCE(wins, 0)::int AS wins,
          COALESCE(total_won, 0)::numeric AS total_won
        FROM users
        ORDER BY COALESCE(wins, 0) DESC, COALESCE(total_won, 0) DESC
        LIMIT $1;
      `,
      [limit]
    );
    return result.rows;
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('column') && msg.includes('wins') && msg.includes('does not exist')) {
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0');
      const result = await pool.query(
        `
          SELECT
            username,
            COALESCE(wins, 0)::int AS wins,
            COALESCE(total_won, 0)::numeric AS total_won
          FROM users
          ORDER BY COALESCE(wins, 0) DESC, COALESCE(total_won, 0) DESC
          LIMIT $1;
        `,
        [limit]
      );
      return result.rows;
    }
    throw err;
  }
}

async function getTopPlayers(limit = 10) {
  try {
    const result = await pool.query(
      `
        SELECT
          username,
          COALESCE(matches_played, 0)::int AS matches_played,
          COALESCE(games_played, 0)::int AS games_played
        FROM users
        ORDER BY COALESCE(matches_played, 0) DESC, COALESCE(games_played, 0) DESC
        LIMIT $1;
      `,
      [limit]
    );
    return result.rows;
  } catch (err) {
    const msg = String(err?.message || '');
    // Auto-heal older DBs that predate matches_played.
    if (msg.includes('column') && msg.includes('matches_played') && msg.includes('does not exist')) {
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_played INT DEFAULT 0");
      const result = await pool.query(
        `
          SELECT
            username,
            COALESCE(matches_played, 0)::int AS matches_played,
            COALESCE(games_played, 0)::int AS games_played
          FROM users
          ORDER BY COALESCE(matches_played, 0) DESC, COALESCE(games_played, 0) DESC
          LIMIT $1;
        `,
        [limit]
      );
      return result.rows;
    }
    if (msg.includes('column') && msg.includes('games_played') && msg.includes('does not exist')) {
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INT DEFAULT 0');
      const result = await pool.query(
        `
          SELECT
            username,
            COALESCE(matches_played, 0)::int AS matches_played,
            COALESCE(games_played, 0)::int AS games_played
          FROM users
          ORDER BY COALESCE(matches_played, 0) DESC, COALESCE(games_played, 0) DESC
          LIMIT $1;
        `,
        [limit]
      );
      return result.rows;
    }
    throw err;
  }
}

module.exports = {
  getTopReferrers,
  getTopWinners,
  getTopPlayers,
};
