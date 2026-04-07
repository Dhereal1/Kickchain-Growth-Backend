const crypto = require('crypto');
const { fetchApifyDatasetItemsWithRetry, normalizeCommunity } = require('./apifyService');
const { extractSignals } = require('./signalEngine');
const { getIntelConfig } = require('./intelConfig');

function jsonStringifySafe(value) {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (err) {
    // Last-resort fallback: store as a JSON string.
    return JSON.stringify(String(value));
  }
}

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

function contentHash({ text, communityName }) {
  const t = String(text || '').trim();
  const c = String(communityName || '').trim();
  const base = `${t}\n${c}`.toLowerCase();
  if (!base.trim()) return null;
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

  const startedAt = Date.now();
  const maxDatasets = Math.max(1, Number(cfg.maxDatasetsPerRun) || 5);
  const timeoutMs = Math.max(1000, Number(cfg.pipelineTimeoutMs) || 8000);
  const runDatasets = datasets.slice(0, maxDatasets);

  const run = await pool.query(
    `INSERT INTO intel_runs (datasets, platform) VALUES ($1::jsonb, $2) RETURNING id`,
    [jsonStringifySafe(runDatasets), platformHint || null]
  );
  const runId = run.rows[0].id;
  await pool.query(`UPDATE intel_runs SET dataset_ids = $1::jsonb WHERE id = $2`, [
    jsonStringifySafe(runDatasets),
    runId,
  ]);

  let fetchedItems = 0;
  let insertedPosts = 0;
  let dedupedPosts = 0;
  let communitiesUpdated = 0;

  try {
    for (const datasetId of runDatasets) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Pipeline timeout after ${timeoutMs}ms`);
      }

      // eslint-disable-next-line no-await-in-loop
      const items = await fetchApifyDatasetItemsWithRetry({
        datasetId,
        token,
        limit: cfg.maxItemsPerDataset,
        offset: 0,
        retries: 3,
      });

      fetchedItems += items.length;

      for (const item of items) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`Pipeline timeout after ${timeoutMs}ms`);
        }

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
        const chash = contentHash({ text, communityName: normalized.name });

        // Posts table (dedup by platform+post_id)
        const postRes = await pool.query(
          `
            INSERT INTO community_posts (
              platform, community_name, post_id, content_hash, text, views, posted_at, dataset_id,
              intent_score, engagement_score, frequency_score, raw
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
            ON CONFLICT DO NOTHING
          `,
          [
            normalized.platform,
            normalized.name,
            postId,
            chash,
            text || null,
            views,
            toTimestamp(normalized.posted_at) || toTimestamp(item?.date || item?.timestamp) || null,
            String(datasetId),
            signals.intent_score,
            signals.engagement_score,
            signals.frequency_score,
            jsonStringifySafe(item),
          ]
        );

        if (postRes.rowCount) insertedPosts += 1;
        else dedupedPosts += 1;

        // Communities master list (upsert)
        const communityRes = await pool.query(
          `
            INSERT INTO communities (
              name, platform, member_count, activity_score, keyword_matches,
              intent_score, engagement_score, score, last_seen_at, raw, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9::jsonb,NOW())
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
            jsonStringifySafe(item),
          ]
        );
        if (communityRes.rowCount) communitiesUpdated += 1;
      }
    }

    const durationMs = Date.now() - startedAt;
    await pool.query(
      `UPDATE intel_runs
       SET fetched_items=$1,
           inserted_posts=$2,
           deduped_posts=$3,
           communities_updated=$4,
           duration_ms=$5,
           status='success'
       WHERE id=$6`,
      [fetchedItems, insertedPosts, dedupedPosts, communitiesUpdated, durationMs, runId]
    );
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const msg = String(err?.message || err);
    await pool.query(
      `UPDATE intel_runs
       SET fetched_items=$1,
           inserted_posts=$2,
           deduped_posts=$3,
           communities_updated=$4,
           duration_ms=$5,
           status='failed',
           error_message=$6,
           error=$7
       WHERE id=$8`,
      [
        fetchedItems,
        insertedPosts,
        dedupedPosts,
        communitiesUpdated,
        durationMs,
        msg,
        String(err?.details || err?.stack || msg),
        runId,
      ]
    );
    throw err;
  }

  return {
    runId,
    datasets_processed: runDatasets.length,
    posts_ingested: insertedPosts,
    posts_deduped: dedupedPosts,
    communities_updated: communitiesUpdated,
    fetched_items: fetchedItems,
  };
}

function computeCommunityScore({ activity_score, engagement_score, intent_score }) {
  const a = Number(activity_score || 0);
  const e = Number(engagement_score || 0);
  const i = Number(intent_score || 0);
  const score = a * 0.4 + e * 0.2 + i * 0.4;
  return Number.isFinite(score) ? score : 0;
}

function computeConfidenceScore({ intent_score, engagement_score }) {
  const maxIntent = 5;
  const maxEngagement = 1000;

  const normalizedIntent = Math.max(0, Math.min(1, Number(intent_score || 0) / maxIntent));
  const normalizedEngagement = Math.max(
    0,
    Math.min(1, Number(engagement_score || 0) / maxEngagement)
  );

  const confidence = normalizedIntent * 0.6 + normalizedEngagement * 0.4;
  return Number.isFinite(confidence) ? confidence : 0;
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
    const confidenceScore = computeConfidenceScore(row);
    const prevRes = await pool.query(
      `SELECT activity_score
       FROM community_metrics
       WHERE day = $1::date - INTERVAL '1 day' AND platform=$2 AND name=$3`,
      [targetDay, row.platform, row.name]
    );
    const prevActivity = Number(prevRes.rows[0]?.activity_score || 0);
    const trendScore = Number(row.activity_score || 0) - prevActivity;

    const r = await pool.query(
      `
        INSERT INTO community_metrics (
          day, platform, name, total_messages, activity_score, intent_score, engagement_score, score, trend_score, confidence_score
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (day, platform, name)
        DO UPDATE SET
          total_messages = EXCLUDED.total_messages,
          activity_score = EXCLUDED.activity_score,
          intent_score = EXCLUDED.intent_score,
          engagement_score = EXCLUDED.engagement_score,
          score = EXCLUDED.score,
          trend_score = EXCLUDED.trend_score,
          confidence_score = EXCLUDED.confidence_score
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
        trendScore,
        confidenceScore,
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
  computeConfidenceScore,
};
