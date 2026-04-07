if (!process.env.VERCEL) {
  require('dotenv').config({ quiet: true });
}
const express = require('express');
const pool = require('./db/pool');
const leaderboardService = require('./services/leaderboardService');
const { postWeeklyLeaderboard } = require('./jobs/weeklyLeaderboard');
const { processLeaderboardUpdate } = require('./events/leaderboardHype');
const { createKickchainBot } = require('./bot/kickchainBot');
const { sendToUsers } = require('./bot/notifyUsers');
const { registerIntelRoutes } = require('./routes/intelRoutes');
const { ingestDatasets, aggregateDaily, cleanupOldPosts } = require('./services/intelPipeline');
const { getIntelConfig } = require('./services/intelConfig');
const { dispatchIntelWebhooks } = require('./services/intelWebhooks');
const { createApifyActors } = require('./services/apifyActors');
const {
  discoverFromMessageExtraction,
  scrapeDiscoveredCommunities,
  computeAndStoreCommunityRankings,
  getDiscoveryConfigFromEnv,
  upsertDiscoveredCommunities,
} = require('./services/communityDiscovery');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function corsMiddleware(req, res, next) {
  const configured = (process.env.CORS_ORIGIN || '*').trim();
  const requestOrigin = req.headers.origin;

  let allowOrigin = configured;
  if (configured !== '*' && requestOrigin) {
    const allowed = configured
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (allowed.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
    } else {
      allowOrigin = allowed[0] || 'null';
    }
  }

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, Authorization'
  );
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
}

app.use(corsMiddleware);

registerIntelRoutes(app, { pool, ensureGrowthSchema });

function generateReferralCode(telegram_id) {
  return `KC${telegram_id}${Math.floor(Math.random() * 1000)}`;
}

let botSingleton = null;
function getBot() {
  if (botSingleton !== null) return botSingleton;
  const { bot } = createKickchainBot();
  botSingleton = bot || null;
  return botSingleton;
}

function isValidTelegramWebhook(req) {
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!secret) return true;

  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (header && String(header) === secret) return true;

  const qs = req.query?.secret;
  if (qs && String(qs) === secret) return true;

  return false;
}

