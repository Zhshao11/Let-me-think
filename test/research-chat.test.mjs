import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptSections, renderSystemPrompt } from '../src/prompt.mjs';
import { getResponseMode, responseModeSummaries, PROTOCOL_VERSION } from '../src/agent/policies.mjs';
import { DEFAULT_CONTEXT_CONTROLS } from '../src/agent/context-controls.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const modes = responseModeSummaries();

async function startApp(t, systemPrompt = 'sections', envOverrides = {}) {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-chat-'));
  const requests = [];
  const failedOnce=new Set();
  const upstream = http.createServer(async (req, res) => {
    req.setEncoding('utf8');
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const failure=payload.messages.findLast(m=>m.role==='user')?.content.match(/FAIL_ONCE_EMPTY_TEST|TRUNCATED_ONCE_TEST/)?.[0];
    if(failure&&!failedOnce.has(failure)){
      failedOnce.add(failure);
      if(failure==='FAIL_ONCE_EMPTY_TEST'){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'模拟上游网络不可用'}}));}
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({choices:[{delta:{content:'PARTIAL_NOT_FINAL'}}]})}\n\n`);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if(payload.tool_choice?.function?.name==='proposal_route'){
      const proposal=payload.messages.findLast(m=>m.role==='user')?.content?.includes('PROPOSAL_WORKFLOW_TEST');
      res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'route',type:'function',function:{name:'proposal_route',arguments:JSON.stringify({route:proposal?'proposal':'direct',objective:proposal?'局部跨模态区分':'',queries:proposal?['local cross modal contrastive']:[],allowBackground:proposal})}}]}}]})}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if(payload.tool_choice?.function?.name==='proposal_assessment'){
      const value={findings:[],gaps:[{direction:'光学SAR细粒度局部对比学习',query:'optical SAR local contrastive learning',reason:'本地无相关方法原文'}],synthesisNotes:'允许模型结合知识提出待验证设计'};
      res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'assessment',type:'function',function:{name:'proposal_assessment',arguments:JSON.stringify(value)}}]}}]})}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (payload.messages[0]?.content.includes('你是科研论文补库规划器')) {
      if(JSON.parse(payload.messages.at(-1).content).request.includes('LIBRARY_PAUSE_HOLD'))await new Promise(resolve=>setTimeout(resolve,300));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({topic:'',bottleneck:'',sourceIds:[],clarification:'请说明当前研究的具体瓶颈？',queries:[]}) } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (payload.messages[0]?.content.includes('你是研究记忆整理器')) {
      const { sources, existing } = JSON.parse(payload.messages.at(-1).content);
      const candidates = sources.filter(source => source.role === 'user').flatMap(source => {
        if (source.content.startsWith('FORGET_AUTO')) {
          const old = existing.find(item => item.key === 'auto_topic');
          return old ? [{ action: 'forget', scope: old.scope, replaceId: old.id, sourceMessageIds: [source.id] }] : [];
        }
        if (source.content.startsWith('AUTO_PROJECT') || source.content.startsWith('CORRECT_AUTO')) return [{ scope: 'project', category: 'topic', key: 'auto_topic', topic: '跨模态匹配', text: source.content, certainty: 'user_report', sourceMessageIds: [source.id], replaceId: existing.find(item => item.key === 'auto_topic')?.id }];
        if (source.content.startsWith('AUTO_PRIVATE')) return [{ scope: 'conversation', category: 'progress', key: 'private_debug', topic: '本轮排错', text: source.content, certainty: 'user_report', sourceMessageIds: [source.id] }];
        return [];
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(candidates) } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (payload.messages[0]?.content.includes('你是会话记忆整理器')) {
      const { previous, additions } = JSON.parse(payload.messages.at(-1).content);
      const data = { userReports: [], assistantHypotheses: [], userDecisions: [], openQuestions: [], ...previous };
      data.userReports.push(...additions.filter((message) => message.role === 'user').map((message) => ({ text: message.content.slice(0, 50), sourceIds: [message.id] })));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(data) } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (payload.messages[0]?.content.includes('你是研究记忆候选项提取器')) {
      const sources = JSON.parse(payload.messages.at(-1).content);
      const source = sources.find((message) => message.role === 'user');
      const candidates = [{ kind: 'result', text: source.content, sourceMessageIds: [source.id] }];
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(candidates) } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (payload.tools?.some(tool=>tool.function.name==='paper_expand_library') && payload.messages.findLast(message=>message.role==='user')?.content?.includes('EXPAND_LIBRARY_TEST') && !payload.messages.some(message=>message.role==='tool')) {
      res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'expand-1',type:'function',function:{name:'paper_expand_library',arguments:'{"maxNewPapers":1}'}}]}}]})}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    const libraryAction=payload.messages.findLast(m=>m.role==='user')?.content?.match(/LIBRARY_SIDE_(STATUS|PAUSE|RESUME)_TEST/)?.[1]?.toLowerCase();
    if(libraryAction&&payload.tools?.some(t=>t.function.name==='paper_library_job')&&!payload.messages.some(m=>m.role==='tool')){
      res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'side-task',type:'function',function:{name:'paper_library_job',arguments:JSON.stringify({action:libraryAction})}}]}}]})}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    const projectQuery = payload.messages.find((message) => typeof message.content === 'string' && message.content.startsWith('PROJECT_TOOL_TEST:'))?.content.slice('PROJECT_TOOL_TEST:'.length);
    if (projectQuery && payload.tools?.some((tool) => tool.function.name === 'project_memory_lookup') && !payload.messages.some((message) => message.role === 'tool')) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'project-lookup', type: 'function', function: { name: 'project_memory_lookup', arguments: JSON.stringify({ query: projectQuery }) } }] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (payload.tools?.length && payload.messages.some((message) => message.content?.includes('TOOL_STREAM_TEST')) && !payload.messages.some((message) => message.role === 'tool')) {
      for (const fragment of [
        { index: 0, id: 'lookup-1', type: 'function', function: { name: 'conversation_', arguments: '{"qu' } },
        { index: 0, function: { name: 'lookup', arguments: 'ery":"840"}' } },
      ]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [fragment] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (payload.messages.at(-1)?.content === 'HOLD_TEST') await new Promise((resolve) => setTimeout(resolve, 120));
    for (const content of ['<pro', 'gress>核对证据</pro', 'gress>测试', '回复。']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: '0',
      OPENAI_API_KEY: 'mock-test-key', OPENAI_MODEL: 'gpt-6.1-sol',
      OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      SYSTEM_PROMPT: systemPrompt, SESSIONS_DIR: sessionsDir, REASONING_EFFORT: '', REASONING_SUPPORTED: 'true', CONTEXT_WINDOW_TOKENS: '32768',
      PROJECTS_DIR: path.join(sessionsDir, 'projects'),
      PAPERS_DIR: path.join(sessionsDir, 'papers'),
      AUTOMATIC_MEMORY: 'false',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit');
      app.kill();
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(sessionsDir, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('App startup timed out')), 5000);
    app.once('error', (err) => { clearTimeout(timer); reject(err); });
    app.once('exit', () => { clearTimeout(timer); reject(new Error('App exited before startup')); });
    app.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/listening on (http:\/\/[^ ]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { url, requests, sessionsDir };
}

async function chat(url, patch = {}) {
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '匹配数量提高是否证明定位更好？' }], ...patch }),
  });
  const text = await response.text();
  const events = response.ok ? text.trim().split('\n\n').map((chunk) => {
    const [event, data] = chunk.split('\n');
    return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
  }) : [];
  return { response, text, events };
}

test('mode selection is strict and prompt construction does not leak between turns', () => {
  assert.equal(getResponseMode().id, 'concise');
  for (const invalid of [null, '', 'unknown', 'toString', {}, 1]) {
    assert.throws(() => getResponseMode(invalid), RangeError);
  }
  const review = renderSystemPrompt(buildPromptSections({ responseMode: 'review' }));
  const concise = renderSystemPrompt(buildPromptSections());
  assert.match(review, /Response mode: review/);
  assert.doesNotMatch(concise, /Response mode: review/);
  assert.equal(buildPromptSections().filter((section) => section.id === 'speaking_style').length, 1);
  assert.equal(buildPromptSections().filter((section) => section.id === 'response_mode').length, 0);
  const copy = getResponseMode();
  copy.instructions = 'changed';
  assert.notEqual(getResponseMode().instructions, copy.instructions);
});

test('all four modes reach the upstream, stream normally and survive session reload', async (t) => {
  const { url, requests, sessionsDir } = await startApp(t);
  const cfg = await fetch(`${url}/api/config`).then((res) => res.json());
  assert.deepEqual(cfg.responseModes, modes);
  assert.equal(cfg.defaultResponseMode, 'concise');
  assert.equal('apiKey' in cfg, false);
  let sessionId;
  const history = [];
  for (const mode of modes) {
    history.push({ role: 'user', content: `检查 ${mode.id}` });
    const { response, events } = await chat(url, { sessionId, responseMode: mode.id, messages: history });
    assert.equal(response.status, 200);
    const meta = events.find((entry) => entry.event === 'meta').data;
    sessionId = meta.sessionId;
    assert.equal(meta.responseMode, mode.id);
    assert.equal(meta.protocolVersion, PROTOCOL_VERSION);
    assert.ok(meta.sections.some((section) => section.id === 'research_protocol'));
    assert.equal(requests.at(-1).messages[0].role, 'system');
    assert.ok(requests.at(-1).messages[0].content.includes(`Response mode: ${mode.id}`));
    assert.equal(events.filter((entry) => entry.event === 'delta').map((entry) => entry.data.text).join(''), '测试回复。');
    if (mode.id === 'concise') assert.ok(events.some((entry) => entry.event === 'progress' && entry.data.text === '核对证据'));
    assert.equal(events.at(-1).event, 'done');
    assert.equal(events.at(-1).data.execution.reviewPasses, mode.profile.reviewPasses);
    assert.equal(requests.at(-1).reasoning_effort, mode.profile.reasoningEffort);
    assert.equal(requests.at(-1).max_completion_tokens, mode.profile.maxCompletionTokens);
    if (history.length > 1) {
      assert.equal(meta.context.modeChanged, true);
      assert.equal(meta.context.recentMessages, 0);
      assert.ok(meta.context.summarizedMessages > 0);
    }
    history.push({ role: 'assistant', content: '测试回复。' });
  }
  const session = await fetch(`${url}/api/sessions/${sessionId}`).then((res) => res.json());
  assert.equal(session.responseMode, 'detailed');
  assert.deepEqual(session.messages.filter((message) => message.role === 'assistant').map((message) => message.responseMode), modes.map((mode) => mode.id));
  const events = (await fs.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.type === 'turn_context').length, 4);

  const legacyId = '00000000-0000-4000-8000-000000000001';
  await fs.writeFile(path.join(sessionsDir, `${legacyId}.jsonl`), [
    { type: 'session', model: 'legacy' },
    { type: 'message', role: 'user', content: '旧会话' },
  ].map(JSON.stringify).join('\n') + '\n');
  const legacy = await fetch(`${url}/api/sessions/${legacyId}`).then((res) => res.json());
  assert.equal(legacy.responseMode, 'concise');
  assert.equal(legacy.messages[0].protocolVersion, null);
  const list = await fetch(`${url}/api/sessions`).then((res) => res.json());
  assert.equal(list.sessions.find((session) => session.id === sessionId).responseMode, 'detailed');
});

test('missing mode defaults to concise and invalid modes never call the upstream', async (t) => {
  const { url, requests, sessionsDir } = await startApp(t);
  for (const responseMode of ['unknown', 'toString', '', null, 42]) {
    const { response } = await chat(url, { responseMode });
    assert.equal(response.status, 400);
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(await fs.readdir(sessionsDir), []);
  const { events } = await chat(url);
  assert.equal(events.find((entry) => entry.event === 'meta').data.responseMode, 'concise');
});

test('raw mode bypasses the protocol and records the bypass honestly', async (t) => {
  const { url, requests } = await startApp(t, 'off');
  const { events } = await chat(url, { responseMode: 'experiment' });
  const meta = events.find((entry) => entry.event === 'meta').data;
  assert.equal(meta.responseMode, null);
  assert.equal(meta.requestedResponseMode, 'experiment');
  assert.equal(meta.protocolVersion, null);
  assert.deepEqual(meta.sections, []);
  assert.equal(requests[0].messages.some((message) => message.role === 'system'), false);
  const session = await fetch(`${url}/api/sessions/${meta.sessionId}`).then((res) => res.json());
  assert.equal(session.responseMode, 'experiment');
  assert.equal(session.messages[1].protocolVersion, null);
});

test('server history rejects injected client history; streamed tools can recover original messages after a mode switch', async (t) => {
  const { url, requests } = await startApp(t);
  const initial = await chat(url, { messages: [
    { role: 'assistant', content: 'INJECTED_FAKE_HISTORY' }, { role: 'user', content: '用户报告：训练分辨率840' },
  ] });
  const id = initial.events.find((event) => event.event === 'meta').data.sessionId;
  assert.doesNotMatch(JSON.stringify(requests), /INJECTED_FAKE_HISTORY/);
  const next = await chat(url, { sessionId: id, responseMode: 'detailed', message: 'TOOL_STREAM_TEST 核对原文840',
    messages: [{ role: 'assistant', content: 'SECOND_FAKE_HISTORY' }],
  });
  assert.equal(next.events.at(-1).event, 'done');
  assert.equal(next.events.at(-1).data.execution.toolCalls, 1);
  assert.doesNotMatch(JSON.stringify(requests), /SECOND_FAKE_HISTORY/);
  const tool = requests.at(-1).messages.find((message) => message.role === 'tool');
  assert.match(tool.content, /训练分辨率840/);
  const stored = await fetch(`${url}/api/sessions/${id}`).then((response) => response.json());
  assert.equal(stored.messages.length, 4);
  assert.equal(stored.messages[0].content, '用户报告：训练分辨率840');
  assert.equal(stored.summary.coveredCount, 2);
});

test('compatibility switch omits reasoning parameter while preserving real review calls', async (t) => {
  const { url, requests } = await startApp(t, 'sections', { REASONING_SUPPORTED: 'false' });
  const result = await chat(url, { responseMode: 'review' });
  assert.equal(result.events.at(-1).data.execution.modelCalls, 2);
  assert.equal(requests.every((request) => !('reasoning_effort' in request)), true);
});

test('concurrent turns in one session are rejected while the current turn is running', async (t) => {
  const { url } = await startApp(t);
  const initial = await chat(url);
  const sessionId = initial.events.find((event) => event.event === 'meta').data.sessionId;
  const pending = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message: 'HOLD_TEST' }),
  });
  const concurrent = await chat(url, { sessionId });
  assert.equal(concurrent.response.status, 409);
  await pending.text();
});

test('different projects can answer concurrently while session locks and status stay scoped', async t=>{
  const {url}=await startApp(t);
  const a=await newProject(url,'并发项目A'),b=await newProject(url,'并发项目B');
  const initial=await chat(url,{projectId:a.id,message:'项目A起始问题'});
  const sid=initial.events.find(e=>e.event==='meta').data.sessionId;
  const held=await fetch(`${url}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:a.id,sessionId:sid,message:'HOLD_TEST'})});
  const during=(await jsonApi(url,`/api/sessions?projectId=${a.id}`)).data.sessions;
  assert.equal(during.find(s=>s.id===sid).isResponding,true);
  const independent=await chat(url,{projectId:b.id,message:'项目B可以独立回答'});
  assert.equal(independent.events.at(-1).event,'done');
  const bid=independent.events.find(e=>e.event==='meta').data.sessionId;
  const wrongScope=await jsonApi(url,`/api/sessions/${sid}?projectId=${b.id}`);
  assert.equal(wrongScope.status,404);
  await held.text();
  const finished=(await jsonApi(url,`/api/sessions?projectId=${a.id}`)).data.sessions;
  assert.equal(finished.find(s=>s.id===sid).isResponding,false);
  const savedA=(await jsonApi(url,`/api/sessions/${sid}?projectId=${a.id}`)).data;
  const savedB=(await jsonApi(url,`/api/sessions/${bid}?projectId=${b.id}`)).data;
  assert.equal(savedA.messages.at(-2).content,'HOLD_TEST');
  assert.equal(savedB.messages.at(-2).content,'项目B可以独立回答');
  assert.equal(savedA.messages.at(-1).status,'complete');assert.equal(savedB.messages.at(-1).status,'complete');
});

