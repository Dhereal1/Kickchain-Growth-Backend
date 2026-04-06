function normalizeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Clamp to int range and avoid negatives.
  const i = Math.trunc(n);
  return i < 0 ? 0 : i;
}

function getKeywordList() {
  const raw = String(process.env.INTEL_KEYWORDS || '').trim();
  if (!raw) return ['game', 'play', '1v1', 'bet', 'earn'];
  return raw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeTelegramDatasetItem(item) {
  const text = String(item?.text || '');

  const channel =
    String(item?.channel || item?.channelName || item?.chat || item?.name || '')
      .trim()
      .slice(0, 200) || null;

  const views = normalizeNumber(item?.views ?? item?.viewCount) ?? 0;

  return {
    name: channel ? channel.toLowerCase() : null,
    platform: 'telegram',
    member_count: views,
    activity_score: views,
    raw: item,
    text,
    views,
    post_id:
      String(item?.id || item?.messageId || item?.message_id || item?.url || '').trim() ||
      null,
    posted_at:
      item?.date || item?.postedAt || item?.timestamp
        ? String(item.date || item.postedAt || item.timestamp)
        : null,
  };
}

function inferPlatform(item, hintedPlatform) {
  const hint = String(hintedPlatform || '').trim().toLowerCase();
  if (hint === 'telegram' || hint === 'discord') return hint;

  const platform = String(item?.platform || '').trim().toLowerCase();
  if (platform === 'telegram' || platform === 'discord') return platform;

  const url = String(item?.url || item?.inviteUrl || item?.link || '').toLowerCase();
  if (url.includes('t.me/')) return 'telegram';
  if (url.includes('discord.gg') || url.includes('discord.com')) return 'discord';

  return 'unknown';
}

function normalizeCommunity(item, hintedPlatform) {
  const hint = String(hintedPlatform || '').trim().toLowerCase();
  if (hint === 'telegram' || item?.channel || item?.channelName) {
    return normalizeTelegramDatasetItem(item);
  }

  const name =
    String(
      item?.name ||
        item?.title ||
        item?.groupName ||
        item?.serverName ||
        item?.communityName ||
        ''
    )
      .trim()
      .slice(0, 200) || null;

  const platform = inferPlatform(item, hintedPlatform);

  const memberCount =
    normalizeNumber(
      item?.member_count ??
        item?.memberCount ??
        item?.members ??
        item?.memberCountApprox ??
        item?.subscriberCount ??
        item?.subscribers
    ) ?? null;

  const activityScore =
    normalizeNumber(
      item?.activity_score ??
        item?.activityScore ??
        item?.messagesPerDay ??
        item?.postsPerDay ??
        item?.postFrequency ??
        item?.dailyMessages
    ) ?? null;

  const keywordMatches =
    normalizeNumber(
      item?.keyword_matches ??
        item?.keywordMatches ??
        item?.keywordsMatched ??
        (Array.isArray(item?.keywordMatches) ? item.keywordMatches.length : null) ??
        (Array.isArray(item?.keywords) ? item.keywords.length : null)
    ) ?? 0;

  return {
    name: name ? name.toLowerCase() : null,
    platform,
    member_count: memberCount,
    activity_score: activityScore,
    keyword_matches: keywordMatches,
    raw: item,
  };
}

async function fetchApifyDatasetItems({ datasetId, token, limit = 500, offset = 0 }) {
  if (!token) throw new Error('APIFY_API_TOKEN is required');
  if (!datasetId) throw new Error('datasetId is required');

  const params = new URLSearchParams();
  params.set('clean', 'true');
  params.set('format', 'json');
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('token', token);

  const url = `https://api.apify.com/v2/datasets/${encodeURIComponent(
    datasetId
  )}/items?${params.toString()}`;

  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const e = new Error(`Apify API error: ${r.status}`);
    e.details = txt.slice(0, 1000);
    throw e;
  }

  const json = await r.json();
  if (!Array.isArray(json)) return [];
  return json;
}

async function fetchApifyDatasetItemsWithRetry({ datasetId, token, limit, offset, retries = 3 }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetchApifyDatasetItems({ datasetId, token, limit, offset });
    } catch (err) {
      lastErr = err;
      const status = String(err?.message || '');
      const backoff = 250 * attempt;
      console.error(`Apify fetch failed (attempt ${attempt}/${retries}) for ${datasetId}:`, status);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr || new Error('Apify fetch failed');
}

async function getCommunitiesFromApify({ datasetId, platformHint }) {
  const token = String(process.env.APIFY_API_TOKEN || '').trim();
  const items = await fetchApifyDatasetItemsWithRetry({ datasetId, token, retries: 3 });

  const normalized = [];
  for (const item of items) {
    const c = normalizeCommunity(item, platformHint);
    if (!c.name || !c.platform || c.platform === 'unknown') continue;
    normalized.push(c);
  }

  return normalized;
}

module.exports = {
  getCommunitiesFromApify,
  fetchApifyDatasetItems,
  fetchApifyDatasetItemsWithRetry,
  normalizeCommunity,
};