function getPublicBaseUrl(req) {
  const envUrl = (process.env.PUBLIC_BASE_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/+$/, '');

  const proto =
    (req.headers['x-forwarded-proto'] && String(req.headers['x-forwarded-proto']).split(',')[0]) ||
    'https';
  const host =
    (req.headers['x-forwarded-host'] && String(req.headers['x-forwarded-host']).split(',')[0]) ||
    req.headers.host;

  if (!host) return '';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

async function telegramSetWebhook({ webhookUrl }) {
  const botToken = String(process.env.BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
  if (!botToken) return { ok: false, description: 'BOT_TOKEN missing' };

  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const body = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  };
  if (secret) body.secret_token = secret;

  const r = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  return json || { ok: false, description: 'Invalid Telegram response' };
}

function computeTierFromReferrals(totalReferrals) {
  const refs = Number(totalReferrals) || 0;
  if (refs >= 50) return 'Diamond';
  if (refs >= 25) return 'Platinum';
  if (refs >= 10) return 'Gold';
  if (refs >= 3) return 'Silver';
  return 'Bronze';
}

async function ensureGrowthSchema() {
  // Keep this idempotent and safe to run multiple times.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);

  async function runOnce(key, statements) {
    const r = await pool.query(
      `INSERT INTO schema_migrations (key) VALUES ($1)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key]
    );
    if (!r.rowCount) return;

    const list = Array.isArray(statements) ? statements : [statements];
    for (const sql of list) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(sql);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      total_won NUMERIC DEFAULT 0,
      games_played INT DEFAULT 0,
      tier TEXT DEFAULT 'Bronze',
      matches_played INT DEFAULT 0,
      wins INT DEFAULT 0,
      fun_mode_completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe migrations for existing DBs
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS total_won NUMERIC DEFAULT 0"
  );
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS games_played INT DEFAULT 0"
  );
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'Bronze'"
  );
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_played INT DEFAULT 0"
  );
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0"
  );
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS fun_mode_completed BOOLEAN DEFAULT FALSE"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT UNIQUE,
      title TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      challenger_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      opponent_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      winner_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
      stake_amount NUMERIC DEFAULT 0,
      is_fun_mode BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      start_date TIMESTAMP,
      status TEXT DEFAULT 'upcoming',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS tournaments_title_uq ON tournaments (title)'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS communities (
      id SERIAL PRIMARY KEY,
      user_id INT,
      name TEXT,
      platform TEXT,
      member_count INT,
      activity_score INT,
      keyword_matches INT DEFAULT 0,
      intent_score INT DEFAULT 0,
      promo_score INT DEFAULT 0,
      content_activity_score INT DEFAULT 0,
      engagement_score INT DEFAULT 0,
      signal_score NUMERIC DEFAULT 0,
      score NUMERIC DEFAULT 0,
      last_seen_at TIMESTAMP,
      raw JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS user_id INT");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS intent_score INT DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS promo_score INT DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS content_activity_score INT DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS engagement_score INT DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS signal_score NUMERIC DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS score NUMERIC DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP");
  // Legacy unique index (single-tenant). Keep it for existing rows with NULL user_id.
  await runOnce('2026-04-07_drop_communities_global_unique', [
    'DROP INDEX IF EXISTS communities_name_platform_uq',
    'DROP INDEX IF EXISTS communities_platform_name_uq',
  ]);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS communities_name_platform_uq ON communities (name, platform) WHERE user_id IS NULL'
  );
  // Multi-tenant unique index.
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS communities_user_name_platform_uq ON communities (user_id, name, platform) WHERE user_id IS NOT NULL'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id BIGSERIAL PRIMARY KEY,
      user_id INT,
      platform TEXT NOT NULL,
      community_name TEXT NOT NULL,
      post_id TEXT NOT NULL,
      content_hash TEXT,
      text TEXT,
      views INT,
      posted_at TIMESTAMP,
      dataset_id TEXT,
      intent_score INT DEFAULT 0,
      promo_score INT DEFAULT 0,
      content_activity_score INT DEFAULT 0,
      engagement_score INT DEFAULT 0,
      frequency_score INT DEFAULT 0,
      raw JSONB,
      ingested_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Allow multi-tenant dedupe (unique per user), keep legacy behavior via partial indexes.
  await runOnce('2026-04-07_migrate_community_posts_uniques', [
    'ALTER TABLE community_posts DROP CONSTRAINT IF EXISTS community_posts_platform_post_id_key',
    'DROP INDEX IF EXISTS community_posts_platform_post_uq',
    'DROP INDEX IF EXISTS community_posts_platform_hash_uq',
    'DROP INDEX IF EXISTS community_posts_user_platform_post_uq',
    'DROP INDEX IF EXISTS community_posts_user_platform_hash_uq',
  ]);
  await pool.query("ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS user_id INT");
  await pool.query("ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS content_hash TEXT");
  await pool.query("ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS promo_score INT DEFAULT 0");
  await pool.query("ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS content_activity_score INT DEFAULT 0");
  // Legacy uniques (single-tenant). Keep them for NULL user_id rows.
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_posts_platform_post_uq ON community_posts (platform, post_id) WHERE user_id IS NULL'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_posts_platform_hash_uq ON community_posts (platform, content_hash) WHERE user_id IS NULL'
  );
  // Multi-tenant uniques.
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_posts_user_platform_post_uq ON community_posts (user_id, platform, post_id) WHERE user_id IS NOT NULL'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_posts_user_platform_hash_uq ON community_posts (user_id, platform, content_hash) WHERE user_id IS NOT NULL'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS community_posts_lookup_idx ON community_posts (platform, community_name, posted_at)'
  );

  // Explicit constraint (requested): makes post uniqueness clear at the schema level.
  await runOnce('2026-04-07_add_unique_post_constraint', `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'unique_post'
      ) THEN
        ALTER TABLE community_posts
        ADD CONSTRAINT unique_post UNIQUE (user_id, platform, post_id);
      END IF;
    END$$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_metrics (
      id BIGSERIAL PRIMARY KEY,
      user_id INT,
      day DATE NOT NULL,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      total_messages INT NOT NULL,
      activity_score INT NOT NULL,
      intent_score INT NOT NULL,
      promo_score INT NOT NULL,
      content_activity_score INT NOT NULL,
      engagement_score INT NOT NULL,
      signal_score NUMERIC NOT NULL,
      score NUMERIC NOT NULL,
      trend_score INT DEFAULT 0,
      confidence_score FLOAT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Allow multi-tenant metrics (unique per user).
  await runOnce('2026-04-07_drop_community_metrics_global_unique', [
    'ALTER TABLE community_metrics DROP CONSTRAINT IF EXISTS community_metrics_day_platform_name_key',
  ]);
  await pool.query("ALTER TABLE community_metrics ADD COLUMN IF NOT EXISTS user_id INT");
  await pool.query("ALTER TABLE community_metrics ADD COLUMN IF NOT EXISTS trend_score INT DEFAULT 0");
  await pool.query("ALTER TABLE community_metrics ADD COLUMN IF NOT EXISTS confidence_score FLOAT DEFAULT 0");
  await pool.query("ALTER TABLE community_metrics ADD COLUMN IF NOT EXISTS promo_score INT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE community_metrics ADD COLUMN IF NOT EXISTS content_activity_score INT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE community_metrics ADD COLUMN IF NOT EXISTS signal_score NUMERIC NOT NULL DEFAULT 0");
  await pool.query(
    'CREATE INDEX IF NOT EXISTS community_metrics_rank_idx ON community_metrics (day, score DESC)'
  );
  // Multi-tenant unique index for metrics.
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_metrics_user_day_platform_name_uq ON community_metrics (user_id, day, platform, name) WHERE user_id IS NOT NULL'
  );
  // Legacy metrics unique (NULL user_id).
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_metrics_day_platform_name_uq ON community_metrics (day, platform, name) WHERE user_id IS NULL'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS intel_runs (
      id BIGSERIAL PRIMARY KEY,
      run_at TIMESTAMP NOT NULL DEFAULT NOW(),
      user_id INT,
      datasets JSONB,
      dataset_ids JSONB,
      platform TEXT,
      fetched_items INT DEFAULT 0,
      inserted_posts INT DEFAULT 0,
      deduped_posts INT DEFAULT 0,
      communities_updated INT DEFAULT 0,
      duration_ms INT DEFAULT 0,
      status TEXT DEFAULT 'running',
      error_message TEXT,
      error TEXT
    );
  `);
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS user_id INT");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS dataset_ids JSONB");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS error_message TEXT");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS deduped_posts INT DEFAULT 0");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS communities_updated INT DEFAULT 0");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS duration_ms INT DEFAULT 0");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running'");

  // Multi-tenant intel users/configs (separate from game users table).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intel_users (
      id SERIAL PRIMARY KEY,
      telegram_chat_id BIGINT,
      api_key TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS intel_user_configs (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES intel_users(id) ON DELETE CASCADE,
      datasets TEXT[],
      keywords TEXT[],
      intent_keywords TEXT[],
      promo_keywords TEXT[],
      activity_keywords TEXT[],
      platforms TEXT[],
      thresholds JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_configs (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      intent_keywords TEXT[],
      platforms TEXT[],
      thresholds JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS intel_webhooks (
      id SERIAL PRIMARY KEY,
      user_id INT,
      name TEXT,
      url TEXT NOT NULL,
      secret TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      last_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query("ALTER TABLE intel_webhooks ADD COLUMN IF NOT EXISTS user_id INT");
  // Drop global-unique constraint so multiple users can use the same URL.
  await runOnce('2026-04-07_drop_intel_webhooks_global_url_unique', [
    'ALTER TABLE intel_webhooks DROP CONSTRAINT IF EXISTS intel_webhooks_url_key',
  ]);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS intel_webhooks_user_url_uq ON intel_webhooks (user_id, url) WHERE user_id IS NOT NULL'
  );

  // Community discovery + ranking layer (optional)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_communities (
      id BIGSERIAL PRIMARY KEY,
      user_id INT,
      community_name TEXT NOT NULL,
      source TEXT NOT NULL,
      meta JSONB,
      discovered_at TIMESTAMP DEFAULT NOW(),
      last_scraped_at TIMESTAMP,
      last_dataset_id TEXT
    );
  `);
  await pool.query("ALTER TABLE discovered_communities ADD COLUMN IF NOT EXISTS user_id INT");
  await pool.query("ALTER TABLE discovered_communities ADD COLUMN IF NOT EXISTS meta JSONB");
  await pool.query("ALTER TABLE discovered_communities ADD COLUMN IF NOT EXISTS last_scraped_at TIMESTAMP");
  await pool.query("ALTER TABLE discovered_communities ADD COLUMN IF NOT EXISTS last_dataset_id TEXT");
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS discovered_communities_uq_legacy ON discovered_communities (community_name) WHERE user_id IS NULL'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS discovered_communities_user_uq ON discovered_communities (user_id, community_name) WHERE user_id IS NOT NULL'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_rankings (
      id BIGSERIAL PRIMARY KEY,
      user_id INT,
      day DATE NOT NULL,
      platform TEXT NOT NULL,
      community_name TEXT NOT NULL,
      total_messages INT NOT NULL DEFAULT 0,
      total_intent INT NOT NULL DEFAULT 0,
      avg_intent FLOAT NOT NULL DEFAULT 0,
      community_score NUMERIC NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'low',
      computed_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query("ALTER TABLE community_rankings ADD COLUMN IF NOT EXISTS user_id INT");
  await pool.query("ALTER TABLE community_rankings ADD COLUMN IF NOT EXISTS total_intent INT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE community_rankings ADD COLUMN IF NOT EXISTS avg_intent FLOAT NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE community_rankings ADD COLUMN IF NOT EXISTS community_score NUMERIC NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE community_rankings ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'low'");
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_rankings_user_day_platform_name_uq ON community_rankings (user_id, day, platform, community_name) WHERE user_id IS NOT NULL'
  );
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_rankings_day_platform_name_uq ON community_rankings (day, platform, community_name) WHERE user_id IS NULL'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS community_rankings_rank_idx ON community_rankings (day, community_score DESC)'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id BIGSERIAL PRIMARY KEY,
      webhook_id INT NOT NULL REFERENCES intel_webhooks(id) ON DELETE CASCADE,
      run_id BIGINT REFERENCES intel_runs(id) ON DELETE SET NULL,
      user_id INT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_status_code INT,
      last_error TEXT,
      payload JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query("ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS user_id INT");
  await pool.query(
    'CREATE INDEX IF NOT EXISTS webhook_deliveries_run_idx ON webhook_deliveries (run_id, created_at DESC)'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_referral_ranks (
      day DATE NOT NULL,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      rank INT NOT NULL,
      total_referrals INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (day, telegram_id)
    );
  `);
}

function registerWithApiAlias(method, path, handler) {
  app[method](path, handler);
  app[method](`/api${path}`, handler);
}

// Print a clear connectivity status on startup
(async () => {
  try {
    const r = await pool.query('SELECT 1 as ok');
    console.log('Database connected ✅', r.rows[0]);

    if (process.env.AUTO_INIT_DB === 'true') {
      await ensureGrowthSchema();
      console.log('Database schema ensured ✅');
    }
  } catch (err) {
    console.error('Database connection failed ❌');
    console.error({
      name: err?.name,
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
    });
  }
})();

// Test route
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      message: 'Database connected ✅',
      time: result.rows[0].now,
    });
  } catch (err) {
    console.error('DB query failed ❌', {
      name: err?.name,
      code: err?.code,
      message: err?.message,
      detail: err?.detail,
    });
    res.status(500).send('Database connection failed ❌');
  }
});

registerWithApiAlias('get', '/db-status', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1 as ok');
    res.json({ ok: true, db: r.rows[0]?.ok === 1 });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: {
        name: err?.name,
        code: err?.code,
        message: err?.message,
      },
    });
  }
});

registerWithApiAlias('get', '/health', async (req, res) => {
  res.json({
    ok: true,
    service: 'kickchain-backend',
    time: new Date().toISOString(),
  });
});

// Optional: discovery + ranking layer pipeline (manual trigger; keep separate from core pipeline).
registerWithApiAlias('post', '/intel/discovery/run', async (req, res) => {
  const auth = String(req.headers.authorization || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.split(' ')[1] : '';
  if (!token || token !== String(process.env.INTEL_API_KEY || '').trim()) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    await ensureGrowthSchema();

    const cfg = getDiscoveryConfigFromEnv();
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const userId = body.user_id ? Number(body.user_id) : null;
    const platform = String(body.platform || cfg.platform || 'telegram').toLowerCase();

    const apifyActors = createApifyActors();

    const messageExtraction = body.message_extraction !== false;

    // Default discovery search queries (keep simple; safe defaults).
    const defaultQueries = [
      'telegram crypto group',
      'telegram betting group',
      'web3 gaming telegram group',
      'telegram gambling chat',
      'telegram crypto signals group',
    ];

    const extraction = messageExtraction
      ? await discoverFromMessageExtraction({
          pool,
          ensureGrowthSchema,
          userId,
          windowHours: Number(body.window_hours || cfg.windowHours),
          maxPosts: Number(body.max_posts || cfg.maxPosts),
        })
      : { ok: true, skipped: true };

    const queries = Array.isArray(body.queries)
      ? body.queries.map(String).filter(Boolean)
      : Array.isArray(body.searchStringsArray)
        ? body.searchStringsArray.map(String).filter(Boolean)
        : defaultQueries;

    const searchEnabled = body.search !== false;
    const scrape =
      body.scrape_discovered === true ||
      body.scrapeDiscovered === true ||
      body.scrape === true ||
      (body.scrape === undefined && searchEnabled && queries.length);
    let search = { ok: true, skipped: true };
    if (searchEnabled && queries.length) {
      if (!String(process.env.APIFY_DISCOVERY_ACTOR_ID || '').trim()) {
        return res.status(400).json({
          ok: false,
          error: 'APIFY_DISCOVERY_ACTOR_ID is required for search discovery',
        });
      }

      const searchInputOverride = {
        ...(Number.isFinite(Number(body.maxResultsPerPage)) ? { maxResultsPerPage: Number(body.maxResultsPerPage) } : {}),
      };

      const run = await apifyActors.runSearch({ queries, input: searchInputOverride });
      const text = JSON.stringify(run.items || []);
      const found = (text.match(/(?:https?:\/\/)?t\.me\/[a-z0-9_]{5,32}/gi) || []).slice(0, 200);
      search = await upsertDiscoveredCommunities({
        pool,
        ensureGrowthSchema,
        userId,
        communities: found,
        source: 'search',
        meta: { actor: 'apify_search', datasetId: run.datasetId },
      });
      search.datasetId = run.datasetId;
      search.items = (run.items || []).length;
      search.queries = queries;
    }

    let scrapeResult = { ok: true, skipped: true };
    if (scrape) {
      if (!String(process.env.APIFY_TELEGRAM_SCRAPER_ACTOR_ID || '').trim()) {
        scrapeResult = {
          ok: false,
          skipped: true,
          error: 'APIFY_TELEGRAM_SCRAPER_ACTOR_ID is required to scrape discovered communities',
        };
      } else {
        scrapeResult = await scrapeDiscoveredCommunities({
          pool,
          ensureGrowthSchema,
          apifyActors,
          userId,
          maxScrapes: Number(body.max_scrapes || cfg.maxScrapes),
          cooldownHours: Number(body.cooldown_hours || cfg.cooldownHours),
          platform,
          configOverride: body.configOverride || null,
        });
      }
    }

    const rankings = await computeAndStoreCommunityRankings({
      pool,
      ensureGrowthSchema,
      userId,
      platform,
    });

    return res.json({ ok: true, extraction, search, scrape: scrapeResult, rankings });
  } catch (err) {
    console.error('intel discovery run failed:', err?.message || String(err));
    if (err?.details) {
      console.error('intel discovery apify details:', String(err.details).slice(0, 2000));
    }
    return res.status(500).json({
      ok: false,
      error: err?.message || 'discovery_failed',
      details: err?.details ? String(err.details).slice(0, 2000) : undefined,
    });
  }
});

// Telegram webhook (Vercel/serverless friendly)
registerWithApiAlias('get', '/telegram/webhook', async (req, res) => {
  res.json({ ok: true, bot: !!process.env.BOT_TOKEN });
});

registerWithApiAlias('post', '/telegram/webhook', async (req, res) => {
  try {
    if (!isValidTelegramWebhook(req)) return res.sendStatus(401);

    const bot = getBot();
    if (!bot) return res.status(503).json({ ok: false, error: 'Bot disabled' });

    await bot.handleUpdate(req.body);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook failed:', err?.message || String(err));
    return res.sendStatus(200);
  }
});

registerWithApiAlias('post', '/telegram/set-webhook', async (req, res) => {
  const adminKey = (process.env.ADMIN_API_KEY || '').trim();
  if (adminKey) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${adminKey}`) return res.sendStatus(401);
  }

  const baseUrl = getPublicBaseUrl(req);
  if (!baseUrl) return res.status(400).json({ ok: false, error: 'Missing base URL' });

  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const webhookUrl = secret
    ? `${baseUrl}/telegram/webhook?secret=${encodeURIComponent(secret)}`
    : `${baseUrl}/telegram/webhook`;

  try {
    const telegram = await telegramSetWebhook({ webhookUrl });
    return res.json({ ok: true, webhookUrl, telegram });
  } catch (err) {
    console.error('set-webhook failed:', err?.message || String(err));
    return res.status(500).json({ ok: false, error: 'Failed to set webhook' });
  }
});

