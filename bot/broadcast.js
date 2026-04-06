const { Telegram } = require('telegraf');
const pool = require('../db/pool');

function getTelegram() {
  const botToken = (process.env.BOT_TOKEN || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');

  if (!botToken) return null;
  return new Telegram(botToken);
}

async function getGroupChatIds() {
  // Prefer DB (works for backend jobs and for bot if it has DATABASE_URL).
  try {
    const result = await pool.query('SELECT chat_id FROM groups');
    return result.rows.map((r) => r.chat_id).filter(Boolean);
  } catch {
    // If DB isn't available in this process, fall back to empty list.
    return [];
  }
}

async function broadcastMessage(message) {
  const telegram = getTelegram();
  if (!telegram) {
    if (!broadcastMessage._warned) {
      broadcastMessage._warned = true;
      console.warn('broadcastMessage skipped: BOT_TOKEN not set in backend environment.');
    }
    return;
  }

  const chatIds = await getGroupChatIds();
  for (const chatId of chatIds) {
    try {
      await telegram.sendMessage(Number(chatId), message);
    } catch (err) {
      // Don't throw; one dead group shouldn't break broadcasting.
      console.error(`Broadcast failed for ${chatId}:`, err?.message || 'Unknown error');

      const status = err?.response?.status;
      const errorCode = err?.response?.error_code;
      if (status === 400 || status === 403 || errorCode === 400 || errorCode === 403) {
        // If the bot is kicked or the chat no longer exists, remove it
        // so we don't repeatedly spam failing chat IDs.
        try {
          await pool.query('DELETE FROM groups WHERE chat_id = $1', [chatId]);
          console.log(`Removed invalid group chat_id=${chatId} from DB`);
        } catch (e) {
          console.error('Failed to remove invalid group from DB:', e?.message || 'Unknown error');
        }
      }
    }
  }
}

module.exports = {
  broadcastMessage,
};

