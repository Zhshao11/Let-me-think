import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { scopedSession, readSession } from './session.mjs';
import { readProject, publicProject, memoryEvidence } from './projects.mjs';

export const MEMORY_CATEGORIES = { identity: '身份与偏好', topic: '研究主题', problem: '研究痛点', progress: '实验进展', plan: '决定与计划' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function location(scope, id) {
  if (!['project', 'conversation'].includes(scope) || !UUID.test(id ?? '')) fail('Invalid memory scope');
  return path.join(config.projectsDir, 'memory', `${scope}-${id}.json`);
}
export function readMemoryStore(scope, id) {
  const file = location(scope, id);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 0, items: [], checkpoints: {}, migrations: [] };
}
function writeStore(scope, id, store) {
  const file = location(scope, id); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file);
}
function active(item, projectId, sessionId = null) {
  if (item.status !== 'active') return false;
  if (!item.sourceSessionId) return true;
  const source = readSession(item.sourceSessionId);
  return Boolean(source && !source.sideContext && !source.deletedAt && source.projectId === projectId && (!sessionId || source.id === sessionId)
    && item.sourceMessageIds.every((id) => source.messages.some((message) => message.id === id)));
}
export function memoryView(projectId, sessionId) {
  if (projectId) readProject(projectId);
  if (sessionId&&scopedSession(sessionId,projectId).sideContext)return {project:{version:0,items:[]},conversation:{version:0,items:[]},categories:MEMORY_CATEGORIES};
  const project = projectId ? readMemoryStore('project', projectId) : { version: 0, items: [] };
  const conversation = sessionId ? readMemoryStore('conversation', sessionId) : { version: 0, items: [] };
  return { project: { version: project.version, items: project.items.filter((item) => active(item, projectId)) },
    conversation: { version: conversation.version, items: conversation.items.filter((item) => active(item, projectId, sessionId)) }, categories: MEMORY_CATEGORIES };
}

export function migrateProjectMemory(projectId) {
  if (!projectId) return;
  const project = publicProject(readProject(projectId));
  const store = readMemoryStore('project', projectId);
  const done = new Set(store.migrations ?? []); let changed = false;
  const cardLabels = { task: '研究任务', researchQuestion: '研究问题', datasets: '数据集', metrics: '指标', baselines: '基线', currentMethod: '当前方法', computeBudget: '计算预算', failureCases: '失败样例', bottleneck: '当前瓶颈' };
  for (const [key, value] of Object.entries(project.card)) {
    const migrationId = `card:${key}`;
    if (!value || done.has(migrationId)) continue;
    const now = new Date().toISOString();
    store.items.push({ id: crypto.randomUUID(), key: migrationId, category: ['bottleneck', 'failureCases'].includes(key) ? 'problem' : 'topic', topic: project.name,
      text: `${cardLabels[key]}：${value}`, certainty: 'user_report', status: 'active', scope: 'project', createdAt: now, updatedAt: now, userEdited: true, migrated: true, sourceSessionId: null, sourceMessageIds: [] });
    done.add(migrationId); changed = true;
  }
  for (const memory of project.memories.filter((item) => item.status === 'confirmed')) {
    const migrationId = `legacy:${memory.id}`;
    if (done.has(migrationId)) continue;
    const now = new Date().toISOString();
    store.items.push({ id: crypto.randomUUID(), key: migrationId, scope: 'project', category: memory.kind === 'result' ? 'progress' : memory.kind === 'hypothesis' ? 'problem' : 'plan',
      topic: project.name, text: memory.text, certainty: memory.kind === 'hypothesis' ? 'hypothesis' : 'user_report', status: 'active', createdAt: now, updatedAt: now,
      sourceSessionId: memory.sourceSessionId, sourceMessageIds: memory.sourceMessageIds, migrated: true, userEdited: true });
    done.add(migrationId); changed = true;
  }
  if (changed) { store.migrations = [...done]; store.version++; writeStore('project', projectId, store); }
}