registerWithApiAlias('get', '/cron/weekly-leaderboard', async (req, res) => {
  const cronHeader = String(req.headers['x-vercel-cron'] || '');
  const secret = (process.env.CRON_SECRET || '').trim();
  const qs = req.query?.secret ? String(req.query.secret) : '';
  const auth = String(req.headers.authorization || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.split(' ')[1] : '';

  const allowed =
    cronHeader === '1' ||
    (secret && qs && qs === secret) ||
    (secret && token && token === secret);
  if (!allowed) return res.sendStatus(401);

  try {
    await postWeeklyLeaderboard();
    return res.json({ ok: true });
  } catch (err) {
    console.error('weekly-leaderboard cron failed:', err?.message || String(err));
    return res.status(500).json({ ok: false });
  }
});

registerWithApiAlias('get', '/cron/daily-nudge', async (req, res) => {
  const cronHeader = String(req.headers['x-vercel-cron'] || '');
  const secret = (process.env.CRON_SECRET || '').trim();
  const qs = req.query?.secret ? String(req.query.secret) : '';
  const auth = String(req.headers.authorization || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.split(' ')[1] : '';

  const allowed =
    cronHeader === '1' ||
    (secret && qs && qs === secret) ||
    (secret && token && token === secret);
  if (!allowed) return res.sendStatus(401);

  const maxUsers = Number(process.env.DAILY_NUDGE_MAX_USERS || 50);
  const onlyTop = Number(process.env.DAILY_NUDGE_ONLY_TOP || 10);

  try {
    await ensureGrowthSchema();

    const newPlayersRes = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM users
       WHERE created_at >= (NOW() AT TIME ZONE 'UTC')::date`
    );
    const newPlayers = newPlayersRes.rows[0]?.c ?? 0;

    const todayRes = await pool.query(
      `SELECT (NOW() AT TIME ZONE 'UTC')::date AS day`
    );
    const today = todayRes.rows[0].day;

    const prevDayRes = await pool.query(
      `SELECT day
       FROM daily_referral_ranks
       WHERE day < $1
       ORDER BY day DESC
       LIMIT 1`,
      [today]
    );
    const prevDay = prevDayRes.rows[0]?.day || null;

    const currentRanksRes = await pool.query(
      `
        WITH ranked AS (
          SELECT
            u.telegram_id,
            COUNT(r.id)::int AS total_referrals,
            CAST(RANK() OVER (ORDER BY COUNT(r.id) DESC) AS int) AS rank
          FROM users u
          LEFT JOIN users r ON r.referred_by = u.referral_code
          GROUP BY u.telegram_id
        )
        SELECT *
        FROM ranked
        WHERE rank <= $1
        ORDER BY rank ASC
      `,
      [onlyTop]
    );

    // Persist today's snapshot for top ranks.
    for (const row of currentRanksRes.rows) {
      await pool.query(
        `
          INSERT INTO daily_referral_ranks (day, telegram_id, rank, total_referrals)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (day, telegram_id)
          DO UPDATE SET rank = EXCLUDED.rank, total_referrals = EXCLUDED.total_referrals
        `,
        [today, row.telegram_id, row.rank, row.total_referrals]
      );
    }

    let previousRanks = new Map();
    if (prevDay) {
      const prevRes = await pool.query(
        `SELECT telegram_id, rank
         FROM daily_referral_ranks
         WHERE day = $1`,
        [prevDay]
      );
      previousRanks = new Map(prevRes.rows.map((r) => [String(r.telegram_id), r.rank]));
    }

    const targets = [];
    for (const row of currentRanksRes.rows) {
      const prevRank = previousRanks.get(String(row.telegram_id));
      if (prevRank && row.rank > prevRank) {
        targets.push({
          telegram_id: row.telegram_id,
          prevRank,
          rank: row.rank,
        });
      }
    }

    const botUsername = String(process.env.BOT_USERNAME || '').trim();
    const playNow =
      botUsername
        ? `https://t.me/${botUsername}`
        : 'Open the bot and tap “Play Match”';

    const messagesSent = [];
    const targetIds = targets.slice(0, maxUsers).map((t) => t.telegram_id);
    for (const t of targets.slice(0, maxUsers)) {
      const text =
        `🔥 New players joined today: ${newPlayers}\n\n` +
        `You dropped to #${t.rank} on the leaderboard (was #${t.prevRank}).\n\n` +
        `⚔️ Play now to climb back up:\n${playNow}\n\n` +
        `What is this?`;
      messagesSent.push(text);
    }

    // Send individualized nudges (best-performing moment is after “win”; this is the daily fallback).
    // If we have no previous snapshot, don't spam; just store ranks for tomorrow.
    if (!prevDay || !targets.length) {
      return res.json({
        ok: true,
        newPlayers,
        prevDay,
        nudged: 0,
        note: 'No previous snapshot or no drops detected; snapshot updated.',
      });
    }

    // Send one-by-one to preserve personalization.
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < targetIds.length; i++) {
      const id = targetIds[i];
      const text = messagesSent[i];
      const r = await sendToUsers([id], text);
      sent += r.sent;
      failed += r.failed;
    }

    return res.json({
      ok: true,
      newPlayers,
      prevDay,
      nudged: sent,
      failed,
    });
  } catch (err) {
    console.error('daily-nudge cron failed:', err?.message || String(err));
    return res.status(500).json({ ok: false });
  }
});

registerWithApiAlias('get', '/cron/intel-sync', async (req, res) => {
  const cronHeader = String(req.headers['x-vercel-cron'] || '');
  const secret = (process.env.CRON_SECRET || '').trim();
  const qs = req.query?.secret ? String(req.query.secret) : '';
  const auth = String(req.headers.authorization || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.split(' ')[1] : '';
  const allowed =
    cronHeader === '1' ||
    (secret && qs && qs === secret) ||
    (secret && token && token === secret);
  if (!allowed) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      hint: 'Vercel Cron calls include x-vercel-cron: 1. For manual tests, pass ?secret=CRON_SECRET or Authorization: Bearer <CRON_SECRET>.',
    });
  }

  try {
    if (String(process.env.INTEL_SANDBOX || '').trim().toLowerCase() === 'true') {
      return res.json({ ok: true, sandbox: true });
    }

    await ensureGrowthSchema();
    const cfg = getIntelConfig();

    const usersRes = await pool.query(
      'SELECT id, telegram_chat_id FROM intel_users ORDER BY id ASC'
    );
    const intelUsers = usersRes.rows || [];

    // Legacy single-tenant fallback when no intel users exist yet.
    if (!intelUsers.length) {
      const datasets =
        (req.query.datasets ? String(req.query.datasets).split(',') : null) ||
        cfg.datasetsDefault;

      const platform =
        String(req.query.platform || '').trim().toLowerCase() ||
        cfg.platforms[0] ||
        'telegram';

      const cleanedDatasets = (datasets || [])
        .map((d) => String(d).trim())
        .filter(Boolean);

      if (!cleanedDatasets.length) {
        return res.status(400).json({ ok: false, error: 'Missing datasets (set APIFY_DATASET_IDS)' });
      }

      const ingest = await ingestDatasets({
        pool,
        ensureGrowthSchema,
        datasets: cleanedDatasets,
        platform,
        userId: null,
      });

      const aggregate = await aggregateDaily({ pool, ensureGrowthSchema, userId: null });
      const cleanup = await cleanupOldPosts({ pool, ensureGrowthSchema, userId: null });

      return res.json({ ok: true, legacy: true, ingest, aggregate, cleanup });
    }

    const results = [];
    for (const u of intelUsers) {
      const uc = await pool.query(
        'SELECT * FROM intel_user_configs WHERE user_id = $1 LIMIT 1',
        [u.id]
      );
      const c = uc.rows[0] || {};

      const datasets = Array.isArray(c.datasets) && c.datasets.length ? c.datasets : cfg.datasetsDefault;
      const platform = Array.isArray(c.platforms) && c.platforms.length ? String(c.platforms[0]).toLowerCase() : (cfg.platforms[0] || 'telegram');
      const configOverride = {
        keywords: c.keywords,
        intentKeywords: c.intent_keywords,
        promoKeywords: c.promo_keywords,
        activityKeywords: c.activity_keywords,
      };

      const cleanedDatasets = (datasets || []).map((d) => String(d).trim()).filter(Boolean);
      if (!cleanedDatasets.length) {
        results.push({ user_id: u.id, ok: false, error: 'missing_datasets' });
        // eslint-disable-next-line no-continue
        continue;
      }

      const ingest = await ingestDatasets({
        pool,
        ensureGrowthSchema,
        datasets: cleanedDatasets,
        platform,
        userId: u.id,
        configOverride: c,
      });
      const aggregate = await aggregateDaily({ pool, ensureGrowthSchema, userId: u.id });
      const cleanup = await cleanupOldPosts({ pool, ensureGrowthSchema, userId: u.id });
      results.push({ user_id: u.id, ok: true, ingest, aggregate, cleanup });
    }

    return res.json({ ok: true, users: results });
  } catch (err) {
    console.error('intel-sync cron failed:', err?.message || String(err));
    return res.status(500).json({ ok: false, error: 'Cron sync failed' });
  }
});

