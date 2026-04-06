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
      if (!day) return res.json({ high_intent_communities: [], trending_communities: [], hot_posts: [] });

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
          WITH prev AS (
            SELECT name, platform, activity_score
            FROM community_metrics
            WHERE day = $1::date - INTERVAL '1 day'
          )
          SELECT
            m.*,
            COALESCE(p.activity_score, 0) AS prev_activity_score
          FROM community_metrics m
          LEFT JOIN prev p ON p.name = m.name AND p.platform = m.platform
          WHERE m.day = $1 AND m.activity_score >= 1
          ORDER BY (m.activity_score - COALESCE(p.activity_score, 0)) DESC, m.score DESC
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

      return res.json({
        high_intent_communities: highIntentRes.rows || [],
        trending_communities: trendingRes.rows || [],
        hot_posts: hotPostsRes.rows || [],
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
