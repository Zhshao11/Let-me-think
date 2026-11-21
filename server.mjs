import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, assertConfigured, saveConfig, publicConfig } from './src/config.mjs';
import { buildPromptSections, renderSystemPrompt, sectionSummaries } from './src/prompt.mjs';
import {
  createSession, ensureSession, appendPromptSections, appendMessage,
  appendModelChange, readSession, listSessions,
} from './src/session.mjs';
import { streamChat } from './src/upstream.mjs';

const WEB_DIR = path.join(config.root, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 2_000_000) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, url) {
  const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const file = path.join(WEB_DIR, name);
  if (!file.startsWith(WEB_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

async function handleChat(req, res) {
  try {
    assertConfigured();
    const body = await readBody(req);
    const history = Array.isArray(body.messages) ? body.messages : [];
    const cleanHistory = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (cleanHistory.length === 0 || cleanHistory.at(-1).role !== 'user') {
      return sendJson(res, 400, { error: 'Last message must be a user message' });
    }

    const rawMode = config.systemPrompt === 'off';
    const sections = rawMode ? [] : buildPromptSections();

    let sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if (sessionId) {
      ensureSession(sessionId, config.model);
    } else {
      sessionId = createSession(config.model);
    }
    if (!rawMode) appendPromptSections(sessionId, sections);
    appendMessage(sessionId, 'user', cleanHistory.at(-1).content);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('meta', { sessionId, model: config.model, sections: sectionSummaries(sections) });
    write('progress', { text: '正在组织回答…' });

    const upstreamMessages = rawMode
      ? [...cleanHistory]
      : [{ role: 'system', content: renderSystemPrompt(sections) }, ...cleanHistory];

    let assistantText = '';
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    await streamChat({
      messages: upstreamMessages,
      model: config.model,
      signal: abort.signal,
      onDelta: (text) => { if (text) { assistantText += text; write('delta', { text }); } },
      onProgress: (text) => write('progress', { text }),
      onReasoning: (text) => write('reasoning', { text }),
    });

    if (assistantText.trim()) appendMessage(sessionId, 'assistant', assistantText);
    write('done', { sessionId, chars: assistantText.length });
    res.end();
  } catch (err) {
    if (!res.headersSent) return sendJson(res, 500, { error: err.message });
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${config.host}:${config.port}`);
  if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/style.css'].includes(url.pathname)) {
    return serveStatic(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    // Never expose the API key or base URL to the browser.
    return sendJson(res, 200, publicConfig());
  }
  if (req.method === 'POST' && url.pathname === '/api/config') {
    return (async () => {
      try {
        const body = await readBody(req);
        const result = saveConfig({
          apiKey: body.apiKey,
          baseUrl: body.baseUrl,
          model: body.model,
          systemPrompt: body.systemPrompt,
          reasoningEffort: body.reasoningEffort,
        });
        return sendJson(res, 200, { ok: true, ...result, ...publicConfig() });
      } catch (err) { return sendJson(res, 400, { error: err.message }); }
    })();
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return sendJson(res, 200, { sessions: listSessions() });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
    const id = url.pathname.slice('/api/sessions/'.length);
    try {
      const session = readSession(id);
      return session ? sendJson(res, 200, session) : sendJson(res, 404, { error: 'Session not found' });
    } catch (err) { return sendJson(res, 400, { error: err.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(config.port, config.host, () => {
  const status = config.apiKey && !config.apiKey.startsWith('sk-your-key') ? 'ready' : 'key missing';
  console.log(`Let-me-think listening on http://${config.host}:${config.port} [${status}]`);
  console.log(`model=${config.model} baseUrl=${config.baseUrl}`);
});
