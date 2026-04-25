const express = require('express');
const { requireIntelUser } = require('../middleware/intelUser');
const { isMatchHypeEventsEnabled } = require('../services/featureFlags');

function registerHypeRoutes(app, { pool, ensureGrowthSchema }) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    if (!isMatchHypeEventsEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
    try {
      await ensureGrowthSchema();
      return next();
    } catch (err) {
      console.error('hype ensure schema failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'db_unavailable' });
    }
  });

  router.use(requireIntelUser({ pool, allowAdmin: true }));

  router.get('/events', async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status).trim().toLowerCase() : '';
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

      const params = [];
      const where = ['1=1'];
      if (status) {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      params.push(limit);

      const r = await pool.query(
        `
          SELECT *
          FROM match_hype_events
          WHERE ${where.join(' AND ')}
          ORDER BY id DESC
          LIMIT $${params.length}
        `,
        params
      );

      return res.json({ ok: true, items: r.rows || [] });
    } catch (err) {
      console.error('hype events failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  app.use('/growth/hype', router);
  app.use('/api/growth/hype', router);
}

module.exports = {
  registerHypeRoutes,
};