async function jsonApi(url, route, method = 'GET', body) {
  const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const scope = (project) => `?projectId=${project.id}`;
async function newProject(url, name, card = {}) {
  const result = await jsonApi(url, '/api/projects', 'POST', { name, card });
  assert.equal(result.status, 201); return result.data;
}
async function addCandidates(url, project, candidates) {
  const result = await jsonApi(url, `/api/projects/${project.id}/memories`, 'POST', { expectedVersion: project.version, candidates });
  assert.equal(result.status, 201); return result.data;
}
async function confirm(url, project, memory, text = memory.text) {
  const result = await jsonApi(url, `/api/projects/${project.id}/memories/${memory.id}`, 'PATCH', { expectedVersion: project.version, action: 'confirm', text });
  assert.equal(result.status, 200); return result.data;
}

test('project state and confirmed memory transfer to new sessions, while foreign sessions and pending memory remain isolated', async (t) => {
  const { url, requests } = await startApp(t);
  let a = await newProject(url, '同名项目', { task: 'CARD_A_PRIVATE' });
  const b = await newProject(url, '同名项目', { task: 'CARD_B_PRIVATE' });
  const first = await chat(url, { projectId: a.id, message: 'SOURCE_A_PRIVATE 真实用户报告' });
  const aid = first.events.find((event) => event.event === 'meta').data.sessionId;
  const source = (await jsonApi(url, `/api/sessions/${aid}${scope(a)}`)).data;
  assert.equal((await jsonApi(url, `/api/sessions/${aid}${scope(b)}`)).status, 404);
  assert.equal((await jsonApi(url, `/api/sessions/${aid}`)).status, 404);
  const calls = requests.length;
  assert.equal((await chat(url, { projectId: b.id, sessionId: aid })).response.status, 404);
  assert.equal(requests.length, calls);
  assert.equal((await jsonApi(url, '/api/sessions')).data.sessions.length, 0);
  a = await addCandidates(url, a, [
    { kind: 'result', text: 'CONFIRMED_A_PRIVATE', sourceSessionId: aid, sourceMessageIds: [source.messages[0].id] },
    { kind: 'hypothesis', text: 'PENDING_A_PRIVATE', sourceSessionId: aid, sourceMessageIds: [source.messages[1].id] },
  ]);
  a = await confirm(url, a, a.memories[0]);
  await chat(url, { projectId: a.id, message: '概括当前研究状态' });
  assert.match(JSON.stringify(requests.at(-1).messages), /CONFIRMED_A_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /PENDING_A_PRIVATE/);
  assert.match(JSON.stringify(requests.at(-1).messages), /CARD_A_PRIVATE/);
  await chat(url, { projectId: b.id, message: '概括当前研究状态' });
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /CONFIRMED_A_PRIVATE|SOURCE_A_PRIVATE|CARD_A_PRIVATE/);
  assert.match(JSON.stringify(requests.at(-1).messages), /CARD_B_PRIVATE/);
  assert.equal((await jsonApi(url, `/api/projects/${b.id}/memories/${a.memories[0].id}/evidence`)).status, 404);
  assert.equal((await jsonApi(url, `/api/projects/${b.id}/memories`, 'POST', { expectedVersion: b.version, candidates: [
    { kind: 'result', text: 'attempt', sourceSessionId: aid, sourceMessageIds: [source.messages[0].id] },
  ] })).status, 404);
  const lookup = await chat(url, { projectId: b.id, responseMode: 'detailed', message: `PROJECT_TOOL_TEST:${a.memories[0].id}` });
  assert.equal(lookup.events.at(-1).data.execution.toolCalls, 1);
  const toolOutput = JSON.parse(requests.at(-1).messages.find((message) => message.role === 'tool').content);
  assert.equal(toolOutput.totalMatches, 0);
});

test('extracting creates editable candidates with provenance and never writes confirmed memory automatically', async (t) => {
  const { url, requests } = await startApp(t);
  let project = await newProject(url, '记忆提取');
  const turn = await chat(url, { projectId: project.id, message: 'EXTRACTION_ORIGINAL: AUC@10=50.1，seed=0，用户报告。' });
  const sid = turn.events.find((event) => event.event === 'meta').data.sessionId;
  const extracted = await jsonApi(url, `/api/projects/${project.id}/extract`, 'POST', { sessionId: sid, expectedVersion: project.version });
  assert.equal(extracted.status, 200);
  project = extracted.data;
  assert.equal(project.memories[0].status, 'candidate');
  assert.equal(project.extraction.sourceCount, 2);
  await chat(url, { projectId: project.id, message: '当前项目有什么结果？' });
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /EXTRACTION_ORIGINAL/);
  const evidence = await jsonApi(url, `/api/projects/${project.id}/memories/${project.memories[0].id}/evidence`);
  assert.match(evidence.data.sources[0].content, /50.1/);
  project = await confirm(url, project, project.memories[0], 'CORRECTED_CONFIRMED: AUC@10=50.1，单seed用户报告。');
  await chat(url, { projectId: project.id, message: '当前项目有什么结果？' });
  assert.match(JSON.stringify(requests.at(-1).messages), /CORRECTED_CONFIRMED/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /EXTRACTION_ORIGINAL/);
});

