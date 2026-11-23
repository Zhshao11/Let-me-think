import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { DEFAULT_RESPONSE_MODE } from './agent/policies.mjs';
import { paperSupplementStatus } from './agent/paper-supplement-status.mjs';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionPath(id) {
  return path.join(config.sessionsDir, `${id}.jsonl`);
}

function writeLine(id, event) {
  fs.mkdirSync(config.sessionsDir, { recursive: true });
  const record={ id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event };
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(sessionPath(id), line, 'utf8');
  return record;
}

export function createSession(model, projectId = null, {sideContext=null,responseMode=DEFAULT_RESPONSE_MODE}={}) {
  const id = crypto.randomUUID();
  writeLine(id, { type: 'session', model, projectId, ...(sideContext?{sideContext,responseMode}:{}) });
  return id;
}

export function ensureSession(id, model, projectId = null) {
  if (!SESSION_ID_RE.test(id)) throw new Error('Invalid session id');
  return scopedSession(id,projectId);
}

export function scopedSession(id, projectId = null, { deleted = false } = {}) {
  const session = readSession(id);
  if (!session || session.projectId !== projectId || Boolean(session.deletedAt) !== deleted) throw Object.assign(new Error('Session not found in this project'), { status: 404 });
  if(session.sideContext){
    const parent=readSession(session.sideContext.parentSessionId);
    if(!parent||parent.deletedAt||parent.projectId!==projectId||parent.sideContext)throw Object.assign(new Error('Parent conversation not found'),{status:404});
  }
  return session;
}

export function deleteSession(id, projectId = null) {
  scopedSession(id, projectId);
  writeLine(id, { type: 'session_deleted' });
}

export function restoreSession(id, projectId = null) {
  scopedSession(id, projectId, { deleted: true });
  writeLine(id, { type: 'session_restored' });
}

export function appendPromptSections(id, sections) {
  writeLine(id, { type: 'prompt_sections', sections: sections.map((s) => s.id) });
}

export function appendTurnContext(id, context) {
  writeLine(id, { type: 'turn_context', ...context });
}

export function appendSummary(id, summary) {
  writeLine(id, { type: 'context_summary', summary });
}

export function appendRuntimeEvent(id, event) {
  writeLine(id, { ...event, type: 'runtime_event' });
}

export function saveContextControls(id, projectId, expectedRevision, controls) {
  const session = scopedSession(id, projectId);
  if (expectedRevision !== session.contextRevision) throw Object.assign(new Error('上下文配置已更新，请重新加载。'), { status: 409 });
  writeLine(id, { type: 'context_controls', revision: expectedRevision + 1, controls });
  return readSession(id);
}

export function appendContextRequest(id, request) {
  if (!SESSION_ID_RE.test(id)) throw new Error('Invalid session id');
  const directory = path.join(config.sessionsDir, 'requests');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.jsonl`);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const lines = [...previous, JSON.stringify({ timestamp: new Date().toISOString(), ...request })].slice(-40);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readContextRequests(id) {
  if (!SESSION_ID_RE.test(id)) throw new Error('Invalid session id');
  const file = path.join(config.sessionsDir, 'requests', `${id}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-40).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

export function appendMessage(id, role, content, metadata = {}) {
  return writeLine(id, { ...metadata, type: 'message', role, content });
}

export function appendTurnStatus(id, status) {
  return writeLine(id, { type: 'turn_status', ...status });
}

export function reviseLastTurn(id, projectId, { messageId, message, expectedRevision }) {
  const session = scopedSession(id, projectId);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== session.messageRevision) throw Object.assign(new Error('对话已更新，请重新加载后再重发。'), { status: 409 });
  const at = session.messages.findLastIndex(m => m.role === 'user');
  const previous = session.messages[at];
  if (!previous || previous.id !== messageId) throw Object.assign(new Error('只能编辑或重发当前对话的最后一轮问题。'), { status: 409 });
  if (typeof message !== 'string' || !message.trim()) throw Object.assign(new Error('问题不能为空。'), { status: 400 });
  const content = message.trim(), changed = content !== previous.content;
  // Same-text retries retain source identity, so already dispatched paper jobs
  // remain idempotent. Edits get a new identity to invalidate old derived memory.
  const replacement = changed ? { id: crypto.randomUUID(), role: 'user', content, timestamp: new Date().toISOString() } : { ...previous };
  delete replacement.replyStatus; delete replacement.replyError; delete replacement.turnId;
  const removed = new Set(session.messages.slice(at).map(m => m.id));
  const controls = session.contextControls ? structuredClone(session.contextControls) : null;
  if (controls) {
    controls.excludedMessageIds = controls.excludedMessageIds.filter(key => !removed.has(key));
    for (const key of removed) delete controls.messageEdits[key];
  }
  writeLine(id, { type: 'turn_revised', targetMessageId: messageId, supersededMessageIds: [...removed], replacement,
    messageRevision: session.messageRevision + 1, controls, changed });
  return { session: readSession(id), source: replacement, changed };
}

