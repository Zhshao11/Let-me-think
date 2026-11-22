import { getEncoding } from 'js-tiktoken';

const encoders = new Map();
const countCache = new Map();
const KNOWN = [
  // API specification; the 500K Codex/Work default is a different surface.
  [/^gpt-6\.1-sol(?:-|$)/, null, 1050000, 'https://developers.openai.com/api/docs/models/gpt-6.1-sol'],
  [/^gpt-4o(?:-mini)?(?:-|$)/, 'o200k_base', 128000],
  [/^gpt-4\.1(?:-mini|-nano)?(?:-|$)/, 'o200k_base', 1047576],
  [/^(?:o1|o3|o4-mini)(?:-|$)/, 'o200k_base', 200000],
  [/^gpt-4-turbo(?:-|$)/, 'cl100k_base', 128000],
];
export function tokenModelInfo(model, configuredWindow = null, configuredEncoding = '') {
  const known = KNOWN.find(([pattern]) => pattern.test(model));
  return {
    encoding: configuredEncoding || known?.[1] || 'o200k_base',
    encodingSource: configuredEncoding ? 'configured' : known?.[1] ? 'model_mapping' : 'fallback_estimate',
    contextWindow: configuredWindow || known?.[2] || null,
    windowSource: configuredWindow ? 'configured' : known ? 'model_mapping' : 'unknown',
    windowSourceUrl: !configuredWindow ? known?.[3] ?? null : null,
    exactBeforeRequest: false,
  };
}
export function countText(text, encoding = 'o200k_base') {
  const key = `${encoding}:${text}`;
  if (countCache.has(key)) return countCache.get(key);
  if (!encoders.has(encoding)) encoders.set(encoding, getEncoding(encoding));
  const count = encoders.get(encoding).encode(String(text), [], []).length;
  if (key.length < 50000) {
    if (countCache.size >= 256) countCache.delete(countCache.keys().next().value);
    countCache.set(key, count);
  }
  return count;
}
export function countRequestTokens(messages, tools = [], encoding = 'o200k_base') {
  // Text is tokenized; chat framing and provider-side tool serialization remain
  // an estimate. API usage.prompt_tokens is authoritative after the call.
  let total = 3;
  for (const message of messages) {
    total += 3 + countText(message.role, encoding) + countText(message.content ?? '', encoding);
    for (const key of ['name', 'tool_call_id', 'tool_calls']) if (message[key]) total += countText(typeof message[key] === 'string' ? message[key] : JSON.stringify(message[key]), encoding);
  }
  if (tools.length) total += countText(JSON.stringify(tools), encoding) + tools.length * 8;
  return total;
}
