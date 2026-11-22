import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContext, estimateTokens, validateSummary, compressionStrategy } from '../src/agent/context.mjs';
import { countText, tokenModelInfo } from '../src/agent/tokens.mjs';
import { validateAutomaticMemories } from '../src/memory-store.mjs';
import { getAgentProfile, resolveAgentProfile } from '../src/agent/profiles.mjs';
import { runAgent } from '../src/agent/runtime.mjs';
import { executeTool } from '../src/agent/tools.mjs';
import { ContextPreviews } from '../src/agent/context-manager.mjs';
import { DEFAULT_CONTEXT_CONTROLS, validateContextControls, controlledHistory, controlledMemories } from '../src/agent/context-controls.mjs';

const empty = () => ({ userReports: [], assistantHypotheses: [], userDecisions: [], openQuestions: [] });
const message = (id, role, content) => ({ id, role, content });
const session = (messages, mode = 'concise') => ({ messages, summary: null, lastTurnContext: { responseMode: mode, systemPrompt: 'sections' } });
const base = (state, profile = getAgentProfile()) => ({ session: state, profile, systemPrompt: 'Expert protocol', currentMessage: '最新问题不能丢失', model: 'mock' });

test('mode switch replaces old raw style with provenance-bearing neutral memory; raw records stay intact', async () => {
  const history = [message('u1', 'user', '用户报告 AUC=50.1'), message('a1', 'assistant', 'OLD_STYLE_MARKER 务必长篇输出')];
  const original = structuredClone(history);
  let calls = 0;
  const summaries = [];
  const result = await prepareContext({ ...base(session(history), getAgentProfile('review')),
    summarize: async ({ additions }) => {
      calls++;
      assert.equal(additions[1].content, original[1].content);
      return { ...empty(), userReports: [{ text: '用户报告 AUC=50.1，未独立验证', sourceIds: ['u1'] }] };
    }, onSummary: (summary) => summaries.push(summary),
  });
  assert.equal(result.stats.modeChanged, true);
  assert.equal(result.stats.recentMessages, 0);
  assert.equal(result.stats.summarizedMessages, 2);
  assert.doesNotMatch(JSON.stringify(result.messages), /OLD_STYLE_MARKER/);
  assert.match(JSON.stringify(result.messages), /50.1/);
  assert.deepEqual(history, original);
  assert.equal(result.messages.at(-1).content, '最新问题不能丢失');
  const state = session(history, 'review');
  state.summary = summaries[0];
  const cached = await prepareContext({ ...base(state, getAgentProfile('review')), summarize: async () => { throw new Error('Unexpected recompression'); } });
  assert.equal(cached.stats.summaryCalls, 0);
  assert.equal(calls, 1);
});

test('budget compaction is bounded, keeps recent raw turns and rejects oversized current input', async () => {
  const history = [];
  for (let index = 0; index < 8; index++) {
    history.push(message(`u${index}`, 'user', '条件=840；'.repeat(110)), message(`a${index}`, 'assistant', '实验建议'.repeat(100)));
  }
  const profile = { ...getAgentProfile(), inputBudget: 9000 };
  const result = await prepareContext({ ...base(session(history), profile), summarize: async () => empty() });
  assert.ok(result.stats.summaryCalls > 0);
  assert.ok(result.stats.recentMessages > 0);
  assert.ok(estimateTokens(result.messages) <= result.stats.inputBudget);
  assert.equal(result.messages.at(-1).content, '最新问题不能丢失');
  await assert.rejects(() => prepareContext({ ...base(session([]), { ...profile, inputBudget: 4000 }), currentMessage: '长句测试。'.repeat(1600) }), (err) => err.status === 413);
});

test('summary validator rejects invented sources, assistant promoted to user evidence and excess text', () => {
  const sources = [message('u', 'user', '50.1'), message('a', 'assistant', '假设')];
  assert.throws(() => validateSummary(JSON.stringify({ ...empty(), userReports: [{ text: '事实', sourceIds: ['a'] }] }), sources));
  assert.throws(() => validateSummary(JSON.stringify({ ...empty(), assistantHypotheses: [{ text: '假设', sourceIds: ['invented'] }] }), sources));
  assert.throws(() => validateSummary(JSON.stringify({ ...empty(), userReports: [{ text: '长'.repeat(2000), sourceIds: ['u'] }] }), sources));
  assert.deepEqual(validateSummary(JSON.stringify(empty()), sources), empty());
});

