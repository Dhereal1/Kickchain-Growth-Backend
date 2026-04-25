const express = require('express');
const { requireIntelUser } = require('../middleware/intelUser');
const { isTournamentOrchestrationEnabled } = require('../services/featureFlags');
const {
  getTournamentState,
  joinTournament,
  startTournament,
  recomputeTournamentProgress,
} = require('../services/tournaments/orchestrator');

function registerTournamentRoutes(app, { pool, ensureGrowthSchema }) {
  const router = express.Router();

  router.get('/health', (_req, res) => res.json({ ok: true, module: 'tournament-orchestration' }));

  // Auth applied per-route in later PRs; keep PR0 as stub-only.
  router.get('/:id(\\d+)', requireIntelUser({ pool, allowAdmin: true }), async (req, res) => {
    try {
      if (!isTournamentOrchestrationEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
      const id = Number(req.params.id);
      const state = await getTournamentState({ pool, ensureGrowthSchema, tournamentId: id });
      if (!state.tournament) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json({ ok: true, ...state });
    } catch (err) {
      console.error('tournament get failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  // Admin helper: join participant by telegram_id
  router.post('/:id(\\d+)/join', requireIntelUser({ pool, allowAdmin: true }), async (req, res) => {
    try {
      if (!isTournamentOrchestrationEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
      if (!req.intelAuth?.isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const telegramId = body.telegram_id != null ? Number(body.telegram_id) : null;
      if (!telegramId || !Number.isFinite(telegramId)) {
        return res.status(400).json({ ok: false, error: 'telegram_id_required' });
      }
      const out = await joinTournament({ pool, ensureGrowthSchema, tournamentId: id, telegramId });
      return res.json(out);
    } catch (err) {
      console.error('tournament join failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.post('/:id(\\d+)/start', requireIntelUser({ pool, allowAdmin: true }), async (req, res) => {
    try {
      if (!isTournamentOrchestrationEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
      if (!req.intelAuth?.isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const out = await startTournament({ pool, ensureGrowthSchema, tournamentId: id });
      return res.json(out);
    } catch (err) {
      console.error('tournament start failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.post('/:id(\\d+)/advance', requireIntelUser({ pool, allowAdmin: true }), async (req, res) => {
    try {
      if (!isTournamentOrchestrationEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
      if (!req.intelAuth?.isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const id = Number(req.params.id);
      const out = await recomputeTournamentProgress({ pool, ensureGrowthSchema, tournamentId: id });
      return res.json(out);
    } catch (err) {
      console.error('tournament advance failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  app.use('/tournaments', router);
  app.use('/api/tournaments', router);
}

module.exports = {
  registerTournamentRoutes,
};
