// Live behavior samples, not an automated quality score. Requires --live.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, assertConfigured } from '../src/config.mjs';
import { buildPromptSections, renderSystemPrompt } from '../src/prompt.mjs';
import { PROTOCOL_VERSION } from '../src/agent/policies.mjs';
import { runAgent } from '../src/agent/runtime.mjs';
import { resolveAgentProfile } from '../src/agent/profiles.mjs';

if (!process.argv.includes('--live')) {
  console.log('Usage: npm run eval:research -- --live [--case=id ...] [--output=/absolute/path/report.md]');
  console.log('Calls the configured model for 6 independent cases; does not change .env or chat sessions.');
  process.exit(0);
}
assertConfigured();
const allCases = JSON.parse(await fs.readFile(new URL('../eval/stage-1.json', import.meta.url), 'utf8'));
const selected = process.argv.filter((arg) => arg.startsWith('--case=')).map((arg) => arg.slice('--case='.length));
if (selected.some((id) => !allCases.some((sample) => sample.id === id))) throw new Error('Unknown case id');
const cases = selected.length ? allCases.filter((sample) => selected.includes(sample.id)) : allCases;
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const output = path.resolve(outputArg?.slice('--output='.length) || path.join(config.root, 'outputs', 'stage-1-live-samples.md'));
await fs.mkdir(path.dirname(output), { recursive: true });
let report = `# 第一阶段真实模型试答\n\n时间：${new Date().toISOString()}\n\n模型：${config.model}\n\n协议：${PROTOCOL_VERSION}\n\n每题为独立对话，直接组装专家协议，不受裸模式配置影响。以下是原始输出和人工验收标准，不代表自动评分或可靠性保证。未使用论文检索和实验运行工具。\n`;
let failed = false;
await fs.writeFile(output, report);
for (const sample of cases) {
  let answer = '';
  let error = '';
  try {
    const profile = resolveAgentProfile(sample.mode, { reasoningSupported: config.reasoningSupported, contextWindow: config.contextWindow });
    await runAgent({
      model: config.model,
      profile, history: [],
      messages: [
        { role: 'system', content: renderSystemPrompt(buildPromptSections({ responseMode: sample.mode, profile })) },
        { role: 'user', content: sample.question },
      ],
      signal: AbortSignal.timeout(180_000),
      onDelta: (text) => { answer += text; },
      onProgress: () => {},
    });
    if (!answer.trim()) throw new Error('No answer content returned');
  } catch (err) {
    failed = true;
    error = `\n\n调用失败：${err.name === 'TimeoutError' ? '超时' : '上游请求未完成'}。`;
  }
  report += `\n## ${sample.id}（${sample.mode}）\n\n问题：${sample.question}\n\n验收标准：${sample.criteria}\n\n### 原始回答（${answer.length} 字符）\n\n${answer}${error}\n`;
  await fs.writeFile(output, report);
  console.log(`${sample.id}: ${error ? 'incomplete' : 'completed'}, ${answer.length} chars`);
}
console.log(`Report: ${output}`);
if (failed) process.exitCode = 1;
