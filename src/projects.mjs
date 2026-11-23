import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { readSession } from './session.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CARD_FIELDS = ['task', 'researchQuestion', 'datasets', 'metrics', 'baselines', 'currentMethod', 'computeBudget', 'failureCases', 'bottleneck'];
export const MEMORY_KINDS = ['result', 'hypothesis', 'decision', 'next_experiment'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function normalizeProjectId(id) {
  if (id === undefined || id === null || id === '') return null;
  if (typeof id !== 'string' || !UUID.test(id)) fail('Invalid project id');
  return id;
}
function projectPath(id) {
  if (!normalizeProjectId(id)) fail('A project is required');
  return path.join(config.projectsDir, `${id}.json`);
}
function save(project) {
  fs.mkdirSync(config.projectsDir, { recursive: true });
  const target = projectPath(project.id);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(project, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
  return project;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) fail('Project name must contain 1–80 characters');
  return value.trim();
}
function card(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !CARD_FIELDS.includes(key))) fail('Invalid project card');
  const result = Object.fromEntries(CARD_FIELDS.map((key) => {
    if (value[key] !== undefined && typeof value[key] !== 'string') fail('Project card values must be text');
    return [key, (value[key] ?? '').trim()];
  }));
  if (Buffer.byteLength(JSON.stringify(result)) > 2400) fail('项目卡片超过 2400 字节，请精简；详细内容可保存为项目记忆。');
  return result;
}
export function createProject(input) {
  const now = new Date().toISOString();
  return save({ schemaVersion: 1, id: crypto.randomUUID(), name: name(input.name), card: card(input.card ?? {}),
    version: 1, createdAt: now, updatedAt: now, memories: [] });
}
export function readProject(id, { includeDeleted = false } = {}) {
  const target = projectPath(id);
  if (!fs.existsSync(target)) fail('Project not found', 404);
  const project = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (project.id !== id) fail('Project identity mismatch', 500);
  if(project.deletedAt&&!includeDeleted)fail('项目已在回收站，请先恢复后使用。',404);
  return project;
}
export function listProjects({deleted=false}={}) {
  if (!fs.existsSync(config.projectsDir)) return [];
  return fs.readdirSync(config.projectsDir).filter(file=>UUID.test(file.slice(0,-5))&&file.endsWith('.json'))
    .map(file=>readProject(file.slice(0,-5),{includeDeleted:true})).filter(project=>Boolean(project.deletedAt)===deleted)
    .map(({id,name,updatedAt,version,deletedAt})=>({id,name,updatedAt,version,deletedAt:deletedAt??null}))
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export function isProjectDeleted(id){
  return fs.existsSync(projectPath(id))&&Boolean(readProject(id,{includeDeleted:true}).deletedAt);
}
export function deleteProject(id,{expectedVersion}={}){
  return mutate(id,expectedVersion,project=>{project.deletedAt=new Date().toISOString();});
}
export function restoreProject(id,{expectedVersion}={}){
  const project=readProject(id,{includeDeleted:true});
  if(!project.deletedAt)fail('项目不在回收站。',409);
  if(expectedVersion!==project.version)fail('项目已更新，请刷新后再恢复。',409);
  project.deletedAt=null;project.version++;project.updatedAt=new Date().toISOString();return save(project);
}
function mutate(id, expectedVersion, change) {
  const project = readProject(id);
  if (expectedVersion !== project.version) fail('项目已更新，请刷新后再保存。', 409);
  change(project);
  project.version++;
  project.updatedAt = new Date().toISOString();
  return save(project);
}
export function updateProject(id, input) {
  return mutate(id, input.expectedVersion, (project) => {
    if (input.name !== undefined) project.name = name(input.name);
    if (input.card !== undefined) project.card = card(input.card);
  });
}
export function memorySourceActive(projectId, memory) {
  if (!memory.sourceSessionId) return true;
  const source = readSession(memory.sourceSessionId);
  return Boolean(source && !source.sideContext && !source.deletedAt && source.projectId === projectId && memory.sourceMessageIds.every((id) => source.messages.some((message) => message.id === id)));
}
export function publicProject(project) {
  return { ...project, memories: project.memories.filter((memory) => ['candidate', 'confirmed'].includes(memory.status) && memorySourceActive(project.id, memory)) };
}
function validateMemory(project, value) {
  if (!MEMORY_KINDS.includes(value.kind) || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 1200) fail('记忆需要有效类型和不超过 1200 字节的正文。');
  const sourceSessionId = value.sourceSessionId ?? null;
  const sourceMessageIds = value.sourceMessageIds ?? [];
  if (!Array.isArray(sourceMessageIds) || sourceMessageIds.length > 8 || sourceMessageIds.some((id) => typeof id !== 'string')) fail('Invalid memory sources');
  if (sourceSessionId) {
    const source = readSession(sourceSessionId);
    if(source?.sideContext)fail('子对话内容不能写入项目记忆。',403);
    if (!source || source.deletedAt || source.projectId !== project.id || !sourceMessageIds.length) fail('Memory source is not active in this project', 404);
    const messages = sourceMessageIds.map((id) => source.messages.find((message) => message.id === id));
    if (messages.some((message) => !message)) fail('Memory source message not found', 404);
    if (['result', 'decision'].includes(value.kind) && messages.some((message) => message.role !== 'user')) fail('实验结果和用户决定必须引用用户原文；助手内容只能作为假设或实验建议。');
  } else if (sourceMessageIds.length) fail('Source messages require a source session');
  const supersedesId = value.supersedesId ?? null;
  if (supersedesId && !project.memories.some((memory) => memory.id === supersedesId && memory.status === 'confirmed' && memorySourceActive(project.id, memory))) fail('待修订记忆不属于当前项目或已失效。', 409);
  return { kind: value.kind, text: value.text.trim(), sourceSessionId, sourceMessageIds: [...new Set(sourceMessageIds)], supersedesId,
    contextEditedSource: value.contextEditedSource === true };
}
export function addMemoryCandidates(id, expectedVersion, values) {
  if (!Array.isArray(values) || values.length > 6) fail('At most 6 candidates per request');
  return mutate(id, expectedVersion, (project) => {
    const normalized = values.map((value) => validateMemory(project, value));
    if (project.memories.length + normalized.length > 500) fail('当前项目记忆已达 500 条上限。');
    for (const value of normalized) {
      if (project.memories.some((memory) => ['candidate', 'confirmed'].includes(memory.status) && memory.text === value.text && memory.kind === value.kind && memory.sourceSessionId === value.sourceSessionId && memory.supersedesId === value.supersedesId)) continue;
      project.memories.push({ id: crypto.randomUUID(), ...value, status: 'candidate', createdAt: new Date().toISOString() });
    }
  });
}
export function reviewMemory(id, memoryId, input) {
  return mutate(id, input.expectedVersion, (project) => {
    const memory = project.memories.find((item) => item.id === memoryId && item.status === 'candidate' && memorySourceActive(id, item));
    if (!memory) fail('待确认记忆不存在或已处理。', 404);
    if (input.action === 'reject') { memory.status = 'rejected'; memory.reviewedAt = new Date().toISOString(); return; }
    if (input.action !== 'confirm') fail('Expected confirm or reject');
    const checked = validateMemory(project, { ...memory, text: input.text ?? memory.text, kind: input.kind ?? memory.kind });
    if (checked.text !== memory.text || checked.kind !== memory.kind) {
      memory.proposedText = memory.text;
      memory.proposedKind = memory.kind;
      memory.editedOnReview = true;
    }
    if (memory.supersedesId) {
      const previous = project.memories.find((item) => item.id === memory.supersedesId);
      previous.status = 'superseded';
      previous.supersededBy = memory.id;
    }
    Object.assign(memory, checked, { status: 'confirmed', reviewedAt: new Date().toISOString() });
  });
}
export function memoryEvidence(projectId, memory) {
  if (!memory.sourceSessionId) return [{ role: 'user', content: '用户手动填写，未经独立核验。' }];
  if (!memorySourceActive(projectId, memory)) return [];
  const source = readSession(memory.sourceSessionId);
  return source.messages.filter((message) => memory.sourceMessageIds.includes(message.id)).map(({ id, role, content }) => ({ id, role, content }));
}