registerWithApiAlias('get', '/cron/intel-full-pipeline', async (req, res) => {
  const cronHeader = String(req.headers['x-vercel-cron'] || '');
  const secret = (process.env.CRON_SECRET || '').trim();
  const qs = req.query?.secret ? String(req.query.secret) : '';
  const auth = String(req.headers.authorization || '');
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.split(' ')[1] : '';
  const allowed =
    cronHeader === '1' ||
    (secret && qs && qs === secret) ||
    (secret && token && token === secret);
  if (!allowed) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      hint: 'Vercel Cron calls include x-vercel-cron: 1. For manual tests, pass ?secret=CRON_SECRET or Authorization: Bearer <CRON_SECRET>.',
    });
  }

  try {
    if (String(process.env.INTEL_SANDBOX || '').trim().toLowerCase() === 'true') {
      return res.json({ ok: true, sandbox: true });
    }

    await ensureGrowthSchema();
    const cfg = getIntelConfig();

    const usersRes = await pool.query(
      'SELECT id, telegram_chat_id FROM intel_users ORDER BY id ASC'
    );
    const intelUsers = usersRes.rows || [];

    const results = [];

    // Legacy single-tenant fallback when no intel users exist yet.
    if (!intelUsers.length) {
      const datasets = cfg.datasetsDefault;
      if (!datasets.length) {
        return res.status(400).json({ ok: false, error: 'Missing datasets (set APIFY_DATASET_IDS)' });
      }
      const platform = cfg.platforms[0] || 'telegram';

      const ingest = await ingestDatasets({ pool, ensureGrowthSchema, datasets, platform, userId: null });
      const aggregate = await aggregateDaily({ pool, ensureGrowthSchema, userId: null });
      const cleanup = await cleanupOldPosts({ pool, ensureGrowthSchema, userId: null });

      const oppRes = await pool.query(
        `
          WITH latest_day AS (SELECT MAX(day) AS day FROM community_metrics WHERE user_id IS NULL)
          SELECT *
          FROM community_metrics
          WHERE user_id IS NULL AND day = (SELECT day FROM latest_day)
          ORDER BY score DESC
          LIMIT 10
        `
      );
      const top = oppRes.rows || [];

      const payload = { timestamp: new Date().toISOString(), top_opportunities: top };
      const webhookResult = await dispatchIntelWebhooks({
        pool,
        ensureGrowthSchema,
        payload,
        runId: ingest?.runId || null,
        userId: null,
      });

      return res.json({ ok: true, legacy: true, ingest, aggregate, cleanup, webhooks: webhookResult });
    }

    for (const u of intelUsers) {
      const uc = await pool.query(
        'SELECT * FROM intel_user_configs WHERE user_id = $1 LIMIT 1',
        [u.id]
      );
      const c = uc.rows[0] || {};

      const datasets = Array.isArray(c.datasets) && c.datasets.length ? c.datasets : cfg.datasetsDefault;
      const platform = Array.isArray(c.platforms) && c.platforms.length ? String(c.platforms[0]).toLowerCase() : (cfg.platforms[0] || 'telegram');

      const cleanedDatasets = (datasets || []).map((d) => String(d).trim()).filter(Boolean);
      if (!cleanedDatasets.length) {
        results.push({ user_id: u.id, ok: false, error: 'missing_datasets' });
        // eslint-disable-next-line no-continue
        continue;
      }

      const ingest = await ingestDatasets({
        pool,
        ensureGrowthSchema,
        datasets: cleanedDatasets,
        platform,
        userId: u.id,
        configOverride: c,
      });
      const aggregate = await aggregateDaily({ pool, ensureGrowthSchema, userId: u.id });
      const cleanup = await cleanupOldPosts({ pool, ensureGrowthSchema, userId: u.id });

      const oppRes = await pool.query(
        `
          WITH latest_day AS (SELECT MAX(day) AS day FROM community_metrics WHERE user_id = $1)
          SELECT *
          FROM community_metrics
          WHERE user_id = $1 AND day = (SELECT day FROM latest_day)
          ORDER BY score DESC
          LIMIT 10
        `,
        [u.id]
      );
      const top = oppRes.rows || [];

      const payload = { timestamp: new Date().toISOString(), top_opportunities: top };
      const webhooks = await dispatchIntelWebhooks({
        pool,
        ensureGrowthSchema,
        payload,
        runId: ingest?.runId || null,
        userId: u.id,
      });

      // Alert user via Telegram if configured
      let alerted = false;
      if (u.telegram_chat_id) {
        try {
          const lines = [];
          lines.push('🔥 Daily Intel Report');
          lines.push('');
          if (!top.length) {
            lines.push('No communities ranked yet.');
          } else {
            lines.push('Top Opportunities:');
            for (const row of top.slice(0, 5)) {
              lines.push(
                `- ${row.name} (${row.platform}) — intent ${row.intent_score}, activity ${row.content_activity_score}, promo ${row.promo_score}`
              );
            }
          }
          lines.push('');
          lines.push('→ Suggested action: engage manually (no automation).');
          await sendToUsers([u.telegram_chat_id], lines.join('\n'));
          alerted = true;
        } catch (err) {
          console.error('intel user alert failed:', err?.message || String(err));
        }
      }

      results.push({ user_id: u.id, ok: true, ingest, aggregate, cleanup, webhooks, alerted });
    }

    return res.json({ ok: true, users: results });
  } catch (err) {
    console.error('intel-full-pipeline cron failed:', err?.message || String(err));
    return res.status(500).json({ ok: false, error: 'Cron pipeline failed' });
  }
});

