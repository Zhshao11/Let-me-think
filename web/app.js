const $ = (s) => document.querySelector(s);
let sessionId = null, projectId = null, messages = [], busy = false, configured = false, responseMode = 'concise';
let viewingTrash = false, viewingDeleted = false, viewEpoch = 0, navigation = 0, currentConfig = null;
async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await res.json(); if (!res.ok) throw new Error(data.error ?? '请求失败'); return data;
}
const scopeQuery = () => `projectId=${encodeURIComponent(projectId ?? '')}`;
function status(text) { $('#context-status').textContent = text; }
function progress(text) { $('#progress').textContent = text; $('#progress').classList.toggle('hidden', !text); }
function renderContent(element,text){
  if(window.markdownRenderer)window.markdownRenderer.renderInto(element,text);
  else element.textContent=text;
}
function appendSourceCopy(node,message){
  if(message.role!=='assistant'||!message.content)return;
  const actions=document.createElement('div');actions.className='message-actions';
  const button=document.createElement('button');button.type='button';button.className='copy-source';button.textContent='复制源码';button.title='复制原始 Markdown，包含 LaTeX 公式源码';
  button.setAttribute('aria-label','复制回复源码');
  button.onclick=async()=>{
    button.disabled=true;
    try{
      const source=String(message.content??'');
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(source);
      else{
        const active=document.activeElement,selection=window.getSelection();
        const ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[];
        const input=document.createElement('textarea');input.value=source;input.className='clipboard-fallback';input.readOnly=true;
        // A textarea outside an open modal cannot receive focus.
        (button.closest('dialog[open]')??document.body).append(input);
        try{input.focus({preventScroll:true});input.select();if(!document.execCommand('copy'))throw new Error('clipboard unavailable');}
        finally{input.remove();active?.focus({preventScroll:true});if(selection){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}}
      }
      button.textContent='已复制';
    }catch{button.textContent='复制失败，点击重试';}
    finally{button.disabled=false;}
  };
  actions.append(button);node.append(actions);
}
function updateControls() {
  $('#send').disabled = busy || !configured || viewingDeleted;
  for (const id of ['project-select', 'new-project', 'new-chat', 'toggle-trash', 'response-mode']) $('#'+id).disabled = busy;
  $('#input').disabled = viewingDeleted;
  window.memoryConsole?.update();
  window.contextUsage?.schedule();
  window.paperUI?.schedule();
  window.sideChat?.update();
}
function resetConversation() {
  navigation++; sessionId = null; messages = []; viewingDeleted = false; $('#input').value = '';
  window.memoryConsole?.reset(); renderMessages(); updateControls();
  status('直接告诉我你的研究背景、问题和实验进展，我会自动整理记忆。');
}
function renderMessages() {
  const target = $('#transcript'); target.replaceChildren();
  if (!messages.length) { target.innerHTML = '<div class="empty-state"><h1>从你的研究问题开始。</h1><p>背景、想法、实验结果，都可以直接在这里聊。</p></div>'; return; }
  for (const m of messages) {
    const node = document.createElement('div'); node.className = `message ${m.role}`;
    const label = document.createElement('div'); label.className = 'role'; label.textContent = m.role === 'user' ? '你' : '研究助手';
    const body = document.createElement('div'); body.className = 'body'; renderContent(body,m.content);
    node.append(label, body); appendSourceCopy(node,m); target.append(node);
  }
  target.scrollTop = target.scrollHeight;
}
async function loadProjects() {
  const { projects } = await api('/api/projects');
  $('#project-select').replaceChildren(new Option('独立对话（不共享记忆）', ''), ...projects.map(p => new Option(p.name, p.id)));
  if (projectId && !projects.some(p => p.id === projectId)) projectId = null;
  $('#project-select').value = projectId ?? '';
}
async function loadSessions() {
  const epoch = viewEpoch, selection = projectId, trash = viewingTrash;
  const data = await api(`/api/sessions?${scopeQuery()}&deleted=${trash}`);
  if (epoch !== viewEpoch || selection !== projectId || trash !== viewingTrash) return;
  const target = $('#session-list'); target.replaceChildren();
  $('#toggle-trash').textContent = trash ? '返回对话' : '回收站';
  for (const s of data.sessions) {
    const row = document.createElement('div'); row.className = 'session-row';
    const open = document.createElement('button'); open.className = 'session-item'+(sessionId === s.id?' active':''); open.textContent = s.preview || '新对话';
    open.onclick = async () => {
      if (busy) return; const ticket = ++navigation;
      try {
        const found = await api(`/api/sessions/${s.id}?${scopeQuery()}&deleted=${trash}`);
        if (busy || epoch !== viewEpoch || ticket !== navigation) return;
        sessionId = found.id; messages = found.messages; viewingDeleted = Boolean(found.deletedAt);
        responseMode = found.responseMode ?? 'concise'; $('#response-mode').value = responseMode;
        window.memoryConsole?.reset(); renderMessages(); updateControls(); loadSessions(); window.workspaceLayout?.closeSidebarOnMobile();
        status(viewingDeleted ? '回收站中的对话，恢复后可继续。' : '研究记忆会在对话后自动更新，可在控制台查看和修改。');
      } catch(e) { progress(e.message); }
    };
    const action = document.createElement('button'); action.className = 'ghost session-action'; action.textContent = trash ? '恢复' : '删除'; action.setAttribute('aria-label', `${trash?'恢复':'删除'}对话：${s.preview || '新对话'}`);
    action.onclick = async () => {
      if (busy) return; busy = true; updateControls();
      try { await api(`/api/sessions/${s.id}${trash?'/restore':''}?${scopeQuery()}`, {method:trash?'POST':'DELETE'}); if (sessionId===s.id) resetConversation(); await loadSessions(); }
      catch(e) { progress(e.message); } finally { busy=false; updateControls(); }
    };
    row.append(open,action); target.append(row);
  }
  if (!data.sessions.length) target.textContent = trash ? '回收站为空' : '还没有对话';
}
async function loadConfig() {
  currentConfig = await api('/api/config'); configured = currentConfig.configured;
  $('#model-label').textContent = currentConfig.model;
  $('#config-badge').textContent = configured ? '连接已配置' : '请先在设置中配置模型';
  const labels = {concise:'简洁',review:'严格评审',experiment:'实验分析',detailed:'详细'};
  $('#response-mode').replaceChildren(...currentConfig.responseModes.map(m=>new Option(labels[m.id]??m.title,m.id))); $('#response-mode').value=responseMode;
  $('#cfg-model').value = currentConfig.model; $('#cfg-window').value=currentConfig.contextWindow??'';
  $('#cfg-model').readOnly=currentConfig.modelLocked;
  $('#cfg-tokenizer').value=currentConfig.tokenizerEncoding??''; $('#cfg-reasoning').value=String(currentConfig.reasoningSupported); $('#cfg-prompt').value=currentConfig.systemPrompt;
  updateControls();
}
async function send(text) {
  if (busy || !configured || viewingDeleted || !text.trim()) return;
  const question=text.trim(), epoch=viewEpoch; navigation++; busy=true; viewingTrash=false; updateControls();
  const user={role:'user',content:question}, assistant={role:'assistant',content:''}; messages.push(user,assistant); renderMessages(); progress('正在回答…');
  const bodyNode=$('#transcript').querySelector('.message.assistant:last-child .body');
  let renderFrame=null;
  const renderAssistant=()=>{renderFrame=null;renderContent(bodyNode,assistant.content);$('#transcript').scrollTop=$('#transcript').scrollHeight;};
  let done=false;
  try {
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,projectId,responseMode,message:question})});
    if(!response.ok) throw new Error((await response.json()).error);
    const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='';
    while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let boundary;
      while((boundary=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const event=block.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim();const line=block.split('\n').find(l=>l.startsWith('data:'))?.slice(5);if(!event||!line)continue;const data=JSON.parse(line);
        if(event==='meta'){sessionId=data.sessionId;window.memoryConsole?.onChange();loadSessions();}
        else if(event==='delta'){assistant.content+=data.text;if(renderFrame===null)renderFrame=requestAnimationFrame(renderAssistant);}
        else if(event==='progress')progress(data.text);
        else if(event==='context_request')window.memoryConsole?.onRequest(data);
        else if(event==='memory_status')status(data.warning?'回答已完成；记忆整理暂未完成，可继续对话。':`已自动整理记忆 · 项目 ${data.project??0} 条 · 当前对话 ${data.conversation??0} 条`);
        else if(event==='error')throw new Error(data.error);
        else if(event==='done'){done=true;const usage=data.execution.usage;if(usage?.prompt_tokens!==undefined)status(`本轮实际输入 ${usage.prompt_tokens.toLocaleString()} tokens · 输出 ${usage.completion_tokens?.toLocaleString()??'—'} tokens${data.memory?.warning?' · 记忆整理待重试':''}`);}
      }
    }
    if(!done)throw new Error('连接中断，原始消息已保留。');
  }catch(e){assistant.content=assistant.content?assistant.content+'\n\n'+e.message:e.message;if(!$('#input').value)$('#input').value=question;}
  finally {if(renderFrame!==null)cancelAnimationFrame(renderFrame);if(epoch===viewEpoch){busy=false;progress('');renderMessages();updateControls();loadSessions();window.memoryConsole?.onChange();}}
}
$('#composer').onsubmit=e=>{e.preventDefault();if($('#send').disabled)return;const text=$('#input').value;$('#input').value='';send(text);};
$('#input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if($('#send').disabled)return;const text=$('#input').value;$('#input').value='';send(text);}};
$('#input').addEventListener('input',()=>{window.memoryConsole?.onChange();window.contextUsage?.schedule();});
$('#new-chat').onclick=()=>{if(busy)return;viewingTrash=false;resetConversation();loadSessions();};
$('#toggle-trash').onclick=()=>{if(busy)return;viewingTrash=!viewingTrash;resetConversation();loadSessions();};
$('#project-select').onchange=async()=>{if(busy)return;projectId=$('#project-select').value||null;viewEpoch++;localStorage.setItem('research.projectId',projectId??'');viewingTrash=false;resetConversation();await loadSessions();};
$('#response-mode').onchange=()=>{responseMode=$('#response-mode').value;window.memoryConsole?.onChange();window.contextUsage?.schedule();};
$('#new-project').onclick=()=>{$('#project-name').value='';$('#project-error').textContent='';$('#new-project-dialog').showModal();};
$('#new-project-form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;updateControls();try{const p=await api('/api/projects',{method:'POST',body:JSON.stringify({name:$('#project-name').value})});projectId=p.id;viewEpoch++;localStorage.setItem('research.projectId',projectId);resetConversation();await loadProjects();await loadSessions();$('#new-project-dialog').close();}catch(e){$('#project-error').textContent=e.message;}finally{busy=false;updateControls();}};
$('#open-settings').onclick=()=>{$('#cfg-key').value='';$('#cfg-base').value='';$('#settings-msg').textContent='';$('#settings-dialog').showModal();};
$('#settings-form').onsubmit=async e=>{e.preventDefault();if(busy)return;try{await api('/api/config',{method:'POST',body:JSON.stringify({apiKey:$('#cfg-key').value,baseUrl:$('#cfg-base').value,model:$('#cfg-model').value,contextWindow:$('#cfg-window').value,tokenizerEncoding:$('#cfg-tokenizer').value,reasoningSupported:$('#cfg-reasoning').value==='true',systemPrompt:$('#cfg-prompt').value})});await loadConfig();$('#settings-dialog').close();window.memoryConsole?.onChange();}catch(e){$('#settings-msg').textContent=e.message;}};
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>$('#'+button.dataset.close).close();
(async()=>{try{projectId=localStorage.getItem('research.projectId')||null;await Promise.all([loadProjects(),loadConfig()]);await loadSessions();}catch(e){progress(e.message);}})();renderMessages();
