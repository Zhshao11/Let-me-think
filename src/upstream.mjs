import { config, assertConfigured, RESEARCH_MODEL } from './config.mjs';

const PROGRESS_OPEN = '<progress>';
const PROGRESS_CLOSE = '</progress>';

// Extract <progress>...</progress> from a stream of text deltas.
// Progress lines travel on their own channel; only the rest reaches the transcript.
class ProgressSplitter {
  constructor(onDelta, onProgress) {
    this.pending = '';
    this.onDelta = onDelta;
    this.onProgress = onProgress;
  }

  push(text) {
    if (!text) return;
    this.pending += text;
    while (true) {
      const open = this.pending.indexOf(PROGRESS_OPEN);
      if (open === -1) {
        this.flushPlain();
        return;
      }
      if (open > 0) {
        this.onDelta(this.pending.slice(0, open));
        this.pending = this.pending.slice(open);
      }
      const close = this.pending.indexOf(PROGRESS_CLOSE, PROGRESS_OPEN.length);
      if (close === -1) return; // wait for the closing tag in a later chunk
      const content = this.pending.slice(PROGRESS_OPEN.length, close);
      if (content.trim()) this.onProgress(content.trim());
      this.pending = this.pending.slice(close + PROGRESS_CLOSE.length);
    }
  }

  flushPlain() {
    // Keep a possible prefix of the opening tag in case it is split across chunks.
    let hold = 0;
    for (let n = 1; n < PROGRESS_OPEN.length; n++) {
      if (this.pending.endsWith(PROGRESS_OPEN.slice(0, n))) { hold = n; break; }
    }
    const emit = hold ? this.pending.slice(0, -hold) : this.pending;
    this.pending = hold ? this.pending.slice(-hold) : '';
    if (emit) this.onDelta(emit);
  }

  end() {
    if (this.pending) this.onDelta(this.pending);
    this.pending = '';
  }
}

async function readError(response) {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    return body?.error?.message ?? body?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || `HTTP ${response.status}`;
  }
}

export function chatRequestBody({ messages, model, reasoningEffort = config.reasoningEffort, maxCompletionTokens, tools = [], toolChoice }) {
  if(model&&model!==RESEARCH_MODEL)throw new Error(`模型已固定为 ${RESEARCH_MODEL}，已阻止其他语言模型请求。`);
  const body = {
    model: RESEARCH_MODEL,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (maxCompletionTokens) body.max_completion_tokens = maxCompletionTokens;
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? 'auto';
  }
  return body;
}

export async function streamChat({ messages, model, onDelta = () => {}, onProgress = () => {}, onReasoning, signal,
  reasoningEffort = config.reasoningEffort, maxCompletionTokens, tools = [], toolChoice, onRequest }) {
  assertConfigured();
  const body = chatRequestBody({ messages, model, reasoningEffort, maxCompletionTokens, tools, toolChoice });
  const toolCalls = new Map();
  let finishReason = null;
  let usage = null;
  let streamCompleted = false;

  onRequest?.(structuredClone(body));
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw new Error(await readError(response));
  if (!response.body) throw new Error('Upstream returned no stream body');

  const splitter = new ProgressSplitter(onDelta, onProgress);
  const decoder = new TextDecoder();
  let buffer = '';

  const handleEvent = (event) => {
    const line = event.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { streamCompleted = true; return; }
    if (!payload) return;
    let json;
    try { json = JSON.parse(payload); } catch { return; }
    if (json.error) throw new Error(json.error.message ?? 'Upstream stream error');
    if (json.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta ?? {};
    for (const fragment of delta.tool_calls ?? []) {
      const call = toolCalls.get(fragment.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      toolCalls.set(fragment.index, call);
    }
    if (typeof delta.content === 'string' && delta.content) {
      splitter.push(delta.content);
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning && onReasoning) onReasoning(reasoning);
  };

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleEvent(event);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleEvent(buffer);
  splitter.end();
  if (!streamCompleted && !finishReason) throw new Error('模型连接中断，回复尚未完成，请重试。');
  return { toolCalls: [...toolCalls.values()], finishReason, usage };
}
