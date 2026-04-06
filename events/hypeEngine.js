const { broadcastMessage } = require('../bot/broadcast');

const BIG_WIN_THRESHOLD = Number(process.env.BIG_WIN_THRESHOLD || 100);
const STREAK_THRESHOLD = Number(process.env.STREAK_THRESHOLD || 3);

function handleMatchResult(user, match) {
  try {
    const { amountWon, streak } = match;

    // 🔥 Big Win Trigger
    if (amountWon >= BIG_WIN_THRESHOLD) {
      broadcastMessage(
        `🔥 BIG WIN ALERT 🔥\n\n${user.username} just won $${amountWon}!\nWho's next? 👀`
      );
    }

    // 🔥 Streak Trigger
    if (streak >= STREAK_THRESHOLD) {
      broadcastMessage(
        `⚡ STREAK ALERT ⚡\n\n${user.username} is on a ${streak} win streak!\nCan anyone stop them? 😤`
      );
    }
  } catch (err) {
    console.error('HypeEngine error:', err?.message || String(err));
  }
}

module.exports = {
  handleMatchResult,
};