test('deletion removes a session and all its derived memory from use; restore recovers both without recreating sessions', async (t) => {
  const { url, requests } = await startApp(t);
  let project = await newProject(url, '删除来源');
  const other = await newProject(url, '其他');
  const turn = await chat(url, { projectId: project.id, message: 'DELETED_SOURCE_SECRET' });
  const sid = turn.events.find((event) => event.event === 'meta').data.sessionId;
  const source = (await jsonApi(url, `/api/sessions/${sid}${scope(project)}`)).data;
  project = await addCandidates(url, project, [
    { kind: 'result', text: 'DERIVED_MEMORY_SECRET', sourceSessionId: sid, sourceMessageIds: [source.messages[0].id] },
    { kind: 'hypothesis', text: 'CANDIDATE_SECRET', sourceSessionId: sid, sourceMessageIds: [source.messages[1].id] },
  ]);
  const pendingId = project.memories[1].id;
  project = await confirm(url, project, project.memories[0]);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}${scope(other)}`, 'DELETE')).status, 404);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}${scope(project)}`, 'DELETE')).status, 200);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}${scope(project)}`)).status, 404);
  assert.equal((await chat(url, { projectId: project.id, sessionId: sid })).response.status, 404);
  assert.equal((await jsonApi(url, `/api/projects/${project.id}`)).data.memories.length, 0);
  assert.equal((await jsonApi(url, `/api/projects/${project.id}/memories/${pendingId}`, 'PATCH', { expectedVersion: project.version, action: 'confirm' })).status, 404);
  const trash = await jsonApi(url, `/api/sessions${scope(project)}&deleted=true`);
  assert.equal(trash.data.sessions[0].id, sid);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}${scope(project)}&deleted=true`)).data.messages.length, 2);
  await chat(url, { projectId: project.id, message: '项目状态' });
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /DELETED_SOURCE_SECRET|DERIVED_MEMORY_SECRET|CANDIDATE_SECRET/);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}/restore${scope(other)}`, 'POST')).status, 404);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}/restore${scope(project)}`, 'POST')).status, 200);
  assert.equal((await jsonApi(url, `/api/projects/${project.id}`)).data.memories.length, 2);
  await chat(url, { projectId: project.id, message: '项目状态' });
  assert.match(JSON.stringify(requests.at(-1).messages), /DERIVED_MEMORY_SECRET/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /CANDIDATE_SECRET/);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}${scope(project)}`)).data.messages[0].content, 'DELETED_SOURCE_SECRET');
});

test('confirmed revisions replace old project memory, rejection and stale versions cannot change current state', async (t) => {
  const { url, requests } = await startApp(t);
  let project = await newProject(url, '更正状态');
  project = await addCandidates(url, project, [{ kind: 'hypothesis', text: 'OLD_RESEARCH_POINT' }]);
  project = await confirm(url, project, project.memories[0]);
  const oldId = project.memories[0].id;
  project = await addCandidates(url, project, [{ kind: 'hypothesis', text: 'NEW_RESEARCH_POINT', supersedesId: oldId }, { kind: 'decision', text: 'REJECTED_POINT' }]);
  const revision = project.memories.find((memory) => memory.supersedesId);
  const rejected = project.memories.find((memory) => memory.text === 'REJECTED_POINT');
  const rejectedResult = await jsonApi(url, `/api/projects/${project.id}/memories/${rejected.id}`, 'PATCH', { expectedVersion: project.version, action: 'reject' });
  project = rejectedResult.data;
  assert.equal((await jsonApi(url, `/api/projects/${project.id}/memories/${revision.id}`, 'PATCH', { expectedVersion: project.version - 1, action: 'confirm' })).status, 409);
  project = await confirm(url, project, revision);
  assert.equal(project.memories.some((memory) => memory.id === oldId), false);
  await chat(url, { projectId: project.id, message: '现在的研究假设？' });
  assert.match(JSON.stringify(requests.at(-1).messages), /NEW_RESEARCH_POINT/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /OLD_RESEARCH_POINT|REJECTED_POINT/);
});

test('assistant-only results and mixed invalid candidates fail atomically; active project cannot be mutated or deleted', async (t) => {
  const { url } = await startApp(t);
  const project = await newProject(url, '边界检查');
  const turn = await chat(url, { projectId: project.id, message: '用户问题' });
  const sid = turn.events.find((event) => event.event === 'meta').data.sessionId;
  const source = (await jsonApi(url, `/api/sessions/${sid}${scope(project)}`)).data;
  const invalid = await jsonApi(url, `/api/projects/${project.id}/memories`, 'POST', { expectedVersion: project.version, candidates: [
    { kind: 'hypothesis', text: 'valid but must not partially save' },
    { kind: 'result', text: 'assistant fabricated result', sourceSessionId: sid, sourceMessageIds: [source.messages[1].id] },
  ] });
  assert.equal(invalid.status, 400);
  assert.equal((await jsonApi(url, `/api/projects/${project.id}`)).data.version, project.version);
  assert.equal((await jsonApi(url, `/api/projects/${project.id}`)).data.memories.length, 0);
  const pending = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, projectId: project.id, message: 'HOLD_TEST' }) });
  assert.equal((await jsonApi(url, `/api/sessions/${sid}${scope(project)}`, 'DELETE')).status, 409);
  assert.equal((await jsonApi(url, `/api/projects/${project.id}`, 'PATCH', { expectedVersion: project.version, card: {} })).status, 409);
  assert.equal((await jsonApi(url, `/api/projects/${project.id}`, 'DELETE', { expectedVersion: project.version })).status, 409);
  await pending.text();
});

test('inspection is read-only and preview sends exactly its selected materials, preserving raw history', async (t) => {
  const { url, requests, sessionsDir } = await startApp(t);
  const first = await chat(url, { message: 'ORIGINAL_TO_CORRECT' });
  const sid = first.events.find((event) => event.event === 'meta').data.sessionId;
  const original = (await jsonApi(url, `/api/sessions/${sid}`)).data;
  const before = await fs.readFile(path.join(sessionsDir, `${sid}.jsonl`), 'utf8');
  const controls = { ...DEFAULT_CONTEXT_CONTROLS, summaryMode: 'off', allowSourceLookup: false,
    messageEdits: { [original.messages[0].id]: 'CORRECTED_INPUT' }, excludedMessageIds: [original.messages[1].id], extraContext: 'ONLY_THIS_TURN' };
  const calls = requests.length;
  const inspected = await jsonApi(url, '/api/context/inspect', 'POST', { sessionId: sid, message: '当前问题', controls });
  assert.equal(inspected.status, 200);
  assert.equal(requests.length, calls);
  assert.equal(await fs.readFile(path.join(sessionsDir, `${sid}.jsonl`), 'utf8'), before);
  const prepared = await jsonApi(url, '/api/context/preview', 'POST', { sessionId: sid, message: '当前问题', controls });
  assert.equal(prepared.status, 200);
  assert.doesNotMatch(JSON.stringify(prepared.data.messages), /ORIGINAL_TO_CORRECT|测试回复/);
  assert.match(JSON.stringify(prepared.data.messages), /CORRECTED_INPUT|ONLY_THIS_TURN/);
  const sent = await chat(url, { sessionId: sid, message: '当前问题', previewId: prepared.data.previewId });
  assert.equal(sent.events.at(-1).event, 'done');
  assert.deepEqual(requests.at(-1).messages, prepared.data.messages);
  assert.deepEqual(requests.at(-1), prepared.data.plannedRequest);
  const trace = sent.events.find((event) => event.event === 'context_request').data;
  assert.deepEqual(trace.payload, requests.at(-1));
  assert.equal('headers' in trace.payload, false);
  const reloaded = (await jsonApi(url, `/api/sessions/${sid}`)).data;
  assert.equal(reloaded.messages[0].content, 'ORIGINAL_TO_CORRECT');
  assert.equal(reloaded.contextRevision, 0);
  await chat(url, { sessionId: sid, message: '下一轮按默认上下文' });
  assert.match(JSON.stringify(requests.at(-1).messages), /ORIGINAL_TO_CORRECT/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /ONLY_THIS_TURN/);
});

test('preview compresses once, reuses its exact summary and records real tool and review requests', async (t) => {
  const { url, requests } = await startApp(t);
  const first = await chat(url, { message: '用户报告：输入840' });
  const sid = first.events.find((event) => event.event === 'meta').data.sessionId;
  const inspected = await jsonApi(url, '/api/context/inspect', 'POST', { sessionId: sid, responseMode: 'review', message: 'TOOL_STREAM_TEST 核对840' });
  assert.equal(inspected.data.stats.needsCompaction, true);
  const prepared = await jsonApi(url, '/api/context/preview', 'POST', { sessionId: sid, responseMode: 'review', message: 'TOOL_STREAM_TEST 核对840' });
  assert.equal(prepared.data.preparationRequests.length, 1);
  const calls = requests.length;
  const sent = await chat(url, { sessionId: sid, responseMode: 'review', message: 'TOOL_STREAM_TEST 核对840', previewId: prepared.data.previewId });
  assert.equal(sent.events.at(-1).data.execution.modelCalls, 3);
  assert.equal(requests.length, calls + 3);
  assert.deepEqual(requests[calls].messages, prepared.data.messages);
  assert.deepEqual(requests[calls], prepared.data.plannedRequest);
  const log = (await jsonApi(url, `/api/sessions/${sid}/context-requests`)).data.requests;
  assert.equal(log.filter((record) => record.origin === 'preview_preparation').length, 1);
  assert.ok(log.some((record) => record.payload.messages.some((message) => message.role === 'tool')));
  assert.ok(log.some((record) => record.stage === 'final'));
});

test('saved controls persist locally, reject stale or foreign edits and filter subsequent memory extraction', async (t) => {
  const { url, requests } = await startApp(t);
  const project = await newProject(url, '上下文配置');
  const foreign = await newProject(url, '另一个项目');
  const first = await chat(url, { projectId: project.id, message: 'PRIVATE_RAW_TO_REVISE' });
  const sid = first.events.find((event) => event.event === 'meta').data.sessionId;
  const source = (await jsonApi(url, `/api/sessions/${sid}${scope(project)}`)).data;
  const controls = { ...DEFAULT_CONTEXT_CONTROLS, summaryMode: 'off', messageEdits: { [source.messages[0].id]: 'EXTRACTION_REVISED_CONTEXT' } };
  const saved = await jsonApi(url, '/api/context/controls', 'PUT', { sessionId: sid, projectId: project.id, expectedRevision: 0, controls });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.revision, 1);
  assert.equal((await jsonApi(url, '/api/context/controls', 'PUT', { sessionId: sid, projectId: project.id, expectedRevision: 0, controls })).status, 409);
  assert.equal((await jsonApi(url, '/api/context/inspect', 'POST', { sessionId: sid, projectId: foreign.id })).status, 404);
  assert.equal((await jsonApi(url, `/api/sessions/${sid}/context-requests${scope(foreign)}`)).status, 404);
  const extracted = await jsonApi(url, `/api/projects/${project.id}/extract`, 'POST', { sessionId: sid, expectedVersion: project.version });
  assert.equal(extracted.status, 200);
  assert.match(JSON.stringify(requests.at(-1).messages), /EXTRACTION_REVISED_CONTEXT/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /PRIVATE_RAW_TO_REVISE/);
  assert.equal(extracted.data.memories[0].contextEditedSource, true);
});

test('preview invalidation covers question, project state, saved rules and source deletion; tokens cannot be reused', async (t) => {
  const { url, requests } = await startApp(t);
  let project = await newProject(url, '预览一致性');
  const request = { projectId: project.id, message: '准备问题' };
  const prepared = await jsonApi(url, '/api/context/preview', 'POST', request);
  const calls = requests.length;
  assert.equal((await chat(url, { ...request, message: '不同问题', previewId: prepared.data.previewId })).response.status, 409);
  assert.equal(requests.length, calls);
  project = (await jsonApi(url, `/api/projects/${project.id}`, 'PATCH', { expectedVersion: project.version, card: { task: '项目已改变' } })).data;
  assert.equal((await chat(url, { ...request, previewId: prepared.data.previewId })).response.status, 409);
  const fresh = await jsonApi(url, '/api/context/preview', 'POST', request);
  const success = await chat(url, { ...request, previewId: fresh.data.previewId });
  assert.equal(success.events.at(-1).event, 'done');
  assert.equal((await chat(url, { ...request, previewId: fresh.data.previewId })).response.status, 409);
  const sid = success.events.find((event) => event.event === 'meta').data.sessionId;
  const ready = await jsonApi(url, '/api/context/preview', 'POST', { ...request, sessionId: sid });
  await jsonApi(url, '/api/context/controls', 'PUT', { projectId: project.id, sessionId: sid, expectedRevision: 0, controls: DEFAULT_CONTEXT_CONTROLS });
  assert.equal((await chat(url, { ...request, sessionId: sid, previewId: ready.data.previewId })).response.status, 409);
  const next = await jsonApi(url, '/api/context/preview', 'POST', { ...request, sessionId: sid });
  await jsonApi(url, `/api/sessions/${sid}${scope(project)}`, 'DELETE');
  assert.equal((await chat(url, { ...request, sessionId: sid, previewId: next.data.previewId })).response.status, 404);
});

test('excluded source data cannot re-enter through summaries or project-memory tool lookups', async (t) => {
  const { url, requests } = await startApp(t);
  let project = await newProject(url, '上下文工具隔离');
  const first = await chat(url, { projectId: project.id, message: 'SOURCE_MUST_STAY_OUT' });
  const sid = first.events.find((event) => event.event === 'meta').data.sessionId;
  const source = (await jsonApi(url, `/api/sessions/${sid}${scope(project)}`)).data;
  project = await addCandidates(url, project, [{ kind: 'result', text: 'DERIVED_MUST_STAY_OUT', sourceSessionId: sid, sourceMessageIds: [source.messages[0].id] }]);
  project = await confirm(url, project, project.memories[0]);
  const controls = { ...DEFAULT_CONTEXT_CONTROLS, excludedMessageIds: [source.messages[0].id], summaryMode: 'off' };
  await jsonApi(url, '/api/context/controls', 'PUT', { projectId: project.id, sessionId: sid, expectedRevision: 0, controls });
  const result = await chat(url, { projectId: project.id, sessionId: sid, responseMode: 'detailed', message: `PROJECT_TOOL_TEST:${project.memories[0].id}` });
  assert.equal(result.events.at(-1).data.execution.toolCalls, 1);
  const toolResult = JSON.parse(requests.at(-1).messages.find((message) => message.role === 'tool').content);
  assert.equal(toolResult.totalMatches, 0);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /SOURCE_MUST_STAY_OUT|DERIVED_MUST_STAY_OUT/);
});

test('automatic topic memory is shared within a project while detailed conversation memory stays private, without confirmation UI', async (t) => {
  const { url, requests } = await startApp(t, 'sections', { AUTOMATIC_MEMORY: 'true' });
  const project = await newProject(url, '自动记忆项目'); const other = await newProject(url, '隔离项目');
  const first = await chat(url, { projectId: project.id, message: 'AUTO_PROJECT 研究主题是SAR匹配；痛点是低纹理；用户身份为研究生。' });
  assert.equal(first.events.at(-1).data.memory.saved, 1);
  assert.equal(first.events.at(-1).data.execution.usage.prompt_tokens, 321);
  const sid = first.events.find(event => event.event === 'meta').data.sessionId;
  await chat(url, { projectId: project.id, sessionId: sid, message: 'AUTO_PRIVATE 这次临时排错端口为9001，只在本对话记住。' });
  const view = (await jsonApi(url, `/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.equal(view.project.items.length, 1); assert.equal(view.conversation.items.length, 1);
  await chat(url, { projectId: project.id, message: '概括背景' });
  const actual = requests.findLast(request => request.messages.at(-1)?.content === '概括背景');
  assert.match(JSON.stringify(actual.messages), /AUTO_PROJECT/); assert.doesNotMatch(JSON.stringify(actual.messages), /AUTO_PRIVATE|9001/);
  await chat(url, { projectId: other.id, message: '背景' });
  const isolated = requests.findLast(request => request.messages.at(-1)?.content === '背景');
  assert.doesNotMatch(JSON.stringify(isolated.messages), /AUTO_PROJECT|AUTO_PRIVATE/);
  const shared = (await jsonApi(url, `/api/memory-console?projectId=${project.id}`)).data;
  assert.equal(shared.conversation.items.length, 0);
  assert.equal((await jsonApi(url, `/api/memory-console?projectId=${other.id}&sessionId=${sid}`)).status, 404);
});

