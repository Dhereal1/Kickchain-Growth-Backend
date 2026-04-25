const test = require('node:test');
const assert = require('node:assert/strict');

const { generateSingleElimBracket } = require('../services/tournaments/bracket');

test('generateSingleElimBracket produces power-of-two bracket and placeholder rounds', () => {
  const participants = [
    { telegram_id: 1, joined_at: '2026-04-25T00:00:01Z' },
    { telegram_id: 2, joined_at: '2026-04-25T00:00:02Z' },
    { telegram_id: 3, joined_at: '2026-04-25T00:00:03Z' },
  ];
  const out = generateSingleElimBracket(participants, { maxParticipants: 16 });
  assert.equal(out.size, 4);
  assert.equal(out.rounds, 2);
  // round 1 has size/2 matches, plus placeholders for round 2
  assert.equal(out.matches.filter((m) => m.round === 1).length, 2);
  assert.equal(out.matches.filter((m) => m.round === 2).length, 1);
});

