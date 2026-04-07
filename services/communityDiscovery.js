const { getIntelConfig } = require('./intelConfig');
const { ingestDatasets, aggregateDaily } = require('./intelPipeline');

function normalizeTelegramUsername(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Accept:
  // - "@name"
  // - "name"
  // - "https://t.me/name"
  // - "t.me/name"
  const lower = raw.toLowerCase();

  const urlMatch = lower.match(/(?:https?:\/\/)?t\.me\/([a-z0-9_]{3,64})/i);
  const username = urlMatch ? urlMatch[1] : lower.replace(/^@/, '');
  if (!username) return null;

  // Filter common non-username paths.
  if (username === 'joinchat') return null;
  if (username === 'c') return null;
  if (username.startsWith('+')) return null;

  // Telegram public username rules: 5-32 chars, letters/numbers/underscore.
  if (!/^[a-z0-9_]{5,32}$/.test(username)) return null;

  return `@${username}`;
}

function extractTelegramUsernamesFromText(text) {
  const t = String(text || '');
  if (!t) return [];

  const out = new Set();
  const re = /(?:https?:\/\/)?t\.me\/([a-z0-9_]{3,64})/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const n = normalizeTelegramUsername(m[1]);
    if (n) out.add(n);
  }
  return Array.from(out);
}

async function upsertDiscoveredCommunities({
  pool,
  ensureGrowthSchema,
  userId = null,
  communities,
  source,
  meta = null,
}) {
  await ensureGrowthSchema();
  const added = [];

  const list = Array.isArray(communities) ? communities : [];
  for (const c of list) {
    const name = normalizeTelegramUsername(c);
    if (!name) continue;

    // eslint-disable-next-line no-await-in-loop
    const r = await pool.query(
      `
        INSERT INTO discovered_communities (user_id, community_name, source, meta)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id, community_name
      `,
      [userId, name, String(source || 'unknown'), meta ? JSON.stringify(meta) : null]
    );

    if (r.rowCount) added.push(r.rows[0]);
  }

  return { added_count: added.length, added };
}

async function discoverFromMessageExtraction({
  pool,
  ensureGrowthSchema,
  userId = null,
  windowHours = 72,
  maxPosts = 5000,
}) {
  await ensureGrowthSchema();

  const res = await pool.query(
    `
      SELECT text
      FROM community_posts
      WHERE platform = 'telegram'
        AND text IS NOT NULL
        AND COALESCE(posted_at, ingested_at) >= NOW() - ($1::int * INTERVAL '1 hour')
        AND ($2::int IS NULL OR user_id = $2)
      ORDER BY COALESCE(posted_at, ingested_at) DESC
      LIMIT $3
    `,
    [windowHours, userId, maxPosts]
  );

  const found = new Set();
  for (const row of res.rows || []) {
    const usernames = extractTelegramUsernamesFromText(row.text);
    for (const u of usernames) found.add(u);
  }

  const upsert = await upsertDiscoveredCommunities({
    pool,
    ensureGrowthSchema,
    userId,
    communities: Array.from(found),
    source: 'message_extraction',
  });

  return { scanned_posts: res.rowCount || 0, found_count: found.size, ...upsert };
}

function coerceBool(value, fallback = false) {
  if (value === true || value === false) return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return fallback;
  return s === 'true' || s === '1' || s === 'yes';
}

async function scrapeDiscoveredCommunities({
  pool,
  ensureGrowthSchema,
  apifyActors,
  userId = null,
  maxScrapes = 5,
  cooldownHours = 12,
  platform = 'telegram',
  configOverride = null,
}) {
  await ensureGrowthSchema();

  const candidates = await pool.query(
    `
      SELECT id, community_name, last_scraped_at
      FROM discovered_communities
      WHERE ($1::int IS NULL OR user_id = $1)
        AND (last_scraped_at IS NULL OR last_scraped_at < NOW() - ($2::int * INTERVAL '1 hour'))
      ORDER BY discovered_at DESC
      LIMIT $3
    `,
    [userId, cooldownHours, maxScrapes]
  );

  const datasetIds = [];
  const scraped = [];
  const skipped = [];

  for (const row of candidates.rows || []) {
    const name = String(row.community_name || '').trim();
    if (!name) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      const { datasetId } = await apifyActors.runTelegramScraper({ community: name });
      if (!datasetId) {
        skipped.push({ community: name, reason: 'no_dataset_id' });
        // eslint-disable-next-line no-continue
        continue;
      }

      datasetIds.push(datasetId);
      scraped.push({ community: name, datasetId });

      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `UPDATE discovered_communities
         SET last_scraped_at = NOW(), last_dataset_id = $1
         WHERE id = $2`,
        [String(datasetId), row.id]
      );
    } catch (err) {
      skipped.push({ community: name, reason: err?.message || String(err) });
    }
  }

  if (!datasetIds.length) {
    return { scraped_count: scraped.length, skipped_count: skipped.length, scraped, skipped, ingest: null, aggregate: null };
  }

  const ingest = await ingestDatasets({
    pool,
    ensureGrowthSchema,
    datasets: datasetIds,
    platform,
    userId,
    configOverride,
  });

  const aggregate = await aggregateDaily({ pool, ensureGrowthSchema, userId });

  return {
    scraped_count: scraped.length,
    skipped_count: skipped.length,
    scraped,
    skipped,
    ingest,
    aggregate,
  };
}