test('automatic corrections supersede previous facts; console edit and deletion persist and are never overwritten or resurrected', async (t) => {
  const { url } = await startApp(t, 'sections', { AUTOMATIC_MEMORY: 'true' });
  const project = await newProject(url, '自动更正');
  let first = await chat(url, { projectId: project.id, message: 'AUTO_PROJECT 初始值为50.1' });
  const sid = first.events.find(event => event.event === 'meta').data.sessionId;
  await chat(url, { projectId: project.id, sessionId: sid, message: 'CORRECT_AUTO 更正，值应为52.3' });
  let view = (await jsonApi(url, `/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.equal(view.project.items.length, 1); assert.match(view.project.items[0].text, /52.3/);
  const id = view.project.items[0].id;
  const route = `/api/memory-console/${id}?projectId=${project.id}&sessionId=${sid}&scope=project`;
  const edited = await jsonApi(url, route, 'PATCH', { expectedVersion: view.project.version, text: '手动权威更正55.0', category: 'progress', topic: '跨模态匹配' });
  assert.equal(edited.status, 200);
  await chat(url, { projectId: project.id, sessionId: sid, message: 'CORRECT_AUTO 不应该覆盖用户编辑' });
  view = (await jsonApi(url, `/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.equal(view.project.items[0].text, '手动权威更正55.0');
  const deleted = await jsonApi(url, route, 'DELETE', { expectedVersion: view.project.version });
  assert.equal(deleted.status, 200);
  await chat(url, { projectId: project.id, sessionId: sid, message: 'AUTO_PROJECT 初始值为50.1' });
  view = (await jsonApi(url, `/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.equal(view.project.items.length, 0);
  assert.equal((await jsonApi(url, route, 'DELETE', { expectedVersion: view.project.version })).status, 404);
});

test('the locked model uses its documented capacity and upstream usage is retained', async (t) => {
  const { url } = await startApp(t, 'sections', { CONTEXT_WINDOW_TOKENS: '' });
  const cfg = (await jsonApi(url, '/api/config')).data;
  assert.equal(cfg.tokenModel.contextWindow, 1050000); assert.equal(cfg.tokenModel.windowSource, 'model_mapping');
  const response = await chat(url); const sid = response.events.find(event => event.event === 'meta').data.sessionId;
  const console = (await jsonApi(url, `/api/memory-console?sessionId=${sid}`)).data;
  assert.equal(console.lastUsage.prompt_tokens, 321);
  assert.equal(console.stats.contextWindow, 1050000);
  assert.equal(console.stats.estimateMethod, 'tokenizer-with-chat-framing-estimate');
});

test('live usage inspection uses GPT-6.1 Sol capacity without upstream calls and respects project scope and mode reserves', async (t) => {
  const { url, requests } = await startApp(t, 'sections', { OPENAI_MODEL:'gpt-6.1-sol', CONTEXT_WINDOW_TOKENS:'' });
  const project = await newProject(url, '窗口用量'); const other = await newProject(url,'另一个项目');
  const response = await chat(url,{projectId:project.id,message:'测试窗口'});
  const sid = response.events.at(-1).data.sessionId;
  const count = requests.length;
  const usage = await jsonApi(url,'/api/context/usage','POST',{projectId:project.id,sessionId:sid,message:'继续',responseMode:'concise'});
  assert.equal(usage.status,200);
  assert.equal(usage.data.tokenModel.contextWindow,1050000);
  assert.equal(usage.data.stats.availableInputBudget,1050000-2048-1024-usage.data.stats.executionReserve-usage.data.stats.toolDefinitionTokens);
  assert.equal(usage.data.lastUsage.prompt_tokens,321);
  assert.equal('history' in usage.data,false);
  const review = await jsonApi(url,'/api/context/usage','POST',{projectId:project.id,sessionId:sid,message:'继续',responseMode:'review'});
  assert.equal(review.data.stats.outputReserve,6144);
  assert.equal(review.data.stats.executionReserve,12000);
  assert.ok(review.data.stats.compressionThresholds[0].tokens < usage.data.stats.compressionThresholds[0].tokens);
  assert.equal((await jsonApi(url,'/api/context/usage','POST',{projectId:other.id,sessionId:sid})).status,404);
  assert.equal(requests.length,count);
});

test('long chat messages are fully processed in memory batches and checkpointed only after their final part', async (t) => {
  const { url, requests } = await startApp(t, 'sections', { AUTOMATIC_MEMORY: 'true', CONTEXT_WINDOW_TOKENS:'65536' });
  const project = await newProject(url, '长消息整理');
  const content = Array.from({ length: 1400 }, (_, i) => `第${i}轮低纹理匹配待验证。`).join('') + 'TAIL_LONG_SOURCE';
  const first = await chat(url, { projectId: project.id, message: content });
  assert.equal(first.response.status,200,first.text);
  assert.equal(first.events.at(-1).event, 'done');
  assert.equal(first.events.at(-1).data.memory.warning, undefined);
  const sid = first.events.at(-1).data.sessionId;
  const organizers = requests.filter(r => r.messages[0]?.content.includes('你是研究记忆整理器'));
  assert.ok(organizers.length > 1);
  const chunks = organizers.flatMap(r => JSON.parse(r.messages.at(-1).content).sources).filter(s => s.role === 'user');
  assert.ok(chunks.map(s => s.content).join('') === content, JSON.stringify(chunks.map(s => ({ id: s.id, length: s.content.length, start: s.content.slice(0, 20), end: s.content.slice(-20) }))));
  assert.equal(new Set(chunks.map(s => s.id)).size, 1);
  const count = requests.length;
  await chat(url, { projectId: project.id, sessionId: sid, message: '继续讨论' });
  const next = requests.slice(count).filter(r => r.messages[0]?.content.includes('你是研究记忆整理器'));
  assert.ok(next.length);
  assert.ok(next.every(r => JSON.parse(r.messages.at(-1).content).sources.every(s => s.id !== chunks[0].id)));
});

test('deleting a source stops automatic project memory; private memory endpoints and natural forget cannot cross scopes', async (t) => {
  const { url } = await startApp(t, 'sections', { AUTOMATIC_MEMORY: 'true' });
  const project = await newProject(url, '来源边界'); const other = await newProject(url, '另一边界');
  const first = await chat(url, { projectId: project.id, message: 'AUTO_PROJECT 记录背景' });
  const sid = first.events.find(event => event.event === 'meta').data.sessionId;
  let view = (await jsonApi(url, `/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  const id = view.project.items[0].id;
  assert.equal((await jsonApi(url, `/api/memory-console/${id}?projectId=${other.id}&scope=project`, 'DELETE', { expectedVersion: 0 })).status, 404);
  await jsonApi(url, `/api/sessions/${sid}?projectId=${project.id}`, 'DELETE');
  view = (await jsonApi(url, `/api/memory-console?projectId=${project.id}`)).data;
  assert.equal(view.project.items.length, 0);
  await jsonApi(url, `/api/sessions/${sid}/restore?projectId=${project.id}`, 'POST');
  const forgot = await chat(url, { projectId: project.id, sessionId: sid, message: 'FORGET_AUTO 请忘记那条研究背景' });
  assert.equal(forgot.events.at(-1).data.memory.saved, 1);
  view = (await jsonApi(url, `/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.equal(view.project.items.length, 0);
});

test('paper HTTP ingestion preserves PDF and scoped assets, rejects invalid files, exposes durable failure and invalidates old previews', async (t) => {
  const {url,requests}=await startApp(t,'sections',{PAPER_PYTHON:'/not-installed-python-for-test'});
  const a=await newProject(url,'论文项目'),b=await newProject(url,'隔离项目');
  const ready=await jsonApi(url,'/api/context/preview','POST',{projectId:a.id,message:'检查新论文'});
  const pdf=Buffer.from('%PDF-1.4\nHTTP_UNIT_FIXTURE\n%%EOF');
  const uploaded=await fetch(`${url}/api/papers/upload?projectId=${a.id}&name=fixture.pdf`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:pdf});
  assert.equal(uploaded.status,202);const value=await uploaded.json(),id=value.paper.id;
  const assets=`/api/papers/${id}/assets/original.pdf`;
  const own=await fetch(`${url}${assets}?projectId=${a.id}`);assert.ok(Buffer.from(await own.arrayBuffer()).equals(pdf));
  assert.equal((await fetch(`${url}${assets}?projectId=${b.id}`)).status,404);
  assert.equal((await jsonApi(url,`/api/papers/${id}?projectId=${b.id}`)).status,404);
  const listed=(await jsonApi(url,`/api/papers?projectId=${a.id}`)).data.papers;
  assert.equal(listed[0].status,'failed');assert.match(listed[0].error,/Docling/);
  assert.equal((await jsonApi(url,`/api/papers?projectId=${b.id}`)).data.papers.length,0);
  const duplicate=await fetch(`${url}/api/papers/upload?projectId=${a.id}&name=again.pdf`,{method:'POST',body:pdf});
  assert.equal((await duplicate.json()).paper.id,id);
  assert.equal((await fetch(`${url}/api/papers/upload?projectId=${a.id}`,{method:'POST',body:'not pdf'})).status,400);
  assert.equal((await jsonApi(url,`/api/papers/${id}/retry?projectId=${a.id}`,'POST',{})).status,202);
  assert.equal((await chat(url,{projectId:a.id,message:'检查新论文',previewId:ready.data.previewId})).response.status,409);
  assert.equal(requests.length,0);
});

test('the page serves its installed Markdown browser bundle locally without exposing node_modules',async(t)=>{
  const {url}=await startApp(t);
  const page=await(await fetch(url+'/')).text();assert.match(page,/\/vendor\/markdown-it\.min\.js/);assert.match(page,/\/markdown\.js/);
  const bundle=await fetch(url+'/vendor/markdown-it.min.js');assert.equal(bundle.status,200);assert.match(bundle.headers.get('content-type'),/javascript/);assert.match(await bundle.text(),/markdownit/);
  assert.equal((await fetch(url+'/markdown.js')).status,200);
  assert.match(page,/\/vendor\/katex\/katex\.min\.css/);
  const mathCss=await fetch(url+'/vendor/katex/katex.min.css');assert.equal(mathCss.status,200);assert.match(mathCss.headers.get('content-type'),/text\/css/);assert.match(await mathCss.text(),/fonts\/KaTeX_Main-Regular\.woff2/);
  const mathFont=await fetch(url+'/vendor/katex/fonts/KaTeX_Main-Regular.woff2');assert.equal(mathFont.status,200);assert.equal(mathFont.headers.get('content-type'),'font/woff2');assert.ok((await mathFont.arrayBuffer()).byteLength>1000);
  for(const asset of ['/vendor/katex/package.json','/vendor/katex/fonts/missing.woff2','/node_modules/katex/package.json'])assert.equal((await fetch(url+asset)).status,404);
  assert.equal((await fetch(url+'/node_modules/markdown-it/package.json')).status,404);
});

test('chat, review, compaction and memory use the locked model; the settings API rejects alternatives',async(t)=>{
  const {url,requests}=await startApp(t,'sections',{OPENAI_MODEL:'legacy-model',AUTOMATIC_MEMORY:'true'});
  const cfg=(await jsonApi(url,'/api/config')).data;
  assert.equal(cfg.model,'gpt-6.1-sol');assert.equal(cfg.modelLocked,true);
  assert.equal((await jsonApi(url,'/api/config','POST',{model:'gpt-4o-mini'})).status,400);
  const project=await newProject(url,'单模型策略');
  const first=await chat(url,{projectId:project.id,message:'AUTO_PROJECT 用户报告研究背景'});
  const sid=first.events.find(e=>e.event==='meta').data.sessionId;
  const second=await chat(url,{projectId:project.id,sessionId:sid,responseMode:'review',message:'请评审目前的研究背景'});
  assert.equal(second.events.at(-1).event,'done');
  assert.equal(second.events.at(-1).data.execution.reviewPasses,1);
  assert.ok(requests.some(r=>r.messages[0]?.content.includes('你是研究记忆整理器')));
  assert.ok(requests.some(r=>r.messages[0]?.content.includes('你是会话记忆整理器')));
  assert.ok(requests.every(r=>r.model==='gpt-6.1-sol'));
});

test('chat starts source-bound background expansion; API isolates chats/projects and rejects recommendations and disabled lookup',async(t)=>{
  const {url,requests}=await startApp(t);
  const project=await newProject(url,'主题补库'),foreign=await newProject(url,'其他项目');
  const reply=await chat(url,{projectId:project.id,message:'EXPAND_LIBRARY_TEST 根据当前瓶颈补充1篇论文到知识库'});
  assert.equal(reply.response.status,200);
  const sid=reply.events.find(e=>e.event==='meta').data.sessionId;
  assert.equal(reply.events.at(-1).data.execution.toolCalls,1);
  const query=`?projectId=${project.id}&sessionId=${sid}`;
  let jobs;
  for(let i=0;i<30;i++){
    jobs=(await jsonApi(url,'/api/library-jobs'+query)).data.jobs;
    if(jobs[0]?.status==='needs_input')break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(jobs.length,1);assert.equal(jobs[0].status,'needs_input');
  assert.match(jobs[0].clarification,/瓶颈/);assert.equal(jobs[0].maxPapers,1);
  assert.equal('snapshot' in jobs[0],false);assert.equal(jobs[0].reasonScope,'current_conversation_only');
  const jobId=jobs[0].id;
  const source=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data.messages[0];
  const duplicate=await jsonApi(url,'/api/library-jobs'+query,'POST',{sourceId:source.id,maxNewPapers:1});
  assert.equal(duplicate.status,202);assert.equal(duplicate.data.job.id,jobId);
  const otherReply=await chat(url,{projectId:project.id,message:'只推荐论文，不要加入知识库'});
  const otherSid=otherReply.events.find(e=>e.event==='meta').data.sessionId;
  const otherQuery=`?projectId=${project.id}&sessionId=${otherSid}`;
  assert.deepEqual((await jsonApi(url,'/api/library-jobs'+otherQuery)).data.jobs,[]);
  assert.equal((await jsonApi(url,`/api/library-jobs/${jobId}`+otherQuery)).status,404);
  assert.equal((await jsonApi(url,`/api/library-jobs/${jobId}/control`+otherQuery,'POST',{action:'pause'})).status,404);
  assert.equal((await jsonApi(url,`/api/library-jobs/${jobId}?projectId=${foreign.id}&sessionId=${sid}`)).status,404);
  const otherSource=(await jsonApi(url,`/api/sessions/${otherSid}?projectId=${project.id}`)).data.messages[0];
  assert.equal((await jsonApi(url,'/api/library-jobs'+otherQuery,'POST',{sourceId:otherSource.id})).status,400);
  assert.equal((await jsonApi(url,'/api/library-jobs'+otherQuery,'POST',{sourceId:source.id})).status,400);
  const saved=await jsonApi(url,'/api/context/controls','PUT',{projectId:project.id,sessionId:sid,expectedRevision:0,controls:{...DEFAULT_CONTEXT_CONTROLS,allowSourceLookup:false}});
  assert.equal(saved.status,200);
  assert.equal((await jsonApi(url,'/api/library-jobs'+query,'POST',{sourceId:source.id})).status,403);
  assert.ok(requests.every(r=>r.model==='gpt-6.1-sol'));
});

test('raw chat does not expose expansion tools and direct expansion is disabled',async(t)=>{
  const {url,requests}=await startApp(t,'off');const project=await newProject(url,'原始模式');
  const reply=await chat(url,{projectId:project.id,message:'EXPAND_LIBRARY_TEST 补充论文到知识库'});
  const sid=reply.events.find(e=>e.event==='meta').data.sessionId;
  assert.ok(requests.every(r=>!r.tools?.some(tool=>tool.function.name==='paper_expand_library')));
  const source=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data.messages[0];
  assert.equal((await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${sid}`,'POST',{sourceId:source.id})).status,403);
});

test('JSON requests preserve Chinese text when UTF-8 bytes span network chunks',async(t)=>{
  const {url}=await startApp(t);const message='研究瓶颈：低纹理匹配';
  const payload=Buffer.from(JSON.stringify({message}));
  const at=payload.indexOf(Buffer.from('研究'))+1;
  const response=await new Promise((resolve,reject)=>{
    const request=http.request(new URL('/api/chat',url),{method:'POST',headers:{'Content-Type':'application/json'}},res=>{
      res.setEncoding('utf8');let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,body}));
    });
    request.on('error',reject);request.write(payload.subarray(0,at));
    setTimeout(()=>request.end(payload.subarray(at)),20);
  });
  assert.equal(response.status,200);
  const meta=response.body.split('\n\n').find(part=>part.startsWith('event: meta\n'));
  const sid=JSON.parse(meta.split('\ndata: ')[1]).sessionId;
  const stored=(await jsonApi(url,`/api/sessions/${sid}`)).data;
  assert.equal(stored.messages[0].content,message);
});

