import crypto from 'node:crypto';

export const DEFAULT_CONTEXT_CONTROLS = {
  includeProjectCard: true, includeProjectMemories: true, includeHistory: true,
  excludedMemoryIds: [], excludedMessageIds: [], messageEdits: {}, memoryEdits: {},
  cardOverride: null, summaryMode: 'auto', summaryText: '', extraContext: '', allowSourceLookup: true,
};
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function validateContextControls(input, session, project) {
  if (!plain(input) || Object.keys(input).some((key) => !Object.hasOwn(DEFAULT_CONTEXT_CONTROLS, key))) fail('Invalid context control fields');
  const controls = { ...structuredClone(DEFAULT_CONTEXT_CONTROLS), ...input };
  for (const key of ['includeProjectCard', 'includeProjectMemories', 'includeHistory', 'allowSourceLookup']) {
    if (typeof controls[key] !== 'boolean') fail(`Invalid ${key}`);
  }
  const messageIds = new Set(session.messages.map((message) => message.id));
  const memoryIds = new Set((project?.memories ?? []).map((memory) => memory.id));
  for (const [key, allowed] of [['excludedMessageIds', messageIds], ['excludedMemoryIds', memoryIds]]) {
    if (!Array.isArray(controls[key]) || controls[key].length > 2000 || controls[key].some((id) => typeof id !== 'string' || !allowed.has(id))) fail('上下文条目不属于当前会话或项目。', 404);
    controls[key] = [...new Set(controls[key])];
  }
  for (const [key, allowed] of [['messageEdits', messageIds], ['memoryEdits', memoryIds]]) {
    if (!plain(controls[key]) || Object.keys(controls[key]).length > 100) fail('Invalid context edits');
    for (const [id, text] of Object.entries(controls[key])) {
      if (!allowed.has(id)) fail('上下文编辑越出当前会话或项目。', 404);
      if (typeof text !== 'string' || Buffer.byteLength(text) > 6000) fail('单条上下文修订不能超过 6000 字节。');
    }
  }
  if (!['auto', 'off', 'manual'].includes(controls.summaryMode)) fail('Invalid summaryMode');
  for (const [key, limit] of [['summaryText', 3500], ['extraContext', 6000]]) {
    if (typeof controls[key] !== 'string' || Buffer.byteLength(controls[key]) > limit) fail(`${key} 超出长度预算。`);
  }
  if (controls.cardOverride !== null) {
    if (!project || !plain(controls.cardOverride) || Object.keys(controls.cardOverride).some((key) => !Object.hasOwn(project.card, key))) fail('Invalid card override');
    controls.cardOverride = { ...project.card, ...controls.cardOverride };
    if (Object.values(controls.cardOverride).some((value) => typeof value !== 'string') || Buffer.byteLength(JSON.stringify(controls.cardOverride)) > 2400) fail('项目卡片修订不能超过 2400 字节。');
  }
  if (Buffer.byteLength(JSON.stringify(controls)) > 50000) fail('上下文配置超过保存预算。');
  return structuredClone(controls);
}

export function controlledHistory(session, controls) {
  if (!controls.includeHistory) return [];
  const excluded = new Set(controls.excludedMessageIds);
  return session.messages.filter((message) => !excluded.has(message.id)).map((message) => {
    if (!Object.hasOwn(controls.messageEdits, message.id)) return { ...message };
    return { ...message, content: `【用户在上下文编辑器修订的投递版本；原始消息保留，来源身份仍为${message.role}】\n${controls.messageEdits[message.id]}`, contextEdited: true };
  });
}

export function controlledMemories(memories, access) {
  if (!access?.controls) return memories;
  const { controls, sessionId, allMessageIds } = access;
  if (!controls.includeProjectMemories) return [];
  const blocked = new Set([...controls.excludedMessageIds, ...Object.keys(controls.messageEdits), ...(!controls.includeHistory ? allMessageIds : [])]);
  return memories.filter((memory) => !controls.excludedMemoryIds.includes(memory.id)
    && !(memory.sourceSessionId === sessionId && memory.sourceMessageIds.some((id) => blocked.has(id))))
    .map((memory) => Object.hasOwn(controls.memoryEdits, memory.id)
      ? { ...memory, text: `【用户的上下文修订，非原文直接引述】${controls.memoryEdits[memory.id]}`, contextEdited: true }
      : { ...memory });
}

export function contextAccess(session, controls) {
  return { controls, sessionId: session.id ?? null, allMessageIds: session.messages.map((message) => message.id) };
}

export function contextStateKey({ session, project, model, profile, systemPrompt, endpoint }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    session: { id: session.id, projectId: session.projectId, messages: session.messages, summary: session.summary,
      lastTurnContext: session.lastTurnContext, contextRevision: session.contextRevision ?? 0, deletedAt: session.deletedAt },
    memoryVersion: session.memoryVersion,
    project, model, profile, systemPrompt, endpoint,
  })).digest('hex');
}

export function emptySession(projectId = null) {
  return { id: null, projectId, messages: [], summary: null, lastTurnContext: null, contextRevision: 0, contextControls: null };
}
