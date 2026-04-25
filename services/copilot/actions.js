const { computeOpportunityScore } = require('../growth-crm/opportunityScore');

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function entityKeyForCommunity(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  return `telegram:${n.startsWith('@') ? n : `@${n}`}`;
}

async function getCopilotActions({
  pool,
  ensureGrowthSchema,
  userId,
  limit = 20,
  cooldownHours = 24,
} = {}) {
  await ensureGrowthSchema();
  const uId = Number(userId);
  if (!Number.isFinite(uId) || !uId) throw new Error('user_id is required');

  const lim = clamp(Number(limit) || 20, 1, 50);
  const cooldown = clamp(Number(cooldownHours) || 24, 0, 24 * 14);

  // Pull pipeline items + latest intel signals in one query.
  const r = await pool.query(
    `
      SELECT
        p.*,
        r.day AS ranking_day,
        r.total_messages,
        r.total_intent,
        r.avg_intent,
        r.community_score,
        r.category,
        a.quality_score AS ai_quality_score,
        a.recommended_action AS ai_recommended_action,
        a.summary AS ai_summary,
        oe.last_outreach_at
      FROM communities_pipeline p
      LEFT JOIN LATERAL (
        SELECT day, total_messages, total_intent, avg_intent, community_score, category
        FROM community_rankings
        WHERE user_id = p.user_id
          AND workspace_id IS NULL
          AND platform = p.platform
          AND community_name = p.community_name
        ORDER BY day DESC, computed_at DESC
        LIMIT 1
      ) r ON TRUE
      LEFT JOIN LATERAL (
        SELECT quality_score, recommended_action, summary
        FROM community_ai_analyses
        WHERE user_id = p.user_id
          AND workspace_id IS NULL
          AND platform = p.platform
          AND community_name = p.community_name
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      ) a ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(created_at) AS last_outreach_at
        FROM outreach_events
        WHERE user_id = p.user_id AND entity_key = $2
      ) oe ON TRUE
      WHERE p.user_id = $1
      ORDER BY p.opportunity_score DESC, p.updated_at DESC
      LIMIT 300
    `,
    [uId, ''] // placeholder; we re-compute outreach in a second pass for correctness
  );

  // Second pass for outreach timestamps (entity_key varies per row).
  const rows = r.rows || [];
  const keys = rows.map((x) => entityKeyForCommunity(x.community_name)).filter(Boolean);
  const lastByKey = new Map();
  if (keys.length) {
    const out = await pool.query(
      `
        SELECT entity_key, MAX(created_at) AS last_outreach_at
        FROM outreach_events
        WHERE user_id = $1 AND entity_key = ANY($2::text[])
        GROUP BY entity_key
      `,
      [uId, keys]
    );
    for (const row of out.rows || []) {
      if (row.entity_key) lastByKey.set(String(row.entity_key), row.last_outreach_at);
    }
  }

  const now = Date.now();
  const cooldownMs = cooldown * 60 * 60 * 1000;

  const actions = [];
  for (const row of rows) {
    const entityKey = entityKeyForCommunity(row.community_name);
    const last = entityKey ? lastByKey.get(entityKey) : null;
    const lastMs = last ? new Date(last).getTime() : 0;
    if (cooldownMs > 0 && lastMs && now - lastMs < cooldownMs) continue;

    const ranking = {
      total_messages: row.total_messages,
      total_intent: row.total_intent,
      avg_intent: row.avg_intent,
      community_score: row.community_score,
    };
    const ai = {
      quality_score: row.ai_quality_score,
      recommended_action: row.ai_recommended_action,
      summary: row.ai_summary,
    };
    const score = computeOpportunityScore({ ranking, ai, pipeline: row });

    const stage = String(row.stage || 'discovered').toLowerCase();
    const suggested =
      stage === 'discovered'
        ? 'Log first outreach and move to ENGAGING.'
        : stage === 'engaging'
          ? 'Follow up and move to WARM if they respond.'
          : stage === 'warm'
            ? 'Propose activation (challenge/tournament) and move to ACTIVATED.'
            : stage === 'activated'
              ? 'Track conversions and negotiate partner terms.'
              : 'Review.';

    actions.push({
      type: 'community_outreach',
      entity_key: entityKey,
      community_name: row.community_name,
      stage,
      score,
      ai_summary: ai.summary || null,
      reason: ai.summary || row.notes || `score ${score}`,
      suggested_next_step: suggested,
      last_outreach_at: last ? new Date(last).toISOString() : null,
    });
  }

  actions.sort((a, b) => Number(b.score) - Number(a.score));
  return actions.slice(0, lim);
}

module.exports = {
  getCopilotActions,
  _internals: { entityKeyForCommunity },
};

