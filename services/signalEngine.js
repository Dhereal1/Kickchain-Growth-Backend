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

function normalizeList(values, fallback) {
  if (!Array.isArray(values) || !values.length) return fallback;
  return values.map((v) => String(v).toLowerCase()).filter(Boolean);
}

function extractSignals({ text, views, raw, config }) {
  const base = getIntelConfig();
  const cfg = config
    ? {
        keywords: normalizeList(config.keywords, base.keywords),
        intentKeywords: normalizeList(
          config.intentKeywords ?? config.intent_keywords,
          base.intentKeywords
        ),
        promoKeywords: normalizeList(config.promoKeywords ?? config.promo_keywords, base.promoKeywords),
        activityKeywords: normalizeList(
          config.activityKeywords ?? config.activity_keywords,
          base.activityKeywords
        ),
      }
    : base;

  const safeText = String(text || '');
  const lowered = safeText.toLowerCase();

  const keyword_matches = countMatches(safeText, cfg.keywords);
  const promo_score = cfg.promoKeywords.filter((k) => lowered.includes(String(k))).length;
  const content_activity_score = cfg.activityKeywords.filter((k) =>
    lowered.includes(String(k))
  ).length;
  const baseIntent = cfg.intentKeywords.filter((k) => lowered.includes(String(k))).length;
  const intent_score = baseIntent + (lowered.includes('?') ? 1 : 0);

  const signal_score =
    promo_score * 0.3 + content_activity_score * 0.5 + intent_score * 1.0;

  const engagement_score = computeEngagementScore({ views, raw });

  // frequency_score is per-post and becomes meaningful when aggregated.
  const frequency_score = 1;

  return {
    keyword_matches,
    intent_score,
    promo_score,
    content_activity_score,
    engagement_score,
    frequency_score,
    signal_score,
  };
}

module.exports = {
  extractSignals,
};
