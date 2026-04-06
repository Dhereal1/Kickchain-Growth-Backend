const express = require('express');
const { ingestDatasets, aggregateDaily } = require('../services/intelPipeline');
const { getIntelConfig } = require('../services/intelConfig');
const { requireApiKey } = require('../middleware/auth');

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

  router.post('/webhook', requireApiKey, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const url = String(body.url || '').trim();
      const name = String(body.name || '').trim() || null;
      const secret = String(body.secret || '').trim() || null;
      const enabled = body.enabled === false ? false : true;

      if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

      await pool.query(
        `
          INSERT INTO intel_webhooks (name, url, secret, enabled, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (url)
          DO UPDATE SET name=EXCLUDED.name, secret=EXCLUDED.secret, enabled=EXCLUDED.enabled, updated_at=NOW()
        `,
        [name, url, secret, enabled]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error('intel webhook register failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to save webhook' });
    }
  });

  router.get('/runs', requireApiKey, async (req, res) => {
    try {
      await ensureGrowthSchema();

      const r = await pool.query(
        `
          SELECT
            id,
            run_at,
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
          ORDER BY id DESC
          LIMIT 50
        `
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

  router.get('/health', requireApiKey, async (req, res) => {
    try {
      await ensureGrowthSchema();
      const cfg = getIntelConfig();
      const r = await pool.query(
        `SELECT * FROM intel_runs ORDER BY id DESC LIMIT 1`
      );
      const last = r.rows[0] || null;
      const lastRunAt = last?.run_at ? new Date(last.run_at).toISOString() : null;
      const lastIngestCount = Number(last?.inserted_posts || 0);
      const datasetsConnected = (cfg.datasetsDefault || []).length;

      const healthy =
        !!last &&
        last.status === 'success' &&
        (Date.now() - new Date(last.run_at).getTime()) < 36 * 60 * 60 * 1000;

      return res.json({
        last_run: lastRunAt,
        status: healthy ? 'healthy' : 'unhealthy',
        datasets_connected: datasetsConnected,
        last_ingest_count: lastIngestCount,
      });
    } catch (err) {
      console.error('intel health failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Health check failed' });
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

      const datasets =
        (Array.isArray(body.datasets) ? body.datasets : null) ||
        (req.query.datasetId ? [String(req.query.datasetId)] : null) ||
        cfg.datasetsDefault;

      const platform =
        String(body.platform || req.query.platform || '').trim().toLowerCase() ||
        cfg.platforms[0] ||
        'telegram';

      const cleanedDatasets = (datasets || [])
        .map((d) => String(d).trim())
        .filter(Boolean);

      if (!cleanedDatasets.length) {
        return res.status(400).json({
          ok: false,
          error:
            'Missing datasets. Send JSON { datasets: [...] } or set APIFY_DATASET_IDS/APIFY_DATASET_ID.',
        });
      }

      const ingest = await ingestDatasets({
        pool,
        ensureGrowthSchema,
        datasets: cleanedDatasets,
        platform,
      });

      // Aggregate for today after ingestion.
      const aggregate = await aggregateDaily({ pool, ensureGrowthSchema });

      return res.json({ ok: true, ingest, aggregate });
    } catch (err) {
      console.error('sync-communities failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: err?.message || 'Sync failed' });
    }
  };

  router.get('/sync-communities', syncHandler);
  router.post('/sync-communities', syncHandler);

  router.get('/today', async (req, res) => {
    try {
      await ensureGrowthSchema();

      const result = await pool.query(`
        WITH latest_day AS (
          SELECT MAX(day) AS day FROM community_metrics
        )
        SELECT
          m.day,
          m.platform,
          m.name,
          m.total_messages,
          m.activity_score,
          m.intent_score,
          m.engagement_score,
          m.score
        FROM community_metrics m
        JOIN latest_day d ON m.day = d.day
        ORDER BY m.score DESC
        LIMIT 10
      `);

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

  router.get('/opportunities', requireApiKey, async (req, res) => {
    try {
      await ensureGrowthSchema();

      if (String(process.env.INTEL_SANDBOX || '').trim().toLowerCase() === 'true') {
        return res.json({
          summary: { total_opportunities: 3, top_platform: 'telegram' },
          opportunities: {
            high_intent: [{ name: '@demo_channel', platform: 'telegram', intent_score: 5, engagement_score: 20, activity_score: 10, trend_score: 5, score: 12 }],
            trending: [{ name: '@demo_trending', platform: 'telegram', trend_score: 15, activity_score: 20, score: 10 }],
            hot_posts: [{ platform: 'telegram', community_name: '@demo_channel', post_id: 'demo', intent_score: 3, engagement_score: 10, views: 100, posted_at: new Date().toISOString() }],
          },
          metadata: { generated_at: new Date().toISOString(), confidence_score: 0.75 },
        });
      }

      const cfg = getIntelConfig();
      const clientId = req.query.client_id ? Number(req.query.client_id) : null;

      let intentThreshold = cfg.intentThreshold;
      let platforms = cfg.platforms;
      if (clientId && Number.isFinite(clientId)) {
        const cr = await pool.query(`SELECT * FROM client_configs WHERE id = $1`, [clientId]);
        const c = cr.rows[0];
        if (c?.thresholds?.intent_threshold) {
          intentThreshold = Number(c.thresholds.intent_threshold) || intentThreshold;
        }
        if (Array.isArray(c?.platforms) && c.platforms.length) {
          platforms = c.platforms.map((p) => String(p).toLowerCase());
        }
      }

      const latestDayRes = await pool.query(`SELECT MAX(day) AS day FROM community_metrics`);
      const day = latestDayRes.rows[0]?.day;
      if (!day) {
        return res.json({
          summary: { total_opportunities: 0, top_platform: null },
          opportunities: { high_intent: [], trending: [], hot_posts: [] },
          metadata: { generated_at: new Date().toISOString(), confidence_score: 0 },
        });
      }

      const highIntentRes = await pool.query(
        `
          SELECT *
          FROM community_metrics
          WHERE day = $1 AND intent_score >= $2
          ${platforms && platforms.length ? 'AND platform = ANY($3::text[])' : ''}
          ORDER BY score DESC
          LIMIT 10
        `,
        platforms && platforms.length ? [day, intentThreshold, platforms] : [day, intentThreshold]
      );

      const trendingRes = await pool.query(
        `
          SELECT
            *
          FROM community_metrics m
          WHERE m.day = $1 AND m.activity_score >= 1
          ${platforms && platforms.length ? 'AND m.platform = ANY($2::text[])' : ''}
          ORDER BY m.trend_score DESC, m.score DESC
          LIMIT 10
        `,
        platforms && platforms.length ? [day, platforms] : [day]
      );

      const hotPostsRes = await pool.query(
        `
          SELECT
            platform,
            community_name,
            post_id,
            views,
            intent_score,
            engagement_score,
            posted_at
          FROM community_posts
          WHERE posted_at >= NOW() - INTERVAL '24 hours'
            ${platforms && platforms.length ? 'AND platform = ANY($1::text[])' : ''}
          ORDER BY (intent_score * 2 + engagement_score) DESC, views DESC
          LIMIT 10
        `
        ,
        platforms && platforms.length ? [platforms] : []
      );

      const highIntent = highIntentRes.rows || [];
      const trending = trendingRes.rows || [];
      const hotPosts = hotPostsRes.rows || [];

      const totalOpp =
        highIntent.length + trending.length + hotPosts.length;

      const topPlatform =
        highIntent[0]?.platform || trending[0]?.platform || hotPosts[0]?.platform || null;

      // Confidence score (client-facing): normalize intent + engagement against caps.
      const intentCap = 10;
      const engagementCap = 100;
      const sample = highIntent.slice(0, 10);
      const avgIntent =
        sample.length ? sample.reduce((s, x) => s + Number(x.intent_score || 0), 0) / sample.length : 0;
      const avgEng =
        sample.length ? sample.reduce((s, x) => s + Number(x.engagement_score || 0), 0) / sample.length : 0;
      const confidence = Math.min(
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

  app.use('/intel', router);
  app.use('/api/intel', router);
}

module.exports = {
  registerIntelRoutes,
};
