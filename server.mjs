import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { markdownBrowserBundle,mathBrowserAsset } from './src/markdown-vendor.mjs';
import { config, assertConfigured, saveConfig, publicConfig } from './src/config.mjs';
import { sectionSummaries } from './src/prompt.mjs';
import { getResponseMode, PROTOCOL_VERSION } from './src/agent/policies.mjs';
import {
  createSession, ensureSession, appendPromptSections, appendMessage,
  appendTurnContext, readSession, listSessions,
  appendSummary, appendRuntimeEvent,
  scopedSession, deleteSession, restoreSession,
  saveContextControls, appendContextRequest, readContextRequests, reviseLastTurn, appendTurnStatus,
} from './src/session.mjs';
import { normalizeProjectId, createProject, readProject, listProjects, updateProject,
  publicProject, addMemoryCandidates, reviewMemory, memoryEvidence,deleteProject,restoreProject } from './src/projects.mjs';
import { extractMemoryCandidates } from './src/agent/project-memory.mjs';
import { contextSpec, assembleManagedContext, ContextPreviews } from './src/agent/context-manager.mjs';
import { emptySession, validateContextControls, controlledHistory, DEFAULT_CONTEXT_CONTROLS } from './src/agent/context-controls.mjs';
import { runAgent } from './src/agent/runtime.mjs';
import { paperSupplementStatus } from './src/agent/paper-supplement-status.mjs';
import { memoryView, migrateProjectMemory, editMemory, memorySource } from './src/memory-store.mjs';
import { syncMemories } from './src/agent/memory.mjs';
import { registerPaper,listPapers,getPaper,paperDirectory,paperChunks } from './src/papers/store.mjs';
import { enqueuePaper,resumePaperJobs,pausePaperJobsForProject,retryPaper,importArxiv,PAPER_FIELDS } from './src/papers/pipeline.mjs';
import { searchArxiv } from './src/papers/discovery.mjs';
import { configureLibraryJobs,resumeLibraryJobs,startLibraryExpansion,controlLibraryExpansion,pauseLibraryJobsForSession,pauseLibraryJobsForProject } from './src/papers/library-jobs.mjs';
import { listLibraryJobs,getLibraryJob,publicLibraryJob } from './src/papers/library-jobs-store.mjs';
import {createSideConversation,listSideConversations} from './src/side-conversations.mjs';

const WEB_DIR = path.join(config.root, 'web');
const MARKDOWN_VENDOR = markdownBrowserBundle();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const activeSessions = new Set();
const activeProjects = new Set();
configureLibraryJobs({isSessionActive:id=>activeSessions.has(id)});
const contextPreviews = new ContextPreviews();
function assertProjectIdle(projectId) {
  if (projectId && activeProjects.has(projectId)) throw Object.assign(new Error('当前项目有任务正在执行，请完成后再修改或删除。'), { status: 409 });
}

function contextScope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Expected a JSON object'), { status: 400 });
  const projectId = normalizeProjectId(body.projectId);
  const project = projectId ? readProject(projectId) : null;
  const sessionId = body.sessionId || null;
  const session = sessionId ? scopedSession(sessionId, projectId) : emptySession(projectId);
  return { projectId, project, sessionId, session };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    req.setEncoding('utf8');
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

function readPdf(req){return new Promise((resolve,reject)=>{
  let size=0,failed=false;const chunks=[];
  req.on('data',chunk=>{if(failed)return;size+=chunk.length;if(size>35*1024*1024){failed=true;chunks.length=0;reject(Object.assign(new Error('PDF 大小不能超过 35 MB'),{status:413}));}else chunks.push(chunk);});
  req.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks));});req.on('error',reject);req.on('aborted',()=>reject(new Error('上传已中断')));
});}

