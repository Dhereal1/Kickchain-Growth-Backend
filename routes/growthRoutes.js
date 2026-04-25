const express = require('express');
const { requireIntelUser } = require('../middleware/intelUser');
const { isGrowthCrmEnabled } = require('../services/featureFlags');
const { computeOpportunityScore } = require('../services/growth-crm/opportunityScore');

function disabled(router) {
  router.use((_req, res) => res.status(404).json({ ok: false, error: 'disabled' }));
  return router;
}

function registerGrowthRoutes(app, { pool, ensureGrowthSchema }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!isGrowthCrmEnabled()) return res.status(404).json({ ok: false, error: 'disabled' });
    return next();
  });

  router.use(requireIntelUser({ pool, allowAdmin: true }));

  router.get('/health', (req, res) => {
    return res.json({ ok: true, module: 'growth-crm', admin: !!req.intelAuth?.isAdmin });
  });

  function resolveUserId(req) {
    const isAdmin = !!req.intelAuth?.isAdmin;
    const userId = isAdmin
      ? (req.query.user_id ? Number(req.query.user_id) : null)
      : Number(req.intelAuth?.user?.id);
    return { isAdmin, userId };
  }

  function normalizeTelegramUsername(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const urlMatch = lower.match(/(?:https?:\/\/)?t\.me\/([a-z0-9_]{3,64})/i);
    const username = urlMatch ? urlMatch[1] : lower.replace(/^@/, '');
    if (!username) return null;
    if (!/^[a-z0-9_]{5,32}$/.test(username)) return null;
    return `@${username}`;
  }

  router.get('/communities', async (req, res) => {
    try {
      await ensureGrowthSchema();
      const { isAdmin, userId } = resolveUserId(req);
      if (!userId && !isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (isAdmin && !userId) return res.status(400).json({ ok: false, error: 'user_id_required' });

      const stage = req.query.stage ? String(req.query.stage).trim().toLowerCase() : '';
      const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

      const params = [Number(userId)];
      const where = ['p.user_id = $1'];
      if (stage) {
        params.push(stage);
        where.push(`p.stage = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(LOWER(p.community_name) LIKE $${params.length} OR LOWER(COALESCE(p.notes,'')) LIKE $${params.length})`);
      }
      params.push(limit);

      const rowsRes = await pool.query(
        `
          SELECT
            p.*,
            r.day AS ranking_day,
            r.total_messages,
            r.total_intent,
            r.avg_intent,
            r.community_score,
            r.category,
            a.quality_score AS ai_quality_score,
            a.recommended_action AS ai_recommended_action,
            a.summary AS ai_summary,
            a.updated_at AS ai_updated_at
          FROM communities_pipeline p
          LEFT JOIN LATERAL (
            SELECT day, total_messages, total_intent, avg_intent, community_score, category
            FROM community_rankings
            WHERE user_id = p.user_id
              AND workspace_id IS NULL
              AND platform = p.platform
              AND community_name = p.community_name
            ORDER BY day DESC, computed_at DESC
            LIMIT 1
          ) r ON TRUE
          LEFT JOIN LATERAL (
            SELECT quality_score, recommended_action, summary, updated_at
            FROM community_ai_analyses
            WHERE user_id = p.user_id
              AND workspace_id IS NULL
              AND platform = p.platform
              AND community_name = p.community_name
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
          ) a ON TRUE
          WHERE ${where.join(' AND ')}
          ORDER BY p.opportunity_score DESC, p.updated_at DESC
          LIMIT $${params.length}
        `,
        params
      );

      const out = (rowsRes.rows || []).map((row) => {
        const ranking = {
          total_messages: row.total_messages,
          total_intent: row.total_intent,
          avg_intent: row.avg_intent,
          community_score: row.community_score,
        };
        const ai = {
          quality_score: row.ai_quality_score,
          recommended_action: row.ai_recommended_action,
          summary: row.ai_summary,
        };
        const computed = computeOpportunityScore({ ranking, ai, pipeline: row });
        return {
          ...row,
          computed_opportunity_score: computed,
          intel: {
            ranking_day: row.ranking_day,
            total_messages: row.total_messages,
            total_intent: row.total_intent,
            avg_intent: row.avg_intent,
            community_score: row.community_score,
            category: row.category,
            ai: ai.summary ? ai : null,
          },
        };
      });

      return res.json({ ok: true, user_id: Number(userId), items: out });
    } catch (err) {
      console.error('growth communities failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.post('/community/update', async (req, res) => {
    try {
      await ensureGrowthSchema();
      if (req.intelAuth?.isAdmin) return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      const userId = Number(req.intelAuth?.user?.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const community = normalizeTelegramUsername(body.community_name);
      if (!community) return res.status(400).json({ ok: false, error: 'invalid_community_name' });

      const platform = String(body.platform || 'telegram').trim().toLowerCase() || 'telegram';
      const stage = String(body.stage || 'discovered').trim().toLowerCase() || 'discovered';
      const allowedStages = new Set(['discovered', 'engaging', 'warm', 'activated', 'partner']);
      if (!allowedStages.has(stage)) return res.status(400).json({ ok: false, error: 'invalid_stage' });

      const assignedTo = body.assigned_to != null ? String(body.assigned_to).trim() : null;
      const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean).slice(0, 25) : null;
      const notes = body.notes != null ? String(body.notes).trim().slice(0, 5000) : null;
      const lastTouch = body.last_touch_at ? new Date(body.last_touch_at) : null;

      const r = await pool.query(
        `
          INSERT INTO communities_pipeline (
            user_id, platform, community_name, stage, opportunity_score, assigned_to, tags, notes, last_touch_at, created_at, updated_at
          )
          VALUES ($1,$2,$3,$4,COALESCE($5,0),$6,$7,$8,$9,NOW(),NOW())
          ON CONFLICT (user_id, platform, community_name)
          DO UPDATE SET
            stage = EXCLUDED.stage,
            assigned_to = COALESCE(EXCLUDED.assigned_to, communities_pipeline.assigned_to),
            tags = COALESCE(EXCLUDED.tags, communities_pipeline.tags),
            notes = COALESCE(EXCLUDED.notes, communities_pipeline.notes),
            last_touch_at = COALESCE(EXCLUDED.last_touch_at, communities_pipeline.last_touch_at),
            updated_at = NOW()
          RETURNING *
        `,
        [
          userId,
          platform,
          community,
          stage,
          body.opportunity_score != null ? Number(body.opportunity_score) : null,
          assignedTo || null,
          tags,
          notes,
          lastTouch && !Number.isNaN(lastTouch.getTime()) ? lastTouch : null,
        ]
      );
      return res.json({ ok: true, item: r.rows[0] });
    } catch (err) {
      console.error('growth community update failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.get('/influencers', async (req, res) => {
    try {
      await ensureGrowthSchema();
      const { isAdmin, userId } = resolveUserId(req);
      if (!userId && !isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (isAdmin && !userId) return res.status(400).json({ ok: false, error: 'user_id_required' });

      const status = req.query.status ? String(req.query.status).trim().toLowerCase() : '';
      const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

      const params = [Number(userId)];
      const where = ['user_id = $1'];
      if (status) {
        params.push(status);
        where.push(`contact_status = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(LOWER(handle) LIKE $${params.length} OR LOWER(COALESCE(notes,'')) LIKE $${params.length})`);
      }
      params.push(limit);

      const r = await pool.query(
        `
          SELECT *
          FROM influencer_pipeline
          WHERE ${where.join(' AND ')}
          ORDER BY updated_at DESC, id DESC
          LIMIT $${params.length}
        `,
        params
      );
      return res.json({ ok: true, user_id: Number(userId), items: r.rows || [] });
    } catch (err) {
      console.error('growth influencers failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.post('/influencer/update', async (req, res) => {
    try {
      await ensureGrowthSchema();
      if (req.intelAuth?.isAdmin) return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      const userId = Number(req.intelAuth?.user?.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const handle = normalizeTelegramUsername(body.handle) || (body.handle ? `@${String(body.handle).replace(/^@/, '').trim().toLowerCase()}` : null);
      if (!handle || !/^@[a-z0-9_]{5,32}$/.test(handle)) return res.status(400).json({ ok: false, error: 'invalid_handle' });
      const platform = String(body.platform || 'telegram').trim().toLowerCase() || 'telegram';

      const contact = body.contact_status != null ? String(body.contact_status).trim().toLowerCase() : null;
      const deal = body.deal_status != null ? String(body.deal_status).trim().toLowerCase() : null;
      const notes = body.notes != null ? String(body.notes).trim().slice(0, 5000) : null;
      const conversions = body.conversions != null ? Math.max(0, Number(body.conversions) || 0) : null;
      const payoutTotal = body.payout_total != null ? Math.max(0, Number(body.payout_total) || 0) : null;

      const r = await pool.query(
        `
          INSERT INTO influencer_pipeline (
            user_id, platform, handle, contact_status, deal_status, payout_total, conversions, notes, created_at, updated_at
          )
          VALUES ($1,$2,$3,COALESCE($4,'new'),COALESCE($5,'none'),COALESCE($6,0),COALESCE($7,0),$8,NOW(),NOW())
          ON CONFLICT (user_id, platform, handle)
          DO UPDATE SET
            contact_status = COALESCE(EXCLUDED.contact_status, influencer_pipeline.contact_status),
            deal_status = COALESCE(EXCLUDED.deal_status, influencer_pipeline.deal_status),
            payout_total = COALESCE(EXCLUDED.payout_total, influencer_pipeline.payout_total),
            conversions = COALESCE(EXCLUDED.conversions, influencer_pipeline.conversions),
            notes = COALESCE(EXCLUDED.notes, influencer_pipeline.notes),
            updated_at = NOW()
          RETURNING *
        `,
        [userId, platform, handle, contact, deal, payoutTotal, conversions, notes]
      );
      return res.json({ ok: true, item: r.rows[0] });
    } catch (err) {
      console.error('growth influencer update failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.get('/campaigns', async (req, res) => {
    try {
      await ensureGrowthSchema();
      const { isAdmin, userId } = resolveUserId(req);
      if (!userId && !isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (isAdmin && !userId) return res.status(400).json({ ok: false, error: 'user_id_required' });

      const r = await pool.query(
        `
          SELECT c.*, i.handle AS influencer_handle
          FROM partner_campaigns c
          LEFT JOIN influencer_pipeline i ON i.id = c.influencer_id
          WHERE c.user_id = $1
          ORDER BY c.updated_at DESC, c.id DESC
          LIMIT 200
        `,
        [Number(userId)]
      );
      return res.json({ ok: true, user_id: Number(userId), items: r.rows || [] });
    } catch (err) {
      console.error('growth campaigns failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  function randomCode() {
    return `camp_${Math.random().toString(16).slice(2, 8)}${Math.random().toString(16).slice(2, 6)}`;
  }

  router.post('/campaign/update', async (req, res) => {
    try {
      await ensureGrowthSchema();
      if (req.intelAuth?.isAdmin) return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      const userId = Number(req.intelAuth?.user?.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
      const code = String(body.code || '').trim() || randomCode();
      const influencerId = body.influencer_id != null ? Number(body.influencer_id) : null;
      const payoutTotal = body.payout_total != null ? Math.max(0, Number(body.payout_total) || 0) : null;

      const r = await pool.query(
        `
          INSERT INTO partner_campaigns (user_id, name, code, influencer_id, payout_total, created_at, updated_at)
          VALUES ($1,$2,$3,$4,COALESCE($5,0),NOW(),NOW())
          ON CONFLICT (user_id, code)
          DO UPDATE SET
            name = EXCLUDED.name,
            influencer_id = COALESCE(EXCLUDED.influencer_id, partner_campaigns.influencer_id),
            payout_total = COALESCE(EXCLUDED.payout_total, partner_campaigns.payout_total),
            updated_at = NOW()
          RETURNING *
        `,
        [userId, name.slice(0, 200), code.slice(0, 64), influencerId, payoutTotal]
      );
      return res.json({ ok: true, item: r.rows[0] });
    } catch (err) {
      console.error('growth campaign update failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.get('/outreach', async (req, res) => {
    try {
      await ensureGrowthSchema();
      const { isAdmin, userId } = resolveUserId(req);
      if (!userId && !isAdmin) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (isAdmin && !userId) return res.status(400).json({ ok: false, error: 'user_id_required' });
      const entityKey = req.query.entity_key ? String(req.query.entity_key).trim() : '';
      if (!entityKey) return res.status(400).json({ ok: false, error: 'entity_key_required' });
      const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

      const r = await pool.query(
        `
          SELECT *
          FROM outreach_events
          WHERE user_id = $1 AND entity_key = $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3
        `,
        [Number(userId), entityKey.slice(0, 120), limit]
      );
      return res.json({ ok: true, items: r.rows || [] });
    } catch (err) {
      console.error('growth outreach get failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  router.post('/outreach/log', async (req, res) => {
    try {
      await ensureGrowthSchema();
      if (req.intelAuth?.isAdmin) return res.status(400).json({ ok: false, error: 'use_user_api_key' });
      const userId = Number(req.intelAuth?.user?.id);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const entityType = String(body.entity_type || '').trim().toLowerCase();
      const entityKey = String(body.entity_key || '').trim();
      const channel = String(body.channel || '').trim().toLowerCase() || 'other';
      const status = String(body.status || '').trim().toLowerCase() || 'drafted';
      const notes = body.notes != null ? String(body.notes).trim().slice(0, 5000) : null;

      const allowedTypes = new Set(['community', 'influencer', 'campaign']);
      if (!allowedTypes.has(entityType)) return res.status(400).json({ ok: false, error: 'invalid_entity_type' });
      if (!entityKey) return res.status(400).json({ ok: false, error: 'entity_key_required' });

      const r = await pool.query(
        `
          INSERT INTO outreach_events (user_id, entity_type, entity_key, channel, status, notes, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          RETURNING *
        `,
        [userId, entityType, entityKey.slice(0, 120), channel.slice(0, 32), status.slice(0, 32), notes]
      );
      return res.json({ ok: true, item: r.rows[0] });
    } catch (err) {
      console.error('growth outreach log failed:', err?.message || String(err));
      return res.status(500).json({ ok: false, error: 'failed' });
    }
  });

  app.use('/growth', router);
  app.use('/api/growth', router);
}

module.exports = {
  registerGrowthRoutes,
  disabled,
};
