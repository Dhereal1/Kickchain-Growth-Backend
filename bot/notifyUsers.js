const { Telegram } = require('telegraf');

function normalizeBotToken(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function getTelegram() {
  const botToken = normalizeBotToken(process.env.BOT_TOKEN);
  if (!botToken) return null;
  return new Telegram(botToken);
}

async function sendToUsers(userIds, text, extra) {
  const telegram = getTelegram();
  if (!telegram) {
    throw new Error('BOT_TOKEN not set');
  }

  const ids = Array.isArray(userIds) ? userIds : [];
  const results = { sent: 0, failed: 0 };

  for (const id of ids) {
    if (!id) continue;
    try {
      await telegram.sendMessage(Number(id), text, extra);
      results.sent += 1;
    } catch (err) {
      results.failed += 1;
      console.error(`sendToUsers failed for ${id}:`, err?.message || 'Unknown error');
    }
  }

  return results;
}

async function sendToChatId(chatId, text, extra) {
  return sendToUsers([chatId], text, extra);
}

module.exports = {
  sendToUsers,
  sendToChatId,
};