function serveStatic(req, res, url) {
  if(url.pathname.startsWith('/vendor/katex/')){
    const asset=mathBrowserAsset(url.pathname.slice('/vendor/katex/'.length));
    if(!asset){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    fs.createReadStream(asset.file).on('error',()=>res.end()).pipe(res);return;
  }
  if(url.pathname==='/vendor/markdown-it.min.js'){
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache'});
    res.end(MARKDOWN_VENDOR);return;
  }
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
  let lockedSession = null;
  let lockedProject = null;
  let activeTurn = null, assistantText = '', replySaved = false;
  try {
    assertConfigured();
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Expected a JSON object' });
    let responseMode;
    try {
      responseMode = getResponseMode(body.responseMode).id;
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    // The server owns history. Legacy clients may supply messages; only the
    // last user input is accepted, never client-supplied assistant/system history.
    const last = Array.isArray(body.messages) ? body.messages.at(-1) : null;
    const currentMessage = body.message ?? (last?.role === 'user' ? last.content : null);
    if (typeof currentMessage !== 'string' || !currentMessage.trim()) return sendJson(res, 400, { error: 'A non-empty user message is required' });
    const model = config.model;
    const projectId = normalizeProjectId(body.projectId);
    const project = projectId ? readProject(projectId) : null;
    const turnConfig = { ...config };
    const rawMode = turnConfig.systemPrompt === 'off';
    let sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if(body.retry!==undefined&&(!sessionId||!body.retry||typeof body.retry!=='object'||Array.isArray(body.retry)||Object.keys(body.retry).some(k=>!['messageId','expectedRevision'].includes(k))||body.previewId))return sendJson(res,400,{error:'重发需要当前会话、最后一条问题ID和对话版本，不支持复用旧发送预览。'});
    if (sessionId && activeSessions.has(sessionId)) return sendJson(res, 409, { error: 'This session already has an active turn' });
    if (sessionId) {
      try { ensureSession(sessionId, model, projectId); }
      catch (err) { return sendJson(res, err.status ?? 400, { error: err.message }); }
    }
    const originalSession = sessionId ? readSession(sessionId) : emptySession(projectId);
    if(!originalSession.sideContext){
      assertProjectIdle(projectId);
      if(config.automaticMemory)migrateProjectMemory(projectId);
    }
    let managed = null;
    let preparationRequests = [];
    if (body.previewId) {
      const preview = contextPreviews.get(body.previewId);
      const spec = contextSpec({ session: originalSession, project, request: { message: currentMessage.trim(), responseMode, contextControls: preview.managed.controls }, config: turnConfig });
      if (preview.sessionId !== sessionId || preview.projectId !== projectId || preview.message !== currentMessage.trim()
        || preview.responseMode !== responseMode || preview.stateKey !== spec.stateKey) {
        return sendJson(res, 409, { error: '问题、模式、项目或会话状态已改变，请重新生成发送预览。' });
      }
      managed = preview.managed;
      preparationRequests = preview.preparationRequests;
      contextPreviews.consume(body.previewId);
    } else if (body.contextControls !== undefined) return sendJson(res, 400, { error: '请先保存上下文配置，或生成准确预览后发送。' });
    if (!sessionId) sessionId = createSession(model, projectId);
    activeSessions.add(sessionId);
    lockedSession = sessionId;
    if (projectId&&!originalSession.sideContext) { activeProjects.add(projectId); lockedProject = projectId; }
    let session = readSession(sessionId), retrySource = null;
    const turnId = crypto.randomUUID();
    if(body.retry){
      const revised=reviseLastTurn(sessionId,projectId,{...body.retry,message:currentMessage.trim()});
      session=revised.session;retrySource=revised.source;
      activeTurn={turnId,userMessageId:retrySource.id};
      appendTurnStatus(sessionId,{...activeTurn,status:'running'});
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]);
    const write = (event, data) => {
      if (!res.headersSent) res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onProgress = (text) => write('progress', { text });
    let requestIndex = 0;
    const onRequest = (request) => {
      const record = { turnId, index: ++requestIndex, timestamp: new Date().toISOString(), ...request };
      appendContextRequest(sessionId, record);
      write('context_request', record);
    };
    const synchronize = async (history, summary) => syncMemories({ projectId, session: readSession(sessionId), history, summary, model,
      encoding: turnConfig.tokenizerEncoding || 'o200k_base', reasoningSupported: turnConfig.reasoningSupported, signal,
      onRequest: (payload) => onRequest({ stage: 'memory_update', payload }) });
    for (const request of preparationRequests) onRequest({ ...request, origin: 'preview_preparation' });
    if (!managed) managed = await assembleManagedContext({
      session, project, request: { message: currentMessage.trim(), responseMode, omitMessageId:retrySource?.id }, config: turnConfig, signal, onProgress,
      onSummary: (summary) => appendSummary(sessionId, summary), onRequest: (payload) => onRequest({ stage: 'summary', payload }),
      onCompression: turnConfig.automaticMemory&&!session.sideContext ? async ({ history, summary }) => {
        try { await synchronize(history, summary); } catch (error) { write('memory_status', { warning: error.message }); }
      } : undefined,
    });
    const { profile, sections, context } = managed;
    const turnContext = {
      requestedResponseMode: responseMode, responseMode: rawMode ? null : responseMode,
      protocolVersion: rawMode ? null : PROTOCOL_VERSION, systemPrompt: rawMode ? 'off' : 'sections',
      runtimeProfile: profile, context: context.stats,
      project: project ? { id: project.id, name: project.name, version: project.version } : null,
      turnId, previewId: body.previewId ?? null, contextRevision: session.contextRevision,
      contextControls: managed.controls,
    };
    if (!rawMode) appendPromptSections(sessionId, sections);
    appendTurnContext(sessionId, turnContext);
    const userSource=retrySource??appendMessage(sessionId, 'user', currentMessage.trim(),{turnId});
    if(!activeTurn){activeTurn={turnId,userMessageId:userSource.id};appendTurnStatus(sessionId,{...activeTurn,status:'running'});}
    write('meta', { sessionId, model, ...turnContext, userMessageId:userSource.id,messageRevision:session.messageRevision,sections: sectionSummaries(sections) });
    onProgress('正在组织回答…');
    const execution = await runAgent({
      messages: context.messages, profile, history: managed.history, projectId,sessionId,sourceId:userSource.id,contextAccess: managed.access, model, signal, onProgress, onRequest,
      onDelta: (text) => { assistantText += text; write('delta', { text }); },
      onEvent: (event) => appendRuntimeEvent(sessionId, event),
    });
    execution.paperSupplement=paperSupplementStatus(execution);
    if (assistantText.trim()) appendMessage(sessionId, 'assistant', assistantText,{turnId,status:'complete',paperSupplement:execution.paperSupplement});
    replySaved=true;
    appendTurnStatus(sessionId,{...activeTurn,status:'complete'});
    appendRuntimeEvent(sessionId, { event: 'usage', usage: execution.usage, callsUsage: execution.callsUsage });
    let memory = null;
    if (turnConfig.automaticMemory&&!session.sideContext) {
      onProgress('正在整理研究记忆…');
      try {
        const latest = readSession(sessionId);
        const controls = validateContextControls(latest.contextControls ?? DEFAULT_CONTEXT_CONTROLS, latest, project);
        memory = await synchronize(controlledHistory(latest, controls), latest.summary);
        write('memory_status', memory);
      } catch (error) { memory = { warning: error.message }; write('memory_status', memory); }
    }
    write('done', { sessionId, chars: assistantText.length, execution, memory });
    res.end();
  } catch (err) {
    if(lockedSession&&activeTurn&&!replySaved){
      const error=err.name==='AbortError'?'连接已中断，回复未完成。':String(err.message).slice(0,500);
      if(assistantText.trim())appendMessage(lockedSession,'assistant',assistantText,{turnId:activeTurn.turnId,status:'incomplete',error});
      appendTurnStatus(lockedSession,{...activeTurn,status:'failed',error});
    }
    if (!res.headersSent) return sendJson(res, err.status ?? 500, { error: err.message });
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    if (lockedSession) activeSessions.delete(lockedSession);
    if (lockedProject) activeProjects.delete(lockedProject);
  }
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, `http://${config.host}:${config.port}`);
  if(url.pathname.startsWith('/api/')&&url.searchParams.get('projectId'))readProject(normalizeProjectId(url.searchParams.get('projectId')));
  if (req.method === 'GET' && (url.pathname.startsWith('/vendor/katex/')||['/', '/index.html', '/favicon.ico', '/favicon-32.png', '/favicon.png', '/app.js', '/side-chat.js', '/workspace-layout.js', '/project-manager.js', '/turn-actions.js', '/markdown.js', '/vendor/markdown-it.min.js', '/context-usage.js', '/memory-console.js', '/papers.js', '/style.css'].includes(url.pathname))) {
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
          reasoningSupported: body.reasoningSupported,
          contextWindow: body.contextWindow,
          tokenizerEncoding: body.tokenizerEncoding,
        });
        return sendJson(res, 200, { ok: true, ...result, ...publicConfig() });
      } catch (err) { return sendJson(res, 400, { error: err.message }); }
    })();
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const projectId = normalizeProjectId(url.searchParams.get('projectId'));
    if (projectId) readProject(projectId);
    return sendJson(res, 200, { sessions: listSessions({ projectId, deleted: url.searchParams.get('deleted') === 'true' }).map(session=>({...session,isResponding:activeSessions.has(session.id)})) });
  }
  const sidesRoute=url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/side-conversations$/);
  if(sidesRoute){
    const projectId=normalizeProjectId(url.searchParams.get('projectId')),parentId=sidesRoute[1];
    if(req.method==='GET')return sendJson(res,200,{conversations:listSideConversations(parentId,projectId,{deleted:url.searchParams.get('deleted')==='true',purpose:url.searchParams.get('purpose')??'discussion'})});
    if(req.method==='POST'){
      const body=await readBody(req);
      if(activeSessions.has(parentId))return sendJson(res,409,{error:'请等主对话当前回复完成后再开启子对话。'});
      return sendJson(res,201,{conversation:createSideConversation(parentId,projectId,{purpose:body.purpose??'discussion'})});
    }
    return sendJson(res,405,{error:'Method not allowed'});
  }
  if(url.pathname.startsWith('/api/library-jobs')){
    const projectId=normalizeProjectId(url.searchParams.get('projectId'));
    const sessionId=url.searchParams.get('sessionId');
    if(!projectId||!sessionId)return sendJson(res,400,{error:'补库任务属于一个项目内的具体对话，请先打开对话。'});
    const session=scopedSession(sessionId,projectId);readProject(projectId);
    const taskSessionId=session.sideContext?.purpose==='library'?session.sideContext.parentSessionId:sessionId;
    if(url.pathname==='/api/library-jobs'&&req.method==='GET')return sendJson(res,200,{jobs:listLibraryJobs(projectId,taskSessionId).map(publicLibraryJob)});
    if(url.pathname==='/api/library-jobs'&&req.method==='POST'){
      const body=await readBody(req);return sendJson(res,202,startLibraryExpansion({projectId,sessionId,sourceId:body.sourceId,maxNewPapers:body.maxNewPapers??3,responseMode:getResponseMode(body.responseMode).id}));
    }
    const route=url.pathname.match(/^\/api\/library-jobs\/([0-9a-f-]+)(\/control)?$/);
    if(route){
      if(!route[2]&&req.method==='GET')return sendJson(res,200,{job:publicLibraryJob(getLibraryJob(projectId,taskSessionId,route[1]))});
      if(route[2]&&req.method==='POST'){const body=await readBody(req);if(session.sideContext&&session.sideContext.purpose!=='library')return sendJson(res,403,{error:'请在论文补库窗口管理任务。'});return sendJson(res,200,{job:controlLibraryExpansion({projectId,sessionId,jobId:route[1],action:body.action,sourceId:body.sourceId,maxNewPapers:body.maxNewPapers})});}
    }
    return sendJson(res,404,{error:'补库任务接口不存在'});
  }
  if(url.pathname.startsWith('/api/papers')){
    const projectId=normalizeProjectId(url.searchParams.get('projectId'));
    if(!projectId)return sendJson(res,400,{error:'请先选择一个研究项目，论文保存在项目内。'});
    readProject(projectId);
    if(url.pathname==='/api/papers'&&req.method==='GET')return sendJson(res,200,{papers:listPapers(projectId),fields:PAPER_FIELDS});
    if(url.pathname==='/api/papers/upload'&&req.method==='POST'){
      const bytes=await readPdf(req);readProject(projectId);const result=registerPaper({projectId,bytes,name:url.searchParams.get('name')});
      if(!result.duplicate)enqueuePaper(projectId,result.paper.id);
      return sendJson(res,202,result);
    }
    if(url.pathname==='/api/papers/import'&&req.method==='POST')return sendJson(res,202,await importArxiv(projectId,(await readBody(req)).url));
    if(url.pathname==='/api/papers/search-online'&&req.method==='GET')return sendJson(res,200,await searchArxiv(url.searchParams.get('q'),{recent:url.searchParams.get('recent')==='true'}));
    const paperRoute=url.pathname.match(/^\/api\/papers\/([0-9a-f-]+)(?:\/(retry|source|assets\/([a-zA-Z0-9._-]+)))?$/);
    if(paperRoute){
      const paper=getPaper(projectId,paperRoute[1]);
      if(paperRoute[2]==='retry'&&req.method==='POST')return sendJson(res,202,{paper:retryPaper(projectId,paper.id)});
      if(paperRoute[2]==='source'&&req.method==='GET'){
        const source=url.searchParams.get('sourceId');
        return sendJson(res,200,{paper:{id:paper.id,title:paper.title},sources:paperChunks(projectId,paper.id,{sourceIds:source?[source]:undefined,page:url.searchParams.has('page')?Number(url.searchParams.get('page')):undefined})});
      }
      if(paperRoute[3]&&req.method==='GET'){
        const name=paperRoute[3];if(!/^(original\.pdf|document\.md|page-\d+\.png|figure-\d+\.png)$/.test(name))return sendJson(res,404,{error:'附件不存在'});
        const filename=path.join(paperDirectory(paper.id),name);if(!fs.existsSync(filename))return sendJson(res,404,{error:'附件尚未生成'});
        res.writeHead(200,{'Content-Type':name.endsWith('.pdf')?'application/pdf':name.endsWith('.png')?'image/png':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(filename).on('error',()=>res.end()).pipe(res);return;
      }
      if(!paperRoute[2]&&req.method==='GET')return sendJson(res,200,{paper,fields:PAPER_FIELDS});
    }
    return sendJson(res,404,{error:'论文接口不存在'});
  }
  if (url.pathname === '/api/context/usage' && req.method === 'POST') {
    const body = await readBody(req);
    const { session, project } = contextScope(body);
    const managed = await assembleManagedContext({ session, project, request: { message: body.message ?? '', responseMode: body.responseMode ?? 'concise' }, config, dryRun: true });
    return sendJson(res, 200, { stats: managed.context.stats, tokenModel: managed.profile.tokenModel, lastUsage: session.lastUsage ?? null });
  }
  if (url.pathname === '/api/memory-console' && req.method === 'GET') {
    const projectId = normalizeProjectId(url.searchParams.get('projectId'));
    const sessionId = url.searchParams.get('sessionId') || null;
    const session = sessionId ? scopedSession(sessionId, projectId) : emptySession(projectId);
    if (projectId&&!session.sideContext) migrateProjectMemory(projectId);
    const view = memoryView(projectId, sessionId);
    const project = projectId ? readProject(projectId) : null;
    const context = await assembleManagedContext({ session, project, request: { message: url.searchParams.get('message') ?? '', responseMode: url.searchParams.get('mode') ?? 'concise' }, config, dryRun: true });
    return sendJson(res, 200, { ...view, stats: context.context.stats, summary: session.summary, controls: context.controls,
      contextRevision: session.contextRevision, history: session.messages.map(({ id, role, content }) => ({ id, role, content })),
      lastUsage: session.lastUsage ?? null, tokenModel: publicConfig().tokenModel });
  }
  const memoryRoute = url.pathname.match(/^\/api\/memory-console\/([0-9a-f-]+)(\/source)?$/);
  if (memoryRoute) {
    const projectId = normalizeProjectId(url.searchParams.get('projectId'));
    const sessionId = url.searchParams.get('sessionId') || null;
    const scope = url.searchParams.get('scope');
    if (!['project', 'conversation'].includes(scope)) return sendJson(res, 400, { error: 'Invalid memory scope' });
    memoryView(projectId, sessionId);
    if (memoryRoute[2] && req.method === 'GET') return sendJson(res, 200, { sources: memorySource(projectId, sessionId, scope, memoryRoute[1]) });
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const body = await readBody(req); assertProjectIdle(projectId);
      if (sessionId && activeSessions.has(sessionId)) return sendJson(res, 409, { error: '当前对话正在整理，请稍后操作。' });
      return sendJson(res, 200, editMemory({ projectId, sessionId, scope, memoryId: memoryRoute[1], ...body, action: req.method === 'DELETE' ? 'delete' : 'edit' }));
    }
  }
  const requestsRoute = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/context-requests$/);
  if (requestsRoute && req.method === 'GET') {
    const projectId = normalizeProjectId(url.searchParams.get('projectId'));
    scopedSession(requestsRoute[1], projectId, { deleted: url.searchParams.get('deleted') === 'true' });
    return sendJson(res, 200, { requests: readContextRequests(requestsRoute[1]) });
  }
  if (['/api/context/inspect', '/api/context/preview', '/api/context/controls'].includes(url.pathname)) {
    const body = await readBody(req);
    const { sessionId, session, projectId, project } = contextScope(body);
    if (req.method === 'PUT' && url.pathname === '/api/context/controls') {
      assertProjectIdle(projectId);
      if (sessionId && activeSessions.has(sessionId)) return sendJson(res, 409, { error: '正在执行的上下文不可修改。' });
      const controls = validateContextControls(body.controls, session, project);
      if (body.expectedRevision !== session.contextRevision) return sendJson(res, 409, { error: '上下文配置已更新，请重新加载。' });
      const target = sessionId ?? createSession(config.model, projectId);
      const updated = saveContextControls(target, projectId, session.contextRevision, controls);
      return sendJson(res, 200, { sessionId: target, revision: updated.contextRevision, controls: updated.contextControls });
    }
    const request = { message: typeof body.message === 'string' ? body.message.trim() : '', responseMode: getResponseMode(body.responseMode).id, contextControls: body.controls };
    const turnConfig = { ...config };
    if (req.method === 'POST' && url.pathname === '/api/context/inspect') {
      const managed = await assembleManagedContext({ session, project, request, config: turnConfig, dryRun: true });
      return sendJson(res, 200, { controls: managed.controls, revision: session.contextRevision,
        defaultControls: DEFAULT_CONTEXT_CONTROLS,
        messages: managed.context.messages, stats: managed.context.stats, profile: managed.profile, sections: managed.sections,
        plannedRequest: managed.plannedRequest,
        ...(body.details === false ? {} : { catalog: { messages: session.messages, summary: session.summary, project: project ? publicProject(project) : null } }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/context/preview') {
      if (!request.message) return sendJson(res, 400, { error: '请先填写本轮问题。' });
      assertProjectIdle(projectId);
      if (sessionId && activeSessions.has(sessionId)) return sendJson(res, 409, { error: '会话正在执行，请完成后再生成预览。' });
      if (projectId) activeProjects.add(projectId);
      if (sessionId) activeSessions.add(sessionId);
      try {
        const preparationRequests = [];
        const abort = new AbortController(); res.on('close', () => abort.abort());
        const managed = await assembleManagedContext({ session, project, request, config: turnConfig,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]),
          onSummary: sessionId ? (summary) => appendSummary(sessionId, summary) : undefined,
          onRequest: (payload) => preparationRequests.push({ stage: 'summary', timestamp: new Date().toISOString(), payload }),
        });
        const freshSession = sessionId ? readSession(sessionId) : session;
        const stateKey = contextSpec({ session: freshSession, project, request, config: turnConfig }).stateKey;
        const previewId = contextPreviews.put({ sessionId, projectId, message: request.message, responseMode: request.responseMode,
          stateKey, managed, preparationRequests });
        return sendJson(res, 200, { previewId, expiresInSeconds: 600, messages: managed.context.messages,
          stats: managed.context.stats, profile: managed.profile, preparationRequests, plannedRequest: managed.plannedRequest });
      } finally { if (projectId) activeProjects.delete(projectId); if (sessionId) activeSessions.delete(sessionId); }
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  const sessionRoute = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]+)(\/restore)?$/);
  if (sessionRoute) {
    const [, id, restore] = sessionRoute;
    const projectId = normalizeProjectId(url.searchParams.get('projectId'));
    if (projectId) readProject(projectId);
    if (req.method === 'GET' && !restore) return sendJson(res, 200, {...scopedSession(id, projectId, { deleted: url.searchParams.get('deleted') === 'true' }),isResponding:activeSessions.has(id)});
    if (req.method === 'DELETE' && !restore || req.method === 'POST' && restore) {
      assertProjectIdle(projectId);
      if (activeSessions.has(id)) return sendJson(res, 409, { error: '会话正在执行，请完成后再删除。' });
      if(!restore&&listSessions({projectId,parentSessionId:id}).some(s=>activeSessions.has(s.id)))return sendJson(res,409,{error:'子对话正在回复，请完成后再删除主对话。'});
      if (restore) restoreSession(id, projectId); else {pauseLibraryJobsForSession(projectId,id);deleteSession(id, projectId);}
      return sendJson(res, 200, { ok: true, deleted: !restore });
    }
  }
  if (url.pathname === '/api/projects') {
    if (req.method === 'GET') return sendJson(res, 200, { projects: listProjects({deleted:url.searchParams.get('deleted')==='true'}).map(project=>({...project,isResponding:activeProjects.has(project.id)||[...activeSessions].some(id=>readSession(id)?.projectId===project.id)})) });
    if (req.method === 'POST') return sendJson(res, 201, publicProject(createProject(await readBody(req))));
  }
  const restoreProjectRoute=url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/restore$/);
  if(restoreProjectRoute){
    if(req.method!=='POST')return sendJson(res,405,{error:'Method not allowed'});
    const body=await readBody(req);assertProjectIdle(restoreProjectRoute[1]);
    return sendJson(res,200,publicProject(restoreProject(restoreProjectRoute[1],body)));
  }
  const projectRoute = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)(?:\/(memories|extract)(?:\/([0-9a-f-]+)(\/evidence)?)?)?$/);
  if (projectRoute) {
    const [, id, resource, memoryId, evidence] = projectRoute;
    const project = readProject(id);
    if (req.method === 'GET' && !resource) return sendJson(res, 200, publicProject(project));
    if (req.method === 'GET' && evidence) {
      const memory = publicProject(project).memories.find((item) => item.id === memoryId);
      if (!memory) return sendJson(res, 404, { error: 'Memory not found in this project' });
      return sendJson(res, 200, { sources: memoryEvidence(id, memory) });
    }
    assertProjectIdle(id);
    if(req.method==='DELETE'&&!resource){
      const body=await readBody(req);assertProjectIdle(id);
      if([...activeSessions].some(sessionId=>readSession(sessionId)?.projectId===id))return sendJson(res,409,{error:'项目内还有对话正在回复，请完成后再删除。'});
      if(body.expectedVersion!==readProject(id).version)return sendJson(res,409,{error:'项目已更新，请刷新后再删除。'});
      pauseLibraryJobsForProject(id);pausePaperJobsForProject(id);
      const deleted=deleteProject(id,body);
      return sendJson(res,200,{ok:true,id:deleted.id,deletedAt:deleted.deletedAt,version:deleted.version});
    }
    if (req.method === 'PATCH' && !resource) {
      const body = await readBody(req); assertProjectIdle(id);
      return sendJson(res, 200, publicProject(updateProject(id, body)));
    }
    if (req.method === 'POST' && resource === 'memories' && !memoryId) {
      const body = await readBody(req);
      assertProjectIdle(id);
      return sendJson(res, 201, publicProject(addMemoryCandidates(id, body.expectedVersion, body.candidates)));
    }
    if (req.method === 'PATCH' && resource === 'memories' && memoryId && !evidence) {
      const body = await readBody(req); assertProjectIdle(id);
      return sendJson(res, 200, publicProject(reviewMemory(id, memoryId, body)));
    }
    if (req.method === 'POST' && resource === 'extract' && !memoryId) {
      assertConfigured();
      const body = await readBody(req);
      const source = scopedSession(body.sessionId, id);
      if (body.expectedVersion !== project.version) return sendJson(res, 409, { error: '项目已更新，请刷新后再提取。' });
      // readBody yields; recheck immediately before acquiring the project lock.
      assertProjectIdle(id);
      if (activeSessions.has(source.id)) return sendJson(res, 409, { error: '会话正在执行。' });
      activeProjects.add(id); activeSessions.add(source.id);
      try {
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const controls = validateContextControls(source.contextControls ?? DEFAULT_CONTEXT_CONTROLS, source, project);
        const extractionId = crypto.randomUUID();
        const extracted = await extractMemoryCandidates({ session: { ...source, messages: controlledHistory(source, controls) }, model: config.model,
          onRequest: (payload) => appendContextRequest(source.id, { turnId: extractionId, stage: 'memory_extraction', payload }),
          reasoningSupported: config.reasoningSupported, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]) });
        const updated = addMemoryCandidates(id, project.version, extracted.candidates);
        return sendJson(res, 200, { ...publicProject(updated), extraction: { sourceCount: extracted.sourceCount, totalMessages: extracted.totalMessages, count: extracted.candidates.length } });
      } finally { activeProjects.delete(id); activeSessions.delete(source.id); }
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status ?? 400, { error: err.message });
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  const owned=resumeLibraryJobs();
  resumePaperJobs({excludeIds:owned});
  const status = config.apiKey && !config.apiKey.startsWith('sk-your-key') ? 'ready' : 'key missing';
  console.log(`Let-me-think listening on http://${config.host}:${server.address().port} [${status}]`);
  console.log(`model=${config.model} baseUrl=${config.baseUrl}`);
});