test('experiment mode follows a background task handoff and reviews the actual user request without inventing a review request',async(t)=>{
  const {url,requests}=await startApp(t);const project=await newProject(url,'任务感知验收');
  const message='EXPAND_LIBRARY_TEST 根据当前研究主题和瓶颈补充最多1篇论文到知识库，说明关联理由';
  const result=await chat(url,{projectId:project.id,responseMode:'experiment',message});
  assert.equal(result.response.status,200);
  const execution=result.events.at(-1).data.execution;
  assert.equal(execution.taskState.kind,'handoff');assert.equal(execution.taskState.status,'queued');
  assert.equal(execution.reviewPasses,1);
  const final=requests.find(r=>r.messages.some(m=>m.role==='system'&&m.content.includes('内部答复检查')));
  assert.ok(final);
  const initial=requests.find(r=>r.tools?.some(t=>t.function.name==='paper_expand_library'));
  assert.deepEqual(final.messages.filter(m=>m.role==='user'),initial.messages.filter(m=>m.role==='user'));
  assert.equal(final.messages.filter(m=>m.role==='user').at(-1).content,message);
  assert.ok(final.messages.some(m=>m.role==='tool'&&JSON.parse(m.content).job?.status==='queued'));
  assert.ok(final.messages.some(m=>m.role==='system'&&m.content.includes('后台已接手论文任务')));
  assert.deepEqual(final.tools??[],[]);
});

