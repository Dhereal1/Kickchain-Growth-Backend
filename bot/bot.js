const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Telegraf } = require('telegraf');
const axios = require('axios');

const botToken = (process.env.BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
const backendUrl = (process.env.BACKEND_URL || '').trim();
const rawGroupId = (process.env.GROUP_ID || '').trim();
const debugChatId = (process.env.DEBUG_CHAT_ID || '').trim().toLowerCase() === 'true';
const enableGroupFallback = (process.env.ENABLE_GROUP_FALLBACK || '').trim().toLowerCase() === 'true';

const normalizeGroupId = (value) => {
  if (!value) return '';
  if (!/^-?\d+$/.test(value)) return value;
  // Telegram group chat IDs are usually negative (supergroups are -100...).
  // If the user omits the leading '-', fix it by prefixing '-' (not '-100').
  if (value.startsWith('-')) return value;
  return `-${value}`;
};

const groupId = normalizeGroupId(rawGroupId);
let runtimeGroupId = '';

const getGroupIdCandidates = () =>
  [...new Set([groupId, runtimeGroupId].filter(Boolean))];

if (!botToken || !backendUrl) {
  console.error('Missing bot configuration in bot/.env');
  process.exit(1);
}

const bot = new Telegraf(botToken);

const savedGroupIds = new Set();
const invalidGroupIds = new Set();

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
      // Keep logs actionable but safe
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
    // Silent: failing to delete shouldn't break onboarding.
  }
};

const sendToAllGroups = async (ctx, text) => {
  // Prefer persistent groups stored in DB.
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

  // Optional fallback for single-group mode when DB groups are unavailable/empty.
  if (enableGroupFallback) {
    return sendToGroupEnv(ctx, text);
  }
  return false;
};

// /start handler
bot.start(async (ctx) => {
  try {
    if (ctx.chat?.type !== 'private') {
      return ctx.reply('👉 Please message me in private to start.');
    }

    const message = ctx.message?.text || '';
    const parts = message.split(' ');

    let referral_code = null;

    // Extract referral code if exists
    if (parts.length > 1) {
      referral_code = parts[1];
    }

    const telegram_id = ctx.from.id;
    const username = ctx.from.username || 'no_username';

    // Call your backend
    const response = await axios.post(`${backendUrl}/user/create`, {
      telegram_id,
      username,
      referral_code_used: referral_code,
    });

    const isNewUser = response.data?.message === 'User created ✅';

    // Join announcement only for truly new users
    if (isNewUser) {
      await sendToAllGroups(
        ctx,
        `🚀 ${username} just joined Kickchain!\n\nCan you beat them?`
      );
    }

    // Referral announcement for ANY referral-link start click
    if (referral_code) {
      await sendToAllGroups(
        ctx,
        `🔥 New referral click!\n${username} entered via a referral link 🚀`
      );
    }

    const stats = await axios.get(
      `${backendUrl}/user/stats/${telegram_id}`
    );

    const data = stats.data;

    const botUsername = ctx.botInfo.username;
    const referralLink = `https://t.me/${botUsername}?start=${data.referral_code}`;

    await ctx.reply(
      `Welcome ${data.username} 🚀\n\n` +
        `🔥 Your referral link:\n${referralLink}\n\n` +
        `📊 Your Stats:\n` +
        (data.tier ? `• Tier: ${data.tier}\n` : '') +
        `• Referrals: ${data.total_referrals}\n` +
        `• Rank: #${data.rank}\n\n` +
        (typeof data.wins === 'number' ? `• Wins: ${data.wins}\n` : '') +
        (typeof data.matches_played === 'number' ? `• Matches: ${data.matches_played}\n\n` : '\n') +
        `Invite more friends and climb the leaderboard 🏆`
    );
  } catch (err) {
    console.error('Bot request failed:', err?.message || 'Unknown error');
    ctx.reply('Something went wrong ❌');
  }
});

// Optional: print the chat id so you can configure GROUP_ID
bot.on('message', (ctx) => {
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    runtimeGroupId = String(ctx.chat.id);
    invalidGroupIds.delete(runtimeGroupId);

    // Persist group so we can broadcast to multiple communities.
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
});

