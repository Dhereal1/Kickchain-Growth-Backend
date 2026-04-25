const test = require('node:test');
const assert = require('node:assert/strict');

const { getCopilotActions, _internals } = require('../services/copilot/actions');

test('entityKeyForCommunity normalizes telegram community key', () => {
  assert.equal(_internals.entityKeyForCommunity('@Demo_Group'), 'telegram:@demo_group');
});

test('getCopilotActions filters by outreach cooldown', async () => {
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (s.includes('FROM communities_pipeline')) {
        return {
          rows: [
            { user_id: 1, platform: 'telegram', community_name: '@a', stage: 'discovered', total_messages: 50, total_intent: 20, avg_intent: 1.0, community_score: 60, ai_quality_score: 7, ai_recommended_action: 'join', ai_summary: 'ok' },
            { user_id: 1, platform: 'telegram', community_name: '@b', stage: 'discovered', total_messages: 10, total_intent: 1, avg_intent: 0.1, community_score: 5, ai_quality_score: 7, ai_recommended_action: 'monitor', ai_summary: 'meh' },
          ],
        };
      }
      if (s.includes('FROM outreach_events') && s.includes('ANY')) {
        return { rows: [{ entity_key: 'telegram:@a', last_outreach_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    },
  };
  const ensureGrowthSchema = async () => {};
  const out = await getCopilotActions({ pool, ensureGrowthSchema, userId: 1, limit: 10, cooldownHours: 24 });
  // @a should be filtered out due to outreach now
  assert.equal(out.some((x) => x.community_name === '@a'), false);
  assert.equal(out.some((x) => x.community_name === '@b'), true);
});

