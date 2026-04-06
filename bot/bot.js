const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createKickchainBot } = require('./kickchainBot');

const { bot, error } = createKickchainBot();

if (!bot) {
  console.error(error || 'Failed to initialize bot. Check bot/.env');
  process.exit(1);
}

bot
  .launch({ dropPendingUpdates: true })
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

