function decidePr6Nudge({ referralScore, churnRisk } = {}) {
  const r = Number(referralScore) || 0;
  const c = Number(churnRisk) || 0;

  // Decision rules (in order):
  // 1) High churn + high referral
  if (c >= 70 && r >= 50) return { nudge_type: 'churn_referral', grant_bonus: true };
  // 2) High referral propensity
  if (r >= 75) return { nudge_type: 'referral_boost', grant_bonus: true };
  // 3) High churn only
  if (c >= 70) return { nudge_type: 'churn_play', grant_bonus: false };

  return null;
}

module.exports = {
  decidePr6Nudge,
};

