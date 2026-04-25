const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createKickchainBot } = require('./kickchainBot');

const { bot, error } = createKickchainBot();

if (!bot) {
  console.error(error || 'Failed to initialize bot. Check bot/.env');
  process.exit(1);
}

async function clearTelegramWebhook() {
  const botToken = String(process.env.BOT_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
  if (!botToken) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: true }),
    });
    const j = await r.json().catch(() => null);
    if (j?.ok) {
      console.log('Telegram webhook cleared ✅ (polling mode)');
    } else {
      console.warn('Failed to clear Telegram webhook (polling may fail):', j?.description || j);
    }
  } catch (err) {
    console.warn('Failed to clear Telegram webhook (polling may fail):', err?.message || String(err));
  }
}

clearTelegramWebhook()
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => console.log('Bot is running 🤖'))
  .catch((err) => {
    const code = err?.response?.error_code;
    const status = err?.response?.status;

    if (code === 404 && err?.on?.method === 'getMe') {
      console.error('Bot startup failed: invalid BOT_TOKEN (Telegram returned 404 on getMe).');
      process.exit(1);
    }

    if (status === 409 || err?.message?.includes('terminated by other getUpdates')) {
      console.error(
        'Bot startup failed: another instance is running with this token. Stop it and retry.'
      );
      process.exit(1);
    }

    console.error('Bot startup failed:', err?.message || 'Unknown error');
    process.exit(1);
  });
