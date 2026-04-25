const { computeOpportunityScore } = require('./opportunityScore');

function normalizeTelegramUsername(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const urlMatch = lower.match(/(?:https?:\/\/)?t\.me\/([a-z0-9_]{3,64})/i);
  const username = urlMatch ? urlMatch[1] : lower.replace(/^@/, '');
  if (!username) return null;
  if (!/^[a-z0-9_]{5,32}$/.test(username)) return null;
  return `@${username}`;
}

async function upsertDiscoveredCommunitiesIntoPipeline({ pool, ensureGrowthSchema, userId, limit = 200 }) {
  await ensureGrowthSchema();
  const uId = Number(userId);
  if (!uId || !Number.isFinite(uId)) return { ok: false, error: 'user_id_required' };

  const res = await pool.query(
    `
      SELECT community_name
      FROM discovered_communities
      WHERE user_id = $1 AND workspace_id IS NULL
      ORDER BY id DESC
      LIMIT $2
    `,
    [uId, Math.max(1, Math.min(500, Number(limit) || 200))]
  );

  const names = (res.rows || [])
    .map((r) => normalizeTelegramUsername(r.community_name))
    .filter(Boolean);

  let upserted = 0;
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    const rankingRes = await pool.query(
      `
        SELECT *
        FROM community_rankings
        WHERE user_id = $1 AND workspace_id IS NULL AND platform = 'telegram' AND community_name = $2
        ORDER BY day DESC, computed_at DESC
        LIMIT 1
      `,
      [uId, name]
    );
    const ranking = rankingRes.rows[0] || null;

    // eslint-disable-next-line no-await-in-loop
    const aiRes = await pool.query(
      `
        SELECT recommended_action, quality_score, summary
        FROM community_ai_analyses
        WHERE user_id = $1 AND workspace_id IS NULL AND platform = 'telegram' AND community_name = $2
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
      [uId, name]
    );
    const ai = aiRes.rows[0] || null;

    const score = computeOpportunityScore({ ranking, ai, pipeline: { stage: 'discovered' } });

    // eslint-disable-next-line no-await-in-loop
    const r = await pool.query(
      `
        INSERT INTO communities_pipeline (user_id, platform, community_name, stage, opportunity_score, created_at, updated_at)
        VALUES ($1, 'telegram', $2, 'discovered', $3, NOW(), NOW())
        ON CONFLICT (user_id, platform, community_name)
        DO UPDATE SET
          opportunity_score = GREATEST(communities_pipeline.opportunity_score, EXCLUDED.opportunity_score),
          updated_at = NOW()
        RETURNING id
      `,
      [uId, name, score]
    );
    upserted += r.rowCount ? 1 : 0;
  }

  return { ok: true, scanned: names.length, upserted };
}

module.exports = {
  upsertDiscoveredCommunitiesIntoPipeline,
};

