const { broadcastMessage } = require('../bot/broadcast');
const leaderboardService = require('../services/leaderboardService');

function formatList(title, data, field) {
  if (!data.length) return `${title}\nNo data yet.\n`;

  let text = `${title}\n\n`;

  data.forEach((user, i) => {
    const name = user.username || 'unknown';
    text += `${i + 1}. ${name} — ${user[field]}\n`;
  });

  return text;
}

async function postWeeklyLeaderboard() {
  try {
    const [referrers, winners, players] = await Promise.all([
      leaderboardService.getTopReferrers(10),
      leaderboardService.getTopWinners(10),
      leaderboardService.getTopPlayers(10),
    ]);

    const message = `
🏆 WEEKLY LEADERBOARD 🏆

${formatList('🔥 Top Referrers', referrers, 'referral_count')}

${formatList('💰 Top Winners', winners, 'total_won')}

${formatList('🎮 Top Players', players, 'games_played')}
`;

    await broadcastMessage(message.trim());
  } catch (err) {
    console.error('Weekly leaderboard error:', err?.message || String(err));
  }
}

module.exports = {
  postWeeklyLeaderboard,
};

