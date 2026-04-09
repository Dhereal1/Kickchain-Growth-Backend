function normalizeAction(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'join') return 'join';
  if (v === 'monitor') return 'monitor';
  if (v === 'ignore') return 'ignore';
  return null;
}

function downgrade(action) {
  const a = normalizeAction(action);
  if (a === 'join') return 'monitor';
  if (a === 'monitor') return 'ignore';
  return 'ignore';
}

function getFinalDecision({ signals, ai }) {
  const intent = Number(signals?.intent_score || 0);
  const activity = Number(signals?.activity_score || 0);

  let decision;

  if (intent >= 3 && activity >= 5) {
    decision = normalizeAction(ai?.recommended_action) || 'join';
  } else if (activity >= 3) {
    decision = 'monitor';
  } else {
    decision = 'ignore';
  }

  const quality = ai?.quality_score;
  if (typeof quality === 'number' && quality < 5) {
    decision = downgrade(decision);
  }

  return decision;
}

function toUpperDecision(decision) {
  const d = normalizeAction(decision);
  if (!d) return 'IGNORE';
  return d.toUpperCase();
}

module.exports = {
  getFinalDecision,
  toUpperDecision,
  normalizeAction,
};

