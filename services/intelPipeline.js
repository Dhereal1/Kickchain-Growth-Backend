const crypto = require('crypto');
const { fetchApifyDatasetItems, normalizeCommunity } = require('./apifyService');
const { extractSignals } = require('./signalEngine');
const { getIntelConfig } = require('./intelConfig');

function stablePostId({ platform, datasetId, item, normalized }) {
  const explicit = String(normalized?.post_id || '').trim();
  if (explicit) return explicit;

  const base = JSON.stringify({
    platform,
    datasetId,
    name: normalized?.name || null,
    text: normalized?.text || '',
    date: normalized?.posted_at || item?.date || item?.timestamp || null,
  });
  return crypto.createHash('sha256').update(base).digest('hex');
}

function toTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  // Invalid dates become "Invalid Date"
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function ingestDatasets({ pool, ensureGrowthSchema, datasets, platform }) {
  const token = String(process.env.APIFY_API_TOKEN || '').trim();
  if (!token) throw new Error('APIFY_API_TOKEN is required');

  const cfg = getIntelConfig();
  const platformHint = platform ? String(platform).toLowerCase() : undefined;

  await ensureGrowthSchema();

  const run = await pool.query(
    `INSERT INTO intel_runs (datasets, platform) VALUES ($1, $2) RETURNING id`,
    [datasets, platformHint || null]
  );
  const runId = run.rows[0].id;

  let fetchedItems = 0;
  let insertedPosts = 0;

  try {
    for (const datasetId of datasets) {
      const items = await fetchApifyDatasetItems({
        datasetId,
        token,
        limit: cfg.maxItemsPerDataset,
        offset: 0,
      });

      fetchedItems += items.length;

      for (const item of items) {
        const normalized = normalizeCommunity(item, platformHint);
        if (!normalized?.name || !normalized?.platform || normalized.platform === 'unknown') continue;

        const postId = stablePostId({
          platform: normalized.platform,
          datasetId,
          item,
          normalized,
        });

        const text = String(normalized.text || item?.text || '');
        const views = Number(normalized.views ?? item?.views ?? item?.viewCount ?? 0) || 0;

        const signals = extractSignals({ text, views, raw: item });

        // Posts table (dedup by platform+post_id)
        const postRes = await pool.query(
          `
            INSERT INTO community_posts (
              platform, community_name, post_id, text, views, posted_at, dataset_id,
              intent_score, engagement_score, frequency_score, raw
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (platform, post_id) DO NOTHING
          `,
          [
            normalized.platform,
            normalized.name,
            postId,
            text || null,
            views,
            toTimestamp(normalized.posted_at) || toTimestamp(item?.date || item?.timestamp) || null,
            String(datasetId),
            signals.intent_score,
            signals.engagement_score,
            signals.frequency_score,
            item,
          ]
        );

        if (postRes.rowCount) insertedPosts += 1;

        // Communities master list (upsert)
        await pool.query(
          `
            INSERT INTO communities (
              name, platform, member_count, activity_score, keyword_matches,
              intent_score, engagement_score, score, last_seen_at, raw, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,NOW())
            ON CONFLICT (name, platform)
            DO UPDATE SET
              member_count = EXCLUDED.member_count,
              activity_score = EXCLUDED.activity_score,
              keyword_matches = EXCLUDED.keyword_matches,
              intent_score = GREATEST(communities.intent_score, EXCLUDED.intent_score),
              engagement_score = GREATEST(communities.engagement_score, EXCLUDED.engagement_score),
              last_seen_at = NOW(),
              raw = EXCLUDED.raw,
              updated_at = NOW()
          `,
          [
            normalized.name,
            normalized.platform,
            Number(normalized.member_count ?? views) || 0,
            Number(normalized.activity_score ?? views) || 0,
            signals.keyword_matches,
            signals.intent_score,
            signals.engagement_score,
            0,
            item,
          ]
        );
      }
    }

    await pool.query(
      `UPDATE intel_runs SET fetched_items=$1, inserted_posts=$2 WHERE id=$3`,
      [fetchedItems, insertedPosts, runId]
    );
  } catch (err) {
    await pool.query(
      `UPDATE intel_runs SET fetched_items=$1, inserted_posts=$2, error=$3 WHERE id=$4`,
      [fetchedItems, insertedPosts, String(err?.message || err), runId]
    );
    throw err;
  }

  return { runId, fetchedItems, insertedPosts };
}

function computeCommunityScore({ activity_score, engagement_score, intent_score }) {
  const a = Number(activity_score || 0);
  const e = Number(engagement_score || 0);
  const i = Number(intent_score || 0);
  const score = a * 0.4 + e * 0.2 + i * 0.4;
  return Number.isFinite(score) ? score : 0;
}

async function aggregateDaily({ pool, ensureGrowthSchema, day }) {
  await ensureGrowthSchema();

  const dayDate = day
    ? String(day)
    : null;

  // Use UTC day boundaries.
  const targetDayRes = await pool.query(
    `SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'UTC')::date) AS day`,
    [dayDate]
  );
  const targetDay = targetDayRes.rows[0].day;

  // Aggregate posts ingested for that day.
  const aggRes = await pool.query(
    `
      WITH day_posts AS (
        SELECT *
        FROM community_posts
        WHERE (posted_at AT TIME ZONE 'UTC')::date = $1
      )
      SELECT
        platform,
        community_name AS name,
        COUNT(*)::int AS total_messages,
        COUNT(*)::int AS activity_score,
        COALESCE(SUM(intent_score), 0)::int AS intent_score,
        COALESCE(SUM(engagement_score), 0)::int AS engagement_score
      FROM day_posts
      GROUP BY platform, community_name
    `,
    [targetDay]
  );

  let upserted = 0;
  for (const row of aggRes.rows) {
    const score = computeCommunityScore(row);
    const r = await pool.query(
      `
        INSERT INTO community_metrics (
          day, platform, name, total_messages, activity_score, intent_score, engagement_score, score
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (day, platform, name)
        DO UPDATE SET
          total_messages = EXCLUDED.total_messages,
          activity_score = EXCLUDED.activity_score,
          intent_score = EXCLUDED.intent_score,
          engagement_score = EXCLUDED.engagement_score,
          score = EXCLUDED.score
      `,
      [
        targetDay,
        row.platform,
        row.name,
        row.total_messages,
        row.activity_score,
        row.intent_score,
        row.engagement_score,
        score,
      ]
    );
    upserted += r.rowCount ? 1 : 0;

    // Keep the master row updated with latest score.
    await pool.query(
      `UPDATE communities
       SET intent_score=$1, engagement_score=$2, score=$3, updated_at=NOW()
       WHERE name=$4 AND platform=$5`,
      [row.intent_score, row.engagement_score, score, row.name, row.platform]
    );
  }

  return { day: targetDay, communitiesAggregated: upserted };
}

async function cleanupOldPosts({ pool, ensureGrowthSchema }) {
  await ensureGrowthSchema();
  const cfg = getIntelConfig();

  const ttlDays = Math.max(1, Number(cfg.postTtlDays) || 30);
  const r = await pool.query(
    `DELETE FROM community_posts WHERE ingested_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [ttlDays]
  );
  return { deletedPosts: r.rowCount || 0, ttlDays };
}

module.exports = {
  ingestDatasets,
  aggregateDaily,
  cleanupOldPosts,
  computeCommunityScore,
};