async function openSide(url,projectId,parentId){
  const result=await jsonApi(url,`/api/sessions/${parentId}/side-conversations?projectId=${projectId??''}`,'POST',{});
  assert.equal(result.status,201);return result.data.conversation;
}

test('a side conversation inherits frozen context, keeps its own history and compression, and never syncs memories into its parent or project',async(t)=>{
  const {url,requests,sessionsDir}=await startApp(t,'sections',{AUTOMATIC_MEMORY:'true'});
  const asset=await fetch(url+'/side-chat.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
  const project=await newProject(url,'子对话隔离');
  const initial=await chat(url,{projectId:project.id,message:'AUTO_PROJECT PARENT_TOPIC_FROZEN 研究低纹理匹配'});
  const sid=initial.events.at(-1).data.sessionId;
  await chat(url,{projectId:project.id,sessionId:sid,message:'AUTO_PRIVATE PARENT_PRIVATE_FROZEN 本轮细节'});
  const parentBefore=await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8');
  const memoryBefore=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  const child=await openSide(url,project.id,sid);
  assert.equal(child.messages.length,0);assert.equal(child.sideContext.parentSessionId,sid);
  const inspected=(await jsonApi(url,'/api/context/inspect','POST',{projectId:project.id,sessionId:child.id,message:'解释当前背景'})).data;
  assert.match(JSON.stringify(inspected.plannedRequest),/PARENT_TOPIC_FROZEN/);assert.match(JSON.stringify(inspected.plannedRequest),/PARENT_PRIVATE_FROZEN/);
  assert.ok(inspected.profile.allowedTools.includes('paper_search_online'));
  for(const name of ['project_memory_lookup','paper_import','paper_expand_library','paper_library_job'])assert.ok(!inspected.profile.allowedTools.includes(name));
  const count=requests.length;
  const childReply=await chat(url,{projectId:project.id,sessionId:child.id,message:'AUTO_PROJECT CHILD_PRIVATE_ONLY 解释互相关与卷积的区别'});
  assert.equal(childReply.events.at(-1).event,'done');assert.equal(childReply.events.at(-1).data.memory,null);
  assert.ok(requests.slice(count).every(r=>!r.messages[0]?.content.includes('你是研究记忆整理器')));
  await chat(url,{projectId:project.id,sessionId:child.id,responseMode:'review',message:'TOOL_STREAM_TEST 查找 PARENT_PRIVATE_FROZEN'});
  const childReload=(await jsonApi(url,`/api/sessions/${child.id}?projectId=${project.id}`)).data;
  assert.equal(childReload.messages.length,4);assert.ok(childReload.summary);
  assert.match(JSON.stringify(childReload.summary),/CHILD_PRIVATE_ONLY/);
  assert.equal(await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8'),parentBefore);
  const memoryAfter=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.deepEqual(memoryAfter.project,memoryBefore.project);assert.deepEqual(memoryAfter.conversation,memoryBefore.conversation);
  const siblings=(await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${project.id}`)).data.conversations;
  assert.equal(siblings.length,1);assert.equal(siblings[0].id,child.id);
  const roots=(await jsonApi(url,`/api/sessions?projectId=${project.id}`)).data.sessions;
  assert.deepEqual(roots.map(s=>s.id),[sid]);
  await chat(url,{projectId:project.id,sessionId:sid,message:'CORRECT_AUTO PARENT_AFTER_FORK 新背景'});
  const sideNow=(await jsonApi(url,'/api/context/inspect','POST',{projectId:project.id,sessionId:child.id,responseMode:'review',message:'继续解释'})).data;
  assert.doesNotMatch(JSON.stringify(sideNow.plannedRequest),/PARENT_AFTER_FORK/);
  const other=await openSide(url,project.id,sid);
  const otherInput=(await jsonApi(url,'/api/context/inspect','POST',{projectId:project.id,sessionId:other.id,message:'讨论背景'})).data;
  assert.match(JSON.stringify(otherInput.plannedRequest),/PARENT_AFTER_FORK/);
  assert.doesNotMatch(JSON.stringify(otherInput.plannedRequest),/CHILD_PRIVATE_ONLY/);
  const rootInput=(await jsonApi(url,'/api/context/inspect','POST',{projectId:project.id,sessionId:sid,message:'继续主线'})).data;
  assert.doesNotMatch(JSON.stringify(rootInput.plannedRequest),/CHILD_PRIVATE_ONLY/);
});

test('side snapshots honor excluded and edited messages, manual summaries, extra context and disabled lookup',async(t)=>{
  const {url}=await startApp(t);const project=await newProject(url,'子对话上下文权限');
  const first=await chat(url,{projectId:project.id,message:'PARENT_HIDDEN_SECRET'});const sid=first.events.at(-1).data.sessionId;
  await chat(url,{projectId:project.id,sessionId:sid,message:'PARENT_ORIGINAL_VALUE'});
  const parent=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data;
  const controls={...DEFAULT_CONTEXT_CONTROLS,excludedMessageIds:[parent.messages[0].id],messageEdits:{[parent.messages[2].id]:'PARENT_EDITED_VALUE'},allowSourceLookup:false,extraContext:'PARENT_EXTRA_FROZEN'};
  await jsonApi(url,'/api/context/controls','PUT',{projectId:project.id,sessionId:sid,expectedRevision:0,controls});
  const child=await openSide(url,project.id,sid);
  const inspected=(await jsonApi(url,'/api/context/inspect','POST',{projectId:project.id,sessionId:child.id,message:'解释背景'})).data;
  const payload=JSON.stringify(inspected.plannedRequest);
  assert.doesNotMatch(payload,/PARENT_HIDDEN_SECRET|PARENT_ORIGINAL_VALUE/);assert.match(payload,/PARENT_EDITED_VALUE/);assert.match(payload,/PARENT_EXTRA_FROZEN/);
  assert.deepEqual(inspected.profile.allowedTools,[]);
  const manual={...controls,summaryMode:'manual',summaryText:'MANUAL_SNAPSHOT_ONLY'};
  await jsonApi(url,'/api/context/controls','PUT',{projectId:project.id,sessionId:sid,expectedRevision:1,controls:manual});
  const manualChild=await openSide(url,project.id,sid);
  const manualInput=(await jsonApi(url,'/api/context/inspect','POST',{projectId:project.id,sessionId:manualChild.id,message:'解释背景'})).data;
  assert.match(JSON.stringify(manualInput.plannedRequest),/MANUAL_SNAPSHOT_ONLY/);
  assert.doesNotMatch(JSON.stringify(manualInput.plannedRequest),/PARENT_EDITED_VALUE|PARENT_ORIGINAL_VALUE|PARENT_HIDDEN_SECRET/);
});

test('side conversations cannot write project memories, extract memory or start library expansion; deleted branches and parents restore safely',async(t)=>{
  const {url}=await startApp(t,'sections',{AUTOMATIC_MEMORY:'true'});
  const project=await newProject(url,'只读子对话'),foreign=await newProject(url,'其他项目');
  const first=await chat(url,{projectId:project.id,message:'主对话研究背景'}),sid=first.events.at(-1).data.sessionId;
  const child=await openSide(url,project.id,sid);
  const reply=await chat(url,{projectId:project.id,sessionId:child.id,message:'帮我补充论文到知识库'});
  assert.equal(reply.response.status,200);
  const stored=(await jsonApi(url,`/api/sessions/${child.id}?projectId=${project.id}`)).data;
  const source=stored.messages[0];
  assert.equal((await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${child.id}`,'POST',{sourceId:source.id})).status,403);
  assert.equal((await jsonApi(url,`/api/projects/${project.id}/extract`,'POST',{sessionId:child.id,expectedVersion:1})).status,403);
  assert.equal((await jsonApi(url,`/api/projects/${project.id}/memories`,'POST',{expectedVersion:1,candidates:[{kind:'hypothesis',text:'不得共享的子对话',sourceSessionId:child.id,sourceMessageIds:[source.id]}]})).status,403);
  const view=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${child.id}`)).data;
  assert.equal(view.project.items.length,0);assert.equal(view.conversation.items.length,0);
  assert.equal((await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${foreign.id}`)).status,404);
  assert.equal((await jsonApi(url,`/api/sessions/${child.id}?projectId=${foreign.id}`)).status,404);
  assert.equal((await jsonApi(url,`/api/sessions/${child.id}/side-conversations?projectId=${project.id}`,'POST',{})).status,400);
  assert.equal((await jsonApi(url,`/api/sessions/${child.id}?projectId=${project.id}`,'DELETE')).status,200);
  assert.equal((await jsonApi(url,`/api/sessions/${child.id}?projectId=${project.id}`)).status,404);
  const trash=(await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${project.id}&deleted=true`)).data.conversations;
  assert.equal(trash.length,1);
  assert.equal((await jsonApi(url,`/api/sessions/${child.id}/restore?projectId=${project.id}`,'POST')).status,200);
  await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`,'DELETE');
  assert.equal((await jsonApi(url,`/api/sessions/${child.id}?projectId=${project.id}`)).status,404);
  await jsonApi(url,`/api/sessions/${sid}/restore?projectId=${project.id}`,'POST');
  assert.equal((await jsonApi(url,`/api/sessions/${child.id}?projectId=${project.id}`)).data.messages.length,2);
});

