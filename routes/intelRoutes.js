const express = require('express');
const { ingestDatasets, aggregateDaily } = require('../services/intelPipeline');
const { getIntelConfig } = require('../services/intelConfig');
const { requireApiKey } = require('../middleware/auth');
const { requireIntelUser } = require('../middleware/intelUser');
const crypto = require('crypto');
const {
  discoverFromMessageExtraction,
  computeAndStoreCommunityRankings,
} = require('../services/communityDiscovery');
const {
  analyzeCommunity,
  hasAIKey,
  computeMessagesHash,
  computeLegacyMessagesHash,
  getCachedCommunityAnalysis,
  resolveAIConfig,
  upsertCommunityAnalysis,
} = require('../services/aiAnalysis');
const {
  getCommunityDecision,
  getCommunityReason,
  computeConfidenceScore,
} = require('../services/decisionLayer');
const { getFinalDecision, toUpperDecision } = require('../services/finalDecision');

function computeRecommendations(topCommunities) {
  const recommendations = [];
  if (!topCommunities.length) return recommendations;

  for (const c of topCommunities.slice(0, 3)) {
    recommendations.push(`Join ${c.name} (${c.platform})`);
  }

  const avgActivity =
    topCommunities.reduce((sum, c) => sum + (Number(c.activity_score) || 0), 0) /
    Math.max(1, topCommunities.length);

  const highActivity = topCommunities.find(
    (c) => (Number(c.activity_score) || 0) > avgActivity && (Number(c.activity_score) || 0) > 0
  );
  if (highActivity) {
    recommendations.push(`High activity detected in ${highActivity.name}`);
  }

  const anyKeywords = topCommunities.some((c) => (Number(c.keyword_matches) || 0) > 0);
  if (anyKeywords) {
    recommendations.push('Users discussing 1v1 games found');
  }

  return recommendations;
}