registerWithApiAlias('get', '/init-db', async (req, res) => {
  try {
    await ensureGrowthSchema();
    res.send('Database schema ready ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to initialize database ❌');
  }
});

registerWithApiAlias('get', '/init-leaderboard', async (req, res) => {
  try {
    await ensureGrowthSchema();
    res.send('Leaderboard fields ready ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed ❌');
  }
});

registerWithApiAlias('get', '/init-groups', async (req, res) => {
  try {
    await ensureGrowthSchema();
    res.send('Groups table ready ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed ❌');
  }
});

registerWithApiAlias('post', '/group/save', async (req, res) => {
  const { chat_id, title } = req.body;

  try {
    await pool.query(
      `
        INSERT INTO groups (chat_id, title)
        VALUES ($1, $2)
        ON CONFLICT (chat_id) DO NOTHING
      `,
      [chat_id, title || null]
    );

    res.send('Group saved ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error ❌');
  }
});

registerWithApiAlias('get', '/groups', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT chat_id, title FROM groups ORDER BY created_at DESC'
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching groups ❌');
  }
});

registerWithApiAlias('post', '/group/delete', async (req, res) => {
  const { chat_id } = req.body;

  try {
    await pool.query('DELETE FROM groups WHERE chat_id = $1', [chat_id]);
    res.send('Group deleted ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting group ❌');
  }
});

