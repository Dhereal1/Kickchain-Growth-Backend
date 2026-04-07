const { getIntelConfig } = require('./intelConfig');

function countMatches(haystack, needles) {
  const text = String(haystack || '').toLowerCase();
  let count = 0;
  for (const needle of needles) {
    const n = String(needle || '').toLowerCase();
    if (!n) continue;
    if (text.includes(n)) count += 1;
  }
  return count;
}

function computeEngagementScore({ views, raw }) {
  const v = Number(views || raw?.views || raw?.viewCount || 0) || 0;
  // Simple, stable proxy: dampen huge channels.
  // e.g. 0..100 scale roughly by sqrt(views).
  const score = Math.floor(Math.sqrt(Math.max(0, v)));
  return Math.max(0, Math.min(100, score));
}

function extractSignals({ text, views, raw }) {
  const cfg = getIntelConfig();
  const keyword_matches = countMatches(text, cfg.keywords);

  const lowered = String(text || '').toLowerCase();
  const baseIntent = cfg.intentKeywords.filter((k) => lowered.includes(String(k))).length;
  const intent_score = baseIntent + (lowered.includes('?') ? 1 : 0);

  const engagement_score = computeEngagementScore({ views, raw });

  // frequency_score is per-post and becomes meaningful when aggregated.
  const frequency_score = 1;

  return {
    keyword_matches,
    intent_score,
    engagement_score,
    frequency_score,
  };
}

module.exports = {
  extractSignals,
};
