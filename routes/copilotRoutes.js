const express = require('express');
const { requireIntelUser } = require('../middleware/intelUser');
const { isCopilotEnabled } = require('../services/featureFlags');
const { getCopilotActions } = require('../services/copilot/actions');
const { draftCopilotText } = require('../services/copilot/prompts');

function registerCopilotRoutes(app, { pool, ensureGrowthSchema }) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    if (!isCopilotEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
    try {
      await ensureGrowthSchema();
      return next();
    } catch (err) {
      console.error('copilot ensure schema failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'db_unavailable' });
    }
  });

  router.use(requireIntelUser({ pool, allowAdmin: true }));
  router.get('/health', (req, res) => {
    return res.json({ ok: true, module: 'copilot', admin: !!req.intelAuth?.isAdmin });
  });

  router.get('/actions', async (req, res) => {
    try {
      if (req.intelAuth?.isAdmin) return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      const userId = Number(req.intelAuth?.user?.id);
      const limit = req.query.limit != null ? Number(req.query.limit) : 20;
      const cooldown = req.query.cooldown_hours != null ? Number(req.query.cooldown_hours) : null;
      const out = await getCopilotActions({
        pool,
        ensureGrowthSchema,
        userId,
        limit,
        cooldownHours: cooldown == null ? 24 : cooldown,
      });
      return res.json({ ok: true, items: out });
    } catch (err) {
      console.error('copilot actions failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.post('/draft-reply', async (req, res) => {
    try {
      if (req.intelAuth?.isAdmin) return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const entityKey = String(body.entity_key || '').trim();
      if (!entityKey) return res.status(400).json({ ok: false, error: 'entity_key_required' });
      const context = body.context != null ? String(body.context) : '';
      const tone = body.tone != null ? String(body.tone) : 'friendly';
      const out = await draftCopilotText({ kind: 'draft-reply', entityKey, context, tone });
      return res.json(out);
    } catch (err) {
      console.error('copilot draft-reply failed:', err?.message || String(err));
      const status = err?.code === 'OPENAI_KEY_MISSING' ? 503 : 500;
      return res.status(status).json({ ok: false, error: err?.message || 'failed' });
    }
  });

  router.post('/draft-dm', async (req, res) => {
    try {
      if (req.intelAuth?.isAdmin) return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const entityKey = String(body.entity_key || '').trim();
      if (!entityKey) return res.status(400).json({ ok: false, error: 'entity_key_required' });
      const context = body.context != null ? String(body.context) : '';
      const tone = body.tone != null ? String(body.tone) : 'friendly';
      const out = await draftCopilotText({ kind: 'draft-dm', entityKey, context, tone });
      return res.json(out);
    } catch (err) {
      console.error('copilot draft-dm failed:', err?.message || String(err));
      const status = err?.code === 'OPENAI_KEY_MISSING' ? 503 : 500;
      return res.status(status).json({ ok: false, error: err?.message || 'failed' });
    }
  });

  app.use('/copilot', router);
  app.use('/api/copilot', router);
}

module.exports = {
  registerCopilotRoutes,
};