test('projectless side conversations work, and a parent cannot be deleted while its child is responding',async(t)=>{
  const {url}=await startApp(t);
  const first=await chat(url,{message:'INDEPENDENT_PARENT_CONTEXT'}),sid=first.events.at(-1).data.sessionId;
  const child=await openSide(url,null,sid);
  const pending=chat(url,{sessionId:child.id,message:'HOLD_TEST'});
  for(let i=0;i<20;i++){
    const current=await jsonApi(url,`/api/sessions/${child.id}`);if(current.data.messages.some(m=>m.content==='HOLD_TEST'))break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal((await jsonApi(url,`/api/sessions/${sid}`,'DELETE')).status,409);
  const root=await chat(url,{sessionId:sid,message:'父对话继续主线'});
  assert.equal(root.response.status,200);assert.equal((await pending).response.status,200);
  const branchInput=(await jsonApi(url,'/api/context/inspect','POST',{sessionId:child.id,message:'继续'})).data;
  assert.match(JSON.stringify(branchInput.plannedRequest),/INDEPENDENT_PARENT_CONTEXT/);
  assert.doesNotMatch(JSON.stringify(branchInput.plannedRequest),/父对话继续主线/);
});

test('the library side conversation reads and controls only its parent tasks and keeps follow-ups out of shared memory',async(t)=>{
  const {url,requests,sessionsDir}=await startApp(t,'sections',{AUTOMATIC_MEMORY:'true'});
  const project=await newProject(url,'补库侧边窗口'),foreign=await newProject(url,'外部项目');
  const initial=await chat(url,{projectId:project.id,message:'EXPAND_LIBRARY_TEST 根据当前主题补充1篇论文到知识库'});
  const sid=initial.events.at(-1).data.sessionId;
  const job=(await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${sid}`)).data.jobs[0];
  const created=await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${project.id}`,'POST',{purpose:'library'});
  assert.equal(created.status,201);const child=created.data.conversation;
  assert.equal(child.sideContext.purpose,'library');
  assert.deepEqual((await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${project.id}`)).data.conversations,[]);
  assert.equal((await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${project.id}&purpose=library`)).data.conversations[0].id,child.id);
  const scoped=`?projectId=${project.id}&sessionId=${child.id}`;
  assert.equal((await jsonApi(url,'/api/library-jobs'+scoped)).data.jobs[0].id,job.id);
  const inspected=(await jsonApi(url,'/api/context/inspect','POST',{projectId:project.id,sessionId:child.id,message:'查进度'})).data;
  assert.ok(inspected.profile.allowedTools.includes('paper_library_job'));
  assert.ok(inspected.profile.allowedTools.includes('paper_expand_library'));
  assert.ok(inspected.profile.allowedTools.includes('paper_import'));
  const before=await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8');
  const memoryBefore=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  const count=requests.length;
  const response=await chat(url,{projectId:project.id,sessionId:child.id,message:'LIBRARY_SIDE_STATUS_TEST AUTO_PROJECT PRIVATE_LIBRARY_DISCUSSION 查补库任务'});
  assert.equal(response.events.at(-1).data.execution.toolCalls,1);
  const tool=requests.slice(count).flatMap(r=>r.messages.filter(m=>m.role==='tool')).at(-1);
  assert.equal(JSON.parse(tool.content).id,job.id);
  assert.equal(await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8'),before);
  const memoryAfter=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.deepEqual(memoryAfter.project,memoryBefore.project);assert.deepEqual(memoryAfter.conversation,memoryBefore.conversation);
  assert.ok(requests.slice(count).every(r=>!r.messages[0]?.content.includes('你是研究记忆整理器')));
  const otherReply=await chat(url,{projectId:project.id,message:'另一个主对话'}),otherId=otherReply.events.at(-1).data.sessionId;
  const otherChild=(await jsonApi(url,`/api/sessions/${otherId}/side-conversations?projectId=${project.id}`,'POST',{purpose:'library'})).data.conversation;
  assert.equal((await jsonApi(url,`/api/library-jobs/${job.id}?projectId=${project.id}&sessionId=${otherChild.id}`)).status,404);
  assert.equal((await jsonApi(url,`/api/library-jobs/${job.id}/control?projectId=${project.id}&sessionId=${otherChild.id}`,'POST',{action:'pause'})).status,404);
  assert.equal((await jsonApi(url,`/api/library-jobs/${job.id}?projectId=${foreign.id}&sessionId=${child.id}`)).status,404);
  assert.equal((await jsonApi(url,`/api/library-jobs/${job.id}/control`+scoped,'POST',{action:'adjust',sourceId:'fake'})).status,400);
  const ordinary=await openSide(url,project.id,sid);
  assert.deepEqual((await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${ordinary.id}`)).data.jobs,[]);
  assert.equal((await jsonApi(url,`/api/library-jobs/${job.id}/control?projectId=${project.id}&sessionId=${ordinary.id}`,'POST',{action:'pause'})).status,403);
});

test('library-side pause and resume use the side user message for authorization without copying it into the parent',async(t)=>{
  const {url,requests}=await startApp(t);const project=await newProject(url,'补库控制');
  const root=await chat(url,{projectId:project.id,message:'LIBRARY_PAUSE_HOLD 根据当前主题补充论文到知识库'}),sid=root.events.at(-1).data.sessionId;
  const source=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data.messages[0];
  const child=(await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${project.id}`,'POST',{purpose:'library'})).data.conversation;
  const created=await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${sid}`,'POST',{sourceId:source.id});
  assert.equal(created.status,202);const id=created.data.job.id;
  const pause=await chat(url,{projectId:project.id,sessionId:child.id,message:'LIBRARY_SIDE_PAUSE_TEST 暂停补库'});
  assert.equal(pause.events.at(-1).data.execution.toolCalls,1);
  const paused=await jsonApi(url,`/api/library-jobs/${id}?projectId=${project.id}&sessionId=${child.id}`);
  assert.equal(paused.data.job.status,'paused');
  const resume=await chat(url,{projectId:project.id,sessionId:child.id,message:'LIBRARY_SIDE_RESUME_TEST 继续刚才的补库'});
  assert.equal(resume.events.at(-1).data.execution.toolCalls,1);
  const tool=requests.at(-1).messages.findLast(m=>m.role==='tool');assert.ok(['queued','running'].includes(JSON.parse(tool.content).status));
  const parent=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data;
  assert.equal(parent.messages.length,2);assert.doesNotMatch(JSON.stringify(parent.messages),/LIBRARY_SIDE_PAUSE_TEST|LIBRARY_SIDE_RESUME_TEST/);
});

test('the library window can create and adjust source-bound jobs while parent messages and memories stay unchanged',async(t)=>{
  const {url,requests,sessionsDir}=await startApp(t,'sections',{AUTOMATIC_MEMORY:'true'});
  const project=await newProject(url,'补库子窗口完整权限');
  const initial=await chat(url,{projectId:project.id,message:'AUTO_PROJECT INHERITED_LIBRARY_TOPIC 低纹理图像匹配'}),sid=initial.events.at(-1).data.sessionId;
  const child=(await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${project.id}`,'POST',{purpose:'library'})).data.conversation;
  const before=await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8');
  const memories=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  const count=requests.length;
  const reply=await chat(url,{projectId:project.id,sessionId:child.id,message:'EXPAND_LIBRARY_TEST CHILD_CREATE_ONLY 根据继承背景补充1篇论文到知识库'});
  assert.equal(reply.events.at(-1).data.execution.toolCalls,1);
  let jobs;
  for(let i=0;i<30;i++){jobs=(await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${child.id}`)).data.jobs;if(jobs[0]?.status==='needs_input')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(jobs[0].status,'needs_input');assert.equal(jobs[0].maxPapers,1);
  assert.equal((await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${sid}`)).data.jobs[0].id,jobs[0].id);
  const plan=requests.slice(count).find(r=>r.messages[0]?.content.includes('你是科研论文补库规划器'));
  const snapshot=JSON.parse(plan.messages.at(-1).content).snapshot;
  assert.match(JSON.stringify(snapshot),/INHERITED_LIBRARY_TOPIC|低纹理图像匹配/);assert.match(JSON.stringify(snapshot),/CHILD_CREATE_ONLY/);
  const followup=await chat(url,{projectId:project.id,sessionId:child.id,message:'LIBRARY_SIDE_RESUME_TEST 新方向为跨模态匹配，继续补库'});
  assert.equal(followup.events.at(-1).data.execution.toolCalls,1);
  const all=(await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${child.id}`)).data.jobs;
  assert.equal(all.length,2);assert.match(all[0].request,/新方向为跨模态匹配/);
  assert.equal(await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8'),before);
  const after=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.deepEqual(after.project,memories.project);assert.deepEqual(after.conversation,memories.conversation);
  const rootLogs=(await jsonApi(url,`/api/sessions/${sid}/context-requests?projectId=${project.id}`)).data.requests;
  assert.doesNotMatch(JSON.stringify(rootLogs),/CHILD_CREATE_ONLY|新方向为跨模态匹配/);
  assert.equal((await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${child.id}`,'POST',{sourceId:initial.events.find(e=>e.event==='meta').data.turnId})).status,400);
});

