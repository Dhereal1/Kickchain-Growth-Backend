function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

// Deterministic 0..100 score based on available intel signals.
function computeOpportunityScore({ ranking, ai, pipeline } = {}) {
  const communityScore = num(ranking?.community_score || ranking?.score);
  const totalMessages = num(ranking?.total_messages);
  const totalIntent = num(ranking?.total_intent);
  const avgIntent = num(ranking?.avg_intent);

  // Normalize into 0..1-ish signals
  const activity = clamp(totalMessages / 200, 0, 1); // 200 msgs ~ maxed
  const intent = clamp((totalIntent / 50) * 0.7 + (avgIntent / 3) * 0.3, 0, 1);
  const base = clamp(communityScore / 120, 0, 1);

  let score01 = base * 0.45 + activity * 0.25 + intent * 0.30;

  const recommended = String(ai?.recommended_action || '').toLowerCase();
  const quality = ai && typeof ai.quality_score === 'number' ? ai.quality_score : null;

  if (recommended === 'join') score01 += 0.08;
  if (recommended === 'monitor') score01 += 0.03;
  if (typeof quality === 'number' && quality < 5) score01 -= 0.06;

  // Slight boost if already engaged in pipeline to keep momentum.
  const stage = String(pipeline?.stage || '').toLowerCase();
  if (stage === 'engaging') score01 += 0.02;
  if (stage === 'warm') score01 += 0.03;
  if (stage === 'activated') score01 += 0.04;
  if (stage === 'partner') score01 += 0.05;

  return Math.round(clamp(score01, 0, 1) * 100);
}

module.exports = {
  computeOpportunityScore,
};