test('review profile performs a private candidate call and a separate final review, without leaking draft', async () => {
  const outputs = [];
  const requests = [];
  const profile = getAgentProfile('review');
  const execution = await runAgent({ profile, messages: [{ role: 'user', content: '研究问题' }], history: [],
    onDelta: (text) => outputs.push(text),
    complete: async (request) => {
      requests.push(structuredClone({ messages: request.messages, tools: request.tools }));
      assert.equal(request.reasoningEffort, 'high');
      request.onDelta(requests.length === 1 ? 'PRIVATE_DRAFT' : '最终判断');
      return { toolCalls: [] };
    },
  });
  assert.deepEqual(outputs, ['最终判断']);
  assert.equal(execution.modelCalls, 2);
  assert.equal(execution.reviewPasses, 1);
  assert.equal(requests[0].tools[0].function.name, 'conversation_lookup');
  assert.deepEqual(requests[1].tools, []);
  assert.match(JSON.stringify(requests[1].messages), /PRIVATE_DRAFT/);
  assert.deepEqual(requests[1].messages.filter(m=>m.role==='user'),[{role:'user',content:'研究问题'}]);
  assert.equal(requests[1].messages.at(-1).role,'user');
});

test('tool calls are scoped to server history, bounded by profile and passed back as tool messages', async () => {
  const history = [message('u', 'user', '训练分辨率840，指标50.1'), message('a', 'assistant', '待验证假设')];
  let calls = 0;
  const outputs = [];
  const execution = await runAgent({ profile: getAgentProfile('detailed'), history, messages: [{ role: 'user', content: '查840' }],
    onDelta: (text) => outputs.push(text),
    complete: async (request) => {
      calls++;
      if (calls === 1) return { toolCalls: [{ id: 't1', type: 'function', function: { name: 'conversation_lookup', arguments: '{"query":"840"}' } }] };
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      assert.match(toolMessage.content, /50.1/);
      assert.match(toolMessage.content, /user_report_unverified/);
      request.onDelta('根据原文作答');
      return { toolCalls: [] };
    },
  });
  assert.equal(execution.toolCalls, 1);
  assert.deepEqual(outputs, ['根据原文作答']);
  assert.throws(() => executeTool({ function: { name: 'conversation_lookup', arguments: '{"query":"840"}' } }, { profile: getAgentProfile('concise'), history }));
  assert.throws(() => executeTool({ function: { name: 'read_file', arguments: '{}' } }, { profile: getAgentProfile('review'), history }));
  assert.deepEqual(resolveAgentProfile('review', { rawMode: true }).allowedTools, []);
  assert.equal(resolveAgentProfile('review', { reasoningSupported: false }).reasoningEffort, null);
});

test('runtime blocks a provider that requests more tools than allowed', async () => {
  const request = { id: 't', type: 'function', function: { name: 'conversation_lookup', arguments: '{"query":"x"}' } };
  let calls = 0;
  await assert.rejects(() => runAgent({ profile: getAgentProfile('review'), messages: [], history: [], onDelta: () => {},
    complete: async () => { calls++; return { toolCalls: [request, { ...request, id: 't2' }, { ...request, id: 't3' }] }; },
  }), /超出/);
  assert.equal(calls, 1);
});

test('context controls preserve originals and block source-derived memory and foreign identifiers', () => {
  const state = { ...session([message('u', 'user', 'ORIGINAL_VALUE'), message('a', 'assistant', 'old assistant')]), id: 's' };
  const project = { card: { task: '' }, memories: [{ id: 'm' }] };
  const controls = validateContextControls({ ...DEFAULT_CONTEXT_CONTROLS, messageEdits: { u: 'CORRECTED_VALUE' } }, state, project);
  const materialized = controlledHistory(state, controls);
  assert.match(materialized[0].content, /CORRECTED_VALUE/);
  assert.doesNotMatch(materialized[0].content, /ORIGINAL_VALUE/);
  assert.equal(state.messages[0].content, 'ORIGINAL_VALUE');
  assert.deepEqual(controlledMemories([{ id: 'm', sourceSessionId: 's', sourceMessageIds: ['u'] }], { controls, sessionId: 's', allMessageIds: ['u', 'a'] }), []);
  assert.throws(() => validateContextControls({ excludedMessageIds: ['foreign'] }, state, project), /当前会话或项目/);
  assert.throws(() => validateContextControls({ memoryEdits: { foreign: 'x' } }, state, project), /越出/);
  assert.throws(() => validateContextControls({ tools: ['read_file'] }, state, project), /Invalid/);
});