async function computeAndStoreCommunityRankings({
  pool,
  ensureGrowthSchema,
  userId = null,
  platform = 'telegram',
  day = null,
}) {
  await ensureGrowthSchema();

  const targetDayRes = await pool.query(
    `SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'UTC')::date) AS day`,
    [day ? String(day) : null]
  );
  const targetDay = targetDayRes.rows[0].day;

  const discovered = await pool.query(
    `
      SELECT community_name
      FROM discovered_communities
      WHERE ($1::int IS NULL OR user_id = $1)
    `,
    [userId]
  );
  const names = (discovered.rows || []).map((r) => r.community_name).filter(Boolean);
  if (!names.length) return { day: targetDay, upserted: 0 };

  const stats = await pool.query(
    `
      SELECT
        community_name,
        COUNT(*)::int as total_messages,
        AVG(intent_score)::float as avg_intent,
        SUM(intent_score)::int as total_intent
      FROM community_posts
      WHERE platform = $1
        AND community_name = ANY($2::text[])
        AND ($3::int IS NULL OR user_id = $3)
      GROUP BY community_name
    `,
    [platform, names, userId]
  );

  let upserted = 0;
  for (const row of stats.rows || []) {
    const totalMessages = Number(row.total_messages || 0);
    const totalIntent = Number(row.total_intent || 0);
    const avgIntent = Number(row.avg_intent || 0);

    const communityScore = totalMessages * 0.3 + totalIntent * 2 + avgIntent * 5;
    const category = communityScore >= 50 ? 'high_value' : communityScore >= 15 ? 'medium' : 'low';

    const isLegacy = userId === null || userId === undefined;
    const sql = isLegacy
      ? `
        INSERT INTO community_rankings (
          user_id, day, platform, community_name,
          total_messages, total_intent, avg_intent,
          community_score, category, computed_at
        )
        VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (day, platform, community_name) WHERE user_id IS NULL
        DO UPDATE SET
          total_messages = EXCLUDED.total_messages,
          total_intent = EXCLUDED.total_intent,
          avg_intent = EXCLUDED.avg_intent,
          community_score = EXCLUDED.community_score,
          category = EXCLUDED.category,
          computed_at = NOW()
      `
      : `
        INSERT INTO community_rankings (
          user_id, day, platform, community_name,
          total_messages, total_intent, avg_intent,
          community_score, category, computed_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT (user_id, day, platform, community_name) WHERE user_id IS NOT NULL
        DO UPDATE SET
          total_messages = EXCLUDED.total_messages,
          total_intent = EXCLUDED.total_intent,
          avg_intent = EXCLUDED.avg_intent,
          community_score = EXCLUDED.community_score,
          category = EXCLUDED.category,
          computed_at = NOW()
      `;

    const params = isLegacy
      ? [
          targetDay,
          platform,
          row.community_name,
          totalMessages,
          totalIntent,
          avgIntent,
          communityScore,
          category,
        ]
      : [
          userId,
          targetDay,
          platform,
          row.community_name,
          totalMessages,
          totalIntent,
          avgIntent,
          communityScore,
          category,
        ];

    // eslint-disable-next-line no-await-in-loop
    const r = await pool.query(sql, params);

    upserted += r.rowCount ? 1 : 0;
  }

  return { day: targetDay, upserted };
}

function getDiscoveryConfigFromEnv() {
  const cfg = getIntelConfig();
  const cooldownHours = Number(process.env.INTEL_DISCOVERY_SCRAPE_COOLDOWN_HOURS || 12) || 12;
  const maxScrapes = Number(process.env.INTEL_DISCOVERY_MAX_SCRAPES_PER_RUN || 5) || 5;
  const windowHours = Number(process.env.INTEL_DISCOVERY_MESSAGE_WINDOW_HOURS || 72) || 72;
  const maxPosts = Number(process.env.INTEL_DISCOVERY_MESSAGE_MAX_POSTS || 5000) || 5000;
  const enabled = coerceBool(process.env.INTEL_DISCOVERY_ENABLED, false);

  return {
    enabled,
    cooldownHours,
    maxScrapes,
    windowHours,
    maxPosts,
    platform: cfg.platforms[0] || 'telegram',
  };
}

module.exports = {
  normalizeTelegramUsername,
  extractTelegramUsernamesFromText,
  upsertDiscoveredCommunities,
  discoverFromMessageExtraction,
  scrapeDiscoveredCommunities,
  computeAndStoreCommunityRankings,
  getDiscoveryConfigFromEnv,
};
