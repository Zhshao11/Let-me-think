// A profile controls execution as well as presentation. No per-turn UI overrides.
export const PROFILE_VERSION = 'research-runtime-v2';
export const DEFAULT_RESPONSE_MODE = 'concise';
const PROFILES = {
  concise: {
    reasoningEffort: 'low', reviewPasses: 0, maxCompletionTokens: 2048,
    inputBudget: 14000, runtimeReserve: 0, recentTurns: 3,
    allowedTools: [], maxToolCalls: 0,
  },
  review: {
    reasoningEffort: 'high', reviewPasses: 1, maxCompletionTokens: 6144,
    inputBudget: 22000, runtimeReserve: 7000, recentTurns: 4,
    allowedTools: ['conversation_lookup', 'project_memory_lookup'], maxToolCalls: 2,
  },
  experiment: {
    reasoningEffort: 'high', reviewPasses: 1, maxCompletionTokens: 6144,
    inputBudget: 22000, runtimeReserve: 7000, recentTurns: 4,
    allowedTools: ['conversation_lookup', 'project_memory_lookup'], maxToolCalls: 2,
  },
  detailed: {
    reasoningEffort: 'medium', reviewPasses: 0, maxCompletionTokens: 8192,
    inputBudget: 24000, runtimeReserve: 4000, recentTurns: 6,
    allowedTools: ['conversation_lookup', 'project_memory_lookup'], maxToolCalls: 3,
  },
};

export function getAgentProfile(id = DEFAULT_RESPONSE_MODE) {
  if (typeof id !== 'string' || !Object.hasOwn(PROFILES, id)) throw new RangeError(`Invalid responseMode. Expected: ${Object.keys(PROFILES).join(', ')}`);
  return { id, version: PROFILE_VERSION, ...structuredClone(PROFILES[id]) };
}

export function resolveAgentProfile(id, { rawMode = false, reasoningSupported = true, contextWindow = null, tokenModel = null } = {}) {
  if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow < 16000)) throw new RangeError('CONTEXT_WINDOW_TOKENS must be an integer >= 16000');
  const profile = getAgentProfile(id);
  profile.rawMode = rawMode;
  if (rawMode) Object.assign(profile, { reasoningEffort: null, reviewPasses: 0, allowedTools: [], maxToolCalls: 0, runtimeReserve: 0 });
  if (!reasoningSupported) profile.reasoningEffort = null;
  profile.contextWindow = contextWindow;
  profile.tokenModel = tokenModel;
  profile.inputBudget = contextWindow ? contextWindow - profile.maxCompletionTokens - 1024 : 24000;
  profile.windowUnknown = !contextWindow;
  if (profile.inputBudget < 8000) throw new RangeError('Context window is too small for this profile');
  return profile;
}
