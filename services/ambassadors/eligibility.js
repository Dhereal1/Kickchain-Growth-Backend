function computeAmbassadorEligibility({ userStats } = {}) {
  const refs = Number(userStats?.total_referrals || 0);
  const wins = Number(userStats?.wins || 0);
  const level = Number(userStats?.level || 1);

  // Simple additive rule; can evolve later.
  const eligible = refs >= 10 || wins >= 10 || level >= 7;
  const reason = eligible
    ? 'Eligible based on referrals/wins/level.'
    : 'Not eligible yet. Reach 10 referrals, 10 wins, or Level 7.';

  return { eligible, reason, thresholds: { referrals: 10, wins: 10, level: 7 } };
}

module.exports = {
  computeAmbassadorEligibility,
};

