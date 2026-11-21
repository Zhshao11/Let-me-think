# Let me think

A minimal, local-first agent runtime. Bring your own API key; the key stays on the server and never reaches the browser.

This project studies the design patterns of modern agent products — observable prompt sections, a separate progress channel, append-only session logs — with a clean-room implementation. It is not derived from any product's source code.

## Run

```bash
cp .env.example .env
# edit .env: set OPENAI_API_KEY, optionally OPENAI_BASE_URL and OPENAI_MODEL
npm start
# open http://127.0.0.1:8787
```

Node.js 20+ required. No npm dependencies: everything uses Node built-ins.

Works with any OpenAI-compatible chat-completions endpoint (OpenAI, DeepSeek, and most gateways). If your provider uses a different path, set `OPENAI_BASE_URL` to its API root.

## What is here

- **Server-side key, web settings panel**: click "设置" in the top bar to fill in API key, base URL, model, and prompt mode. Saved values go to `.env` on the server and take effect without a restart. The browser never receives the key or base URL — `GET /api/config` returns only `model`, `hasKey`, and `systemPrompt`. Empty key/base URL fields leave the current values unchanged.
- **Observable system prompt**: `src/prompt.mjs` assembles the prompt from named sections. The browser's "提示词构成" panel shows which sections were active and their sizes. Set `SYSTEM_PROMPT=off` in `.env` to send only the conversation history — no system message at all.
- **Progress vs transcript**: text wrapped in `<progress>...</progress>` is routed to a one-line status area; reasoning content goes to its own event; only the answer body enters the transcript. Parsing survives tags split across network chunks.
- **Append-only sessions**: every turn is written to `data/sessions/<uuid>.jsonl` with typed events (`session`, `prompt_sections`, `message`, `model_change`), message IDs and a parent chain. Survives restarts; list and reload from the sidebar.
- **Streaming**: upstream SSE is forwarded as SSE with typed events (`meta`, `progress`, `reasoning`, `delta`, `done`, `error`).

## Layout

```
server.mjs              HTTP routes and SSE orchestration
src/config.mjs          env + .env loading
src/prompt.mjs          sectioned system prompt
src/session.mjs         JSONL session store
src/upstream.mjs        OpenAI-compatible streaming client
web/                    dependency-free chat UI
scripts/mock-upstream.mjs  local SSE mock for testing without API credits
```

## Test without spending credits

```bash
node scripts/mock-upstream.mjs          # terminal 1, listens on :8788
# set OPENAI_BASE_URL=http://127.0.0.1:8788/v1 in .env
npm start                               # terminal 2
```

## Next steps

The placeholders in `src/prompt.mjs` mark where the interesting parts plug in:

1. **Tools** — register a tool registry, expose it via `tools` in the upstream request, and handle `tool_calls` in the SSE loop.
2. **Skills** — load skill documents from disk, put a brief catalog in the prompt, fetch full instructions on demand.
3. **Memory** — write a `personalization` / `persistent_memory` section with a token budget.
4. **Context budget** — trim or summarize old messages before they exceed the model's window.
