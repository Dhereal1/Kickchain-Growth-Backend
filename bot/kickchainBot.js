const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

function normalizeBotToken(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function toMiniappUrl(miniappPublicUrl) {
  const base = normalizeUrl(miniappPublicUrl);
  if (!base) return '';
  const lower = base.toLowerCase();
  if (lower.endsWith('/miniapp/')) return base;
  if (lower.endsWith('/miniapp')) return `${base}/`;
  return `${base}/miniapp/`;
}

function readEnvValueFromFile(envPath, key) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, 'm');
    const m = text.match(re);
    if (!m) return '';
    return String(m[1] || '').trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

function normalizeGroupId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^-?\d+$/.test(v)) return v;
  if (v.startsWith('-')) return v;
  return `-${v}`;
}

function parseInternalGroupIds() {
  const raw = String(process.env.INTERNAL_GROUP_IDS || '').trim();
  if (!raw) return new Set();
  const parts = raw
    .split(',')
    .map((s) => normalizeGroupId(s))
    .map((s) => String(s).trim())
    .filter(Boolean);
  return new Set(parts);
}

function createKickchainBot(options) {
  const botToken = normalizeBotToken(options?.botToken || process.env.BOT_TOKEN);
  const port = Number(process.env.PORT || 3004) || 3004;
  const defaultBackendUrl = `http://127.0.0.1:${port}`;

  // IMPORTANT:
  // - In polling mode the bot usually runs co-located with the backend (same process/container),
  //   so the most reliable default is 127.0.0.1.
  // - If you run the bot separately, set BOT_BACKEND_URL to the backend's reachable URL.
  const botBackendOverride = normalizeUrl(options?.backendUrl || process.env.BOT_BACKEND_URL);
  const envBackendUrl = normalizeUrl(
    process.env.BACKEND_URL ||
      process.env.PUBLIC_BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  );
  const pollingEnv = String(process.env.ENABLE_TELEGRAM_POLLING || '').trim().toLowerCase();
  const pollingEnabled = pollingEnv ? (pollingEnv === 'true' || pollingEnv === '1' || pollingEnv === 'yes') : !process.env.VERCEL;
  const backendUrl = botBackendOverride || (pollingEnabled && !process.env.VERCEL ? defaultBackendUrl : (envBackendUrl || defaultBackendUrl));

  const httpTimeoutMs = Math.max(1000, Number(process.env.BOT_HTTP_TIMEOUT_MS || 60000) || 60000);
  axios.defaults.timeout = httpTimeoutMs;

  const envPath = path.join(process.cwd(), '.env');
  let cachedMiniapp = { mtimeMs: 0, url: '' };

  function getMiniappUrl() {
    // Prefer the .env file so local tunnel scripts that rewrite it take effect without restarting.
    try {
      const st = fs.statSync(envPath);
      if (st.mtimeMs !== cachedMiniapp.mtimeMs) {
        cachedMiniapp.mtimeMs = st.mtimeMs;
        const v = readEnvValueFromFile(envPath, 'MINIAPP_PUBLIC_URL');
        cachedMiniapp.url = toMiniappUrl(v);
      }
      if (cachedMiniapp.url) return cachedMiniapp.url;
    } catch {
      // ignore
    }

    return toMiniappUrl(process.env.MINIAPP_PUBLIC_URL || '');
  }

  console.log('Kickchain bot config', {
    polling_enabled: pollingEnabled,
    backend_url: backendUrl,
    timeout_ms: httpTimeoutMs,
    backend_override: !!botBackendOverride,
    miniapp_public_url: normalizeUrl(process.env.MINIAPP_PUBLIC_URL || '') || null,
  });

  const rawGroupId = String(options?.groupId || process.env.GROUP_ID || '').trim();
  const debugChatId =
    String(options?.debugChatId ?? process.env.DEBUG_CHAT_ID ?? '')
      .trim()
      .toLowerCase() === 'true';
  const enableGroupFallback =
    String(options?.enableGroupFallback ?? process.env.ENABLE_GROUP_FALLBACK ?? '')
      .trim()
      .toLowerCase() === 'true';

  if (!botToken) {
    return { bot: null, error: 'Missing BOT_TOKEN' };
  }

  const intelAdminKey = String(process.env.INTEL_API_KEY || '').trim();
  const internalGroupIds = parseInternalGroupIds();
  const allowAnyGroupWorkspace =
    String(process.env.ALLOW_ANY_GROUP_WORKSPACE || '').trim().toLowerCase() === 'true';

  function isInternalGroup(chatId) {
    const id = normalizeGroupId(chatId);
    return internalGroupIds.has(String(id));
  }

  let cachedBotId = null;
  async function getBotId(ctx) {
    if (cachedBotId) return cachedBotId;
    const info = ctx?.botInfo || null;
    if (info?.id) {
      cachedBotId = Number(info.id);
      return cachedBotId;
    }
    const me = await ctx.telegram.getMe();
    cachedBotId = Number(me?.id);
    return cachedBotId;
  }

  function isAdminStatus(status) {
    return status === 'creator' || status === 'administrator';
  }

  async function getMemberStatus(ctx, userId) {
    try {
      const m = await ctx.telegram.getChatMember(ctx.chat.id, userId);
      return String(m?.status || '').toLowerCase();
    } catch {
      return '';
    }
  }

  async function isBotAdminInChat(ctx) {
    const botId = await getBotId(ctx);
    const status = await getMemberStatus(ctx, botId);
    return isAdminStatus(status);
  }

  async function isSenderAdminInChat(ctx) {
    const fromId = Number(ctx.from?.id);
    if (!fromId) return false;
    const status = await getMemberStatus(ctx, fromId);
    return isAdminStatus(status);
  }

  function isWorkspaceAllowedByEnv(chatId) {
    if (internalGroupIds.size) return isInternalGroup(chatId);
    return allowAnyGroupWorkspace;
  }

  const groupId = normalizeGroupId(rawGroupId);
  let runtimeGroupId = '';

  const savedGroupIds = new Set();
  const invalidGroupIds = new Set();

  const getGroupIdCandidates = () =>
    [...new Set([groupId, runtimeGroupId].filter(Boolean))];

  const sendToGroupEnv = async (ctx, text) => {
    const groupIdCandidates = getGroupIdCandidates();
    if (!groupIdCandidates.length) return false;

    for (const candidate of groupIdCandidates) {
      if (invalidGroupIds.has(String(candidate))) continue;
      try {
        await ctx.telegram.sendMessage(Number(candidate), text);
        return true;
      } catch (err) {
        const status = err?.response?.status;
        const errorCode = err?.response?.error_code;
        if (status === 400 || status === 403 || errorCode === 400 || errorCode === 403) {
          invalidGroupIds.add(String(candidate));
        }
        console.error(
          `Failed to send group message to ${candidate}:`,
          err?.message || 'Unknown error'
        );
      }
    }
    return false;
  };

  const deleteGroupFromDB = async (chatId) => {
    try {
      await axios.post(`${backendUrl}/group/delete`, { chat_id: chatId });
    } catch {
      // Silent
    }
  };

  const sendToAllGroups = async (ctx, text) => {
    try {
      const response = await axios.get(`${backendUrl}/groups`);
      const groups = response.data || [];

      let sentAny = false;
      for (const group of groups) {
        const chatId = group.chat_id;
        if (!chatId) continue;
        if (invalidGroupIds.has(String(chatId))) continue;

        try {
          await ctx.telegram.sendMessage(Number(chatId), text);
          sentAny = true;
        } catch (err) {
          const status = err?.response?.status;
          const errorCode = err?.response?.error_code;
          if (status === 400 || status === 403 || errorCode === 400 || errorCode === 403) {
            invalidGroupIds.add(String(chatId));
            await deleteGroupFromDB(chatId);
          }
          console.error(
            `Failed to send group message to DB chat_id=${chatId}:`,
            err?.message || 'Unknown error'
          );
        }
      }

      if (sentAny) return true;
      if (groups.length) return false;
    } catch (err) {
      console.error('Failed to fetch groups from backend:', err?.message || 'Unknown error');
    }

    if (enableGroupFallback) {
      return sendToGroupEnv(ctx, text);
    }
    return false;
  };

  const bot = new Telegraf(botToken);
  bot.catch((err, ctx) => {
    console.error('Bot error:', err?.message || String(err), {
      chat_id: ctx?.chat?.id,
      chat_type: ctx?.chat?.type,
      from_id: ctx?.from?.id,
      update_type: ctx?.updateType,
    });
  });

  const logAllUpdates =
    String(process.env.BOT_LOG_ALL_UPDATES || '').trim().toLowerCase() === 'true';
  if (logAllUpdates) {
    bot.use((ctx, next) => {
      try {
        const chat = ctx?.chat;
        const from = ctx?.from;
        const text = ctx?.message?.text;
        const isCommand = typeof text === 'string' && text.trim().startsWith('/');
        console.info('Telegram update', {
          update_type: ctx?.updateType,
          chat_id: chat?.id,
          chat_type: chat?.type,
          from_id: from?.id,
          from_username: from?.username,
          has_text: typeof text === 'string' && text.length > 0,
          is_command: isCommand,
        });
      } catch {
        // ignore
      }
      return next();
    });
  }

  bot.on('text', (ctx, next) => {
    const text = String(ctx.message?.text || '');
    if (text.startsWith('/run') || text.startsWith('/top') || text.startsWith('/leaderboard') || text.startsWith('/join')) {
      console.info('Command received', {
        text: text.slice(0, 60),
        chat_id: ctx.chat?.id,
        chat_type: ctx.chat?.type,
        from_id: ctx.from?.id,
        from_username: ctx.from?.username,
      });
    }
    return next();
  });
  const PLAY_MATCH_CB = 'kc_play_match';
  const STAKE_10_CB = 'kc_stake_10';
  const STAKE_25_CB = 'kc_stake_25';
  const REFERRAL_PUSH_CB = 'kc_referral_push';
  let cachedBotUsername = '';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const autoRegisterPrivate =
    String(process.env.BOT_AUTO_REGISTER_PRIVATE || 'true').trim().toLowerCase() !== 'false';

  const autoWorkspaceIntelEnabled =
    String(process.env.BOT_AUTO_WORKSPACE_INTEL || 'true').trim().toLowerCase() !== 'false';
  const autoWorkspaceIntelCooldownMs = Math.max(
    10_000,
    Number(process.env.BOT_AUTO_WORKSPACE_INTEL_COOLDOWN_MS || 5 * 60 * 1000) || 5 * 60 * 1000
  );
  const autoWorkspaceIntelSearch =
    String(process.env.BOT_AUTO_WORKSPACE_INTEL_SEARCH || '').trim().toLowerCase() === 'true';
  const autoWorkspaceIntelMessageExtraction =
    String(process.env.BOT_AUTO_WORKSPACE_INTEL_MESSAGE_EXTRACTION || 'true')
      .trim()
      .toLowerCase() !== 'false';

  const lastAutoEnqueueAttemptAtByChat = new Map();
  const pendingOnboardingNudgeByUser = new Map();

  async function ensureUserRegistered({ ctx, referralCode = null }) {
    try {
      const telegram_id = ctx.from?.id;
      const username = ctx.from?.username || 'no_username';
      if (!telegram_id) return { ok: false, reason: 'missing_telegram_id' };

      const response = await axios.post(`${backendUrl}/user/create`, {
        telegram_id,
        username,
        referral_code_used: referralCode,
      });

      const isNewUser = response.data?.message === 'User created ✅';
      return { ok: true, isNewUser, user: response.data?.user || null };
    } catch (err) {
      console.error('auto registration failed:', err?.response?.data || err?.message || String(err));
      return { ok: false, reason: 'registration_failed' };
    }
  }

  const getBotUsername = async (ctx) => {
    if (cachedBotUsername) return cachedBotUsername;
    const fromCtx = ctx.botInfo?.username;
    if (fromCtx) {
      cachedBotUsername = fromCtx;
      return cachedBotUsername;
    }
    try {
      const me = await ctx.telegram.getMe();
      cachedBotUsername = me?.username || '';
      return cachedBotUsername;
    } catch {
      return '';
    }
  };

  bot.start(async (ctx) => {
    try {
      if (ctx.chat?.type !== 'private') {
        return ctx.reply('👉 Please message me in private to start.');
      }

      const telegram_id = ctx.from?.id;
      const username = ctx.from?.username || ctx.from?.first_name || 'no_username';
      if (!telegram_id) {
        return ctx.reply('Could not read your Telegram user id. Please retry.');
      }

      const message = ctx.message?.text || '';
      const parts = message.split(' ');
      const referral_code = parts.length > 1 ? parts[1] : null;

      const reg = await ensureUserRegistered({ ctx, referralCode: referral_code });
      if (reg.ok && reg.isNewUser) {
        await sendToAllGroups(
          ctx,
          `🚀 ${username} just joined Kickchain!\n\nCan you beat them?`
        );
      }

      if (referral_code) {
        await sendToAllGroups(
          ctx,
          `🔥 New referral click!\n${username} entered via a referral link 🚀`
        );
      }

      const stats = await axios.get(`${backendUrl}/user/stats/${telegram_id}`);
      const data = stats.data || {};
      const botUsername = await getBotUsername(ctx);
      const referralLink =
        botUsername && data.referral_code
          ? `https://t.me/${botUsername}?start=${encodeURIComponent(String(data.referral_code))}`
          : '';

      const buttons = [
        [{ text: '🎮 Play Free (60s)', callback_data: PLAY_MATCH_CB }],
      ];
      const miniappUrl = getMiniappUrl();
      if (miniappUrl) {
        buttons.push([{ text: '🏆 Open Mini App', web_app: { url: miniappUrl } }]);
      }

      await ctx.reply(
        `🚀 Welcome to Kickchain\n\n` +
          `⚔️ Play 1v1 matches and win rewards\n\n` +
          `👉 Tap below to get your *first win* (free)\n\n` +
          `🔥 Your referral link:\n${referralLink || '(referral link unavailable)'}\n\n` +
          `🏆 Invite friends → climb leaderboard → earn more`,
        {
          reply_markup: {
            inline_keyboard: buttons,
          },
        }
      );

      // Onboarding nudge: if they don't play within 60s, remind them.
      // Best-effort (in-memory). Safe-guard against duplicate timers per user.
      if (!pendingOnboardingNudgeByUser.has(String(telegram_id))) {
        const t = setTimeout(async () => {
          pendingOnboardingNudgeByUser.delete(String(telegram_id));
          try {
            const latest = await axios.get(`${backendUrl}/user/stats/${telegram_id}`);
            const s = latest.data || {};
            if ((Number(s.matches_played) || 0) > 0) return;
            await ctx.telegram.sendMessage(
              ctx.chat.id,
              `⏳ Quick one: want a free win to get started?\nTap: “Play Free (60s)”`
            );
          } catch {
            // ignore
          }
        }, 60_000);
        pendingOnboardingNudgeByUser.set(String(telegram_id), t);
      }
    } catch (err) {
      console.error('Bot request failed:', err?.message || 'Unknown error');
      ctx.reply('Something went wrong ❌');
    }
  });

  bot.action(PLAY_MATCH_CB, async (ctx) => {
    try {
      await ctx.answerCbQuery('Starting free match…');

      const telegram_id = ctx.from?.id;
      const username = ctx.from?.username || ctx.from?.first_name || 'no_username';
      if (!telegram_id) return;

      // Guided "first match" flow: fast first win, then prompt for stake.
      await ctx.reply('🎮 Free Match started…');
      await sleep(900);
      await ctx.reply('⚔️ Match found. Playing…');
      await sleep(1400);
      const practice = await axios.post(`${backendUrl}/matches/practice`, {
        telegram_id,
        username,
      });
      const data = practice.data?.stats || {};

      let oneAwayLine = '';
      try {
        const lb = await axios.get(`${backendUrl}/leaderboard/extended`);
        const winners = Array.isArray(lb.data?.winners) ? lb.data.winners : [];
        if (winners.length >= 10) {
          const tenth = winners[winners.length - 1] || null;
          const threshold = Number(tenth?.wins);
          const myWins = Number(data?.wins || 0);
          if (Number.isFinite(threshold) && threshold > 0 && myWins === threshold - 1) {
            oneAwayLine = `\n\n⚡ You’re 1 win away from the Top 10 leaderboard.`;
          }
        }
      } catch {
        // ignore
      }

      const botUsername = await getBotUsername(ctx);
      const referralLink = botUsername
        ? `https://t.me/${botUsername}?start=${data.referral_code}`
        : '';

      await ctx.reply(
        `🔥 First win recorded ✅\n\n` +
          `Next: try a *staked* match (real challenge), or invite a friend.` +
          `${oneAwayLine}\n\n` +
          `Referral link:\n${referralLink || '(referral link unavailable)'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💰 Stake $10', callback_data: STAKE_10_CB }],
              [{ text: '💰 Stake $25', callback_data: STAKE_25_CB }],
              [{ text: '📣 Share Referral', callback_data: REFERRAL_PUSH_CB }],
              [{ text: '🎮 Play Free Again', callback_data: PLAY_MATCH_CB }],
            ],
          },
        }
      );
    } catch (err) {
      console.error('play_match action failed:', err?.message || 'Unknown error');
      try {
        await ctx.answerCbQuery('Failed to create match');
      } catch {
        // ignore
      }
    }
  });

  async function createStakeChallenge(ctx, amount) {
    const telegram_id = ctx.from?.id;
    if (!telegram_id) return null;
    const stake = Number(amount) || 0;
    const res = await axios.post(`${backendUrl}/matches/challenge`, {
      challenger_id: telegram_id,
      stake_amount: stake,
      is_fun_mode: false,
    });
    return res.data || null;
  }

  bot.action(STAKE_10_CB, async (ctx) => {
    try {
      await ctx.answerCbQuery('Creating $10 challenge…');
      const match = await createStakeChallenge(ctx, 10);
      if (!match?.id) return ctx.reply('Failed to create challenge ❌');
      const name = ctx.from?.username || ctx.from?.first_name || 'challenger';
      const text =
        `🔥 NEW CHALLENGE!\n\n` +
        `👤 Challenger: ${name}\n` +
        `💰 Stake: 10 USDC\n\n` +
        `Accept with: /join ${match.id}\n` +
        `Winner reports: /win ${match.id}`;
      if (ctx.chat?.type === 'private') {
        await sendToAllGroups(ctx, text);
        return ctx.reply(`Challenge posted to groups ✅\n\n${text}`);
      }
      return ctx.reply(text);
    } catch (err) {
      console.error('stake_10 failed:', err?.message || 'Unknown error');
      return ctx.reply('Failed to create challenge ❌');
    }
  });

  bot.action(STAKE_25_CB, async (ctx) => {
    try {
      await ctx.answerCbQuery('Creating $25 challenge…');
      const match = await createStakeChallenge(ctx, 25);
      if (!match?.id) return ctx.reply('Failed to create challenge ❌');
      const name = ctx.from?.username || ctx.from?.first_name || 'challenger';
      const text =
        `🔥 NEW CHALLENGE!\n\n` +
        `👤 Challenger: ${name}\n` +
        `💰 Stake: 25 USDC\n\n` +
        `Accept with: /join ${match.id}\n` +
        `Winner reports: /win ${match.id}`;
      if (ctx.chat?.type === 'private') {
        await sendToAllGroups(ctx, text);
        return ctx.reply(`Challenge posted to groups ✅\n\n${text}`);
      }
      return ctx.reply(text);
    } catch (err) {
      console.error('stake_25 failed:', err?.message || 'Unknown error');
      return ctx.reply('Failed to create challenge ❌');
    }
  });

  bot.action(REFERRAL_PUSH_CB, async (ctx) => {
    try {
      await ctx.answerCbQuery('Here is your referral link');

      const telegram_id = ctx.from?.id;
      if (!telegram_id) return;

      const stats = await axios.get(`${backendUrl}/user/stats/${telegram_id}`);
      const data = stats.data || {};
      const botUsername = await getBotUsername(ctx);
      const referralLink = botUsername
        ? `https://t.me/${botUsername}?start=${data.referral_code}`
        : '';

      const shareText =
        `⚔️ I just won on Kickchain!\n\n` +
        `Join with my link:\n${referralLink || '(referral link unavailable)'}\n\n` +
        `🏆 Let’s climb the leaderboard together.`;

      await ctx.reply(
        `📣 Copy and share this message:\n\n${shareText}`
      );
    } catch (err) {
      console.error('referral_push action failed:', err?.message || 'Unknown error');
      try {
        await ctx.answerCbQuery('Failed');
      } catch {
        // ignore
      }
    }
  });

  bot.on('message', (ctx, next) => {
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
      runtimeGroupId = String(ctx.chat.id);
      invalidGroupIds.delete(runtimeGroupId);

      const chatIdStr = String(ctx.chat.id);
      if (!savedGroupIds.has(chatIdStr)) {
        savedGroupIds.add(chatIdStr);
        axios
          .post(`${backendUrl}/group/save`, {
            chat_id: ctx.chat.id,
            title: ctx.chat.title || null,
          })
          .catch((err) => {
            console.error('Failed to save group:', err?.message || 'Unknown error');
          });
      }
    }

    if (debugChatId) {
      console.log('CHAT_ID:', ctx.chat?.id);
    }

    return next();
  });

  bot.command('help', async (ctx) => {
    const lines = [];
    lines.push('Kickchain bot commands:');
    lines.push('');
    lines.push('Private chat:');
    lines.push('- /start — register (optional referral code)');
    lines.push('- /app — open the Mini App (leaderboard/stats)');
    lines.push('- /stats — your stats + referral link');
    lines.push('- /fun_match — create a fun match');
    lines.push('- /challenge <stake> — create a paid challenge');
    lines.push('- /join <match_id> — join a match');
    lines.push('- /win <match_id> — report match winner');
    lines.push('');
    lines.push('Group workspace (internal groups only):');
    lines.push('- /run — run intel discovery');
    lines.push('- /top — show latest intel results');
    lines.push('- /leaderboard — weekly team leaderboard');
    lines.push('');
    lines.push('Debug:');
    lines.push('- /whereami — print chat id/type');
    lines.push('- /testgroup — broadcast test message');
    return ctx.reply(lines.join('\n'));
  });

  bot.command('app', async (ctx) => {
    try {
      const miniappUrl = getMiniappUrl();
      if (!miniappUrl) {
        return ctx.reply(
          'Mini App is not configured.\n\nSet MINIAPP_PUBLIC_URL to your public HTTPS base URL (e.g. ngrok), then try again.'
        );
      }
      return ctx.reply(
        'Open Kickchain Mini App:',
        Markup.inlineKeyboard([Markup.button.webApp('Open Mini App', miniappUrl)])
      );
    } catch (err) {
      console.error('app command failed:', err?.message || 'Unknown error');
      return ctx.reply('Failed to open Mini App ❌');
    }
  });

  bot.command('stats', async (ctx) => {
    try {
      const telegram_id = ctx.from.id;
      const stats = await axios.get(`${backendUrl}/user/stats/${telegram_id}`);
      const data = stats.data;
      const botUsername = await getBotUsername(ctx);
      const referralLink =
        botUsername && data?.referral_code
          ? `https://t.me/${botUsername}?start=${encodeURIComponent(String(data.referral_code))}`
          : '';

      await ctx.reply(
        `📊 Your Stats:\n` +
          (data.tier ? `• Tier: ${data.tier}\n` : '') +
          `• Referrals: ${data.total_referrals}\n` +
          `• Rank: #${data.rank}\n\n` +
          (typeof data.wins === 'number' ? `• Wins: ${data.wins}\n` : '') +
          (typeof data.matches_played === 'number'
            ? `• Matches: ${data.matches_played}\n\n`
            : '\n') +
          `🔥 Your referral link:\n${referralLink || '(referral link unavailable)'}\n\n` +
          `Invite more friends and climb the leaderboard 🏆`
      );
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        return ctx.reply('Send /start first to register ✅');
      }
      console.error('Stats command failed:', err?.message || 'Unknown error');
      ctx.reply('Something went wrong ❌');
    }
  });

  bot.command('leaderboard', async (ctx) => {
    try {
      if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
        return ctx.reply('Use /leaderboard inside the team group workspace.');
      }
      if (!isWorkspaceAllowedByEnv(ctx.chat.id)) {
        console.warn('Unauthorized intel /leaderboard attempt', {
          chat_id: ctx.chat?.id,
          chat_type: ctx.chat?.type,
          from_id: ctx.from?.id,
          from_username: ctx.from?.username,
        });
        if (!internalGroupIds.size && !allowAnyGroupWorkspace) {
          return ctx.reply(
            '❌ Not allowed here.\n\nAdmin: set INTERNAL_GROUP_IDS, or set ALLOW_ANY_GROUP_WORKSPACE=true and make the bot an admin.'
          );
        }
        return ctx.reply(
          '❌ Not allowed here.\n\nAdmin: add this chat_id to INTERNAL_GROUP_IDS, then restart the bot.\nTip: run /whereami to see chat_id.'
        );
      }
      if (allowAnyGroupWorkspace && !internalGroupIds.size) {
        const botIsAdmin = await isBotAdminInChat(ctx);
        if (!botIsAdmin) {
          return ctx.reply('Make the bot an admin in this group to use workspace commands.');
        }
        const senderIsAdmin = await isSenderAdminInChat(ctx);
        if (!senderIsAdmin) {
          return ctx.reply('Only group admins can run workspace commands in this group.');
        }
      }
      if (!intelAdminKey) return ctx.reply('Intel admin key is not configured on the backend.');

      const r = await axios.get(`${backendUrl}/intel/workspace/actions/leaderboard`, {
        headers: { Authorization: `Bearer ${intelAdminKey}` },
        params: { telegram_chat_id: String(ctx.chat.id), days: 7, format: 'team' },
      });
      const team = r.data?.team_output || null;
      if (team) return ctx.reply(team);
      return ctx.reply('No actions logged yet. Use /join @community to log.');
    } catch (err) {
      console.error('Leaderboard command failed:', err?.message || 'Unknown error');
      ctx.reply('Error fetching leaderboard ❌');
    }
  });

  bot.command('fun_match', async (ctx) => {
    try {
      const telegram_id = ctx.from.id;
      const res = await axios.post(`${backendUrl}/matches/challenge`, {
        challenger_id: telegram_id,
        stake_amount: 0,
        is_fun_mode: true,
      });

      await ctx.reply(
        `🎮 Fun match created (#${res.data.id}).\n\n` +
          `Ask someone to accept with:\n` +
          `/join ${res.data.id}\n\n` +
          `When you're done playing, the winner reports the result with:\n` +
          `/win ${res.data.id}`
      );
    } catch (err) {
      console.error('fun_match failed:', err?.message || 'Unknown error');
      ctx.reply('Failed to create fun match ❌');
    }
  });

  bot.command('challenge', async (ctx) => {
    const message = ctx.message?.text || '';
    const parts = message.split(' ').filter(Boolean);
    const amount = parts.length > 1 ? Number(parts[1]) : 10;

    try {
      const telegram_id = ctx.from.id;
      const res = await axios.post(`${backendUrl}/matches/challenge`, {
        challenger_id: telegram_id,
        stake_amount: amount,
        is_fun_mode: false,
      });

      const challengerName = ctx.from.username || ctx.from.first_name || 'challenger';
      const text =
        `🔥 NEW CHALLENGE!\n\n` +
        `👤 Challenger: ${challengerName}\n` +
        `💰 Stake: ${Number.isFinite(amount) ? amount : 0} USDC\n\n` +
        `Accept with: /join ${res.data.id}\n` +
        `Winner reports: /win ${res.data.id}`;

      if (ctx.chat?.type === 'private') {
        await sendToAllGroups(ctx, text);
        await ctx.reply(`Challenge posted to groups ✅\n\n${text}`);
      } else {
        await ctx.reply(text);
      }
    } catch (err) {
      console.error('challenge failed:', err?.message || 'Unknown error');
      ctx.reply('Failed to create challenge ❌');
    }
  });

  bot.command('join', async (ctx) => {
    const message = ctx.message?.text || '';
    const parts = message.split(' ').filter(Boolean);
    if (parts.length < 2) return ctx.reply('Usage: /join <match_id>  OR  /join @community');
    const match_id = parts[1];

    try {
      // Growth workflow: /join @community (group-only)
      if (String(match_id || '').startsWith('@')) {
        if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
          return ctx.reply('Use /join @community inside the team group workspace.');
        }
        if (!internalGroupIds.size || !isInternalGroup(ctx.chat.id)) {
          console.warn('Unauthorized intel /join attempt', {
            chat_id: ctx.chat?.id,
            chat_type: ctx.chat?.type,
            from_id: ctx.from?.id,
            from_username: ctx.from?.username,
          });
          return ctx.reply('❌ Not allowed here');
        }
        if (!intelAdminKey) return ctx.reply('Intel admin key is not configured on the backend.');

        const community = String(match_id || '').trim().toLowerCase();
        if (!/^@[a-z0-9_]{5,32}$/.test(community)) {
          return ctx.reply('Invalid community. Use: /join @community (public username).');
        }

        const user_id = ctx.from?.id;
        const username = ctx.from?.username || ctx.from?.first_name || 'unknown';

        await axios.post(
          `${backendUrl}/intel/workspace/actions/join`,
          {
            telegram_chat_id: String(ctx.chat.id),
            user_id,
            username,
            community_name: community,
            action_type: 'join',
          },
          { headers: { Authorization: `Bearer ${intelAdminKey}` } }
        );

        return ctx.reply(`✅ Logged: joined ${community}`);
      }

      const telegram_id = ctx.from.id;
      await axios.post(`${backendUrl}/matches/join`, {
        match_id,
        opponent_id: telegram_id,
      });

      await ctx.reply(
        `⚔️ Match #${match_id} is now ACTIVE!\n\n` +
          `Play your match, then the winner reports the result with:\n` +
          `/win ${match_id}`
      );
    } catch (err) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message || err?.response?.data || err?.message;
      console.error('join failed:', msg);
      if (status === 400) return ctx.reply('Match not available ❌');
      if (status === 404) return ctx.reply('Match/user not found ❌');
      ctx.reply('Failed to join match ❌');
    }
  });

  bot.command('win', async (ctx) => {
    const message = ctx.message?.text || '';
    const parts = message.split(' ').filter(Boolean);
    if (parts.length < 2) return ctx.reply('Usage: /win <match_id>');
    const match_id = parts[1];

    try {
      const telegram_id = ctx.from.id;
      const done = await axios.post(`${backendUrl}/matches/complete`, {
        match_id,
        winner_id: telegram_id,
      });
      await ctx.reply(`🏁 Result recorded for match #${match_id} ✅`);

      const hype = done.data?.hype || null;
      if (hype?.allowed && hype?.text) {
        await sendToAllGroups(ctx, String(hype.text).slice(0, 1000));
      }
    } catch (err) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message || err?.response?.data || err?.message;
      console.error('win failed:', msg);
      if (status === 400) return ctx.reply(`Could not record result ❌\n${String(msg)}`);
      if (status === 404) return ctx.reply('Match not found ❌');
      ctx.reply('Failed to record result ❌');
    }
  });

  bot.command('testgroup', async (ctx) => {
    try {
      const groupsRes = await axios.get(`${backendUrl}/groups`);
      const groups = groupsRes.data || [];
      if (!groups.length) {
        return ctx.reply(
          'No groups saved yet. Add the bot to a group and send any message so the bot can detect and save the chat ID.'
        );
      }

      const ok = await sendToAllGroups(ctx, '✅ Group announcement test from Kickchain bot');
      if (ok) {
        await ctx.reply('Group test sent ✅');
      } else {
        await ctx.reply(
          'Group test failed ❌\nCheck bot membership/admin role, and group permissions.'
        );
      }
    } catch (err) {
      console.error('testgroup command failed:', err?.message || 'Unknown error');
      ctx.reply('Group test failed ❌');
    }
  });

  bot.command('whereami', async (ctx) => {
    await ctx.reply(
      `chat_id: ${ctx.chat?.id}\nchat_type: ${ctx.chat?.type || 'unknown'}`
    );
  });

  // Workspace intelligence commands (group = workspace)
  bot.command('run', async (ctx) => {
    try {
      if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
        return ctx.reply('Use /run inside a Telegram group workspace.');
      }
      if (!isWorkspaceAllowedByEnv(ctx.chat.id)) {
        console.warn('Unauthorized intel /run attempt', {
          chat_id: ctx.chat?.id,
          chat_type: ctx.chat?.type,
          from_id: ctx.from?.id,
          from_username: ctx.from?.username,
        });
        if (!internalGroupIds.size && !allowAnyGroupWorkspace) {
          return ctx.reply(
            '❌ Not allowed here.\n\nAdmin: set INTERNAL_GROUP_IDS, or set ALLOW_ANY_GROUP_WORKSPACE=true and make the bot an admin.'
          );
        }
        return ctx.reply(
          '❌ Not allowed here.\n\nAdmin: add this chat_id to INTERNAL_GROUP_IDS, then restart the bot.\nTip: run /whereami to see chat_id.'
        );
      }
      if (allowAnyGroupWorkspace && !internalGroupIds.size) {
        const botIsAdmin = await isBotAdminInChat(ctx);
        if (!botIsAdmin) {
          return ctx.reply('Make the bot an admin in this group to use workspace commands.');
        }
        const senderIsAdmin = await isSenderAdminInChat(ctx);
        if (!senderIsAdmin) {
          return ctx.reply('Only group admins can run workspace commands in this group.');
        }
      }
      if (!intelAdminKey) {
        return ctx.reply('Intel admin key is not configured on the backend.');
      }

      const chatId = String(ctx.chat.id);
      const title = ctx.chat.title || null;

      console.info('Intel /run starting', { chat_id: chatId, title });
      await ctx.reply('🚀 Running discovery… results will be posted shortly.');

      // Queue a durable job on the backend (serverless-safe).
      const enqueue = await axios.post(
        `${backendUrl}/intel/workspace/enqueue-run`,
        {
          telegram_chat_id: chatId,
          name: title,
          requested_by: ctx.from?.id,
          requested_by_username: ctx.from?.username || null,
          options: {
            // Keep the run serverless-safe by default; can be overridden via manual API calls.
            message_extraction: false,
            max_scrapes: 1,
          },
        },
        { headers: { Authorization: `Bearer ${intelAdminKey}` } }
      );

      const preview = Array.isArray(enqueue.data?.preview) ? enqueue.data.preview : [];
      if (preview.length) {
        const lines = ['⚡ Quick Results (Instant)', ''];
        for (let i = 0; i < Math.min(3, preview.length); i += 1) {
          lines.push(`${i + 1}. ${preview[i]}`);
        }
        await ctx.reply(lines.join('\n').trim());
      }

      return;
    } catch (err) {
      const status = err?.response?.status;
      const apiErr = err?.response?.data?.error;
      const apiDetails = err?.response?.data?.details;
      const msg = apiErr || err?.message || 'Run failed';
      console.error('intel /run failed:', { status, msg, details: apiDetails });
      const extra = apiDetails ? `\nDetails: ${String(apiDetails).slice(0, 180)}` : '';
      return ctx.reply(`❌ Intel run failed: ${String(msg).slice(0, 180)}${extra}`);
    }
  });

  bot.command('top', async (ctx) => {
    try {
      if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') {
        return ctx.reply('Use /top inside a Telegram group workspace.');
      }
      if (!isWorkspaceAllowedByEnv(ctx.chat.id)) {
        console.warn('Unauthorized intel /top attempt', {
          chat_id: ctx.chat?.id,
          chat_type: ctx.chat?.type,
          from_id: ctx.from?.id,
          from_username: ctx.from?.username,
        });
        if (!internalGroupIds.size && !allowAnyGroupWorkspace) {
          return ctx.reply(
            '❌ Not allowed here.\n\nAdmin: set INTERNAL_GROUP_IDS, or set ALLOW_ANY_GROUP_WORKSPACE=true and make the bot an admin.'
          );
        }
        return ctx.reply(
          '❌ Not allowed here.\n\nAdmin: add this chat_id to INTERNAL_GROUP_IDS, then restart the bot.\nTip: run /whereami to see chat_id.'
        );
      }
      if (allowAnyGroupWorkspace && !internalGroupIds.size) {
        const botIsAdmin = await isBotAdminInChat(ctx);
        if (!botIsAdmin) {
          return ctx.reply('Make the bot an admin in this group to use workspace commands.');
        }
        const senderIsAdmin = await isSenderAdminInChat(ctx);
        if (!senderIsAdmin) {
          return ctx.reply('Only group admins can run workspace commands in this group.');
        }
      }
      if (!intelAdminKey) {
        return ctx.reply('Intel admin key is not configured on the backend.');
      }

      const chatId = String(ctx.chat.id);
      console.info('Intel /top requested', { chat_id: chatId });
      const r = await axios.get(`${backendUrl}/intel/workspace/top`, {
        headers: { Authorization: `Bearer ${intelAdminKey}` },
        params: { telegram_chat_id: chatId, format: 'team' },
      });

      const team = r.data?.team_output || null;
      console.info('Intel /top response', { chat_id: chatId, has_team_output: !!team });
      if (team) return ctx.reply(team);
      return ctx.reply('No workspace results yet. Run /run first.');
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Failed';
      console.error('intel /top failed:', msg);
      return ctx.reply(`❌ Failed to load top: ${String(msg).slice(0, 180)}`);
    }
  });

  // Friendly default behavior: reply with /help in private chats when users send plain text
  // or unknown commands. Avoids "silent bot" confusion.
  bot.on('text', async (ctx, next) => {
    try {
      await next();
    } catch {
      // ignore
    }
    try {
      if (ctx.chat?.type !== 'private') return;
      const text = String(ctx.message?.text || '').trim();
      if (!text) return;
      if (text === '/help') return;
      if (autoRegisterPrivate && !text.startsWith('/')) {
        const reg = await ensureUserRegistered({ ctx, referralCode: null });
        if (reg.ok && reg.isNewUser) {
          const username = ctx.from?.username || 'no_username';
          try {
            await sendToAllGroups(ctx, `🚀 ${username} just joined Kickchain!\n\nCan you beat them?`);
          } catch {
            // ignore group broadcast failures
          }
        }
      }
      if (text.startsWith('/')) {
        return ctx.reply('Unknown command. Send /help for available commands.');
      }
      return ctx.reply('Send /help to see what I can do.');
    } catch {
      // ignore
    }
  });

  // Workspace automation: auto-enqueue intel runs on group activity (no manual /run needed).
  bot.on('text', async (ctx, next) => {
    try {
      await next();
    } catch {
      // ignore
    }
    try {
      if (!autoWorkspaceIntelEnabled) return;
      if (!intelAdminKey) return;
      if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return;
      if (!isWorkspaceAllowedByEnv(ctx.chat.id)) return;
      if (allowAnyGroupWorkspace && !internalGroupIds.size) {
        const botIsAdmin = await isBotAdminInChat(ctx);
        if (!botIsAdmin) return;
      }

      const text = String(ctx.message?.text || '').trim();
      if (!text) return;
      if (text.startsWith('/')) return; // don't react to commands
      if (ctx.from?.is_bot) return;

      const chatId = String(ctx.chat.id);
      const lastAttemptAt = Number(lastAutoEnqueueAttemptAtByChat.get(chatId) || 0);
      const now = Date.now();
      if (now - lastAttemptAt < autoWorkspaceIntelCooldownMs) return;
      lastAutoEnqueueAttemptAtByChat.set(chatId, now);

      const title = ctx.chat.title || null;

      await axios.post(
        `${backendUrl}/intel/workspace/enqueue-run`,
        {
          telegram_chat_id: chatId,
          name: title,
          requested_by: ctx.from?.id,
          requested_by_username: ctx.from?.username || null,
          options: {
            search: autoWorkspaceIntelSearch,
            scrape: true,
            message_extraction: autoWorkspaceIntelMessageExtraction,
            max_scrapes: 1,
            // Let backend guardrails cap these. Keep defaults unless explicitly overridden.
          },
        },
        { headers: { Authorization: `Bearer ${intelAdminKey}` } }
      );
    } catch (err) {
      // Best-effort: don't spam the chat or crash the bot on automation failures.
      const status = err?.response?.status;
      const msg = err?.response?.data?.error || err?.message || 'auto workspace enqueue failed';
      console.error('auto workspace enqueue failed:', { status, msg });
    }
  });

  return {
    bot,
    sendToAllGroups,
    getGroupIdCandidates,
  };
}

module.exports = {
  createKickchainBot,
};
