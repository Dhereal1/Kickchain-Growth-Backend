function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function getCommunityDecision(community) {
  const intent = Number(community?.intent_score || 0);
  const activity = Number(community?.activity_score || 0);

  if (intent >= 3 && activity >= 5) return 'JOIN';
  if (activity >= 3) return 'MONITOR';
  return 'IGNORE';
}

function computeConfidenceScore({ intentScore, activityScore, avgEngagementScore }) {
  const intentStrength = clamp01((Number(intentScore || 0) / 10) * 1.0);
  const activityStrength = clamp01((Number(activityScore || 0) / 25) * 1.0);
  const engagementStrength = clamp01((Number(avgEngagementScore || 0) / 30) * 1.0);

  return clamp01(intentStrength * 0.5 + activityStrength * 0.3 + engagementStrength * 0.2);
}

function getCommunityReason(community) {
  const intent = Number(community?.intent_score || 0);
  const activity = Number(community?.activity_score || 0);
  const avgEng = Number(community?.avg_engagement_score || 0);

  const decision = getCommunityDecision({ intent_score: intent, activity_score: activity });

  if (decision === 'JOIN') {
    const parts = [
      `High activity (${activity} msgs)`,
      `strong intent (${intent} signals)`,
    ];
    if (avgEng > 0) parts.push(`engagement looks real (avg ${avgEng.toFixed(1)})`);
    return parts.join(' and ') + '.';
  }

  if (decision === 'MONITOR') {
    if (intent >= 3) return `Intent signals exist (${intent}), but activity is still moderate (${activity} msgs).`;
    if (avgEng > 0) return `Active (${activity} msgs) with some engagement (avg ${avgEng.toFixed(1)}), but weak intent.`;
    return `Active (${activity} msgs) but low intent signals (${intent}).`;
  }

  if (activity === 0 && intent === 0) return 'No activity or intent signals detected in the recent window.';
  return `Low activity (${activity} msgs) and weak intent signals (${intent}).`;
}

module.exports = {
  getCommunityDecision,
  getCommunityReason,
  computeConfidenceScore,
};

