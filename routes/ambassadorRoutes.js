const express = require('express');
const { requireIntelUser } = require('../middleware/intelUser');
const { isAmbassadorsEnabled } = require('../services/featureFlags');

function registerAmbassadorRoutes(app, { pool, ensureGrowthSchema }) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    if (!isAmbassadorsEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
    try {
      await ensureGrowthSchema();
      return next();
    } catch (err) {
      console.error('ambassador ensure schema failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'db_unavailable' });
    }
  });

  router.use(requireIntelUser({ pool, allowAdmin: true }));
  router.get('/health', (req, res) => {
    return res.json({ ok: true, module: 'ambassadors', admin: !!req.intelAuth?.isAdmin });
  });

  router.post('/apply', async (req, res) => {
    try {
      if (!req.intelAuth?.isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const telegramId = body.telegram_id != null ? Number(body.telegram_id) : null;
      if (!telegramId || !Number.isFinite(telegramId)) {
        return res.status(400).json({ ok: false, error: 'telegram_id_required' });
      }

      const status = body.status != null ? String(body.status).trim().toLowerCase() : 'active';
      const level = body.level != null ? Math.max(1, Number(body.level) || 1) : 1;
      const score = body.score != null ? Number(body.score) || 0 : 0;

      const r = await pool.query(
        `
          INSERT INTO ambassadors (telegram_id, status, level, score, created_at, updated_at)
          VALUES ($1,$2,$3,$4,NOW(),NOW())
          ON CONFLICT (telegram_id)
          DO UPDATE SET
            status = COALESCE(EXCLUDED.status, ambassadors.status),
            level = COALESCE(EXCLUDED.level, ambassadors.level),
            score = COALESCE(EXCLUDED.score, ambassadors.score),
            updated_at = NOW()
          RETURNING *
        `,
        [telegramId, status, level, score]
      );
      return res.json({ ok: true, ambassador: r.rows[0] });
    } catch (err) {
      console.error('ambassador apply failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.post('/boosts/upsert', async (req, res) => {
    try {
      if (!req.intelAuth?.isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const telegramId = body.telegram_id != null ? Number(body.telegram_id) : null;
      const boostType = String(body.boost_type || '').trim().toLowerCase();
      if (!telegramId || !Number.isFinite(telegramId)) {
        return res.status(400).json({ ok: false, error: 'telegram_id_required' });
      }
      if (!boostType) return res.status(400).json({ ok: false, error: 'boost_type_required' });

      const multiplier = Math.max(1, Math.min(10, Number(body.multiplier || 1) || 1));
      const startsAt = body.starts_at ? new Date(body.starts_at) : null;
      const endsAt = body.ends_at ? new Date(body.ends_at) : null;

      // Ensure ambassador exists
      await pool.query(
        `INSERT INTO ambassadors (telegram_id, status, level, score, created_at, updated_at)
         VALUES ($1,'active',1,0,NOW(),NOW())
         ON CONFLICT (telegram_id) DO NOTHING`,
        [telegramId]
      );

      const r = await pool.query(
        `
          INSERT INTO ambassador_boosts (telegram_id, boost_type, multiplier, starts_at, ends_at, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
          ON CONFLICT (telegram_id, boost_type)
          DO UPDATE SET
            multiplier = EXCLUDED.multiplier,
            starts_at = EXCLUDED.starts_at,
            ends_at = EXCLUDED.ends_at,
            updated_at = NOW()
          RETURNING *
        `,
        [
          telegramId,
          boostType,
          multiplier,
          startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null,
          endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
        ]
      );
      return res.json({ ok: true, boost: r.rows[0] });
    } catch (err) {
      console.error('ambassador boost upsert failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.get('/boosts', async (req, res) => {
    try {
      if (!req.intelAuth?.isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const telegramId = req.query.telegram_id != null ? Number(req.query.telegram_id) : null;
      if (!telegramId || !Number.isFinite(telegramId)) {
        return res.status(400).json({ ok: false, error: 'telegram_id_required' });
      }
      const r = await pool.query(
        `SELECT * FROM ambassador_boosts WHERE telegram_id = $1 ORDER BY updated_at DESC, id DESC`,
        [telegramId]
      );
      return res.json({ ok: true, items: r.rows || [] });
    } catch (err) {
      console.error('ambassador boosts get failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  app.use('/ambassadors', router);
  app.use('/api/ambassadors', router);
}

module.exports = {
  registerAmbassadorRoutes,
};
