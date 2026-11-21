import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const config = {
  root,
  host: pick('HOST', '127.0.0.1'),
  port: Number(pick('PORT', '8787')),
  baseUrl: pick('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey: pick('OPENAI_API_KEY', ''),
  model: pick('OPENAI_MODEL', 'gpt-4o-mini'),
  sessionsDir: path.resolve(root, pick('SESSIONS_DIR', './data/sessions')),
  reasoningEffort: pick('REASONING_EFFORT', '') || null,
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
};

export function saveConfig(patch) {
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
    if (field === 'apiKey' || field === 'model' || field === 'baseUrl' || field === 'systemPrompt') {
      config[field] = value;
    } else if (field === 'reasoningEffort') {
      config.reasoningEffort = value || null;
    }
  }

  return { changed: Object.keys(updates) };
}

export function publicConfig() {
  return {
    model: config.model,
    hasKey: hasKey(config.apiKey),
    configured: hasKey(config.apiKey),
    systemPrompt: config.systemPrompt,
  };
}
