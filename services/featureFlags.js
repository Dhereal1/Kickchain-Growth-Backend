function truthy(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function isGrowthCrmEnabled() {
  return truthy(process.env.ENABLE_GROWTH_CRM);
}

function isMatchHypeEventsEnabled() {
  return truthy(process.env.ENABLE_MATCH_HYPE_EVENTS);
}

function isTournamentOrchestrationEnabled() {
  return truthy(process.env.ENABLE_TOURNAMENT_ORCHESTRATION);
}

function isAmbassadorsEnabled() {
  return truthy(process.env.ENABLE_AMBASSADORS);
}

function isCopilotEnabled() {
  return truthy(process.env.ENABLE_COPILOT);
}

function isPr6ReferralEngineEnabled() {
  return truthy(process.env.ENABLE_PR6_REFERRAL_ENGINE);
}

module.exports = {
  truthy,
  isGrowthCrmEnabled,
  isMatchHypeEventsEnabled,
  isTournamentOrchestrationEnabled,
  isAmbassadorsEnabled,
  isCopilotEnabled,
  isPr6ReferralEngineEnabled,
};