registerWithApiAlias('post', '/user/create', async (req, res) => {
  const { telegram_id, username, referral_code_used } = req.body;

  try {
    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegram_id]
    );

    if (existingUser.rows.length > 0) {
      return res.json({
        message: 'User already exists',
        user: existingUser.rows[0],
      });
    }

    // Generate referral code
    const referral_code = generateReferralCode(telegram_id);

    let referrer = null;

    if (referral_code_used) {
      const refResult = await pool.query(
        'SELECT * FROM users WHERE referral_code = $1',
        [referral_code_used]
      );

      if (refResult.rows.length > 0) {
        referrer = refResult.rows[0];
      }
    }

    // Insert new user
    const result = await pool.query(
      `INSERT INTO users (telegram_id, username, referral_code, referred_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        telegram_id,
        username,
        referral_code,
        referrer ? referrer.referral_code : null,
      ]
    );

    if (referrer) {
      console.log(`Referral success: ${referrer.username} invited ${username}`);
    }

    const createdUser = result.rows[0];

    res.json({
      message: 'User created ✅',
      user: createdUser,
    });

    // Fire-and-forget: detect leaderboard changes after new user insertion.
    if (process.env.ENABLE_LEADERBOARD_HYPE !== 'false') {
      void (async () => {
        try {
          const [referrers, winners, players] = await Promise.all([
            leaderboardService.getTopReferrers(10),
            leaderboardService.getTopWinners(10),
            leaderboardService.getTopPlayers(10),
          ]);

          await processLeaderboardUpdate({
            referrers,
            winners,
            players,
          });
        } catch (err) {
          console.error('Leaderboard hype failed:', err?.message || String(err));
        }
      })();
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating user ❌');
  }
});

app.get('/referrals/:telegram_id', async (req, res) => {
  const { telegram_id } = req.params;

  try {
    // Get the user first
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegram_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found ❌' });
    }

    const user = userResult.rows[0];

    // Find all users they referred
    const referralsResult = await pool.query(
      'SELECT * FROM users WHERE referred_by = $1',
      [user.referral_code]
    );

    res.json({
      user: user.username,
      referral_code: user.referral_code,
      total_referrals: referralsResult.rows.length,
      referrals: referralsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching referrals ❌');
  }
});

registerWithApiAlias('get', '/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.username,
        u.referral_code,
        COUNT(r.id)::int AS total_referrals,
        CASE
          WHEN COUNT(r.id) >= 50 THEN 'Diamond'
          WHEN COUNT(r.id) >= 25 THEN 'Platinum'
          WHEN COUNT(r.id) >= 10 THEN 'Gold'
          WHEN COUNT(r.id) >= 3 THEN 'Silver'
          ELSE 'Bronze'
        END AS tier
      FROM users u
      LEFT JOIN users r
        ON r.referred_by = u.referral_code
      GROUP BY u.id
      ORDER BY total_referrals DESC
      LIMIT 10;
    `);

    res.json({
      leaderboard: result.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching leaderboard ❌');
  }
});

