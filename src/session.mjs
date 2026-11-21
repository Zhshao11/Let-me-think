import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionPath(id) {
  return path.join(config.sessionsDir, `${id}.jsonl`);
}

function writeLine(id, event) {
  fs.mkdirSync(config.sessionsDir, { recursive: true });
  const line = JSON.stringify({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event }) + '\n';
  fs.appendFileSync(sessionPath(id), line, 'utf8');
}

export function createSession(model) {
  const id = crypto.randomUUID();
  writeLine(id, { type: 'session', model });
  return id;
}

export function ensureSession(id, model) {
  if (!SESSION_ID_RE.test(id)) throw new Error('Invalid session id');
  if (!fs.existsSync(sessionPath(id))) createSessionWithId(id, model);
}

function createSessionWithId(id, model) {
  fs.mkdirSync(config.sessionsDir, { recursive: true });
  const line = JSON.stringify({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'session',
    sessionId: id,
    model,
  }) + '\n';
  fs.appendFileSync(sessionPath(id), line, 'utf8');
}

export function appendPromptSections(id, sections) {
  writeLine(id, { type: 'prompt_sections', sections: sections.map((s) => s.id) });
}

export function appendMessage(id, role, content) {
  writeLine(id, { type: 'message', role, content });
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
  for (const event of events) {
    if (event.type === 'session') {
      model = event.model ?? null;
      createdAt = event.timestamp ?? null;
    } else if (event.type === 'model_change') {
      model = event.model;
    } else if (event.type === 'message') {
      const message = { role: event.role, content: event.content, id: event.id, parentId, timestamp: event.timestamp };
      messages.push(message);
      parentId = event.id;
    }
  }
  return { id, model, createdAt, messages };
}

export function listSessions() {
  if (!fs.existsSync(config.sessionsDir)) return [];
  return fs.readdirSync(config.sessionsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const id = name.slice(0, -6);
      try {
        const session = readSession(id);
        if (!session) return null;
        const firstUser = session.messages.find((m) => m.role === 'user');
        return {
          id,
          model: session.model,
          createdAt: session.createdAt,
          messageCount: session.messages.length,
          preview: (firstUser?.content ?? '').slice(0, 80),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}
