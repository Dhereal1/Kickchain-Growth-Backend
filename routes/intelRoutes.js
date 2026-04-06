const express = require('express');
const { ingestDatasets, aggregateDaily } = require('../services/intelPipeline');
const { getIntelConfig } = require('../services/intelConfig');

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

  router.post('/webhook', async (req, res) => {
    try {
      await ensureGrowthSchema();

      const adminKey = (process.env.ADMIN_API_KEY || '').trim();
      if (adminKey) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${adminKey}`) return res.sendStatus(401);
      }

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

  router.get('/runs', async (req, res) => {
    try {
      await ensureGrowthSchema();
      const r = await pool.query(
        `
          SELECT
            id,
            run_at,
            datasets,
            platform,
            fetched_items,
            inserted_posts,
            deduped_posts,
            communities_updated,
            duration_ms,
            status,
            error
          FROM intel_runs
          ORDER BY id DESC
          LIMIT 50
        `
      );
      return res.json({ runs: r.rows || [] });
    } catch (err) {
      console.error('intel runs failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Failed to load runs' });
    }
  });

  router.get('/health', async (req, res) => {
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

  router.get('/opportunities', async (req, res) => {
    try {
      await ensureGrowthSchema();
      const cfg = getIntelConfig();

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
          ORDER BY score DESC
          LIMIT 10
        `,
        [day, cfg.intentThreshold]
      );

      const trendingRes = await pool.query(
        `
          SELECT
            *
          FROM community_metrics m
          WHERE m.day = $1 AND m.activity_score >= 1
          ORDER BY m.trend_score DESC, m.score DESC
          LIMIT 10
        `,
        [day]
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
          ORDER BY (intent_score * 2 + engagement_score) DESC, views DESC
          LIMIT 10
        `
      );

      const highIntent = highIntentRes.rows || [];
      const trending = trendingRes.rows || [];
      const hotPosts = hotPostsRes.rows || [];

      const totalOpp =
        highIntent.length + trending.length + hotPosts.length;

      const topPlatform =
        highIntent[0]?.platform || trending[0]?.platform || hotPosts[0]?.platform || null;

      // Simple confidence heuristic: presence of intent and at least some posts.
      const confidence =
        Math.min(
          1,
          0.2 +
            (highIntent.length ? 0.4 : 0) +
            (hotPosts.length ? 0.2 : 0) +
            (trending.length ? 0.2 : 0)
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