function registerIntelRoutes(app, { pool, ensureGrowthSchema }) {
  const router = express.Router();
  const requireUser = requireIntelUser({ pool, allowAdmin: true });

  // Admin helper: provision an intel user (multi-tenant).
  router.post('/admin/users', requireApiKey, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const telegramChatId = body.telegram_chat_id ? String(body.telegram_chat_id).trim() : null;
      const apiKey =
        (body.api_key ? String(body.api_key).trim() : '') ||
        `kc_user_${crypto.randomBytes(16).toString('hex')}`;

      const r = await pool.query(
        `
          INSERT INTO intel_users (telegram_chat_id, api_key)
          VALUES ($1, $2)
          RETURNING id, telegram_chat_id, api_key, created_at
        `,
        [telegramChatId ? Number(telegramChatId) : null, apiKey]
      );

      return res.json({ ok: true, user: r.rows[0] });
    } catch (err) {
      console.error('admin create user failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to create user' });
    }
  });

  router.post('/webhook', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const url = String(body.url || '').trim();
      const name = String(body.name || '').trim() || null;
      const secret = String(body.secret || '').trim() || null;
      const enabled = body.enabled === false ? false : true;

      if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

      const userId = req.intelAuth?.isAdmin
        ? (body.user_id ? Number(body.user_id) : null)
        : Number(req.intelAuth?.user?.id);

      if (!userId) {
        return res.status(400).json({ ok: false, error: 'user_id is required for admin' });
      }

      await pool.query(
        `
          INSERT INTO intel_webhooks (user_id, name, url, secret, enabled, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (user_id, url) WHERE user_id IS NOT NULL
          DO UPDATE SET name=EXCLUDED.name, secret=EXCLUDED.secret, enabled=EXCLUDED.enabled, updated_at=NOW()
        `,
        [userId, name, url, secret, enabled]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error('intel webhook register failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to save webhook' });
    }
  });

  router.get('/runs', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const userId = req.intelAuth?.isAdmin ? null : Number(req.intelAuth?.user?.id);
      const r = await pool.query(
        `
          SELECT
            id,
            run_at,
            user_id,
            datasets,
            dataset_ids,
            platform,
            fetched_items,
            inserted_posts,
            deduped_posts,
            communities_updated,
            duration_ms,
            status,
            error_message,
            error
          FROM intel_runs
          WHERE ($1::int IS NULL OR user_id = $1)
          ORDER BY id DESC
          LIMIT 50
        `,
        [userId]
      );

      const runs = r.rows || [];
      const considered = runs.filter((x) => x.status === 'success' || x.status === 'failed');
      const successes = considered.filter((x) => x.status === 'success').length;
      const successRate = considered.length ? successes / considered.length : 0;
      const avgDuration =
        considered.length
          ? Math.round(
              considered.reduce((sum, x) => sum + Number(x.duration_ms || 0), 0) / considered.length
            )
          : 0;

      return res.json({
        success_rate: Number(successRate.toFixed(2)),
        avg_duration_ms: avgDuration,
        avg_processing_time_ms: avgDuration,
        last_5_runs: runs.slice(0, 5),
      });
    } catch (err) {
      console.error('intel runs failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to load runs' });
    }
  });

  router.get('/health', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();
      const cfg = getIntelConfig();
      const userId = req.intelAuth?.isAdmin ? null : Number(req.intelAuth?.user?.id);
      const r = await pool.query(
        `SELECT * FROM intel_runs WHERE ($1::int IS NULL OR user_id = $1) ORDER BY id DESC LIMIT 1`,
        [userId]
      );
      const last = r.rows[0] || null;
      const lastRunAt = last?.run_at ? new Date(last.run_at).toISOString() : null;
      const lastIngestCount = Number(last?.inserted_posts || 0);
      const communitiesConnected = (cfg.communitiesDefault || []).length;

      const healthy =
        !!last &&
        last.status === 'success' &&
        (Date.now() - new Date(last.run_at).getTime()) < 36 * 60 * 60 * 1000;

      return res.json({
        last_run: lastRunAt,
        status: healthy ? 'healthy' : 'unhealthy',
        communities_connected: communitiesConnected,
        last_ingest_count: lastIngestCount,
      });
    } catch (err) {
      console.error('intel health failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Health check failed' });
    }
  });

  router.get('/config', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const isAdmin = !!req.intelAuth?.isAdmin;
      const userId = isAdmin
        ? (req.query.user_id ? Number(req.query.user_id) : null)
        : Number(req.intelAuth?.user?.id);

      if (isAdmin && !userId) {
        return res.status(400).json({ ok: false, error: 'user_id is required for admin' });
      }

      const r = await pool.query(
        `
          SELECT
            user_id,
            datasets,
            keywords,
            intent_keywords,
            promo_keywords,
            activity_keywords,
            platforms,
            thresholds,
            updated_at
          FROM intel_user_configs
          WHERE user_id = $1
          LIMIT 1
        `,
        [userId]
      );

      const row = r.rows[0] || null;
      return res.json({
        ok: true,
        user_id: userId,
        // Backward compatibility: "datasets" now represents Telegram communities/usernames.
        datasets: row?.datasets || null,
        communities: row?.datasets || null,
        keywords: row?.keywords || null,
        intent_keywords: row?.intent_keywords || null,
        promo_keywords: row?.promo_keywords || null,
        activity_keywords: row?.activity_keywords || null,
        platforms: row?.platforms || null,
        thresholds: row?.thresholds || null,
        updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      });
    } catch (err) {
      console.error('intel config get failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to load config' });
    }
  });

  router.post('/config', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();
      if (req.intelAuth?.isAdmin) {
        return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      }

      const userId = Number(req.intelAuth.user.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      const datasets = Array.isArray(body.communities)
        ? body.communities.map(String)
        : Array.isArray(body.datasets)
          ? body.datasets.map(String)
          : null;
      const keywords = Array.isArray(body.keywords) ? body.keywords.map(String) : null;
      const intentKeywords = Array.isArray(body.intent_keywords) ? body.intent_keywords.map(String) : null;
      const promoKeywords = Array.isArray(body.promo_keywords) ? body.promo_keywords.map(String) : null;
      const activityKeywords = Array.isArray(body.activity_keywords) ? body.activity_keywords.map(String) : null;
      const platforms = Array.isArray(body.platforms) ? body.platforms.map(String) : null;
      const thresholdsObj = body.thresholds && typeof body.thresholds === 'object' ? body.thresholds : null;
      const thresholdsJson = thresholdsObj ? JSON.stringify(thresholdsObj) : null;

      await pool.query(
        `
          INSERT INTO intel_user_configs (
            user_id, datasets, keywords, intent_keywords, promo_keywords, activity_keywords, platforms, thresholds, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            datasets=COALESCE(EXCLUDED.datasets, intel_user_configs.datasets),
            keywords=COALESCE(EXCLUDED.keywords, intel_user_configs.keywords),
            intent_keywords=COALESCE(EXCLUDED.intent_keywords, intel_user_configs.intent_keywords),
            promo_keywords=COALESCE(EXCLUDED.promo_keywords, intel_user_configs.promo_keywords),
            activity_keywords=COALESCE(EXCLUDED.activity_keywords, intel_user_configs.activity_keywords),
            platforms=COALESCE(EXCLUDED.platforms, intel_user_configs.platforms),
            thresholds=COALESCE(EXCLUDED.thresholds, intel_user_configs.thresholds),
            updated_at=NOW()
        `,
        [userId, datasets, keywords, intentKeywords, promoKeywords, activityKeywords, platforms, thresholdsJson]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error('intel config failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to save config' });
    }
  });

  // Multi-source ingestion (supports GET for backward compatibility, prefer POST)
  const syncHandler = async (req, res) => {
    try {
      if (String(process.env.INTEL_SANDBOX || '').trim().toLowerCase() === 'true') {
        return res.json({
          ok: true,
          sandbox: true,
          ingest: {
            runId: null,
            datasets_processed: 0,
            posts_ingested: 0,
            posts_deduped: 0,
            communities_updated: 0,
            fetched_items: 0,
          },
          aggregate: { day: new Date().toISOString().slice(0, 10), communitiesAggregated: 0 },
        });
      }

      const cfg = getIntelConfig();
      const body = req.body && typeof req.body === 'object' ? req.body : {};

      const userId = req.intelAuth?.isAdmin
        ? (body.user_id ? Number(body.user_id) : null)
        : Number(req.intelAuth?.user?.id);

      let userConfig = null;
      if (userId) {
        const uc = await pool.query(
          `SELECT * FROM intel_user_configs WHERE user_id = $1 LIMIT 1`,
          [userId]
        );
        userConfig = uc.rows[0] || null;
      }

      const configOverride = userConfig
        ? {
            keywords: userConfig.keywords,
            intentKeywords: userConfig.intent_keywords,
            promoKeywords: userConfig.promo_keywords,
            activityKeywords: userConfig.activity_keywords,
          }
        : null;

      const communities =
        (Array.isArray(body.communities) ? body.communities : null) ||
        // Backward compatibility: older clients used `datasets` and `datasetId`.
        (Array.isArray(body.datasets) ? body.datasets : null) ||
        (req.query.community ? [String(req.query.community)] : null) ||
        (req.query.datasetId ? [String(req.query.datasetId)] : null) ||
        (userConfig?.communities && Array.isArray(userConfig.communities) ? userConfig.communities : null) ||
        (userConfig?.datasets && Array.isArray(userConfig.datasets) ? userConfig.datasets : null) ||
        cfg.communitiesDefault;

      const platform =
        String(body.platform || req.query.platform || '').trim().toLowerCase() ||
        (userConfig?.platforms && Array.isArray(userConfig.platforms) && userConfig.platforms.length
          ? String(userConfig.platforms[0]).toLowerCase()
          : '') ||
        cfg.platforms[0] ||
        'telegram';

      const cleanedCommunities = (communities || [])
        .map((d) => String(d).trim())
        .filter(Boolean);

      if (!cleanedCommunities.length) {
        return res.status(400).json({
          ok: false,
          error:
            'Missing communities. Send JSON { communities: [...] } or set INTEL_COMMUNITIES/TELETHON_COMMUNITIES.',
        });
      }

      const ingest = await ingestDatasets({
        pool,
        ensureGrowthSchema,
        communities: cleanedCommunities,
        platform,
        userId,
        configOverride,
      });

      // Aggregate for today after ingestion.
      const aggregate = await aggregateDaily({
        pool,
        ensureGrowthSchema,
        userId,
      });

      return res.json({ ok: true, ingest, aggregate });
    } catch (err) {
      console.error('sync-communities failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: err?.message || 'Sync failed' });
    }
  };

  router.get('/sync-communities', requireUser, syncHandler);
  router.post('/sync-communities', requireUser, syncHandler);

  router.get('/today', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const userId = req.intelAuth?.isAdmin ? null : Number(req.intelAuth?.user?.id);
      const result = await pool.query(`
        WITH latest_day AS (
          SELECT MAX(day) AS day FROM community_metrics WHERE ($1::int IS NULL OR user_id = $1)
        )
        SELECT
          m.day,
          m.user_id,
          m.platform,
          m.name,
          m.total_messages,
          m.activity_score,
          m.intent_score,
          m.engagement_score,
          m.confidence_score,
          m.score
        FROM community_metrics m
        JOIN latest_day d ON m.day = d.day
        WHERE ($1::int IS NULL OR m.user_id = $1)
        ORDER BY m.score DESC
        LIMIT 10
      `, [userId]);

      const topCommunities = result.rows || [];

      return res.json({
        top_communities: topCommunities,
        recommendations: computeRecommendations(topCommunities),
      });
    } catch (err) {
      console.error('intel today failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to load intel' });
    }
  });

  router.get('/opportunities', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      if (String(process.env.INTEL_SANDBOX || '').trim().toLowerCase() === 'true') {
        return res.json({
          summary: { total_opportunities: 3, top_platform: 'telegram' },
          opportunities: {
            high_intent: [{ name: '@demo_channel', platform: 'telegram', intent_score: 5, engagement_score: 20, activity_score: 10, trend_score: 5, score: 12 }],
            high_activity: [{ name: '@demo_activity', platform: 'telegram', content_activity_score: 8, score: 9 }],
            promo_heavy: [{ name: '@demo_promo', platform: 'telegram', promo_score: 7, score: 8 }],
            trending: [{ name: '@demo_trending', platform: 'telegram', trend_score: 15, activity_score: 20, score: 10 }],
            hot_posts: [{ platform: 'telegram', community_name: '@demo_channel', post_id: 'demo', intent_score: 3, engagement_score: 10, views: 100, posted_at: new Date().toISOString() }],
          },
          metadata: { generated_at: new Date().toISOString(), confidence_score: 0.75 },
        });
      }

      const cfg = getIntelConfig();
      const userId = req.intelAuth?.isAdmin
        ? (req.query.user_id ? Number(req.query.user_id) : null)
        : Number(req.intelAuth?.user?.id);

      if (!userId && !req.intelAuth?.isAdmin) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }

      let intentThreshold = cfg.intentThreshold;
      let platforms = cfg.platforms;

      if (userId) {
        const uc = await pool.query(
          `SELECT * FROM intel_user_configs WHERE user_id = $1 LIMIT 1`,
          [userId]
        );
        const c = uc.rows[0];
        if (c?.thresholds?.intent_threshold) {
          intentThreshold = Number(c.thresholds.intent_threshold) || intentThreshold;
        }
        if (Array.isArray(c?.platforms) && c.platforms.length) {
          platforms = c.platforms.map((p) => String(p).toLowerCase());
        }
      }

      const latestDayRes = await pool.query(
        `SELECT MAX(day) AS day FROM community_metrics WHERE user_id = $1`,
        [userId]
      );
      const day = latestDayRes.rows[0]?.day;
      if (!day) {
        return res.json({
          summary: { total_opportunities: 0, top_platform: null },
          opportunities: { high_intent: [], high_activity: [], promo_heavy: [], trending: [], hot_posts: [] },
          metadata: { generated_at: new Date().toISOString(), confidence_score: 0 },
        });
      }

      const highIntentRes = await pool.query(
        `
          SELECT *
          FROM community_metrics
          WHERE user_id = $1 AND day = $2 AND intent_score >= $3
          ${platforms && platforms.length ? 'AND platform = ANY($4::text[])' : ''}
          ORDER BY score DESC
          LIMIT 10
        `,
        platforms && platforms.length
          ? [userId, day, intentThreshold, platforms]
          : [userId, day, intentThreshold]
      );

      const highActivityRes = await pool.query(
        `
          SELECT *
          FROM community_metrics
          WHERE user_id = $1 AND day = $2
            AND content_activity_score >= $3
            ${platforms && platforms.length ? 'AND platform = ANY($4::text[])' : ''}
          ORDER BY content_activity_score DESC, score DESC
          LIMIT 10
        `,
        platforms && platforms.length ? [userId, day, 5, platforms] : [userId, day, 5]
      );

      const promoHeavyRes = await pool.query(
        `
          SELECT *
          FROM community_metrics
          WHERE user_id = $1 AND day = $2
            AND promo_score >= $3
            ${platforms && platforms.length ? 'AND platform = ANY($4::text[])' : ''}
          ORDER BY promo_score DESC, score DESC
          LIMIT 10
        `,
        platforms && platforms.length ? [userId, day, 5, platforms] : [userId, day, 5]
      );

      const trendingRes = await pool.query(
        `
          SELECT
            *
          FROM community_metrics m
          WHERE m.user_id = $1 AND m.day = $2 AND m.activity_score >= 1
          ${platforms && platforms.length ? 'AND m.platform = ANY($3::text[])' : ''}
          ORDER BY m.trend_score DESC, m.score DESC
          LIMIT 10
        `,
        platforms && platforms.length ? [userId, day, platforms] : [userId, day]
      );

      const hotPostsRes = await pool.query(
        `
          SELECT
            platform,
            community_name,
            post_id,
            views,
            intent_score,
            promo_score,
            content_activity_score,
            engagement_score,
            posted_at
          FROM community_posts
          WHERE user_id = $1 AND COALESCE(posted_at, ingested_at) >= NOW() - INTERVAL '24 hours'
            ${platforms && platforms.length ? 'AND platform = ANY($2::text[])' : ''}
          ORDER BY (intent_score * 2 + engagement_score) DESC, views DESC
          LIMIT 10
        `
        ,
        platforms && platforms.length ? [userId, platforms] : [userId]
      );

      const highIntent = highIntentRes.rows || [];
      const highActivity = highActivityRes.rows || [];
      const promoHeavy = promoHeavyRes.rows || [];
      const trending = trendingRes.rows || [];
      const hotPosts = hotPostsRes.rows || [];

      const totalOpp =
        highIntent.length + highActivity.length + promoHeavy.length + trending.length + hotPosts.length;

      const topPlatform =
        highIntent[0]?.platform ||
        highActivity[0]?.platform ||
        promoHeavy[0]?.platform ||
        trending[0]?.platform ||
        hotPosts[0]?.platform ||
        null;

      // Confidence score (client-facing): normalize intent + engagement against caps.
      const intentCap = 10;
      const engagementCap = 100;
      const sample = highIntent.slice(0, 10);
      const avgIntent =
        sample.length ? sample.reduce((s, x) => s + Number(x.intent_score || 0), 0) / sample.length : 0;
      const avgEng =
        sample.length ? sample.reduce((s, x) => s + Number(x.engagement_score || 0), 0) / sample.length : 0;
      const confidenceFromRows = (rows) => {
        const r = (rows || []).filter((x) => typeof x.confidence_score === 'number');
        if (!r.length) return null;
        const avg = r.reduce((s, x) => s + Number(x.confidence_score || 0), 0) / r.length;
        return Math.max(0, Math.min(1, avg));
      };

      const confidence =
        confidenceFromRows(highIntent.slice(0, 10)) ??
        confidenceFromRows(highActivity.slice(0, 10)) ??
        confidenceFromRows(promoHeavy.slice(0, 10)) ??
        confidenceFromRows(trending.slice(0, 10)) ??
        Math.min(
          1,
          (Math.min(1, avgIntent / intentCap) * 0.7) + (Math.min(1, avgEng / engagementCap) * 0.3)
        );

      return res.json({
        summary: {
          total_opportunities: totalOpp,
          top_platform: topPlatform,
        },
        opportunities: {
          high_intent: highIntent,
          high_activity: highActivity,
          promo_heavy: promoHeavy,
          trending: trending,
          hot_posts: hotPosts,
        },
        metadata: {
          generated_at: new Date().toISOString(),
          confidence_score: Number(confidence.toFixed(2)),
        },
      });
    } catch (err) {
      console.error('opportunities failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to load opportunities' });
    }
  });

  router.get('/discovered-communities', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const userId = req.intelAuth?.isAdmin ? null : Number(req.intelAuth?.user?.id);
      const includeAi =
        String(req.query.include_ai || req.query.ai || '').trim() === '1' ||
        String(req.query.include_ai || req.query.ai || '').toLowerCase() === 'true';
      const aiLimitRaw = req.query.ai_limit != null ? Number(req.query.ai_limit) : 10;
      const aiLimit = Math.max(0, Math.min(50, Number.isFinite(aiLimitRaw) ? aiLimitRaw : 10));
      const format = String(req.query.format || '').trim().toLowerCase();

      // Always recompute rankings from existing posts (safe, no ingestion changes).
      await computeAndStoreCommunityRankings({ pool, ensureGrowthSchema, userId, platform: 'telegram' });

      const latestDayRes = await pool.query(
        `SELECT MAX(day) AS day FROM community_rankings WHERE ($1::int IS NULL OR user_id = $1)`,
        [userId]
      );
      const day = latestDayRes.rows[0]?.day || null;
      if (!day) return res.json([]);

      const r = await pool.query(
        `
          SELECT
            community_name AS community,
            community_score AS score,
            total_messages,
            total_intent,
            avg_intent,
            category,
            platform,
            day
          FROM community_rankings
          WHERE ($1::int IS NULL OR user_id = $1)
            AND day = $2
            AND platform = 'telegram'
            AND (total_messages > 10 OR total_intent > 3)
          ORDER BY community_score DESC
          LIMIT 100
        `,
        [userId, day]
      );

      const rows = (r.rows || []).map((x) => ({
        ...x,
        community_name: x.community,
      }));

      const communities = rows.map((x) => String(x.community || '').trim()).filter(Boolean);
      const engagementByCommunity = new Map();
      if (communities.length) {
        const agg = await pool.query(
          `
            SELECT
              community_name,
              AVG(engagement_score) AS avg_engagement_score
            FROM community_posts
            WHERE platform = 'telegram'
              AND community_name = ANY($1::text[])
              AND ($2::int IS NULL OR user_id = $2)
              AND ingested_at >= NOW() - INTERVAL '72 hours'
            GROUP BY community_name
          `,
          [communities, userId]
        );
        for (const row of agg.rows || []) {
          engagementByCommunity.set(String(row.community_name), Number(row.avg_engagement_score || 0));
        }
      }

      const baseItems = rows.map((row) => {
        const activityScore = Number(row.total_messages || 0);
        const intentScore = Number(row.total_intent || 0);
        const avgEngagement = engagementByCommunity.get(String(row.community)) || 0;

        const decision = getCommunityDecision({ intent_score: intentScore, activity_score: activityScore });
        const confidence = computeConfidenceScore({
          intentScore,
          activityScore,
          avgEngagementScore: avgEngagement,
        });

        const item = {
          ...row,
          activity_score: activityScore,
          intent_score: intentScore,
          avg_engagement_score: avgEngagement,
          decision,
          confidence_score: Number(confidence.toFixed(2)),
          reason: getCommunityReason({
            intent_score: intentScore,
            activity_score: activityScore,
            avg_engagement_score: avgEngagement,
          }),
        };

        return item;
      });

      if (!includeAi) {
        if (format === 'team') {
          const lines = ['🔥 Top Communities:', ''];
          for (let i = 0; i < Math.min(10, baseItems.length); i += 1) {
            const it = baseItems[i];
            const finalDecision = toUpperDecision(
              getFinalDecision({ signals: { intent_score: it.intent_score, activity_score: it.activity_score }, ai: null })
            );
            lines.push(`${i + 1}. ${it.community_name} — ${finalDecision}`);
            lines.push(`   Reason: ${it.reason}`);
            lines.push('');
          }
          return res.json({ ok: true, items: baseItems, team_output: lines.join('\n').trim() });
        }
        return res.json(baseItems);
      }

      const keyPresent = hasAIKey();
      if (!keyPresent) {
        const out = baseItems.map((x) => ({
          ...x,
          final_decision: toUpperDecision(
            getFinalDecision({
              signals: { intent_score: x.intent_score, activity_score: x.activity_score },
              ai: null,
            })
          ),
          final_reason: x.reason,
          ai_summary: null,
          ai: { skipped: true, reason: 'AI API key missing' },
        }));
        if (format === 'team') {
          const lines = ['🔥 Top Communities:', ''];
          for (let i = 0; i < Math.min(10, out.length); i += 1) {
            const it = out[i];
            lines.push(`${i + 1}. ${it.community_name} — ${it.final_decision || it.decision}`);
            lines.push(`   Reason: ${it.final_reason || it.reason}`);
            lines.push('');
          }
          return res.json({ ok: true, items: out, team_output: lines.join('\n').trim() });
        }
        return res.json(out);
      }

      const analyzed = [];
      for (let i = 0; i < baseItems.length; i += 1) {
        const row = baseItems[i];
        if (aiLimit && analyzed.length >= aiLimit) {
          analyzed.push({ ...row, ai_summary: null, ai: { skipped: true, reason: 'ai_limit' } });
          continue;
        }

        const comm = String(row.community || '').trim();
        if (!comm) {
          analyzed.push({ ...row, ai_summary: null, ai: { skipped: true, reason: 'missing_community' } });
          continue;
        }

        // Pull up to 10 recent messages (lightweight, post-processing only).
        const m = await pool.query(
          `
            SELECT text, posted_at
            FROM community_posts
            WHERE platform = 'telegram'
              AND community_name = $1
              AND ($2::int IS NULL OR user_id = $2)
            ORDER BY posted_at DESC NULLS LAST, ingested_at DESC
            LIMIT 10
          `,
          [comm, userId]
        );
        const messages = (m.rows || [])
          .map((x) => ({ text: x.text, posted_at: x.posted_at }))
          .filter((x) => x && x.text);
        if (!messages.length) {
          analyzed.push({ ...row, ai_summary: null, ai: { skipped: true, reason: 'no_messages' } });
          continue;
        }

        const model = resolveAIConfig().model;
        const messagesHash = computeMessagesHash(messages);
        const legacyMessagesHash = computeLegacyMessagesHash(messages);
        const cached = await getCachedCommunityAnalysis({
          pool,
          ensureGrowthSchema,
          userId,
          platform: 'telegram',
          communityName: comm,
          messagesHash,
          legacyMessagesHash,
        });

        if (cached?.analysis) {
          const finalDecision = toUpperDecision(
            getFinalDecision({
              signals: { intent_score: row.intent_score, activity_score: row.activity_score },
              ai: cached.analysis,
            })
          );
          const finalReason = cached.analysis?.summary || row.reason;
          analyzed.push({
            ...row,
            final_decision: finalDecision,
            final_reason: finalReason,
            ai_summary: cached.analysis?.summary || null,
            ai: { ...cached.analysis, cached: true },
          });
          continue;
        }

        try {
          const ai = await analyzeCommunity({ communityName: comm, messages, model });
          await upsertCommunityAnalysis({
            pool,
            ensureGrowthSchema,
            userId,
            platform: 'telegram',
            communityName: comm,
            messagesHash,
            model,
            provider: ai?._meta?.provider || resolveAIConfig().provider,
            modelVersion: ai?._meta?.model_version || null,
            analysis: ai,
          });
          const finalDecision = toUpperDecision(
            getFinalDecision({
              signals: { intent_score: row.intent_score, activity_score: row.activity_score },
              ai,
            })
          );
          const finalReason = ai?.summary || row.reason;
          analyzed.push({
            ...row,
            final_decision: finalDecision,
            final_reason: finalReason,
            ai_summary: ai?.summary || null,
            ai: { ...ai, cached: false },
          });
        } catch (err) {
          analyzed.push({
            ...row,
            final_decision: toUpperDecision(
              getFinalDecision({
                signals: { intent_score: row.intent_score, activity_score: row.activity_score },
                ai: null,
              })
            ),
            final_reason: row.reason,
            ai_summary: null,
            ai: { skipped: true, reason: err?.message || 'analysis_failed' },
          });
        }
      }

      if (format === 'team') {
        const lines = ['🔥 Top Communities:', ''];
        for (let i = 0; i < Math.min(10, analyzed.length); i += 1) {
          const it = analyzed[i];
          lines.push(`${i + 1}. ${it.community_name} — ${it.final_decision || it.decision}`);
          lines.push(`   Reason: ${it.final_reason || it.reason}`);
          lines.push('');
        }
        return res.json({ ok: true, items: analyzed, team_output: lines.join('\n').trim() });
      }

      return res.json(analyzed);
    } catch (err) {
      console.error('discovered-communities failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to load discovered communities' });
    }
  });

  router.post('/analyze-community', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const community = String(body.community || '').trim();
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const messages = rawMessages.slice(0, 10);

      if (!community) return res.status(400).json({ ok: false, error: 'community is required' });
      if (!messages.length) return res.status(400).json({ ok: false, error: 'messages must be a non-empty array' });

      const userId = req.intelAuth?.isAdmin
        ? (body.user_id ? Number(body.user_id) : null)
        : Number(req.intelAuth?.user?.id);

      const model = resolveAIConfig({ model: body.model }).model;
      const messagesHash = computeMessagesHash(messages);
      const legacyMessagesHash = computeLegacyMessagesHash(messages);

      const cached = await getCachedCommunityAnalysis({
        pool,
        ensureGrowthSchema,
        userId,
        platform: 'telegram',
        communityName: community,
        messagesHash,
        legacyMessagesHash,
      });

      if (cached?.analysis) {
        return res.json({ ok: true, community, ai: cached.analysis, cached: true });
      }

      const ai = await analyzeCommunity({ communityName: community, messages, model });
      await upsertCommunityAnalysis({
        pool,
        ensureGrowthSchema,
        userId,
        platform: 'telegram',
        communityName: community,
        messagesHash,
        model,
        provider: ai?._meta?.provider || resolveAIConfig().provider,
        modelVersion: ai?._meta?.model_version || null,
        analysis: ai,
      });

      return res.json({ ok: true, community, ai, cached: false });
    } catch (err) {
      console.error('analyze-community failed:', err?.message || String(err));
      const msg = String(err?.message || 'Failed to analyze community');
      const status = err?.code === 'OPENAI_KEY_MISSING' ? 503 : 500;
      return res.status(status).json({ ok: false, error: msg });
    }
  });

  router.post('/discovered-communities/refresh', requireUser, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const userId = req.intelAuth?.isAdmin ? null : Number(req.intelAuth?.user?.id);

      const extraction = await discoverFromMessageExtraction({
        pool,
        ensureGrowthSchema,
        userId,
        windowHours: 72,
        maxPosts: 5000,
      });

      const rankings = await computeAndStoreCommunityRankings({
        pool,
        ensureGrowthSchema,
        userId,
        platform: 'telegram',
      });

      return res.json({ ok: true, extraction, rankings });
    } catch (err) {
      console.error('discovered-communities refresh failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to refresh discovery' });
    }
  });

  app.use('/intel', router);
  app.use('/api/intel', router);
}

module.exports = {
  registerIntelRoutes,
};
