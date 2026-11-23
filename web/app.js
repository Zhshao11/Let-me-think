const $ = (s) => document.querySelector(s);
let sessionId = null, projectId = null, messages = [], busy = false, configured = false, responseMode = 'concise';
let viewingTrash = false, viewingDeleted = false, viewEpoch = 0, navigation = 0, currentConfig = null;
let messageRevision=0,serverResponding=false,replyPoll=null;
// Streams belong to conversations, not to the selected screen.
const activeReplies=new Set(),conversationViews=new Map(),deletingSessions=new Set();
const conversationKey=(project,id)=>`${project??''}/${id}`;
let currentView={sessionId:null,projectId:null,draft:'',status:'',progress:''};
const currentRun=()=>activeReplies.has(currentView);
function saveView(){
  Object.assign(currentView,{sessionId,projectId,messages,messageRevision,responseMode,serverResponding,viewingDeleted,draft:$('#input').value});
  conversationViews.set(conversationKey(projectId,sessionId??'draft'),currentView);
}
function showView(view){
  saveView();viewEpoch++;navigation++;clearTimeout(replyPoll);currentView=view;
  sessionId=view.sessionId;projectId=view.projectId;messages=view.messages??[];messageRevision=view.messageRevision??0;
  responseMode=view.responseMode??responseMode;serverResponding=Boolean(view.serverResponding);viewingDeleted=Boolean(view.viewingDeleted);
  busy=currentRun();view.unread=false;if(sessionId)conversationViews.set(conversationKey(projectId,sessionId),view);$('#input').value=view.draft??'';$('#response-mode').value=responseMode;
  window.memoryConsole?.reset();renderMessages();updateControls();
  status(view.status||'研究记忆会在对话后自动更新，可在控制台查看和修改。');progress(view.progress||'');watchCurrentReply();
}
async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await res.json(); if (!res.ok) throw new Error(data.error ?? '请求失败'); return data;
}
const scopeQuery = () => `projectId=${encodeURIComponent(projectId ?? '')}`;
function status(text) { currentView.status=text;$('#context-status').textContent = text; }
function progress(text) { currentView.progress=text;$('#progress').textContent = text; $('#progress').classList.toggle('hidden', !text); }
function renderContent(element,text){
  if(window.markdownRenderer)window.markdownRenderer.renderInto(element,text);
  else element.textContent=text;
}
function appendSourceCopy(node,message){
  if(message.role!=='assistant'||!message.content)return;
  const actions=document.createElement('div');actions.className='message-actions response-actions';
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
  actions.append(button);window.turnActions?.appendPaperSupplement(actions,message);node.append(actions);
}
function updateControls() {
  $('#send').disabled = busy || serverResponding || !configured || viewingDeleted;
  for (const id of ['project-select', 'new-project', 'new-chat', 'toggle-trash', 'response-mode']) $('#'+id).disabled = busy&&!currentRun();
  $('#input').disabled = viewingDeleted;
  window.memoryConsole?.update();
  window.contextUsage?.schedule();
  window.paperUI?.schedule();
  window.sideChat?.update();
  window.projectManager?.update();
}
function resetConversationForProject(selection){
  showView(conversationViews.get(conversationKey(selection,'draft'))??{sessionId:null,projectId:selection,messages:[],messageRevision:0,responseMode,draft:'',status:'直接告诉我你的研究背景、问题和实验进展，我会自动整理记忆。',progress:''});
}
function resetConversation() {
  showView({sessionId:null,projectId,messages:[],messageRevision:0,responseMode,draft:'',status:'直接告诉我你的研究背景、问题和实验进展，我会自动整理记忆。',progress:''});
}
function renderMessages() {
  const target = $('#transcript'); target.replaceChildren();
  if (!messages.length) { target.innerHTML = '<div class="empty-state"><h1>从你的研究问题开始。</h1><p>背景、想法、实验结果，都可以直接在这里聊。</p></div>'; return; }
  const question=messages.findLast(m=>m.role==='user'),at=messages.indexOf(question);
  const reply=messages.slice(at+1).findLast(m=>m.role==='assistant'&&m.content.trim());
  for (const m of messages) {
    const node = document.createElement('div'); node.className = `message ${m.role}`;
    const label = document.createElement('div'); label.className = 'role'; label.textContent = m.role === 'user' ? '你' : '研究助手';
    const body = document.createElement('div'); body.className = 'body'; renderContent(body,m.content);
    node.append(label, body); appendSourceCopy(node,m);
    if(!viewingDeleted)window.turnActions?.decorate(node,m,{question,reply,revision:messageRevision,disabled:busy||serverResponding,responding:busy||serverResponding,retry:send});
    target.append(node);
  }
  target.scrollTop = target.scrollHeight;
}
async function refreshCurrentSession(){
  if(!sessionId)return null;
  const id=sessionId,selection=projectId,epoch=viewEpoch;
  const found=await api(`/api/sessions/${id}?projectId=${encodeURIComponent(selection??'')}&deleted=${viewingDeleted}`);
  if(id!==sessionId||selection!==projectId||epoch!==viewEpoch)return null;
  if(!currentRun()){messages=found.messages;messageRevision=found.messageRevision??0;}serverResponding=Boolean(found.isResponding)||currentRun();
  saveView();
  renderMessages();updateControls();clearTimeout(replyPoll);
  watchCurrentReply();
  return found;
}
function watchCurrentReply(){
  clearTimeout(replyPoll);if(!serverResponding||busy)return;
  const id=sessionId,epoch=viewEpoch;
  replyPoll=setTimeout(()=>refreshCurrentSession().catch(()=>{if(id===sessionId&&epoch===viewEpoch){progress('连接暂未恢复，正在重新检查回复状态…');watchCurrentReply();}}),1500);
}
async function loadProjects() {
  const { projects } = await api('/api/projects');
  $('#project-select').replaceChildren(new Option('独立对话（不共享记忆）', ''), ...projects.map(p => new Option(p.name, p.id)));
  if(projectId&&!projects.some(p=>p.id===projectId)){resetConversationForProject(null);viewingTrash=false;localStorage.setItem('research.projectId','');}
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
    const key=conversationKey(selection,s.id),cached=conversationViews.get(key);
    const running=s.isResponding||[...activeReplies].some(v=>v.projectId===selection&&v.sessionId===s.id);
    const open = document.createElement('button'); open.className = 'session-item'+(sessionId === s.id?' active':'');
    const title=document.createElement('span');title.textContent=s.preview||'新对话';open.append(title);
    if(running||cached?.unread){const badge=document.createElement('small');badge.className='session-reply-state';badge.textContent=running?'正在回复':cached.failed?'回复未完成':'新回复';open.append(badge);}
    open.onclick = async () => {
      const ticket = ++navigation;
      try {
        const found = await api(`/api/sessions/${s.id}?projectId=${encodeURIComponent(selection??'')}&deleted=${trash}`);
        if (epoch !== viewEpoch || ticket !== navigation) return;
        if(sessionId===found.id)saveView();
        const live=[...activeReplies].find(v=>v.projectId===selection&&v.sessionId===s.id);
        const view=live??{...conversationViews.get(key),sessionId:found.id,projectId:selection,messages:found.messages,messageRevision:found.messageRevision??0,responseMode:found.responseMode??'concise',serverResponding:Boolean(found.isResponding),viewingDeleted:Boolean(found.deletedAt)};
        showView(view);loadSessions();window.workspaceLayout?.closeSidebarOnMobile();
        if(viewingDeleted)status('回收站中的对话，恢复后可继续。');
      } catch(e) { if(epoch===viewEpoch&&ticket===navigation)progress(e.message); }
    };
    const action = document.createElement('button'); action.className = 'ghost session-action'; action.textContent = trash ? '恢复' : '删除'; action.setAttribute('aria-label', `${trash?'恢复':'删除'}对话：${s.preview || '新对话'}`);
    action.disabled=Boolean(running)||deletingSessions.has(key);
    action.onclick = async () => {
      if(deletingSessions.has(key))return;deletingSessions.add(key);action.disabled=true;
      try {
        await api(`/api/sessions/${s.id}${trash?'/restore':''}?projectId=${encodeURIComponent(selection??'')}`,{method:trash?'POST':'DELETE'});
        if(projectId===selection&&sessionId===s.id)resetConversation();
        conversationViews.delete(key);await loadSessions();
      }catch(e){if(projectId===selection)progress(e.message);}
      finally{deletingSessions.delete(key);action.disabled=Boolean(running);}
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
async function send(text,retry=null) {
  if (busy || serverResponding || !configured || viewingDeleted || !text.trim()) return;
  saveView();const view=currentView,question=text.trim(),oldIds=new Set(messages.map(m=>m.id));
  const selectedProject=projectId,selectedMode=responseMode;
  clearTimeout(replyPoll);navigation++;viewingTrash=false;
  const user={role:'user',content:question,replyStatus:'running'},assistant={role:'assistant',content:'',status:'streaming'};
  if(retry){const at=view.messages.findIndex(m=>m.id===retry.messageId);if(at<0)return;user.id=retry.messageId;view.messages=view.messages.slice(0,at);}
  view.messages.push(user,assistant);view.progress='正在回答…';activeReplies.add(view);busy=true;
  messages=view.messages;renderMessages();updateControls();progress(view.progress);loadSessions();
  const visible=()=>currentView===view;
  const showProgress=value=>{view.progress=value;if(visible())progress(value);};
  const showStatus=value=>{view.status=value;if(visible())status(value);};
  let renderFrame=null;
  const renderAssistant=()=>{
    renderFrame=null;if(!visible())return;
    const body=$('#transcript').querySelector('.message.assistant:last-child .body');
    if(body)renderContent(body,assistant.content);$('#transcript').scrollTop=$('#transcript').scrollHeight;
  };
  let done=false,failure=null;
  try {
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:view.sessionId,projectId:selectedProject,responseMode:selectedMode,message:question,...(retry?{retry}:{})})});
    if(!response.ok)throw new Error((await response.json()).error);
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let boundary;
      while((boundary=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const event=block.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim(),line=block.split('\n').find(l=>l.startsWith('data:'))?.slice(5);if(!event||!line)continue;const data=JSON.parse(line);
        if(event==='meta'){
          if(conversationViews.get(conversationKey(selectedProject,'draft'))===view)conversationViews.delete(conversationKey(selectedProject,'draft'));
          view.sessionId=data.sessionId;user.id=data.userMessageId;view.messageRevision=data.messageRevision??view.messageRevision;
          conversationViews.set(conversationKey(selectedProject,view.sessionId),view);
          if(visible()){sessionId=view.sessionId;messageRevision=view.messageRevision;updateControls();window.memoryConsole?.onChange();}
          loadSessions();
        }else if(event==='delta'){assistant.content+=data.text;if(visible()&&renderFrame===null)renderFrame=requestAnimationFrame(renderAssistant);}
        else if(event==='progress')showProgress(data.text);
        else if(event==='context_request'){if(visible())window.memoryConsole?.onRequest(data);}
        else if(event==='memory_status')showStatus(data.warning?'回答已完成；记忆整理暂未完成，可继续对话。':`已自动整理记忆 · 项目 ${data.project??0} 条 · 当前对话 ${data.conversation??0} 条`);
        else if(event==='error')throw new Error(data.error);
        else if(event==='done'){
          done=true;assistant.status='complete';assistant.paperSupplement=data.execution.paperSupplement;const usage=data.execution.usage;
          if(usage?.prompt_tokens!==undefined)showStatus(`本轮实际输入 ${usage.prompt_tokens.toLocaleString()} tokens · 输出 ${usage.completion_tokens?.toLocaleString()??'—'} tokens${data.memory?.warning?' · 记忆整理待重试':''}`);
        }
      }
    }
    if(!done)throw new Error('连接中断，原始消息已保留。');
  }catch(e){failure=e.message;assistant.status='incomplete';user.replyStatus='failed';user.replyError=failure;}
  finally {
    if(renderFrame!==null)cancelAnimationFrame(renderFrame);
    let found=null;
    try{
      if(view.sessionId)found=await api(`/api/sessions/${view.sessionId}?projectId=${encodeURIComponent(selectedProject??'')}`);
      if(found){view.messages=found.messages;view.messageRevision=found.messageRevision??0;view.serverResponding=Boolean(found.isResponding);}
    }catch{showProgress('连接未恢复，问题和已有回复保留在原对话。');}
    activeReplies.delete(view);view.unread=!visible();view.failed=Boolean(failure);
    const saved=found?.messages.some(m=>m.role==='user'&&m.content===question&&(!oldIds.has(m.id)||m.id===user.id));
    if(failure&&!retry&&!saved&&!view.draft)view.draft=question;
    view.progress=failure?'本轮未能正常结束，可在上一条问题下重发或编辑。'+failure:'';
    if(visible()){
      busy=false;messages=view.messages;messageRevision=view.messageRevision;serverResponding=Boolean(view.serverResponding);
      if(failure&&!retry&&!saved&&!$('#input').value)$('#input').value=question;
      renderMessages();updateControls();progress(view.progress);watchCurrentReply();window.memoryConsole?.onChange();
    }
    loadSessions();
  }
}
$('#composer').onsubmit=e=>{e.preventDefault();if($('#send').disabled)return;const text=$('#input').value;$('#input').value='';send(text);};
$('#input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if($('#send').disabled)return;const text=$('#input').value;$('#input').value='';send(text);}};
$('#input').addEventListener('input',()=>{currentView.draft=$('#input').value;window.memoryConsole?.onChange();window.contextUsage?.schedule();});
$('#new-chat').onclick=()=>{viewingTrash=false;resetConversation();loadSessions();};
$('#toggle-trash').onclick=()=>{viewingTrash=!viewingTrash;resetConversation();loadSessions();};
$('#project-select').onchange=async()=>{saveView();const selection=$('#project-select').value||null;resetConversationForProject(selection);localStorage.setItem('research.projectId',projectId??'');viewingTrash=false;await loadSessions();};
$('#response-mode').onchange=()=>{responseMode=$('#response-mode').value;window.memoryConsole?.onChange();window.contextUsage?.schedule();};
$('#new-project').onclick=()=>{$('#project-name').value='';$('#project-error').textContent='';$('#new-project-dialog').showModal();};
let creatingProject=false;
$('#new-project-form').onsubmit=async e=>{
  e.preventDefault();if(creatingProject)return;creatingProject=true;const submit=e.currentTarget.querySelector('[type=submit]');submit.disabled=true;
  try{const p=await api('/api/projects',{method:'POST',body:JSON.stringify({name:$('#project-name').value})});resetConversationForProject(p.id);localStorage.setItem('research.projectId',p.id);viewingTrash=false;await loadProjects();await loadSessions();$('#new-project-dialog').close();}
  catch(e){$('#project-error').textContent=e.message;}finally{creatingProject=false;submit.disabled=false;}
};
$('#open-settings').onclick=()=>{$('#cfg-key').value='';$('#cfg-base').value='';$('#settings-msg').textContent='';$('#settings-dialog').showModal();};
$('#settings-form').onsubmit=async e=>{e.preventDefault();if(busy)return;try{await api('/api/config',{method:'POST',body:JSON.stringify({apiKey:$('#cfg-key').value,baseUrl:$('#cfg-base').value,model:$('#cfg-model').value,contextWindow:$('#cfg-window').value,tokenizerEncoding:$('#cfg-tokenizer').value,reasoningSupported:$('#cfg-reasoning').value==='true',systemPrompt:$('#cfg-prompt').value})});await loadConfig();$('#settings-dialog').close();window.memoryConsole?.onChange();}catch(e){$('#settings-msg').textContent=e.message;}};
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>$('#'+button.dataset.close).close();
(async()=>{try{projectId=localStorage.getItem('research.projectId')||null;currentView.projectId=projectId;await Promise.all([loadProjects(),loadConfig()]);await loadSessions();}catch(e){progress(e.message);}})();renderMessages();
