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
    [
      'any game',
      'recommend',
      'what to play',
      'looking for',
      'who plays',
      'new game',
      'suggest',
      'need a game',
      'any bot',
      'play with',
    ];

  const promoKeywords =
    (json.promo_keywords && Array.isArray(json.promo_keywords) ? json.promo_keywords : null) ||
    (process.env.INTEL_PROMO_KEYWORDS ? parseCsv(process.env.INTEL_PROMO_KEYWORDS) : null) ||
    ['join', 'play', 'win', 'earn', 'invite', 'reward', 'contest', 'launch', 'airdrop'];

  const activityKeywords =
    (json.activity_keywords && Array.isArray(json.activity_keywords) ? json.activity_keywords : null) ||
    (process.env.INTEL_ACTIVITY_KEYWORDS ? parseCsv(process.env.INTEL_ACTIVITY_KEYWORDS) : null) ||
    ['game', 'play', 'mission', 'race', 'earn', 'token'];

  const platforms =
    (json.platforms && Array.isArray(json.platforms) ? json.platforms : null) ||
    (process.env.INTEL_PLATFORMS ? parseCsv(process.env.INTEL_PLATFORMS) : null) ||
    ['telegram'];

  const intentThreshold =
    Number(json.intent_threshold ?? process.env.INTEL_INTENT_THRESHOLD ?? 2) || 2;

  const trendingSpikeRatio =
    Number(json.trending_spike_ratio ?? process.env.INTEL_TRENDING_SPIKE_RATIO ?? 1.5) || 1.5;

  const maxMessagesPerCommunity =
    Number(
      json.max_messages_per_community ??
        process.env.INTEL_MAX_MESSAGES_PER_COMMUNITY ??
        process.env.TELETHON_MAX_MESSAGES_PER_GROUP ??
        50
    ) || 50;

  const maxCommunitiesPerRun =
    Number(json.max_communities_per_run ?? process.env.INTEL_MAX_COMMUNITIES_PER_RUN ?? 20) || 20;

  const pipelineTimeoutMs =
    Number(json.pipeline_timeout_ms ?? process.env.INTEL_PIPELINE_TIMEOUT_MS ?? 8000) || 8000;

  const postTtlDays =
    Number(json.post_ttl_days ?? process.env.INTEL_POST_TTL_DAYS ?? 30) || 30;

  const communitiesDefault =
    (json.communities && Array.isArray(json.communities) ? json.communities : null) ||
    // Backward compatibility: older config used `datasets` to mean sources; now it means communities/usernames.
    (json.datasets && Array.isArray(json.datasets) ? json.datasets : null) ||
    (process.env.INTEL_COMMUNITIES ? parseCsv(process.env.INTEL_COMMUNITIES) : null) ||
    (process.env.TELETHON_COMMUNITIES ? parseCsv(process.env.TELETHON_COMMUNITIES) : null) ||
    // Older envs (deprecated): treat as communities if they look like usernames.
    (process.env.APIFY_DATASET_IDS ? parseCsv(process.env.APIFY_DATASET_IDS) : null) ||
    (process.env.APIFY_DATASET_ID ? [String(process.env.APIFY_DATASET_ID).trim()].filter(Boolean) : []);

  return {
    keywords: keywords.map((k) => String(k).toLowerCase()),
    intentKeywords: intentKeywords.map((k) => String(k).toLowerCase()),
    promoKeywords: promoKeywords.map((k) => String(k).toLowerCase()),
    activityKeywords: activityKeywords.map((k) => String(k).toLowerCase()),
    platforms: platforms.map((p) => String(p).toLowerCase()),
    intentThreshold,
    trendingSpikeRatio,
    maxMessagesPerCommunity,
    maxCommunitiesPerRun,
    pipelineTimeoutMs,
    postTtlDays,
    communitiesDefault,
  };
}

module.exports = {
  getIntelConfig,
};
