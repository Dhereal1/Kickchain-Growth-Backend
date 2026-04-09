const crypto = require('crypto');
const { extractSignals } = require('./signalEngine');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function normalizeUsername(username) {
  const raw = String(username || '').trim();
  if (!raw) return null;
  const u = raw.startsWith('@') ? raw : `@${raw}`;
  const lower = u.toLowerCase();
  if (!/^@[a-z0-9_]{5,32}$/.test(lower)) return null;
  return `@${lower.slice(1)}`;
}

async function ingestTelethonGroups({
  pool,
  ensureGrowthSchema,
  workspaceId,
  groups,
  configOverride = null,
  datasetId = null,
}) {
  await ensureGrowthSchema();

  const wsId = Number(workspaceId);
  const list = Array.isArray(groups) ? groups : [];
  let postsInserted = 0;
  const communities = new Set();

  for (const g of list) {
    const community = normalizeUsername(g?.username);
    if (!community) continue;
    communities.add(community);

    const msgs = Array.isArray(g?.messages) ? g.messages : [];
    for (const m of msgs) {
      const text = m?.text ?? null;
      const views = Number(m?.views || 0) || 0;
      const postedAt = m?.date ? new Date(m.date) : null;

      // Use a stable per-workspace post id to avoid collisions across groups.
      const postKey = `${community}:${String(m?.id ?? '')}`;
      const postId = sha256Hex(postKey);
      const contentHash = sha256Hex(`${community}:${String(text || '')}`);

      const signals = extractSignals({ text, views, raw: m, config: configOverride });

      // eslint-disable-next-line no-await-in-loop
      const r = await pool.query(
        `
          INSERT INTO community_posts (
            workspace_id,
            platform,
            community_name,
            post_id,
            content_hash,
            text,
            views,
            posted_at,
            dataset_id,
            intent_score,
            promo_score,
            content_activity_score,
            engagement_score,
            frequency_score,
            raw
          ) VALUES (
            $1, 'telegram', $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14::jsonb
          )
          ON CONFLICT DO NOTHING
        `,
        [
          wsId,
          community,
          postId,
          contentHash,
          text,
          views,
          postedAt,
          datasetId ? String(datasetId) : 'telethon',
          Number(signals.intent_score || 0),
          Number(signals.promo_score || 0),
          Number(signals.content_activity_score || 0),
          Number(signals.engagement_score || 0),
          Number(signals.frequency_score || 0),
          JSON.stringify({ group: { username: community, title: g?.title || null, type: g?.type || null }, message: m }),
        ]
      );

      postsInserted += r.rowCount || 0;
    }
  }

  return { communities: Array.from(communities), posts_inserted: postsInserted };
}

module.exports = {
  ingestTelethonGroups,
};