test('dry inspection never summarizes; manual summaries and no-summary mode honor budget and selected history', async () => {
  const state = session([message('u', 'user', 'RAW_SECRET'), message('a', 'assistant', 'old')]);
  const estimate = await prepareContext({ ...base(state, getAgentProfile('review')), dryRun: true, summarize: async () => { throw new Error('Must not call'); } });
  assert.equal(estimate.stats.needsCompaction, true);
  assert.equal(estimate.stats.exact, false);
  const manual = await prepareContext({ ...base(state), summaryMode: 'manual', summaryText: 'MANUAL_CORRECTION', extraContext: 'USER_NOTE' });
  assert.match(JSON.stringify(manual.messages), /MANUAL_CORRECTION|USER_NOTE/);
  assert.doesNotMatch(JSON.stringify(manual.messages), /RAW_SECRET/);
  await assert.rejects(() => prepareContext({ ...base(session([message('big', 'user', '长句测试。'.repeat(800))]), { ...getAgentProfile(), inputBudget: 1500 }), summaryMode: 'off' }), /超过/);
});

test('preview cache expires and consumes tokens, without exposing mutable stored references', () => {
  const store = new ContextPreviews({ limit: 1 });
  const first = store.put({ messages: ['original'] });
  const copy = store.get(first); copy.messages[0] = 'changed';
  assert.equal(store.get(first).messages[0], 'original');
  store.put({ messages: [] });
  assert.throws(() => store.get(first), /过期/);
  const expired = new ContextPreviews({ ttl: -1 });
  assert.throws(() => expired.get(expired.put({})), /过期/);
});

test('token budget uses tokenization and unknown windows stay unknown; compression changes with actual occupancy', () => {
  assert.equal(countText('你好'), 1);
  assert.notEqual(countText('你好'), Buffer.byteLength('你好'));
  assert.equal(tokenModelInfo('unknown-custom-model').contextWindow, null);
  assert.equal(tokenModelInfo('unknown-custom-model').encodingSource, 'fallback_estimate');
  assert.equal(tokenModelInfo('unknown-custom-model', 65536).contextWindow, 65536);
  assert.equal(compressionStrategy(4000, 10000).id, 'full');
  assert.equal(compressionStrategy(6000, 10000).id, 'light');
  assert.equal(compressionStrategy(8500, 10000).id, 'topic');
  assert.equal(compressionStrategy(9500, 10000).id, 'deep');
});

test('GPT-6.1 Sol uses its API window and token thresholds rather than the old temporary work budget', async () => {
  const model = tokenModelInfo('gpt-6.1-sol');
  assert.equal(model.contextWindow, 1050000);
  assert.match(model.windowSourceUrl, /developers.openai.com\/api\/docs\/models\/gpt-6.1-sol/);
  assert.equal(model.encodingSource, 'fallback_estimate');
  assert.equal(tokenModelInfo('gpt-6.1-sol-2026-11-22').contextWindow, 1050000);
  assert.equal(tokenModelInfo('gpt-6.1-sol', 128000).contextWindow, 128000);
  const profile = resolveAgentProfile('concise', { contextWindow: model.contextWindow, tokenModel: model });
  const history = [message('u', 'user', Array.from({length:4000},(_,i)=>`实验${i}：低纹理匹配待验证。`).join('')), message('a','assistant','尚未验证')];
  const result = await prepareContext({ ...base(session(history), profile), dryRun: true });
  assert.ok(result.stats.estimatedTokens > 24000);
  assert.equal(result.stats.needsCompaction, false);
  assert.equal(result.stats.contextWindow, 1050000);
  const available = 1050000 - profile.maxCompletionTokens - 1024;
  assert.equal(result.stats.availableInputBudget, available);
  for (const threshold of result.stats.compressionThresholds) {
    assert.equal(threshold.tokens, Math.ceil(available * threshold.ratio));
    assert.equal(compressionStrategy(threshold.tokens, available).id, threshold.id);
  }
  assert.equal(compressionStrategy(result.stats.compressionThresholds[0].tokens-1, available).id,'full');
  assert.equal(result.stats.uncompressedTokens,result.stats.estimatedTokens);
});

test('automatic memory cannot promote assistant claims into user facts or reference foreign sources', () => {
  const values = [{ scope: 'project', category: 'progress', topic: '测试', key: 'score', text: '用户结果50.1', certainty: 'user_report', sourceMessageIds: ['a'] }];
  assert.throws(() => validateAutomaticMemories(values, [message('a', 'assistant', '建议50.1')], 'project', []), /助手/);
  assert.throws(() => validateAutomaticMemories(values, [message('u', 'user', '结果')], 'project', []), /来源/);
  const valid = validateAutomaticMemories([{ ...values[0], sourceMessageIds: ['u'] }], [message('u', 'user', '报告')], null, []);
  assert.equal(valid[0].scope, 'conversation');
});
