const { broadcastMessage } = require('../bot/broadcast');
const { getSnapshot, setSnapshot } = require('../cache/leaderboardCache');

let lastRun = 0;

function shouldRun() {
  const cooldownMs = Number(process.env.LEADERBOARD_HYPE_COOLDOWN_MS || 30000);
  const now = Date.now();
  if (now - lastRun < cooldownMs) return false;
  lastRun = now;
  return true;
}

function detectChanges(type, oldList, newList, maxTopN) {
  const messages = [];

  newList.forEach((user, index) => {
    const username = user?.username || '';
    if (!username) return;

    const prevIndex = oldList.findIndex((u) => u?.username === username);

    // New #1
    if (index === 0 && prevIndex !== 0) {
      messages.push(`👑 NEW #1 ${type.toUpperCase()}!\n\n${username} just took the top spot!`);
    }

    // Entered Top N
    if (prevIndex === -1 && index < maxTopN) {
      messages.push(`🚀 ${username} entered Top ${maxTopN} (${type})!`);
    }

    // Overtake
    if (prevIndex > index && prevIndex !== -1) {
      messages.push(`⚔️ ${username} is climbing! Now #${index + 1} in ${type}`);
    }
  });

  return messages;
}

async function processLeaderboardUpdate(newData) {
  const oldData = getSnapshot();
  const maxTopN = Number(process.env.LEADERBOARD_HYPE_TOP_N || 10);

  // Avoid spamming on the very first snapshot when we have no baseline.
  const hasBaseline =
    (oldData.referrers && oldData.referrers.length) ||
    (oldData.winners && oldData.winners.length) ||
    (oldData.players && oldData.players.length);

  if (!hasBaseline) {
    setSnapshot(newData);
    return;
  }

  const messages = [
    ...detectChanges('referrers', oldData.referrers || [], newData.referrers || [], maxTopN),
    ...detectChanges('winners', oldData.winners || [], newData.winners || [], maxTopN),
    ...detectChanges('players', oldData.players || [], newData.players || [], maxTopN),
  ];

  // Always update snapshot, but only broadcast if outside cooldown.
  setSnapshot(newData);

  if (!messages.length) return;
  if (!shouldRun()) return;

  for (const msg of messages) {
    try {
      await broadcastMessage(msg);
    } catch (err) {
      console.error('LeaderboardHype broadcast failed:', err?.message || String(err));
    }
  }
}

module.exports = {
  processLeaderboardUpdate,
};

