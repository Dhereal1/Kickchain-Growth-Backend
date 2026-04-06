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
  const result = await pool.query(
    `
      SELECT
        username,
        total_won
      FROM users
      ORDER BY total_won DESC
      LIMIT $1;
    `,
    [limit]
  );

  return result.rows;
}

async function getTopPlayers(limit = 10) {
  const result = await pool.query(
    `
      SELECT
        username,
        games_played
      FROM users
      ORDER BY games_played DESC
      LIMIT $1;
    `,
    [limit]
  );

  return result.rows;
}

module.exports = {
  getTopReferrers,
  getTopWinners,
  getTopPlayers,
};

