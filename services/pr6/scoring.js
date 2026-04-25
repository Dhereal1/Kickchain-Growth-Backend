function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function computeReferralScore({
  referralsTotal,
  winsLast30d,
  winStreak,
  dailyStreak,
} = {}) {
  const refs = num(referralsTotal);
  const wins = num(winsLast30d);
  const streak = num(winStreak);
  const daily = num(dailyStreak);

  const r = clamp(Math.min(refs, 25) / 25, 0, 1);
  const w = clamp(Math.min(wins, 20) / 20, 0, 1);
  const s = clamp(Math.min(streak, 10) / 10, 0, 1);
  const d = clamp(Math.min(daily, 14) / 14, 0, 1);

  const score01 = 0.4 * r + 0.3 * w + 0.2 * s + 0.1 * d;
  return clamp(Math.round(100 * score01), 0, 100);
}

function computeChurnRisk({ lastActiveAtMs, nowMs } = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const last = Number.isFinite(Number(lastActiveAtMs)) ? Number(lastActiveAtMs) : now;
  const diffMs = Math.max(0, now - last);
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  // clamp(round(100 * (days - 1) / 14), 0, 100)
  const raw = Math.round((100 * (days - 1)) / 14);
  return clamp(raw, 0, 100);
}

module.exports = {
  computeReferralScore,
  computeChurnRisk,
};

