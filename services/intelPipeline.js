const { getIntelConfig } = require('./intelConfig');
const { fetchTelethonGroups } = require('./telethonService');
const { ingestTelethonGroups } = require('./telethonIngest');

function jsonStringifySafe(value) {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch (err) {
    // Last-resort fallback: store as a JSON string.
    return JSON.stringify(String(value));
  }
}

function normalizeTelegramUsername(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  const urlMatch = lower.match(/(?:https?:\/\/)?t\.me\/([a-z0-9_]{3,64})/i);
  const username = urlMatch ? urlMatch[1] : lower.replace(/^@/, '');
  if (!username) return null;

  if (username === 'joinchat') return null;
  if (username === 'c') return null;
  if (username.startsWith('+')) return null;

  if (!/^[a-z0-9_]{5,32}$/.test(username)) return null;
  return `@${username}`;
}

async function ingestDatasets({
  pool,
  ensureGrowthSchema,
  datasets = null,
  communities = null,
  platform,
  userId = null,
  workspaceId = null,
  configOverride = null,
}) {
  const cfg = getIntelConfig();
  const platformHint = platform ? String(platform).toLowerCase() : undefined;

  await ensureGrowthSchema();

  const wsId = workspaceId === null || workspaceId === undefined ? null : Number(workspaceId);
  const effectiveUserId = wsId ? null : userId;

  const startedAt = Date.now();
  const maxCommunities = Math.max(1, Number(cfg.maxCommunitiesPerRun) || 20);
  const timeoutMs = Math.max(1000, Number(cfg.pipelineTimeoutMs) || 8000);

  const rawList = Array.isArray(communities) ? communities : Array.isArray(datasets) ? datasets : [];
  const runCommunities = rawList
    .map(normalizeTelegramUsername)
    .filter(Boolean)
    .slice(0, maxCommunities);

  if (!runCommunities.length) {
    const e = new Error(
      'Missing communities. Set INTEL_COMMUNITIES/TELETHON_COMMUNITIES or send JSON { communities: [...] }.'
    );
    e.code = 'COMMUNITIES_MISSING';
    throw e;
  }

  const run = await pool.query(
    `INSERT INTO intel_runs (user_id, datasets, platform) VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [effectiveUserId, jsonStringifySafe(runCommunities), platformHint || null]
  );
  const runId = run.rows[0].id;
  await pool.query(`UPDATE intel_runs SET dataset_ids = $1::jsonb WHERE id = $2`, [
    jsonStringifySafe(runCommunities),
    runId,
  ]);

  const maxMsgs = Math.max(1, Number(cfg.maxMessagesPerCommunity) || 50);

  let postsSeen = 0;
  let postsInserted = 0;
  let postsDeduped = 0;

  try {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Pipeline timeout after ${timeoutMs}ms`);

    const fetched = await fetchTelethonGroups({ usernames: runCommunities, maxMessagesPerGroup: maxMsgs });
    const groups = Array.isArray(fetched?.groups) ? fetched.groups : [];
    postsSeen = groups.reduce((sum, g) => sum + (Array.isArray(g?.messages) ? g.messages.length : 0), 0);

    const ingested = await ingestTelethonGroups({
      pool,
      ensureGrowthSchema,
      workspaceId: wsId,
      userId: effectiveUserId,
      groups,
      configOverride,
      datasetId: 'telethon_fetch',
    });

    postsInserted = Number(ingested?.posts_inserted || 0);
    postsDeduped = Number(ingested?.posts_deduped || Math.max(0, postsSeen - postsInserted));

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
      [postsSeen, postsInserted, postsDeduped, 0, durationMs, runId]
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
      [postsSeen, postsInserted, postsDeduped, 0, durationMs, msg, String(err?.details || err?.stack || msg), runId]
    );
    throw err;
  }

  return {
    runId,
    // Backward compatible keys (older clients call these "datasets").
    datasets_processed: runCommunities.length,
    communities_processed: runCommunities.length,
    posts_seen: postsSeen,
    posts_ingested: postsInserted,
    posts_deduped: postsDeduped,
    communities_updated: 0,
    fetched_items: postsSeen,
  };
}

function computeCommunityScore({ activity_score, engagement_score, intent_score }) {
  const a = Number(activity_score || 0);
  const eSum = Number(engagement_score || 0);
  const i = Number(intent_score || 0);

  // engagement_score is aggregated as a SUM across posts; use per-post average so
  // "broadcast channels with views" don't automatically outrank real conversations.
  const eAvg = a > 0 ? eSum / a : 0;

  // Keep weights aligned with the intended scoring engine, but apply engagement as avg.
  const score = a * 0.4 + eAvg * 0.2 + i * 0.4;
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
  // many ingested items don't carry a reliable posted_at; fall back to ingested_at and use a 24h window by default.
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

    // Keep the master row updated with latest score (and insert if missing).
    if (isLegacy) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `
          INSERT INTO communities (
            user_id, name, platform, member_count, activity_score, keyword_matches,
            intent_score, promo_score, content_activity_score, engagement_score, signal_score, score,
            last_seen_at, raw, updated_at
          )
          VALUES (NULL,$1,$2,0,$3,0,$4,$5,$6,$7,$8,$9,NOW(),NULL,NOW())
          ON CONFLICT (name, platform) WHERE user_id IS NULL
          DO UPDATE SET
            activity_score = EXCLUDED.activity_score,
            intent_score = EXCLUDED.intent_score,
            promo_score = EXCLUDED.promo_score,
            content_activity_score = EXCLUDED.content_activity_score,
            engagement_score = EXCLUDED.engagement_score,
            signal_score = EXCLUDED.signal_score,
            score = EXCLUDED.score,
            last_seen_at = NOW(),
            updated_at = NOW()
        `,
        [
          row.name,
          row.platform,
          row.activity_score,
          row.intent_score,
          row.promo_score,
          row.content_activity_score,
          row.engagement_score,
          signalScore,
          score,
        ]
      );
    } else {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `
          INSERT INTO communities (
            user_id, name, platform, member_count, activity_score, keyword_matches,
            intent_score, promo_score, content_activity_score, engagement_score, signal_score, score,
            last_seen_at, raw, updated_at
          )
          VALUES ($1,$2,$3,0,$4,0,$5,$6,$7,$8,$9,$10,NOW(),NULL,NOW())
          ON CONFLICT (user_id, name, platform) WHERE user_id IS NOT NULL
          DO UPDATE SET
            activity_score = EXCLUDED.activity_score,
            intent_score = EXCLUDED.intent_score,
            promo_score = EXCLUDED.promo_score,
            content_activity_score = EXCLUDED.content_activity_score,
            engagement_score = EXCLUDED.engagement_score,
            signal_score = EXCLUDED.signal_score,
            score = EXCLUDED.score,
            last_seen_at = NOW(),
            updated_at = NOW()
        `,
        [
          userId,
          row.name,
          row.platform,
          row.activity_score,
          row.intent_score,
          row.promo_score,
          row.content_activity_score,
          row.engagement_score,
          signalScore,
          score,
        ]
      );
    }
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
