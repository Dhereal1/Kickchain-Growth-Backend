const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Telegraf } = require('telegraf');
const axios = require('axios');

const botToken = (process.env.BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
const backendUrl = (process.env.BACKEND_URL || '').trim();
const rawGroupId = (process.env.GROUP_ID || '').trim();
const debugChatId = (process.env.DEBUG_CHAT_ID || '').trim().toLowerCase() === 'true';

const normalizeGroupId = (value) => {
  if (!value) return '';
  if (!/^-?\d+$/.test(value)) return value;
  if (value.startsWith('-100')) return value;
  if (!value.startsWith('-')) return `-100${value}`;
  return value;
};

const groupId = normalizeGroupId(rawGroupId);
let runtimeGroupId = '';

const getGroupIdCandidates = () =>
  [...new Set([groupId, rawGroupId, runtimeGroupId].filter(Boolean))];

if (!botToken || !backendUrl) {
  console.error('Missing bot configuration in bot/.env');
  process.exit(1);
}

const bot = new Telegraf(botToken);

const savedGroupIds = new Set();

const sendToGroupEnv = async (ctx, text) => {
  const groupIdCandidates = getGroupIdCandidates();
  if (!groupIdCandidates.length) return false;
  for (const candidate of groupIdCandidates) {
    try {
      await ctx.telegram.sendMessage(Number(candidate), text);
      return true;
    } catch (err) {
      // Keep logs actionable but safe
      console.error(
        `Failed to send group message to ${candidate}:`,
        err?.message || 'Unknown error'
      );
    }
  }
  return false;
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

      try {
        await ctx.telegram.sendMessage(Number(chatId), text);
        sentAny = true;
      } catch (err) {
        console.error(
          `Failed to send group message to DB chat_id=${chatId}:`,
          err?.message || 'Unknown error'
        );
      }
    }

    if (sentAny) return true;
  } catch (err) {
    console.error('Failed to fetch groups from backend:', err?.message || 'Unknown error');
  }

  // Fallback: your current GROUP_ID (so announcements still work)
  return sendToGroupEnv(ctx, text);
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
        `• Referrals: ${data.total_referrals}\n` +
        `• Rank: #${data.rank}\n\n` +
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
        `• Referrals: ${data.total_referrals}\n` +
        `• Rank: #${data.rank}\n\n` +
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
      const isYou = user.username && ctx.from?.username && user.username === ctx.from.username;

      message += `${index + 1}. ${username} — ${totalReferrals} invites${isYou ? ' 👉 YOU' : ''}\n`;
    });

    await ctx.reply(message.trim());
  } catch (err) {
    console.error('Leaderboard command failed:', err?.message || 'Unknown error');
    ctx.reply('Error fetching leaderboard ❌');
  }
});

bot.command('testgroup', async (ctx) => {
  try {
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
  .launch()
  .then(() => {
    console.log('Bot is running 🤖');
    const groupIdCandidates = getGroupIdCandidates();
    if (groupIdCandidates.length) {
      if (rawGroupId !== groupId) {
        console.log(`GROUP_ID normalized from ${rawGroupId} to ${groupId}`);
      }
      console.log(`Group hype enabled for ${groupIdCandidates.join(', ')}`);
    } else {
      console.log('Group hype disabled (GROUP_ID not set)');
    }
  })
  .catch((err) => {
    if (err?.response?.error_code === 404 && err?.on?.method === 'getMe') {
      console.error('Bot startup failed: invalid BOT_TOKEN (Telegram returned 404 on getMe).');
      console.error('Get a fresh token from BotFather and update bot/.env.');
      process.exit(1);
    }

    console.error('Bot startup failed:', err?.message || 'Unknown error');
    process.exit(1);
  });