export function appendModelChange(id, model) {
  writeLine(id, { type: 'model_change', model });
}

export function readSession(id) {
  if (!SESSION_ID_RE.test(id)) throw new Error('Invalid session id');
  const file = sessionPath(id);
  if (!fs.existsSync(file)) return null;
  const events = fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  const messages = [];
  let model = null;
  let createdAt = null;
  let parentId = null;
  let projectId = null;
  let deletedAt = null;
  // Legacy sessions predate research modes; use the default for the next turn.
  let turnContext = { responseMode: null, protocolVersion: null };
  let responseMode = DEFAULT_RESPONSE_MODE;
  let summary = null;
  let lastTurnContext = null;
  let contextRevision = 0;
  let contextControls = null;
  let lastUsage = null;
  let sideContext = null;
  let messageRevision = 0;
  let pendingPaperSupplement = null;
  for (const event of events) {
    if (event.type === 'session') {
      model = event.model ?? null;
      createdAt = event.timestamp ?? null;
      projectId = event.projectId ?? null;
      sideContext = event.sideContext??null;
      responseMode=event.responseMode??DEFAULT_RESPONSE_MODE;
    } else if (event.type === 'session_deleted') {
      deletedAt = event.timestamp;
    } else if (event.type === 'session_restored') {
      deletedAt = null;
    } else if (event.type === 'model_change') {
      model = event.model;
    } else if (event.type === 'turn_context') {
      pendingPaperSupplement = null;
      lastTurnContext = event;
      turnContext = { responseMode: event.responseMode, protocolVersion: event.protocolVersion };
      responseMode = event.requestedResponseMode ?? event.responseMode ?? DEFAULT_RESPONSE_MODE;
    } else if (event.type === 'context_summary') {
      summary = event.summary;
    } else if (event.type === 'context_controls') {
      contextRevision = event.revision;
      contextControls = event.controls;
    } else if (event.type === 'runtime_event' && event.event === 'usage') {
      lastUsage = event.usage;
    } else if (event.type === 'runtime_event' && event.event === 'proposal_workflow' && event.stage === 'ready') {
      // Recover decisions from older replies that already logged the workflow.
      pendingPaperSupplement = paperSupplementStatus({proposalWorkflow:event});
    } else if (event.type === 'turn_revised') {
      const at = messages.findIndex(m => m.id === event.targetMessageId);
      if (at >= 0) {
        messages.splice(at);
        parentId = messages.at(-1)?.id ?? null;
        messages.push({ ...turnContext, ...event.replacement, parentId });
        parentId = event.replacement.id;
        summary = null; lastUsage = null; contextControls = event.controls;
        messageRevision = event.messageRevision;
        pendingPaperSupplement = null;
      }
    } else if (event.type === 'turn_status') {
      const source = messages.find(m => m.id === event.userMessageId && m.role === 'user');
      if (source) { source.replyStatus = event.status; source.replyError = event.error ?? null; source.turnId = event.turnId; }
    } else if (event.type === 'message') {
      const message = { role: event.role, content: event.content, id: event.id, parentId, timestamp: event.timestamp, ...turnContext,
        ...(event.status ? { status: event.status } : {}), ...(event.error ? { error: event.error } : {}), ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.role==='assistant'?{paperSupplement:event.paperSupplement??(event.status==='incomplete'?null:pendingPaperSupplement)}:{}) };
      messages.push(message);
      parentId = event.id;
    }
  }
  return { id, model, createdAt, projectId, deletedAt, responseMode, messages, summary, lastTurnContext, contextRevision, contextControls, lastUsage, sideContext, messageRevision };
}

export function listSessions({ projectId = null, deleted = false, parentSessionId=null } = {}) {
  if (!fs.existsSync(config.sessionsDir)) return [];
  return fs.readdirSync(config.sessionsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const id = name.slice(0, -6);
      try {
        const session = readSession(id);
        if (!session || session.projectId !== projectId || Boolean(session.deletedAt) !== deleted) return null;
        if(parentSessionId?session.sideContext?.parentSessionId!==parentSessionId:session.sideContext)return null;
        const firstUser = session.messages.find((m) => m.role === 'user');
        return {
          id,
          projectId,
          deletedAt: session.deletedAt,
          model: session.model,
          responseMode: session.responseMode,
          createdAt: session.createdAt,
          messageCount: session.messages.length,
          ...(session.sideContext?{parentSessionId,purpose:session.sideContext.purpose??'discussion',inheritedMessageCount:session.sideContext.messages.length}:{}),
          preview: (firstUser?.content ?? '').slice(0, 80),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}