export function validateAutomaticMemories(values, sources, projectId, existing) {
  if (!Array.isArray(values) || values.length > 16) fail('自动记忆结构无效');
  const messages = new Map(sources.map((message) => [message.id, message]));
  return values.map((value) => {
    if (value?.action === 'forget') {
      const previous = existing.find((item) => item.id === value.replaceId && item.scope === value.scope && item.status === 'active');
      if (!previous || !Array.isArray(value.sourceMessageIds) || !value.sourceMessageIds.length
        || value.sourceMessageIds.some((id) => messages.get(id)?.role !== 'user')) fail('删除记忆必须有当前用户的明确指令来源');
      return { ...previous, action: 'forget', replaceId: previous.id, sourceMessageIds: value.sourceMessageIds };
    }
    if (!value || !['project', 'conversation'].includes(value.scope) || !Object.hasOwn(MEMORY_CATEGORIES, value.category)
      || typeof value.key !== 'string' || !value.key.trim() || value.key.length > 120
      || typeof value.topic !== 'string' || !value.topic.trim() || value.topic.length > 80
      || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 3000
      || !['user_report', 'hypothesis', 'proposal'].includes(value.certainty)
      || !Array.isArray(value.sourceMessageIds) || !value.sourceMessageIds.length || value.sourceMessageIds.length > 10
      || value.sourceMessageIds.some((id) => !messages.has(id))) fail('自动记忆内容或来源校验失败');
    if (value.scope === 'project' && !projectId) value = { ...value, scope: 'conversation' };
    const refs = value.sourceMessageIds.map((id) => messages.get(id));
    if (value.certainty === 'user_report' && refs.some((message) => message.role !== 'user')) fail('助手内容不能自动记为用户事实');
    if (value.category === 'identity' && refs.some((message) => message.role !== 'user')) fail('身份记忆必须来自用户');
    if (value.replaceId) {
      const old = existing.find((item) => item.id === value.replaceId && item.scope === value.scope && item.status === 'active');
      if (!old) fail('修订目标不在当前记忆范围');
    }
    return { scope: value.scope, category: value.category, key: value.key.trim(), topic: value.topic.trim(), text: value.text.trim(), certainty: value.certainty,
      sourceMessageIds: [...new Set(value.sourceMessageIds)], replaceId: value.replaceId ?? null };
  });
}

export function applyAutomaticMemories({ projectId, sessionId, values, throughId }) {
  if(scopedSession(sessionId,projectId).sideContext)fail('子对话不会写入项目或对话记忆。',403);
  const stores = { project: projectId ? readMemoryStore('project', projectId) : null, conversation: readMemoryStore('conversation', sessionId) };
  const now = new Date().toISOString(); let saved = 0;
  for (const value of values) {
    const store = stores[value.scope]; if (!store) continue;
    if (value.action !== 'forget' && store.items.some((item) => item.status === 'deleted' && item.key === value.key && item.topic === value.topic)) continue;
    const old = value.replaceId ? store.items.find((item) => item.id === value.replaceId) : store.items.findLast((item) => item.key === value.key && item.topic === value.topic && item.category === value.category);
    if (value.action === 'forget' && old) { old.status = 'deleted'; old.userEdited = true; old.updatedAt = now; saved++; continue; }
    if (old?.userEdited || old?.status === 'deleted') continue;
    if (old?.text === value.text) continue;
    if (old) { old.status = 'superseded'; old.updatedAt = now; }
    if (store.items.some((item) => item.status === 'deleted' && item.text === value.text)) continue;
    if (store.items.length >= 2000) continue;
    store.items.push({ ...value, id: crypto.randomUUID(), sourceSessionId: sessionId, status: 'active', createdAt: now, updatedAt: now, userEdited: false }); saved++;
  }
  const local = stores.conversation;
  if (throughId) local.checkpoints[sessionId] = throughId;
  for (const [scope, store] of Object.entries(stores)) {
    if (!store) continue;
    store.version++;
    writeStore(scope, scope === 'project' ? projectId : sessionId, store);
  }
  return saved;
}

export function editMemory({ projectId, sessionId, scope, memoryId, expectedVersion, action, text, category, topic }) {
  if (sessionId&&scopedSession(sessionId,projectId).sideContext)fail('子对话不能修改项目或对话记忆。',403);
  if (scope === 'project') { if (!projectId) fail('没有选择项目'); readProject(projectId); }
  else if (scope !== 'conversation' || !sessionId) fail('没有选择对话');
  const id = scope === 'project' ? projectId : sessionId;
  const store = readMemoryStore(scope, id);
  if (expectedVersion !== store.version) fail('记忆已更新，请刷新后再保存。', 409);
  const item = store.items.find((memory) => memory.id === memoryId && active(memory, projectId, scope === 'conversation' ? sessionId : null));
  if (!item) fail('当前范围找不到这条记忆', 404);
  if (action === 'delete') item.status = 'deleted';
  else if (action === 'edit') {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 3000 || !Object.hasOwn(MEMORY_CATEGORIES, category) || typeof topic !== 'string' || !topic.trim() || topic.length > 80) fail('请填写有效内容、类别和主题');
    item.revisions ??= []; item.revisions.push({ text: item.text, updatedAt: item.updatedAt }); item.revisions = item.revisions.slice(-10);
    Object.assign(item, { text: text.trim(), category, topic: topic.trim() });
  } else fail('Invalid memory action');
  item.userEdited = true; item.updatedAt = new Date().toISOString();
  store.version++; writeStore(scope, id, store);
  return memoryView(projectId, sessionId);
}

export function memorySource(projectId, sessionId, scope, memoryId) {
  const view = memoryView(projectId, sessionId);
  const item = view[scope]?.items.find((memory) => memory.id === memoryId);
  if (!item) fail('记忆不存在', 404);
  return item.sourceSessionId ? memoryEvidence(projectId, item) : [];
}
