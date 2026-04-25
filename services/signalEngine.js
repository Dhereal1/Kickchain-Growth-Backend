const { getIntelConfig } = require('./intelConfig');

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function includesKeyword({ rawLower, normalizedLower }, keyword) {
  const kRaw = String(keyword || '').toLowerCase().trim();
  if (!kRaw) return false;
  if (rawLower.includes(kRaw)) return true;

  const kNorm = normalizeForMatch(kRaw);
  if (!kNorm) return false;
  return normalizedLower.includes(kNorm);
}

function countMatches(haystack, needles) {
  const rawLower = String(haystack || '').toLowerCase();
  const normalizedLower = normalizeForMatch(haystack);
  let count = 0;
  for (const needle of needles) {
    if (includesKeyword({ rawLower, normalizedLower }, needle)) count += 1;
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
  const loweredNorm = normalizeForMatch(safeText);

  if (!safeText || safeText.length < 5) {
    return {
      keyword_matches: 0,
      intent_score: 0,
      promo_score: 0,
      content_activity_score: 0,
      engagement_score: 0,
      frequency_score: 0,
      signal_score: 0,
    };
  }

  const keyword_matches = countMatches(safeText, cfg.keywords);
  const promo_score = cfg.promoKeywords.filter((k) =>
    includesKeyword({ rawLower: lowered, normalizedLower: loweredNorm }, k)
  ).length;
  const content_activity_score = cfg.activityKeywords.filter((k) =>
    includesKeyword({ rawLower: lowered, normalizedLower: loweredNorm }, k)
  ).length;
  const baseIntent = cfg.intentKeywords.filter((k) =>
    includesKeyword({ rawLower: lowered, normalizedLower: loweredNorm }, k)
  ).length;

  // Strong "real conversation" intent rule (transactional / request language).
  const hasRealIntent =
    lowered.includes('mua') || // buy (VN)
    lowered.includes('bán') || // sell (VN)
    lowered.includes('buy') ||
    lowered.includes('sell') ||
    lowered.includes('looking for') ||
    lowered.includes('need') ||
    lowered.includes('anyone');

  const intent_score = hasRealIntent ? 5 : baseIntent + (lowered.includes('?') ? 1 : 0);

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
