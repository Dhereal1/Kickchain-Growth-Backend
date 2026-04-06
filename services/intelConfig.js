function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function getIntelConfig() {
  const json = parseJson(process.env.INTEL_CONFIG_JSON, {});

  const keywords = (json.keywords && Array.isArray(json.keywords) ? json.keywords : null) ||
    (process.env.INTEL_KEYWORDS ? parseCsv(process.env.INTEL_KEYWORDS) : null) ||
    ['game', 'play', '1v1', 'bet', 'earn'];

  const intentKeywords =
    (json.intent_keywords && Array.isArray(json.intent_keywords) ? json.intent_keywords : null) ||
    (process.env.INTEL_INTENT_KEYWORDS ? parseCsv(process.env.INTEL_INTENT_KEYWORDS) : null) ||
    ['any game', 'recommend', 'looking for', 'what to play'];

  const platforms =
    (json.platforms && Array.isArray(json.platforms) ? json.platforms : null) ||
    (process.env.INTEL_PLATFORMS ? parseCsv(process.env.INTEL_PLATFORMS) : null) ||
    ['telegram'];

  const intentThreshold =
    Number(json.intent_threshold ?? process.env.INTEL_INTENT_THRESHOLD ?? 2) || 2;

  const trendingSpikeRatio =
    Number(json.trending_spike_ratio ?? process.env.INTEL_TRENDING_SPIKE_RATIO ?? 1.5) || 1.5;

  const maxItemsPerDataset =
    Number(json.max_items_per_dataset ?? process.env.APIFY_MAX_ITEMS_PER_DATASET ?? 1000) || 1000;

  const postTtlDays =
    Number(json.post_ttl_days ?? process.env.INTEL_POST_TTL_DAYS ?? 30) || 30;

  const datasetsDefault =
    (json.datasets && Array.isArray(json.datasets) ? json.datasets : null) ||
    (process.env.APIFY_DATASET_IDS ? parseCsv(process.env.APIFY_DATASET_IDS) : null) ||
    (process.env.APIFY_DATASET_ID ? [String(process.env.APIFY_DATASET_ID).trim()].filter(Boolean) : []);

  return {
    keywords: keywords.map((k) => String(k).toLowerCase()),
    intentKeywords: intentKeywords.map((k) => String(k).toLowerCase()),
    platforms: platforms.map((p) => String(p).toLowerCase()),
    intentThreshold,
    trendingSpikeRatio,
    maxItemsPerDataset,
    postTtlDays,
    datasetsDefault,
  };
}

module.exports = {
  getIntelConfig,
};

