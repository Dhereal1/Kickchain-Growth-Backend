const test = require('node:test');
const assert = require('node:assert/strict');

const { computeOpportunityScore } = require('../services/growth-crm/opportunityScore');

test('computeOpportunityScore clamps to 0..100 and is deterministic', () => {
  const ranking = { community_score: 80, total_messages: 120, total_intent: 30, avg_intent: 1.2 };
  const ai = { quality_score: 7, recommended_action: 'join', summary: 'ok' };
  const s1 = computeOpportunityScore({ ranking, ai, pipeline: { stage: 'discovered' } });
  const s2 = computeOpportunityScore({ ranking, ai, pipeline: { stage: 'discovered' } });
  assert.equal(s1, s2);
  assert.ok(s1 >= 0 && s1 <= 100);
});

test('computeOpportunityScore downgrades when AI quality is low', () => {
  const ranking = { community_score: 90, total_messages: 160, total_intent: 40, avg_intent: 1.4 };
  const good = computeOpportunityScore({ ranking, ai: { quality_score: 8, recommended_action: 'join' } });
  const bad = computeOpportunityScore({ ranking, ai: { quality_score: 2, recommended_action: 'join' } });
  assert.ok(bad < good);
});

