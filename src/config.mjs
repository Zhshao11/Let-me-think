import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const fileValues = loadDotEnv(path.join(root, '.env'));
const pick = (key, fallback = '') => process.env[key] ?? fileValues[key] ?? fallback;

const baseUrl = pick('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
const apiKey = pick('OPENAI_API_KEY', '');
const model = pick('OPENAI_MODEL', 'gpt-4o-mini');
const sessionsDir = path.resolve(root, pick('SESSIONS_DIR', './data/sessions'));

export const config = {
  root,
  host: pick('HOST', '127.0.0.1'),
  port: Number(pick('PORT', '8787')),
  baseUrl,
  apiKey,
  model,
  sessionsDir,
  reasoningEffort: pick('REASONING_EFFORT', '') || null,
};

export function assertConfigured() {
  if (!apiKey || apiKey.startsWith('sk-your-key')) {
    throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and fill your key.');
  }
}
