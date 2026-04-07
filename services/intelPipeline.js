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

async function ingestDatasets({
  pool,
  ensureGrowthSchema,
  datasets,
  platform,
  userId = null,
  configOverride = null,
}) {
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
    `INSERT INTO intel_runs (user_id, datasets, platform) VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [userId, jsonStringifySafe(runDatasets), platformHint || null]
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

        const signals = extractSignals({ text, views, raw: item, config: configOverride });
        const chash = contentHash({ text, communityName: normalized.name });

        // Posts table (dedup by platform+post_id)
        const postRes = await pool.query(
          `
            INSERT INTO community_posts (
              user_id, platform, community_name, post_id, content_hash, text, views, posted_at, dataset_id,
              intent_score, promo_score, content_activity_score, engagement_score, frequency_score, raw
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
            ON CONFLICT DO NOTHING
          `,
          [
            userId,
            normalized.platform,
            normalized.name,
            postId,
            chash,
            text || null,
            views,
            toTimestamp(normalized.posted_at) || toTimestamp(item?.date || item?.timestamp) || null,
            String(datasetId),
            signals.intent_score,
            signals.promo_score,
            signals.content_activity_score,
            signals.engagement_score,
            signals.frequency_score,
            jsonStringifySafe(item),
          ]
        );

        if (postRes.rowCount) insertedPosts += 1;
        else dedupedPosts += 1;

        // Communities master list (upsert) - handle legacy NULL user_id and multi-tenant user_id.
        const isLegacy = userId === null || userId === undefined;
        const communitySql = isLegacy
          ? `
            INSERT INTO communities (
              user_id, name, platform, member_count, activity_score, keyword_matches,
              intent_score, promo_score, content_activity_score, engagement_score, signal_score, score,
              last_seen_at, raw, updated_at
            )
            VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12::jsonb,NOW())
            ON CONFLICT (name, platform) WHERE user_id IS NULL
            DO UPDATE SET
              member_count = EXCLUDED.member_count,
              activity_score = EXCLUDED.activity_score,
              keyword_matches = EXCLUDED.keyword_matches,
              intent_score = GREATEST(communities.intent_score, EXCLUDED.intent_score),
              promo_score = GREATEST(communities.promo_score, EXCLUDED.promo_score),
              content_activity_score = GREATEST(communities.content_activity_score, EXCLUDED.content_activity_score),
              engagement_score = GREATEST(communities.engagement_score, EXCLUDED.engagement_score),
              signal_score = GREATEST(communities.signal_score, EXCLUDED.signal_score),
              last_seen_at = NOW(),
              raw = EXCLUDED.raw,
              updated_at = NOW()
          `
          : `
            INSERT INTO communities (
              user_id, name, platform, member_count, activity_score, keyword_matches,
              intent_score, promo_score, content_activity_score, engagement_score, signal_score, score,
              last_seen_at, raw, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13::jsonb,NOW())
            ON CONFLICT (user_id, name, platform) WHERE user_id IS NOT NULL
            DO UPDATE SET
              member_count = EXCLUDED.member_count,
              activity_score = EXCLUDED.activity_score,
              keyword_matches = EXCLUDED.keyword_matches,
              intent_score = GREATEST(communities.intent_score, EXCLUDED.intent_score),
              promo_score = GREATEST(communities.promo_score, EXCLUDED.promo_score),
              content_activity_score = GREATEST(communities.content_activity_score, EXCLUDED.content_activity_score),
              engagement_score = GREATEST(communities.engagement_score, EXCLUDED.engagement_score),
              signal_score = GREATEST(communities.signal_score, EXCLUDED.signal_score),
              last_seen_at = NOW(),
              raw = EXCLUDED.raw,
              updated_at = NOW()
          `;

        const communityParams = isLegacy
          ? [
              normalized.name,
              normalized.platform,
              Number(normalized.member_count ?? views) || 0,
              Number(normalized.activity_score ?? views) || 0,
              signals.keyword_matches,
              signals.intent_score,
              signals.promo_score,
              signals.content_activity_score,
              signals.engagement_score,
              signals.signal_score,
              0,
              jsonStringifySafe(item),
            ]
          : [
              userId,
              normalized.name,
              normalized.platform,
              Number(normalized.member_count ?? views) || 0,
              Number(normalized.activity_score ?? views) || 0,
              signals.keyword_matches,
              signals.intent_score,
              signals.promo_score,
              signals.content_activity_score,
              signals.engagement_score,
              signals.signal_score,
              0,
              jsonStringifySafe(item),
            ];

        const communityRes = await pool.query(communitySql, communityParams);
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

function computeSignalScore({ promo_score, content_activity_score, intent_score }) {
  const p = Number(promo_score || 0);
  const a = Number(content_activity_score || 0);
  const i = Number(intent_score || 0);
  const score = p * 0.3 + a * 0.5 + i * 1.0;
  return Number.isFinite(score) ? score : 0;
}

function computeConfidenceScore({ intent_score, engagement_score, total_messages }) {
  const messages = Math.max(1, Number(total_messages || 0) || 1);

  // We aggregate intent/engagement as sums; convert to per-post averages for a stable 0..1 confidence signal.
  const avgIntentPerPost = (Number(intent_score || 0) || 0) / messages;
  const avgEngagementPerPost = (Number(engagement_score || 0) || 0) / messages;

  // intent_score is keyword matches (+1 for '?') per post; defaults currently ~0..11.
  const maxIntentPerPost = 10;
  // engagement_score is normalized to 0..100 in signalEngine.
  const maxEngagementPerPost = 100;

  const normalizedIntent = Math.max(0, Math.min(1, avgIntentPerPost / maxIntentPerPost));
  const normalizedEngagement = Math.max(
    0,
    Math.min(1, avgEngagementPerPost / maxEngagementPerPost)
  );

  const confidence = normalizedIntent * 0.6 + normalizedEngagement * 0.4;
  return Number.isFinite(confidence) ? confidence : 0;
}

async function aggregateDaily({ pool, ensureGrowthSchema, day, userId = null }) {
  await ensureGrowthSchema();

  const debug = String(process.env.INTEL_DEBUG || '').trim().toLowerCase() === 'true';

  const dayDate = day ? String(day) : null;

  // Use UTC day boundaries for persistence key, but allow a rolling window when day isn't specified.
  const targetDayRes = await pool.query(
    `SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'UTC')::date) AS day`,
    [dayDate]
  );
  const targetDay = targetDayRes.rows[0].day;

  // Aggregate posts ingested for that day.
  // Root-cause fix for "communitiesAggregated: 0":
  // many Apify items don't carry a reliable posted_at; fall back to ingested_at and use a 24h window by default.
  const filterSql = dayDate
    ? `(COALESCE(posted_at, ingested_at) AT TIME ZONE 'UTC')::date = $1`
    : `COALESCE(posted_at, ingested_at) >= NOW() - INTERVAL '1 day'`;

  const params = dayDate ? [targetDay] : [];

  const userWhere =
    userId === null || userId === undefined
      ? 'user_id IS NULL'
      : 'user_id = $' + (params.length + 1);
  const aggParams = userId === null || userId === undefined ? params : [...params, userId];

  const aggRes = await pool.query(
    `
      WITH window_posts AS (
        SELECT *
        FROM community_posts
        WHERE ${filterSql} AND ${userWhere}
      )
      SELECT
        platform,
        community_name AS name,
        COUNT(*)::int AS total_messages,
        COUNT(*)::int AS activity_score,
        COALESCE(SUM(intent_score), 0)::int AS intent_score,
        COALESCE(SUM(promo_score), 0)::int AS promo_score,
        COALESCE(SUM(content_activity_score), 0)::int AS content_activity_score,
        COALESCE(SUM(engagement_score), 0)::int AS engagement_score
      FROM window_posts
      GROUP BY platform, community_name
    `,
    aggParams
  );

  if (debug) {
    try {
      const countRes = await pool.query(
        `SELECT COUNT(*)::int AS c FROM community_posts WHERE ${filterSql} AND ${userWhere}`,
        aggParams
      );
      console.log('INTEL_DEBUG post_count_window:', countRes.rows[0]?.c ?? 0);
      console.log('INTEL_DEBUG aggregated_rows:', aggRes.rows.length);
    } catch (err) {
      console.log('INTEL_DEBUG failed:', err?.message || String(err));
    }
  }

  let upserted = 0;
  for (const row of aggRes.rows) {
    const score = computeCommunityScore(row);
    const signalScore = computeSignalScore(row);
    const confidenceScore = computeConfidenceScore(row);
    const prevRes = await pool.query(
      `SELECT activity_score
       FROM community_metrics
       WHERE (($1::int IS NULL AND user_id IS NULL) OR user_id = $1)
         AND day = $2::date - INTERVAL '1 day'
         AND platform=$3 AND name=$4`,
      [userId, targetDay, row.platform, row.name]
    );
    const prevActivity = Number(prevRes.rows[0]?.activity_score || 0);
    const trendScore = Number(row.activity_score || 0) - prevActivity;

    const isLegacy = userId === null || userId === undefined;
    const metricsSql = isLegacy
      ? `
        INSERT INTO community_metrics (
          user_id, day, platform, name, total_messages, activity_score, intent_score, promo_score, content_activity_score,
          engagement_score, signal_score, score, trend_score, confidence_score
        )
        VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (day, platform, name) WHERE user_id IS NULL
        DO UPDATE SET
          total_messages = EXCLUDED.total_messages,
          activity_score = EXCLUDED.activity_score,
          intent_score = EXCLUDED.intent_score,
          promo_score = EXCLUDED.promo_score,
          content_activity_score = EXCLUDED.content_activity_score,
          engagement_score = EXCLUDED.engagement_score,
          signal_score = EXCLUDED.signal_score,
          score = EXCLUDED.score,
          trend_score = EXCLUDED.trend_score,
          confidence_score = EXCLUDED.confidence_score
      `
      : `
        INSERT INTO community_metrics (
          user_id, day, platform, name, total_messages, activity_score, intent_score, promo_score, content_activity_score,
          engagement_score, signal_score, score, trend_score, confidence_score
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (user_id, day, platform, name) WHERE user_id IS NOT NULL
        DO UPDATE SET
          total_messages = EXCLUDED.total_messages,
          activity_score = EXCLUDED.activity_score,
          intent_score = EXCLUDED.intent_score,
          promo_score = EXCLUDED.promo_score,
          content_activity_score = EXCLUDED.content_activity_score,
          engagement_score = EXCLUDED.engagement_score,
          signal_score = EXCLUDED.signal_score,
          score = EXCLUDED.score,
          trend_score = EXCLUDED.trend_score,
          confidence_score = EXCLUDED.confidence_score
      `;

    const metricsParams = isLegacy
      ? [
          targetDay,
          row.platform,
          row.name,
          row.total_messages,
          row.activity_score,
          row.intent_score,
          row.promo_score,
          row.content_activity_score,
          row.engagement_score,
          signalScore,
          score,
          trendScore,
          confidenceScore,
        ]
      : [
          userId,
          targetDay,
          row.platform,
          row.name,
          row.total_messages,
          row.activity_score,
          row.intent_score,
          row.promo_score,
          row.content_activity_score,
          row.engagement_score,
          signalScore,
          score,
          trendScore,
          confidenceScore,
        ];

    const r = await pool.query(metricsSql, metricsParams);
    upserted += r.rowCount ? 1 : 0;

    // Keep the master row updated with latest score.
    await pool.query(
      `UPDATE communities
       SET intent_score=$1,
           promo_score=$2,
           content_activity_score=$3,
           engagement_score=$4,
           signal_score=$5,
           score=$6,
           updated_at=NOW()
       WHERE (($7::int IS NULL AND user_id IS NULL) OR user_id=$7) AND name=$8 AND platform=$9`,
      [
        row.intent_score,
        row.promo_score,
        row.content_activity_score,
        row.engagement_score,
        signalScore,
        score,
        userId,
        row.name,
        row.platform,
      ]
    );
  }

  return { day: targetDay, communitiesAggregated: upserted };
}

async function cleanupOldPosts({ pool, ensureGrowthSchema, userId = null }) {
  await ensureGrowthSchema();
  const cfg = getIntelConfig();

  const ttlDays = Math.max(1, Number(cfg.postTtlDays) || 30);
  const r = await pool.query(
    `DELETE FROM community_posts
     WHERE ingested_at < NOW() - ($1::int * INTERVAL '1 day')
       AND ($2::int IS NULL OR user_id = $2)`,
    [ttlDays, userId]
  );
  return { deletedPosts: r.rowCount || 0, ttlDays };
}

module.exports = {
  ingestDatasets,
  aggregateDaily,
  cleanupOldPosts,
  computeCommunityScore,
  computeConfidenceScore,
  computeSignalScore,
};