bot.command('stats', async (ctx) => {
  try {
    const telegram_id = ctx.from.id;

    const stats = await axios.get(
      `${backendUrl}/user/stats/${telegram_id}`
    );

    const data = stats.data;
    const botUsername = ctx.botInfo?.username || '';
    const referralLink = `https://t.me/${botUsername}?start=${data.referral_code}`;

    await ctx.reply(
      `📊 Your Stats:\n` +
        (data.tier ? `• Tier: ${data.tier}\n` : '') +
        `• Referrals: ${data.total_referrals}\n` +
        `• Rank: #${data.rank}\n\n` +
        (typeof data.wins === 'number' ? `• Wins: ${data.wins}\n` : '') +
        (typeof data.matches_played === 'number' ? `• Matches: ${data.matches_played}\n\n` : '\n') +
        `🔥 Your referral link:\n${referralLink}\n\n` +
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
    const response = await axios.get(`${backendUrl}/leaderboard`);
    const leaderboard = response.data.leaderboard || [];

    let message = '🏆 Top Referrers\n\n';

    leaderboard.forEach((user, index) => {
      const username = user.username || 'unknown';
      const totalReferrals = user.total_referrals ?? 0;
      const tier = user.tier ? ` [${user.tier}]` : '';
      const isYou = user.username && ctx.from?.username && user.username === ctx.from.username;

      message += `${index + 1}. ${username}${tier} — ${totalReferrals} invites${isYou ? ' 👉 YOU' : ''}\n`;
    });

    await ctx.reply(message.trim());
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

    // If the user challenges in private, broadcast it to all saved groups.
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
  if (parts.length < 2) return ctx.reply('Usage: /join <match_id>');
  const match_id = parts[1];

  try {
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
    if (status === 400) return ctx.reply(`Match not available ❌`);
    if (status === 404) return ctx.reply(`Match/user not found ❌`);
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
    await axios.post(`${backendUrl}/matches/complete`, {
      match_id,
      winner_id: telegram_id,
    });

    await ctx.reply(`🏁 Result recorded for match #${match_id} ✅`);
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.message || err?.response?.data || err?.message;
    console.error('win failed:', msg);
    if (status === 400) return ctx.reply(`Could not record result ❌\n${String(msg)}`);
    if (status === 404) return ctx.reply(`Match not found ❌`);
    ctx.reply('Failed to record result ❌');
  }
});

bot.command('testgroup', async (ctx) => {
  try {
    const groupsRes = await axios.get(`${backendUrl}/groups`);
    const groups = groupsRes.data || [];
    if (!groups.length) {
      return ctx.reply(
        'No groups saved yet. Add the bot to a group and send any message (or /start) there so the bot can detect and save the chat ID.'
      );
    }

    const ok = await sendToAllGroups(ctx, '✅ Group announcement test from Kickchain bot');
    if (ok) {
      await ctx.reply('Group test sent ✅');
    } else {
      await ctx.reply(
        'Group test failed ❌\nCheck GROUP_ID, bot membership/admin role, and group permissions.'
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

bot
  .launch({ dropPendingUpdates: true })
  .then(() => {
    console.log('Bot is running 🤖');
    console.log(enableGroupFallback
      ? `Group fallback enabled for ${groupId || '(none configured)'}`
      : 'Group fallback disabled (DB groups only)');
  })
  .catch((err) => {
    if (err?.response?.error_code === 404 && err?.on?.method === 'getMe') {
      console.error('Bot startup failed: invalid BOT_TOKEN (Telegram returned 404 on getMe).');
      console.error('Get a fresh token from BotFather and update bot/.env.');
      process.exit(1);
    }

    if (err?.response?.status === 409 || err?.message?.includes('terminated by other getUpdates')) {
      console.error(
        'Bot startup failed: another bot instance is already running with this token. Stop other node bot processes and retry.'
      );
      process.exit(1);
    }

    console.error('Bot startup failed:', err?.message || 'Unknown error');
    process.exit(1);
  });
