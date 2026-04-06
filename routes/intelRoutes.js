const express = require('express');
const { getCommunitiesFromApify } = require('../services/apifyService');

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

function makeCronAuthCheck(req) {
  const cronHeader = String(req.headers['x-vercel-cron'] || '');
  const secret = (process.env.CRON_SECRET || '').trim();
  const qs = req.query?.secret ? String(req.query.secret) : '';
  return cronHeader === '1' || (secret && qs && qs === secret);
}

function registerIntelRoutes(app, { pool, ensureGrowthSchema }) {
  const router = express.Router();

  router.get('/sync-communities', async (req, res) => {
    try {
      await ensureGrowthSchema();

      const datasetId =
        String(req.query.datasetId || '').trim() ||
        String(process.env.APIFY_DATASET_ID || '').trim();
      const platformHint = String(req.query.platform || '').trim().toLowerCase() || undefined;

      if (!datasetId) {
        return res.status(400).json({
          ok: false,
          error: 'Missing datasetId. Provide ?datasetId=... or set APIFY_DATASET_ID.',
        });
      }

      const communities = await getCommunitiesFromApify({ datasetId, platformHint });

      let upserted = 0;
      for (const c of communities) {
        const r = await pool.query(
          `
            INSERT INTO communities (name, platform, member_count, activity_score, keyword_matches, raw, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (name, platform)
            DO UPDATE SET
              member_count = EXCLUDED.member_count,
              activity_score = EXCLUDED.activity_score,
              keyword_matches = EXCLUDED.keyword_matches,
              raw = EXCLUDED.raw,
              updated_at = NOW()
          `,
          [
            c.name,
            c.platform,
            c.member_count,
            c.activity_score,
            c.keyword_matches,
            c.raw,
          ]
        );
        upserted += r.rowCount ? 1 : 0;
      }

      return res.json({
        ok: true,
        datasetId,
        fetched: communities.length,
        upserted,
      });
    } catch (err) {
      console.error('sync-communities failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Sync failed' });
    }
  });

  router.get('/today', async (req, res) => {
    try {
      await ensureGrowthSchema();

      const result = await pool.query(
        `
          SELECT
            id,
            name,
            platform,
            member_count,
            activity_score,
            keyword_matches,
            created_at,
            updated_at,
            (
              (COALESCE(activity_score, 0) * 0.6) +
              (COALESCE(member_count, 0) * 0.2) +
              (COALESCE(keyword_matches, 0) * 0.2)
            ) AS score
          FROM communities
          ORDER BY score DESC, updated_at DESC
          LIMIT 10
        `
      );

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

  // Cron (Vercel safe): triggers sync using APIFY_DATASET_ID (or override via query)
  router.get('/cron/intel-sync', async (req, res) => {
    if (!makeCronAuthCheck(req)) return res.sendStatus(401);

    try {
      await ensureGrowthSchema();
      const datasetId =
        String(req.query.datasetId || '').trim() ||
        String(process.env.APIFY_DATASET_ID || '').trim();

      if (!datasetId) {
        return res.status(400).json({
          ok: false,
          error: 'Missing APIFY_DATASET_ID (or pass ?datasetId=...)',
        });
      }

      const platformHint = String(req.query.platform || '').trim().toLowerCase() || undefined;
      const communities = await getCommunitiesFromApify({ datasetId, platformHint });

      for (const c of communities) {
        await pool.query(
          `
            INSERT INTO communities (name, platform, member_count, activity_score, keyword_matches, raw, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (name, platform)
            DO UPDATE SET
              member_count = EXCLUDED.member_count,
              activity_score = EXCLUDED.activity_score,
              keyword_matches = EXCLUDED.keyword_matches,
              raw = EXCLUDED.raw,
              updated_at = NOW()
          `,
          [
            c.name,
            c.platform,
            c.member_count,
            c.activity_score,
            c.keyword_matches,
            c.raw,
          ]
        );
      }

      return res.json({
        ok: true,
        datasetId,
        fetched: communities.length,
      });
    } catch (err) {
      console.error('cron intel-sync failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'Cron sync failed' });
    }
  });

  app.use('/intel', router);
  app.use('/api/intel', router);
}

module.exports = {
  registerIntelRoutes,
};
