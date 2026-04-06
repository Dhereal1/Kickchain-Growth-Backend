require('dotenv').config();
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
      name TEXT,
      platform TEXT,
      member_count INT,
      activity_score INT,
      keyword_matches INT DEFAULT 0,
      intent_score INT DEFAULT 0,
      engagement_score INT DEFAULT 0,
      score NUMERIC DEFAULT 0,
      last_seen_at TIMESTAMP,
      raw JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS intent_score INT DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS engagement_score INT DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS score NUMERIC DEFAULT 0");
  await pool.query("ALTER TABLE communities ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP");
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS communities_name_platform_uq ON communities (name, platform)'
  );
  await pool.query('DROP INDEX IF EXISTS communities_platform_name_uq');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      community_name TEXT NOT NULL,
      post_id TEXT NOT NULL,
      content_hash TEXT,
      text TEXT,
      views INT,
      posted_at TIMESTAMP,
      dataset_id TEXT,
      intent_score INT DEFAULT 0,
      engagement_score INT DEFAULT 0,
      frequency_score INT DEFAULT 0,
      raw JSONB,
      ingested_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(platform, post_id)
    );
  `);
  await pool.query("ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS content_hash TEXT");
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS community_posts_platform_hash_uq ON community_posts (platform, content_hash)'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS community_posts_lookup_idx ON community_posts (platform, community_name, posted_at)'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_metrics (
      id BIGSERIAL PRIMARY KEY,
      day DATE NOT NULL,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      total_messages INT NOT NULL,
      activity_score INT NOT NULL,
      intent_score INT NOT NULL,
      engagement_score INT NOT NULL,
      score NUMERIC NOT NULL,
      trend_score INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(day, platform, name)
    );
  `);
  await pool.query("ALTER TABLE community_metrics ADD COLUMN IF NOT EXISTS trend_score INT DEFAULT 0");
  await pool.query(
    'CREATE INDEX IF NOT EXISTS community_metrics_rank_idx ON community_metrics (day, score DESC)'
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS intel_runs (
      id BIGSERIAL PRIMARY KEY,
      run_at TIMESTAMP NOT NULL DEFAULT NOW(),
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
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS dataset_ids JSONB");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS error_message TEXT");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS deduped_posts INT DEFAULT 0");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS communities_updated INT DEFAULT 0");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS duration_ms INT DEFAULT 0");
  await pool.query("ALTER TABLE intel_runs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running'");

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
      name TEXT,
      url TEXT UNIQUE NOT NULL,
      secret TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      last_sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id BIGSERIAL PRIMARY KEY,
      webhook_id INT NOT NULL REFERENCES intel_webhooks(id) ON DELETE CASCADE,
      run_id BIGINT REFERENCES intel_runs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_status_code INT,
      last_error TEXT,
      payload JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
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

  const allowed = cronHeader === '1' || (secret && qs && qs === secret);
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

  const allowed = cronHeader === '1' || (secret && qs && qs === secret);
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
  const allowed = cronHeader === '1' || (secret && qs && qs === secret);
  if (!allowed) return res.sendStatus(401);

  try {
    if (String(process.env.INTEL_SANDBOX || '').trim().toLowerCase() === 'true') {
      return res.json({ ok: true, sandbox: true });
    }

    const cfg = getIntelConfig();
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
    });

    const aggregate = await aggregateDaily({ pool, ensureGrowthSchema });
    const cleanup = await cleanupOldPosts({ pool, ensureGrowthSchema });

    return res.json({ ok: true, ingest, aggregate, cleanup });
  } catch (err) {
    console.error('intel-sync cron failed:', err?.message || String(err));
    return res.status(500).json({ ok: false, error: 'Cron sync failed' });
  }
});

registerWithApiAlias('get', '/cron/intel-full-pipeline', async (req, res) => {
  const cronHeader = String(req.headers['x-vercel-cron'] || '');
  const secret = (process.env.CRON_SECRET || '').trim();
  const qs = req.query?.secret ? String(req.query.secret) : '';
  const allowed = cronHeader === '1' || (secret && qs && qs === secret);
  if (!allowed) return res.sendStatus(401);

  try {
    if (String(process.env.INTEL_SANDBOX || '').trim().toLowerCase() === 'true') {
      return res.json({ ok: true, sandbox: true });
    }

    const cfg = getIntelConfig();
    const datasets = cfg.datasetsDefault;
    if (!datasets.length) {
      return res.status(400).json({ ok: false, error: 'Missing datasets (set APIFY_DATASET_IDS)' });
    }

    const platform = cfg.platforms[0] || 'telegram';

    const ingest = await ingestDatasets({
      pool,
      ensureGrowthSchema,
      datasets,
      platform,
    });
    const aggregate = await aggregateDaily({ pool, ensureGrowthSchema });
    const cleanup = await cleanupOldPosts({ pool, ensureGrowthSchema });

    // Client webhook output (SaaS-ready)
    let webhookResult = null;
    try {
      const oppRes = await pool.query(
        `
          WITH latest_day AS (SELECT MAX(day) AS day FROM community_metrics)
          SELECT *
          FROM community_metrics
          WHERE day = (SELECT day FROM latest_day)
          ORDER BY score DESC
          LIMIT 10
        `
      );
      const top = oppRes.rows || [];
      const payload = {
        timestamp: new Date().toISOString(),
        top_opportunities: top,
      };
      webhookResult = await dispatchIntelWebhooks({
        pool,
        ensureGrowthSchema,
        payload,
        runId: ingest?.runId || null,
      });
    } catch (err) {
      console.error('intel webhook dispatch failed:', err?.message || String(err));
      webhookResult = { sent: 0, failed: 1 };
    }

    // Internal alert system (Telegram only; no user DMs)
    const alertChatId = String(process.env.INTEL_ALERT_TELEGRAM_CHAT_ID || '').trim();
    const botUsername = String(process.env.BOT_USERNAME || '').trim();
    if (alertChatId) {
      try {
        const opp = await pool.query(
          `
            WITH latest_day AS (SELECT MAX(day) AS day FROM community_metrics)
            SELECT *
            FROM community_metrics
            WHERE day = (SELECT day FROM latest_day)
            ORDER BY score DESC
            LIMIT 5
          `
        );

        const lines = [];
        lines.push('🔥 Daily Intel Report');
        lines.push('');

        const top = opp.rows || [];
        if (!top.length) {
          lines.push('No communities ranked yet.');
        } else {
          lines.push('Top Opportunities:');
          for (const c of top) {
            lines.push(
              `- ${c.name} (${c.platform}) — intent ${c.intent_score}, engagement ${c.engagement_score}, activity ${c.activity_score}`
            );
          }
        }

        lines.push('');
        lines.push('→ Suggested action: engage manually (no automation).');
        if (botUsername) {
          lines.push(`Intel API: https://t.me/${botUsername}`);
        }

        // Use internal notifier; this sends to a single admin chat only.
        await sendToUsers([alertChatId], lines.join('\n'));
      } catch (err) {
        console.error('intel alert failed:', err?.message || String(err));
      }
    }

    return res.json({
      ok: true,
      ingest,
      aggregate,
      cleanup,
      webhooks: webhookResult,
      alerted: !!alertChatId,
    });
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
