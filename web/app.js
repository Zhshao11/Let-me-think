const $ = (sel) => document.querySelector(sel);
const transcript = $('#transcript');
const input = $('#input');
const sendBtn = $('#send');
const progressEl = $('#progress');
const promptPanel = $('#prompt-panel');

let sessionId = null;
let messages = [];
let busy = false;

function renderMessages() {
  transcript.innerHTML = '';
  if (messages.length === 0) {
    transcript.innerHTML = '<div class="empty-state"><h1>想清楚了再说。</h1><p>本地运行的极简 Agent 运行时 · 密钥只在服务端</p></div>';
    return;
  }
  for (const msg of messages) {
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = msg.role === 'user' ? '你' : '助手';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = msg.content;
    el.append(role, body);
    transcript.append(el);
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function setProgress(text) {
  if (!text) { progressEl.classList.add('hidden'); return; }
  progressEl.textContent = text;
  progressEl.classList.remove('hidden');
}

async function loadSessions() {
  const { sessions } = await fetch('/api/sessions').then((r) => r.json());
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === sessionId ? ' active' : '');
    item.textContent = s.preview || '(空会话)';
    item.title = `${s.model ?? ''} · ${s.messageCount} 条消息`;
    item.onclick = async () => {
      if (busy) return;
      const data = await fetch(`/api/sessions/${s.id}`).then((r) => r.json());
      sessionId = data.id;
      messages = data.messages.map((m) => ({ role: m.role, content: m.content }));
      renderMessages();
      loadSessions();
    };
    list.append(item);
  }
}

async function loadConfig() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  // Only the model name is shown; key and base URL never leave the server.
  $('#model-label').textContent = cfg.model;
  $('#config-badge').textContent = cfg.configured ? '服务端密钥已配置' : '密钥未配置：点右上角设置';
  $('#cfg-model').placeholder = cfg.model || '例如 gpt-6.1-sol';
  $('#cfg-prompt').value = cfg.systemPrompt || 'sections';
  sendBtn.disabled = !cfg.configured;
}

function openSettings() {
  $('#settings-overlay').classList.remove('hidden');
  $('#cfg-key').value = '';
  $('#cfg-base').value = '';
  $('#settings-msg').textContent = '';
  $('#settings-msg').classList.remove('error');
}
function closeSettings() { $('#settings-overlay').classList.add('hidden'); }

async function saveSettings(e) {
  e.preventDefault();
  const msg = $('#settings-msg');
  msg.classList.remove('error');
  msg.textContent = '保存中…';
  const payload = {
    apiKey: $('#cfg-key').value,
    baseUrl: $('#cfg-base').value,
    model: $('#cfg-model').value,
    systemPrompt: $('#cfg-prompt').value,
    reasoningEffort: $('#cfg-reasoning').value,
  };
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? '保存失败');
    $('#cfg-key').value = '';
    $('#cfg-base').value = '';
    msg.textContent = '已保存并生效';
    await loadConfig();
    setTimeout(closeSettings, 700);
  } catch (err) {
    msg.textContent = `保存失败：${err.message}`;
    msg.classList.add('error');
  }
}

function showSections(sections) {
  promptPanel.innerHTML = sections.length
    ? sections.map((s) => `<div class="section"><b>${s.id}</b> · ${s.title} · ${s.chars} chars</div>`).join('')
    : '<div class="section">无 system prompt，仅发送对话内容</div>';
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;
  const userMessage = { role: 'user', content: text.trim() };
  messages.push(userMessage);
  const assistantMessage = { role: 'assistant', content: '' };
  messages.push(assistantMessage);
  renderMessages();
  setProgress('连接中…');

  const bodyEl = transcript.querySelector('.message.assistant:last-child .body');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, messages: messages.slice(0, -1) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error ?? 'Request failed');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = chunk.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
        if (!event || !dataLine) continue;
        const data = JSON.parse(dataLine);
        if (event === 'meta') {
          sessionId = data.sessionId;
          showSections(data.sections);
          loadSessions();
        } else if (event === 'progress') {
          setProgress(data.text);
        } else if (event === 'delta') {
          assistantMessage.content += data.text;
          bodyEl.textContent = assistantMessage.content;
          transcript.scrollTop = transcript.scrollHeight;
        } else if (event === 'error') {
          throw new Error(data.error);
        }
      }
    }
    if (!assistantMessage.content) assistantMessage.content = '（无输出）';
    bodyEl.textContent = assistantMessage.content;
  } catch (err) {
    assistantMessage.content = `出错了：${err.message}`;
    bodyEl.textContent = assistantMessage.content;
  } finally {
    setProgress('');
    busy = false;
    sendBtn.disabled = false;
    renderMessages();
    loadSessions();
  }
}

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  send(text);
};
input.onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); input.value = ''; }
};
$('#new-chat').onclick = () => {
  if (busy) return;
  sessionId = null;
  messages = [];
  renderMessages();
  loadSessions();
};
$('#toggle-prompt').onclick = () => promptPanel.classList.toggle('hidden');
$('#open-settings').onclick = openSettings;
$('#close-settings').onclick = closeSettings;
$('#cancel-settings').onclick = closeSettings;
$('#settings-overlay').onclick = (e) => { if (e.target.id === 'settings-overlay') closeSettings(); };
$('#settings-form').onsubmit = saveSettings;

loadConfig();
loadSessions();
renderMessages();
