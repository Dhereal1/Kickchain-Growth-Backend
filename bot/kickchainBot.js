const { Telegraf } = require('telegraf');
const axios = require('axios');

function normalizeBotToken(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function normalizeGroupId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!/^-?\d+$/.test(v)) return v;
  if (v.startsWith('-')) return v;
  return `-${v}`;
}

function createKickchainBot(options) {
  const botToken = normalizeBotToken(options?.botToken || process.env.BOT_TOKEN);
  const backendUrl = String(options?.backendUrl || process.env.BACKEND_URL || '').trim();
  const rawGroupId = String(options?.groupId || process.env.GROUP_ID || '').trim();
  const debugChatId =
    String(options?.debugChatId ?? process.env.DEBUG_CHAT_ID ?? '')
      .trim()
      .toLowerCase() === 'true';
  const enableGroupFallback =
    String(options?.enableGroupFallback ?? process.env.ENABLE_GROUP_FALLBACK ?? '')
      .trim()
      .toLowerCase() === 'true';

  if (!botToken || !backendUrl) {
    return { bot: null, error: 'Missing BOT_TOKEN or BACKEND_URL' };
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
  const PLAY_MATCH_CB = 'kc_play_match';
  const REFERRAL_PUSH_CB = 'kc_referral_push';
  let cachedBotUsername = '';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

      const message = ctx.message?.text || '';
      const parts = message.split(' ');
      const referral_code = parts.length > 1 ? parts[1] : null;

      const telegram_id = ctx.from.id;
      const username = ctx.from.username || 'no_username';

      const response = await axios.post(`${backendUrl}/user/create`, {
        telegram_id,
        username,
        referral_code_used: referral_code,
      });

      const isNewUser = response.data?.message === 'User created ✅';
      if (isNewUser) {
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
      const data = stats.data;
      const botUsername = ctx.botInfo?.username || '';
      const referralLink = `https://t.me/${botUsername}?start=${data.referral_code}`;

      await ctx.reply(
        `🚀 Welcome to Kickchain\n\n` +
          `⚔️ Play 1v1 matches and win rewards\n\n` +
          `👉 Tap below to start your first match\n\n` +
          `🔥 Your referral link:\n${referralLink}\n\n` +
          `🏆 Invite friends → climb leaderboard → earn more`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: '🎮 Play Match', callback_data: PLAY_MATCH_CB }]],
          },
        }
      );
    } catch (err) {
      console.error('Bot request failed:', err?.message || 'Unknown error');
      ctx.reply('Something went wrong ❌');
    }
  });

  bot.action(PLAY_MATCH_CB, async (ctx) => {
    try {
      await ctx.answerCbQuery('Finding opponent...');

      const telegram_id = ctx.from?.id;
      if (!telegram_id) return;

      // Immediate action + dopamine loop (no real gameplay needed yet)
      await ctx.reply('Finding opponent...');
      await sleep(2500);
      await ctx.reply('🔥 You won!');

      const stats = await axios.get(`${backendUrl}/user/stats/${telegram_id}`);
      const data = stats.data || {};
      const botUsername = await getBotUsername(ctx);
      const referralLink = botUsername
        ? `https://t.me/${botUsername}?start=${data.referral_code}`
        : '';

      await ctx.reply(
        `🔥 You won your first match!\n\n` +
          `Invite a friend and earn rewards:\n` +
          `${referralLink || '(referral link unavailable)'}\n\n` +
          `🏆 Climb the leaderboard now\n\n` +
          `What is this?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📣 Share Referral', callback_data: REFERRAL_PUSH_CB }],
              [{ text: '🎮 Play Again', callback_data: PLAY_MATCH_CB }],
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

  bot.on('message', (ctx) => {
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
  });

  bot.command('stats', async (ctx) => {
    try {
      const telegram_id = ctx.from.id;
      const stats = await axios.get(`${backendUrl}/user/stats/${telegram_id}`);
      const data = stats.data;
      const botUsername = ctx.botInfo?.username || '';
      const referralLink = `https://t.me/${botUsername}?start=${data.referral_code}`;

      await ctx.reply(
        `📊 Your Stats:\n` +
          (data.tier ? `• Tier: ${data.tier}\n` : '') +
          `• Referrals: ${data.total_referrals}\n` +
          `• Rank: #${data.rank}\n\n` +
          (typeof data.wins === 'number' ? `• Wins: ${data.wins}\n` : '') +
          (typeof data.matches_played === 'number'
            ? `• Matches: ${data.matches_played}\n\n`
            : '\n') +
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

  return {
    bot,
    sendToAllGroups,
    getGroupIdCandidates,
  };
}

module.exports = {
  createKickchainBot,
};