// Extended leaderboard (service-backed; does not break existing /leaderboard)
app.get('/leaderboard/extended', async (req, res) => {
  try {
    const [referrers, winners, players] = await Promise.all([
      leaderboardService.getTopReferrers(10),
      leaderboardService.getTopWinners(10),
      leaderboardService.getTopPlayers(10),
    ]);

    res.json({ referrers, winners, players });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

registerWithApiAlias('get', '/user/stats/:telegram_id', async (req, res) => {
  const { telegram_id } = req.params;

  try {
    // Get user
    const userResult = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegram_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found ❌' });
    }

    const user = userResult.rows[0];

    // Count referrals
    const countResult = await pool.query(
      'SELECT COUNT(*)::int AS total FROM users WHERE referred_by = $1',
      [user.referral_code]
    );

    const totalReferrals = countResult.rows[0].total;

    // Get rank (1 = most referrals)
    const rankResult = await pool.query(
      `
        SELECT rank
        FROM (
          SELECT
            u.referral_code,
            CAST(RANK() OVER (ORDER BY COUNT(r.id) DESC) AS int) AS rank
          FROM users u
          LEFT JOIN users r
            ON r.referred_by = u.referral_code
          GROUP BY u.referral_code
        ) ranked
        WHERE referral_code = $1;
      `,
      [user.referral_code]
    );

    const rank = rankResult.rows[0]?.rank || 0;

    const tier = computeTierFromReferrals(totalReferrals);
    // Keep tier stored but always derived from referrals for correctness.
    await pool.query(
      'UPDATE users SET tier = $1 WHERE telegram_id = $2 AND tier IS DISTINCT FROM $1',
      [tier, telegram_id]
    );

    res.json({
      username: user.username,
      referral_code: user.referral_code,
      total_referrals: totalReferrals,
      rank,
      tier,
      matches_played: user.matches_played ?? 0,
      wins: user.wins ?? 0,
      fun_mode_completed: !!user.fun_mode_completed,
      total_won: user.total_won ?? 0,
      games_played: user.games_played ?? 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching stats ❌');
  }
});

// Match endpoints
registerWithApiAlias('post', '/matches/challenge', async (req, res) => {
  const { challenger_id, stake_amount, is_fun_mode } = req.body || {};
  try {
    if (!challenger_id) return res.status(400).json({ message: 'challenger_id is required' });

    const userRes = await pool.query('SELECT telegram_id FROM users WHERE telegram_id = $1', [
      challenger_id,
    ]);
    if (userRes.rows.length === 0) return res.status(404).json({ message: 'Challenger not found' });

    const stake = Number(stake_amount || 0);
    if (!Number.isFinite(stake) || stake < 0) return res.status(400).json({ message: 'Invalid stake_amount' });

    const result = await pool.query(
      `INSERT INTO matches (challenger_id, stake_amount, is_fun_mode)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [challenger_id, stake, !!is_fun_mode]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating challenge ❌');
  }
});

registerWithApiAlias('get', '/matches/pending', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, u.username as challenger_name
      FROM matches m
      JOIN users u ON m.challenger_id = u.telegram_id
      WHERE m.status = 'pending'
      ORDER BY m.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching challenges ❌');
  }
});

registerWithApiAlias('post', '/matches/join', async (req, res) => {
  const { match_id, opponent_id } = req.body || {};
  try {
    if (!match_id || !opponent_id) return res.status(400).json({ message: 'match_id and opponent_id are required' });

    const oppRes = await pool.query('SELECT telegram_id FROM users WHERE telegram_id = $1', [
      opponent_id,
    ]);
    if (oppRes.rows.length === 0) return res.status(404).json({ message: 'Opponent not found' });

    const matchRes = await pool.query('SELECT * FROM matches WHERE id = $1', [match_id]);
    if (matchRes.rows.length === 0) return res.status(404).json({ message: 'Match not found' });
    const match = matchRes.rows[0];
    if (String(match.challenger_id) === String(opponent_id)) {
      return res.status(400).json({ message: 'You cannot join your own match' });
    }

    const result = await pool.query(
      `UPDATE matches
       SET opponent_id = $1, status = 'active'
       WHERE id = $2 AND status = 'pending' AND opponent_id IS NULL
       RETURNING *`,
      [opponent_id, match_id]
    );
    if (result.rows.length === 0) return res.status(400).send('Match not available ❌');
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error joining match ❌');
  }
});

registerWithApiAlias('post', '/matches/complete', async (req, res) => {
  const { match_id, winner_id } = req.body || {};
  try {
    if (!match_id || !winner_id) return res.status(400).json({ message: 'match_id and winner_id are required' });

    const matchRes = await pool.query('SELECT * FROM matches WHERE id = $1', [match_id]);
    if (matchRes.rows.length === 0) return res.status(404).send('Match not found');
    const match = matchRes.rows[0];

    if (match.status !== 'active') return res.status(400).json({ message: 'Match is not active' });
    if (!match.opponent_id) return res.status(400).json({ message: 'Match has no opponent yet' });

    const participants = [match.challenger_id, match.opponent_id].map((v) => String(v));
    if (!participants.includes(String(winner_id))) {
      return res.status(400).json({ message: 'winner_id must be a match participant' });
    }

    await pool.query(
      `UPDATE matches SET winner_id = $1, status = 'completed' WHERE id = $2`,
      [winner_id, match_id]
    );

    // Update user stats (safe even if older rows had NULLs)
    await pool.query(
      `UPDATE users
       SET matches_played = COALESCE(matches_played, 0) + 1
       WHERE telegram_id = ANY($1::bigint[])`,
      [[match.challenger_id, match.opponent_id]]
    );
    await pool.query(
      `UPDATE users
       SET wins = COALESCE(wins, 0) + 1
       WHERE telegram_id = $1`,
      [winner_id]
    );

    if (match.is_fun_mode) {
      await pool.query(
        `UPDATE users
         SET fun_mode_completed = TRUE
         WHERE telegram_id = ANY($1::bigint[])`,
        [[match.challenger_id, match.opponent_id]]
      );
    }

    // Keep tiers in sync with referral counts.
    for (const uid of [match.challenger_id, match.opponent_id]) {
      const stats = await pool.query(
        `SELECT COUNT(*)::int AS refs
         FROM users
         WHERE referred_by = (SELECT referral_code FROM users WHERE telegram_id = $1)`,
        [uid]
      );
      const tier = computeTierFromReferrals(stats.rows[0]?.refs || 0);
      await pool.query(
        'UPDATE users SET tier = $1 WHERE telegram_id = $2 AND tier IS DISTINCT FROM $1',
        [tier, uid]
      );
    }

    res.send('Match completed and stats updated ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error completing match ❌');
  }
});

// Tournament endpoints
registerWithApiAlias('get', '/tournaments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tournaments ORDER BY start_date ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching tournaments ❌');
  }
});

registerWithApiAlias('post', '/seed-tournaments', async (req, res) => {
  try {
    const allowed =
      process.env.ALLOW_SEED_TOURNAMENTS === 'true' ||
      process.env.NODE_ENV !== 'production';

    if (!allowed) {
      return res.status(403).json({ message: 'Seeding disabled' });
    }

    await pool.query(`
      INSERT INTO tournaments (title, description, start_date, status)
      VALUES
        ('Kickchain Genesis Cup', 'The first official 1v1 tournament with a 1000 USDC prize pool.', NOW() + INTERVAL '7 days', 'upcoming'),
        ('Weekend Warriors', 'Fast-paced 1v1 matches for casual players.', NOW() + INTERVAL '2 days', 'upcoming')
      ON CONFLICT (title) DO NOTHING
    `);
    res.send('Tournaments seeded ✅');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error seeding tournaments ❌');
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });

  async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => {
      console.log('HTTP server closed.');
    });
    try {
      await pool.end();
      console.log('DB pool closed.');
    } catch (err) {
      console.error('Failed to close DB pool:', err?.message || String(err));
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Local-only scheduler (Vercel serverless can't keep a process alive reliably).
  if (process.env.ENABLE_WEEKLY_LEADERBOARD === 'true' && !process.env.VERCEL) {
    // eslint-disable-next-line global-require
    const cron = require('node-cron');
    const schedule = process.env.WEEKLY_LEADERBOARD_CRON || '0 18 * * 0';
    cron.schedule(schedule, () => {
      console.log('Posting weekly leaderboard...');
      postWeeklyLeaderboard();
    });
  }
}

module.exports = app;
