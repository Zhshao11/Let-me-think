import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RESPONSE_MODE, responseModeSummaries } from './agent/policies.mjs';
import { tokenModelInfo } from './agent/tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function loadDotEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const fileValues = loadDotEnv(envPath);
const pick = (key, fallback = '') => process.env[key] ?? fileValues[key] ?? fallback;
const hasKey = (value) => Boolean(value && !value.startsWith('sk-your-key'));
export const RESEARCH_MODEL = 'gpt-6.1-sol';

export const config = {
  root,
  host: pick('HOST', '127.0.0.1'),
  port: Number(pick('PORT', '8787')),
  baseUrl: pick('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey: pick('OPENAI_API_KEY', ''),
  // One model policy covers chat, review, compression, memory and papers.
  // Legacy environment values cannot silently select another language model.
  get model() { return RESEARCH_MODEL; },
  sessionsDir: path.resolve(root, pick('SESSIONS_DIR', './data/sessions')),
  projectsDir: path.resolve(root, pick('PROJECTS_DIR', './data/projects')),
  papersDir: path.resolve(root, pick('PAPERS_DIR', './data/papers') || './data/papers'),
  paperPython: pick('PAPER_PYTHON', '') || path.join(root, '.venv-papers/bin/python'),
  reasoningEffort: pick('REASONING_EFFORT', '') || null,
  reasoningSupported: pick('REASONING_SUPPORTED', 'true') !== 'false',
  contextWindow: Number(pick('CONTEXT_WINDOW_TOKENS', '')) || null,
  tokenizerEncoding: pick('TOKENIZER_ENCODING', ''),
  automaticMemory: pick('AUTOMATIC_MEMORY', 'true') !== 'false',
  // 'sections' = sectioned system prompt; 'off' = send only the conversation.
  systemPrompt: pick('SYSTEM_PROMPT', 'sections') === 'off' ? 'off' : 'sections',
};

export function assertConfigured() {
  if (!hasKey(config.apiKey)) {
    throw new Error('OPENAI_API_KEY is not set. Configure it in the Settings panel or .env.');
  }
}

// Values that may be changed at runtime from the Settings panel.
const WRITABLE = {
  OPENAI_BASE_URL: 'baseUrl',
  OPENAI_API_KEY: 'apiKey',
  OPENAI_MODEL: 'model',
  SYSTEM_PROMPT: 'systemPrompt',
  REASONING_EFFORT: 'reasoningEffort',
  REASONING_SUPPORTED: 'reasoningSupported',
  CONTEXT_WINDOW_TOKENS: 'contextWindow',
  TOKENIZER_ENCODING: 'tokenizerEncoding',
};

export function saveConfig(patch) {
  if(patch.model!==undefined&&patch.model!==null&&String(patch.model).trim()&&String(patch.model).trim()!==RESEARCH_MODEL){
    throw new Error(`模型已固定为 ${RESEARCH_MODEL}，不能使用其他语言模型。`);
  }
  const current = loadDotEnv(envPath);
  const updates = {};

  for (const [envKey, field] of Object.entries(WRITABLE)) {
    if (!(field in patch)) continue;
    let value = patch[field];
    if (value === undefined || value === null) continue;
    value = String(value).trim();
    // Empty string means "leave unchanged" for secrets and endpoint;
    // for optional fields it means "clear".
    if (field === 'baseUrl' || field === 'apiKey' || field === 'model') {
      if (!value) continue;
    }
    if (field === 'baseUrl') value = value.replace(/\/+$/, '');
    if (field === 'systemPrompt') value = value === 'off' ? 'off' : 'sections';
    if (field === 'reasoningEffort') value = value || '';
    if (field === 'reasoningSupported' && !['true', 'false'].includes(value)) throw new Error('reasoningSupported must be true or false');
    if (field === 'contextWindow' && value && (!Number.isSafeInteger(Number(value)) || Number(value) < 16000)) throw new Error('上下文窗口须填写服务商实际提供的 token 数，至少 16000。');
    if (field === 'tokenizerEncoding' && !['', 'o200k_base', 'cl100k_base'].includes(value)) throw new Error('不支持该 tokenizer');
    current[envKey] = value;
    updates[field] = value;
  }

  if (Object.keys(updates).length === 0) return { changed: [] };

  // Preserve comments and unknown keys; replace known keys in place, append new ones.
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const seen = new Set();
  text = text.split(/\r?\n/).map((line) => {
    const eq = line.indexOf('=');
    if (eq < 1 || line.trim().startsWith('#')) return line;
    const key = line.slice(0, eq).trim();
    if (!(key in current)) return line;
    seen.add(key);
    return `${key}=${current[key]}`;
  }).join('\n').replace(/\n+$/, '');
  for (const key of Object.keys(current)) {
    if (!seen.has(key)) text += `${text ? '\n' : ''}${key}=${current[key]}`;
  }
  fs.writeFileSync(envPath, text + '\n', { mode: 0o600 });

  // Mutate the shared object so all modules see the new values without restart.
  for (const [field, value] of Object.entries(updates)) {
    if (field === 'model') continue;
    if (field === 'apiKey' || field === 'baseUrl' || field === 'systemPrompt') {
      config[field] = value;
    } else if (field === 'reasoningEffort') {
      config.reasoningEffort = value || null;
    } else if (field === 'reasoningSupported') {
      config.reasoningSupported = value === 'true';
    } else if (field === 'contextWindow') {
      config.contextWindow = Number(value) || null;
    } else if (field === 'tokenizerEncoding') {
      config.tokenizerEncoding = value;
    }
  }

  return { changed: Object.keys(updates) };
}

export function publicConfig() {
  return {
    model: config.model,
    modelLocked: true,
    hasKey: hasKey(config.apiKey),
    configured: hasKey(config.apiKey),
    systemPrompt: config.systemPrompt,
    defaultResponseMode: DEFAULT_RESPONSE_MODE,
    responseModes: responseModeSummaries(),
    reasoningSupported: config.reasoningSupported,
    reasoningEffort: config.reasoningEffort,
    contextWindow: config.contextWindow,
    tokenizerEncoding: config.tokenizerEncoding,
    tokenModel: tokenModelInfo(config.model, config.contextWindow, config.tokenizerEncoding),
  };
}
