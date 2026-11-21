// Minimal OpenAI-compatible SSE mock for local testing without API credits.
// Usage: node scripts/mock-upstream.mjs   (listens on 127.0.0.1:8788)
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body || '{}');
  const userText = payload.messages?.at(-1)?.content ?? '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  const send = (text, field = 'content') => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { [field]: text } }] })}\n\n`);
  };
  send('正在查看这个问题…\n', 'reasoning_content');
  send('<progress>正在核对要点…</progress>');
  const parts = [`收到：「${userText}」\n`, '这是 mock 上游的流式回复。', '\n进度通道与正文已分离。'];
  for (const part of parts) {
    for (const ch of part) { send(ch); await new Promise((r) => setTimeout(r, 8)); }
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(8788, '127.0.0.1', () => console.log('mock upstream on 127.0.0.1:8788'));
