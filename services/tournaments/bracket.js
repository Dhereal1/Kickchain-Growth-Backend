function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function seedParticipants(participants) {
  const list = Array.isArray(participants) ? participants.slice() : [];
  list.sort((a, b) => {
    const ta = String(a.joined_at || '').localeCompare(String(b.joined_at || ''));
    if (ta !== 0) return ta;
    return Number(a.telegram_id || 0) - Number(b.telegram_id || 0);
  });
  return list.map((p, idx) => ({ ...p, seed: idx + 1 }));
}

// Returns bracket matches for all rounds.
// Each match has: round (1..R), slot (0..), player_a, player_b.
function generateSingleElimBracket(participants, { maxParticipants = 16 } = {}) {
  const seeded = seedParticipants(participants);
  const maxP = Math.max(2, Math.min(256, Number(maxParticipants) || 16));
  const trimmed = seeded.slice(0, maxP);
  const size = nextPowerOfTwo(Math.max(2, trimmed.length));
  const rounds = Math.log2(size);

  const padded = trimmed.slice();
  while (padded.length < size) padded.push({ telegram_id: null, seed: null, bye: true });

  const matches = [];

  // Round 1 pairings: simple sequential seeding (stable).
  for (let slot = 0; slot < size / 2; slot += 1) {
    const a = padded[slot * 2] || null;
    const b = padded[slot * 2 + 1] || null;
    matches.push({
      round: 1,
      slot,
      player_a: a?.telegram_id != null ? Number(a.telegram_id) : null,
      player_b: b?.telegram_id != null ? Number(b.telegram_id) : null,
      seed_a: a?.seed ?? null,
      seed_b: b?.seed ?? null,
    });
  }

  // Placeholder matches for later rounds.
  for (let round = 2; round <= rounds; round += 1) {
    const slots = size / 2 ** round;
    for (let slot = 0; slot < slots; slot += 1) {
      matches.push({ round, slot, player_a: null, player_b: null, seed_a: null, seed_b: null });
    }
  }

  return { size, rounds, matches };
}

module.exports = {
  nextPowerOfTwo,
  generateSingleElimBracket,
  seedParticipants,
};

