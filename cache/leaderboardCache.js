let lastSnapshot = {
  referrers: [],
  winners: [],
  players: [],
};

function getSnapshot() {
  return lastSnapshot;
}

function setSnapshot(newSnapshot) {
  lastSnapshot = newSnapshot;
}

module.exports = {
  getSnapshot,
  setSnapshot,
};