test('proposal workflow first-request preview is exact, local search precedes advice and missing evidence becomes a separate queued job',async(t)=>{
  const {url,requests,sessionsDir}=await startApp(t);
  const project=await newProject(url,'方案工作流端到端验收');
  const initial=await chat(url,{projectId:project.id,message:'虚构研究背景：光学SAR局部匹配'});
  const sid=initial.events.at(-1).data.sessionId;
  const message='PROPOSAL_WORKFLOW_TEST 请给提高局部跨模态区分能力的具体方案';
  const prepared=await jsonApi(url,'/api/context/preview','POST',{projectId:project.id,sessionId:sid,message});
  assert.equal(prepared.data.plannedRequest.tool_choice.function.name,'proposal_route');
  const count=requests.length;
  const reply=await chat(url,{projectId:project.id,sessionId:sid,message,previewId:prepared.data.previewId});
  assert.equal(reply.events.at(-1).event,'done');
  assert.deepEqual(requests[count],prepared.data.plannedRequest);
  const execution=reply.events.at(-1).data.execution;
  assert.equal(execution.proposalWorkflow.route,'proposal');
  assert.equal(execution.proposalWorkflow.background.job.status,'queued');
  assert.equal(execution.paperSupplement.needed,true);
  assert.match(execution.paperSupplement.requirements[0].direction,/光学SAR/);
  assert.equal(execution.taskState,null);
  assert.equal(execution.toolCalls,1);
  assert.equal(reply.events.filter(e=>e.event==='delta').map(e=>e.data.text).join(''),'测试回复。');
  const jobs=(await jsonApi(url,`/api/library-jobs?projectId=${project.id}&sessionId=${sid}`)).data.jobs;
  assert.equal(jobs.length,1);assert.equal(jobs[0].origin,'proposal_evidence_gap');
  assert.match(jobs[0].directions[0].direction,/光学SAR/);
  const log=(await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(log.some(e=>JSON.stringify(e).includes('"stage":"ready"')));
  const traces=(await jsonApi(url,`/api/sessions/${sid}/context-requests?projectId=${project.id}`)).data.requests;
  assert.ok(traces.some(r=>r.stage==='proposal_route'));assert.ok(traces.some(r=>r.stage==='proposal_assessment'));
  const stored=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data;
  assert.equal(stored.messages.length,4);
  assert.deepEqual(stored.messages.at(-1).paperSupplement,execution.paperSupplement);
  assert.doesNotMatch(JSON.stringify(stored.messages),/补充方向|job_id/);
});


test('a failed unanswered turn can be retried without adding a second user message, and stale retry requests are rejected',async(t)=>{
  const {url,requests}=await startApp(t);
  const initial=await chat(url,{message:'FAIL_ONCE_EMPTY_TEST 当前问题'});
  assert.equal(initial.events.at(-1).event,'error');
  const sid=initial.events.find(e=>e.event==='meta').data.sessionId;
  const failed=(await jsonApi(url,`/api/sessions/${sid}`)).data;
  assert.equal(failed.messages.length,1);assert.equal(failed.messages[0].replyStatus,'failed');assert.equal(failed.isResponding,false);
  const source=failed.messages[0],count=requests.length;
  const retry=await chat(url,{sessionId:sid,message:source.content,retry:{messageId:source.id,expectedRevision:failed.messageRevision}});
  assert.equal(retry.events.at(-1).event,'done');
  const final=(await jsonApi(url,`/api/sessions/${sid}`)).data;
  assert.equal(final.messages.length,2);assert.equal(final.messages[0].id,source.id);assert.equal(final.messages[0].replyStatus,'complete');assert.equal(final.messageRevision,1);
  assert.equal(requests[count].messages.filter(m=>m.role==='user'&&m.content===source.content).length,1);
  const attempts=requests.length;
  const stale=await chat(url,{sessionId:sid,message:source.content,retry:{messageId:source.id,expectedRevision:0}});
  assert.equal(stale.response.status,409);assert.equal(requests.length,attempts);
});
test('an upstream stream ending without a completion marker saves only a marked fragment, and retry excludes it',async(t)=>{
  const {url,requests}=await startApp(t);
  const initial=await chat(url,{message:'TRUNCATED_ONCE_TEST 当前问题'});
  assert.equal(initial.events.at(-1).event,'error');
  const sid=initial.events.find(e=>e.event==='meta').data.sessionId;
  const failed=(await jsonApi(url,`/api/sessions/${sid}`)).data;
  assert.equal(failed.messages.length,2);assert.equal(failed.messages[1].status,'incomplete');assert.equal(failed.messages[1].content,'PARTIAL_NOT_FINAL');
  const source=failed.messages[0],count=requests.length;
  const retry=await chat(url,{sessionId:sid,message:source.content,retry:{messageId:source.id,expectedRevision:0}});
  assert.equal(retry.events.at(-1).event,'done');assert.doesNotMatch(JSON.stringify(requests.slice(count)),/PARTIAL_NOT_FINAL/);
  const final=(await jsonApi(url,`/api/sessions/${sid}`)).data;
  assert.equal(final.messages.length,2);assert.equal(final.messages[1].status,'complete');
});
test('editing a completed turn excludes its old answer and project memory, keeps raw revisions and regenerates only the latest question',async(t)=>{
  const {url,requests,sessionsDir}=await startApp(t,'sections',{AUTOMATIC_MEMORY:'true'});
  const project=await newProject(url,'编辑后重发');
  const first=await chat(url,{projectId:project.id,message:'AUTO_PROJECT OLD_FACT 数据是旧值'});
  const sid=first.events.at(-1).data.sessionId;
  const before=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data;
  const count=requests.length;
  const edited=await chat(url,{projectId:project.id,sessionId:sid,message:'AUTO_PROJECT CORRECTED_FACT 数据改正',retry:{messageId:before.messages[0].id,expectedRevision:0}});
  assert.equal(edited.events.at(-1).event,'done');
  const calls=requests.slice(count).filter(r=>!r.messages[0]?.content.includes('你是研究记忆整理器'));
  assert.ok(calls.length);assert.doesNotMatch(JSON.stringify(calls),/OLD_FACT/);
  const after=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data;
  assert.equal(after.messages.length,2);assert.notEqual(after.messages[0].id,before.messages[0].id);
  const memories=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.match(JSON.stringify(memories.project.items),/CORRECTED_FACT/);assert.doesNotMatch(JSON.stringify(memories.project.items),/OLD_FACT/);
  assert.match(await fs.readFile(path.join(sessionsDir,sid+'.jsonl'),'utf8'),/OLD_FACT/);
  const next=await chat(url,{projectId:project.id,sessionId:sid,message:'下一轮'});
  assert.equal(next.events.at(-1).event,'done');
  const invalid=await chat(url,{projectId:project.id,sessionId:sid,message:'非法修改旧轮',retry:{messageId:after.messages[0].id,expectedRevision:after.messageRevision}});
  assert.equal(invalid.response.status,409);
});
test('side-conversation retry stays private and a retry cannot replace an active turn',async(t)=>{
  const {url}=await startApp(t,'sections',{AUTOMATIC_MEMORY:'true'});
  const project=await newProject(url,'子对话重发隔离');
  const root=await chat(url,{projectId:project.id,message:'AUTO_PROJECT PARENT_FIXED_BACKGROUND'}),sid=root.events.at(-1).data.sessionId;
  const child=await openSide(url,project.id,sid);
  const failed=await chat(url,{projectId:project.id,sessionId:child.id,message:'FAIL_ONCE_EMPTY_TEST 子对话问题'});
  assert.equal(failed.events.at(-1).event,'error');
  const state=(await jsonApi(url,`/api/sessions/${child.id}?projectId=${project.id}`)).data;
  const retry=await chat(url,{projectId:project.id,sessionId:child.id,message:'子对话修改后的问题',retry:{messageId:state.messages[0].id,expectedRevision:0}});
  assert.equal(retry.events.at(-1).event,'done');
  const parent=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data;
  assert.equal(parent.messages.length,2);assert.doesNotMatch(JSON.stringify(parent),/子对话修改后的问题/);
  const memory=(await jsonApi(url,`/api/memory-console?projectId=${project.id}&sessionId=${sid}`)).data;
  assert.doesNotMatch(JSON.stringify(memory.project.items),/子对话修改后的问题/);
  const held=await fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,projectId:project.id,message:'HOLD_TEST'})});
  const active=(await jsonApi(url,`/api/sessions/${sid}?projectId=${project.id}`)).data;
  assert.equal(active.isResponding,true);
  const clash=await chat(url,{sessionId:sid,projectId:project.id,message:'HOLD_TEST',retry:{messageId:active.messages.at(-1).id,expectedRevision:active.messageRevision}});
  assert.equal(clash.response.status,409);await held.text();
});



test('project deletion hides every scoped resource and restoration preserves chats, memories, paper assets and conversation trash',async t=>{
  const {url,requests}=await startApp(t,'sections',{PAPER_PYTHON:'/not-installed-project-deletion-parser'});
  let p=await newProject(url,'可恢复项目');const other=await newProject(url,'可恢复项目');
  const first=await chat(url,{projectId:p.id,message:'项目内研究记录'}),sid=first.events.find(e=>e.event==='meta').data.sessionId;
  p=await addCandidates(url,p,[{kind:'hypothesis',text:'项目假设保留'}]);p=await confirm(url,p,p.memories[0]);
  const side=(await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${p.id}`,'POST',{})).data.conversation;
  const old=await chat(url,{projectId:p.id,message:'已经删除的对话'}),oldId=old.events.find(e=>e.event==='meta').data.sessionId;
  await jsonApi(url,`/api/sessions/${oldId}?projectId=${p.id}`,'DELETE');
  const pdf=Buffer.from('%PDF-1.4\nPROJECT_DELETE_PDF_FIXTURE\n%%EOF');
  const uploaded=await fetch(url+`/api/papers/upload?projectId=${p.id}&name=keep.pdf`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:pdf});
  const paper=(await uploaded.json()).paper;assert.equal(uploaded.status,202);
  assert.equal((await jsonApi(url,`/api/projects/${p.id}`,'DELETE',{expectedVersion:p.version-1})).status,409);
  const deleted=await jsonApi(url,`/api/projects/${p.id}`,'DELETE',{expectedVersion:p.version});assert.equal(deleted.status,200);
  assert.deepEqual((await jsonApi(url,'/api/projects')).data.projects.map(p=>p.id),[other.id]);
  assert.equal((await jsonApi(url,'/api/projects?deleted=true')).data.projects[0].id,p.id);
  for(const route of [`/api/projects/${p.id}`,`/api/projects/${p.id}?deleted=true`,`/api/sessions?projectId=${p.id}`,`/api/sessions/${sid}?projectId=${p.id}`,`/api/sessions/${sid}/context-requests?projectId=${p.id}`,`/api/sessions/${sid}/side-conversations?projectId=${p.id}`,`/api/sessions/${side.id}?projectId=${p.id}`,`/api/memory-console?projectId=${p.id}`,`/api/papers?projectId=${p.id}`,`/api/library-jobs?projectId=${p.id}&sessionId=${sid}`])assert.equal((await jsonApi(url,route)).status,404,route);
  assert.equal((await fetch(url+`/api/papers/${paper.id}/assets/original.pdf?projectId=${p.id}&deleted=true`)).status,404);
  const calls=requests.length;assert.equal((await chat(url,{projectId:p.id,sessionId:sid,message:'不能再发'})).response.status,404);assert.equal(requests.length,calls);
  assert.equal((await jsonApi(url,'/api/context/usage','POST',{projectId:p.id,sessionId:sid,message:'检查'})).status,404);
  assert.equal((await jsonApi(url,`/api/projects/${p.id}/restore`,'POST',{expectedVersion:p.version})).status,409);
  const restored=await jsonApi(url,`/api/projects/${p.id}/restore`,'POST',{expectedVersion:deleted.data.version});assert.equal(restored.status,200);assert.equal(restored.data.memories[0].text,'项目假设保留');
  assert.equal((await jsonApi(url,`/api/sessions/${sid}?projectId=${p.id}`)).data.messages[0].content,'项目内研究记录');
  assert.equal((await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${p.id}`)).data.conversations[0].id,side.id);
  assert.equal((await jsonApi(url,`/api/sessions?projectId=${p.id}&deleted=true`)).data.sessions[0].id,oldId);
  assert.equal((await jsonApi(url,`/api/sessions?projectId=${p.id}`)).data.sessions.some(s=>s.id===oldId),false);
  const asset=await fetch(url+`/api/papers/${paper.id}/assets/original.pdf?projectId=${p.id}`);assert.equal(asset.status,200);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),pdf);
  assert.equal((await jsonApi(url,`/api/projects/${other.id}`)).status,200);
});

test('an active side conversation prevents project deletion even when its parent is idle',async t=>{
  const {url}=await startApp(t),p=await newProject(url,'子对话删除保护');
  const first=await chat(url,{projectId:p.id,message:'主对话'}),sid=first.events.find(e=>e.event==='meta').data.sessionId;
  const side=(await jsonApi(url,`/api/sessions/${sid}/side-conversations?projectId=${p.id}`,'POST',{})).data.conversation;
  const held=await fetch(url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectId:p.id,sessionId:side.id,message:'HOLD_TEST'})});
  assert.equal((await jsonApi(url,'/api/projects')).data.projects.find(project=>project.id===p.id).isResponding,true);
  assert.equal((await jsonApi(url,`/api/projects/${p.id}`,'DELETE',{expectedVersion:p.version})).status,409);
  await held.text();assert.equal((await jsonApi(url,`/api/projects/${p.id}`,'DELETE',{expectedVersion:p.version})).status,200);
});
