(()=>{
  const dialog=$('#side-chat'),select=$('#side-chat-select'),input=$('#side-chat-input'),transcript=$('#side-chat-transcript');
  let ownerKey='',owner=null,current=null,items=[],sending=false,loading=false,trash=false,epoch=0,controller=null;
  let kind='discussion';const views=new Map();
  const mainKey=()=>`${projectId??''}/${sessionId??''}/${viewingDeleted}`;
  const query=()=>new URLSearchParams({projectId:owner.projectId??''});
  const endpoint=()=>`/api/sessions/${owner.parentId}/side-conversations?${query()}&deleted=${trash}&purpose=${kind}`;
  const sessionEndpoint=(id=current.id,suffix='')=>`/api/sessions/${id}${suffix}?${query()}&deleted=${trash}`;
  const notice=text=>{$('#side-chat-progress').textContent=text;};
  function controls(){
    $('#side-chat-send').disabled=sending||loading||!current||trash||!configured;
    input.disabled=loading||!current||trash;
    select.disabled=sending||loading||!items.length;
    $('#new-side-chat').disabled=sending||loading;
    $('#side-chat-mode').disabled=sending||loading||trash;
    $('#delete-side-chat').disabled=sending||loading||!current;
    $('#delete-side-chat').textContent=trash?'恢复':'删除';
    $('#side-chat-trash').disabled=sending||loading;
    $('#side-chat-trash').textContent=trash?'返回子对话':'回收站';
  }
  function renderList(){
    select.replaceChildren(...items.map(s=>new Option(s.preview||(kind==='library'?'补库讨论':'新子对话'),s.id)));
    if(current)select.value=current.id;
  }
  function render(){
    transcript.replaceChildren();
    if(kind==='library'&&!trash){const jobs=document.createElement('div');jobs.className='side-library-jobs';transcript.append(jobs);window.paperUI?.renderLibraryJobs();}
    const messages=current?.messages??[];
    if(!messages.length){const p=document.createElement('p');p.className='console-empty';p.textContent=trash?'回收站里没有子对话。':kind==='library'?'可以直接在这里发起补库、补充背景、调整任务，也可以追问进展和论文关联理由。':current?'已承接当前上下文。可以直接问概念、查论文或讨论一个旁支问题。':'还没有子对话，点击“新开子对话”即可。';transcript.append(p);}
    for(const message of messages){
      const node=document.createElement('div');node.className=`message ${message.role}`;
      const label=document.createElement('div');label.className='role';label.textContent=message.role==='user'?'你':'研究助手';
      const body=document.createElement('div');body.className='body';renderContent(body,message.content);node.append(label,body);appendSourceCopy(node,message);transcript.append(node);
    }
    transcript.scrollTop=transcript.scrollHeight;
  }
  async function usage(ticket=epoch){
    if(!current){$('#side-chat-usage').textContent='';return;}
    const id=current.id;
    try{
      const result=await api('/api/context/usage',{method:'POST',body:JSON.stringify({projectId:owner.projectId,sessionId:id,responseMode:$('#side-chat-mode').value,message:input.value})});
      if(ticket!==epoch||id!==current?.id)return;
      const stats=result.stats;
      $('#side-chat-usage').textContent=`承接 ${current.sideContext.messages.length} 条上下文 · 子对话预计输入 ${stats.estimatedTokens.toLocaleString()}${stats.contextWindow?' / '+stats.contextWindow.toLocaleString():''} tokens`;
    }catch(e){if(ticket===epoch&&!trash)notice(e.message);}
  }
  async function refreshList(ticket){
    const result=await api(endpoint());if(ticket!==epoch)return false;items=result.conversations;renderList();return true;
  }
  async function load(id,ticket){
    const found=await api(sessionEndpoint(id));if(ticket!==epoch)return;
    if(found.sideContext?.parentSessionId!==owner.parentId||(found.sideContext.purpose??'discussion')!==kind)throw new Error('子对话不属于当前窗口。');
    current=found;input.value='';$('#side-chat-mode').value=found.responseMode??'concise';renderList();render();controls();usage(ticket);
  }
  async function create(ticket){
    trash=false;
    const result=await api(endpoint(),{method:'POST',body:JSON.stringify({purpose:kind})});if(ticket!==epoch)return;
    current=result.conversation;input.value='';$('#side-chat-mode').value=current.responseMode;await refreshList(ticket);if(ticket!==epoch)return;renderList();render();usage(ticket);
  }
  async function operation(action){
    if(sending||loading)return;
    loading=true;controls();notice('');const ticket=++epoch;
    try{await action(ticket);}catch(e){if(ticket===epoch)notice(e.message);}finally{if(ticket===epoch){loading=false;controls();}}
  }
  async function send(){
    if(sending||loading||!current||trash||!input.value.trim())return;
    const ticket=epoch,question=input.value.trim(),target=current,selectedOwner={...owner};
    input.value='';sending=true;controller=new AbortController();controls();notice('正在回答…');
    const answer={role:'assistant',content:''};target.messages.push({role:'user',content:question},answer);render();
    let done=false;
    try{
      const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({sessionId:target.id,projectId:selectedOwner.projectId,responseMode:$('#side-chat-mode').value,message:question})});
      if(!response.ok)throw new Error((await response.json()).error);
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let boundary;
        while((boundary=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const lines=block.split('\n');
          const event=lines.find(l=>l.startsWith('event:'))?.slice(6).trim(),dataLine=lines.find(l=>l.startsWith('data:'))?.slice(5);if(!event||!dataLine)continue;
          const data=JSON.parse(dataLine);if(ticket!==epoch)continue;
          if(event==='delta'){answer.content+=data.text;render();}
          else if(event==='progress')notice(data.text);
          else if(event==='error')throw new Error(data.error);
          else if(event==='done'){done=true;const u=data.execution.usage;notice(u?.prompt_tokens!==undefined?`实际输入 ${u.prompt_tokens.toLocaleString()} · 输出 ${(u.completion_tokens??0).toLocaleString()} tokens · 内容只保存在此子对话`:'内容已保存在此子对话。');}
        }
      }
      if(!done)throw new Error('连接中断，可以重新打开子对话查看已保存的消息。');
    }catch(e){if(ticket===epoch){notice(e.name==='AbortError'?'已停止。':e.message);if(!input.value)input.value=question;}}
    finally{
      if(ticket===epoch){sending=false;controller=null;controls();if(kind==='library')window.paperUI?.schedule();
        try{const found=await api(sessionEndpoint(target.id));if(ticket===epoch){current=found;render();await refreshList(ticket);usage(ticket);}}catch(e){if(ticket===epoch)notice(e.message);}
      }
    }
  }
  function open(purpose='discussion'){
    if(!sessionId||busy||viewingDeleted)return;
    if(dialog.open&&purpose===kind){dialog.close();return;}
    if(!dialog.open)dialog.show();
    if((sending||loading)&&purpose!==kind){notice('当前讨论正在执行，请完成后再切换窗口。');return;}
    if(kind!==purpose){
      views.set(kind,{current,items,trash,draft:input.value,mode:$('#side-chat-mode').value});
      epoch++;kind=purpose;const saved=views.get(kind);current=saved?.current??null;items=saved?.items??[];trash=saved?.trash??false;input.value=saved?.draft??'';$('#side-chat-mode').value=saved?.mode??responseMode;notice('');
    }
    $('#side-chat-title').textContent=kind==='library'?'论文补库':'子对话';
    dialog.dataset.purpose=kind;
    $('.side-chat-note').textContent=kind==='library'?'在这里直接补库、调整方向、暂停或继续。讨论不回写主对话及研究记忆。':'承接开启时的上下文。这里的讨论和检索结果只留在子对话，不写入主对话或项目记忆。';
    $('#new-side-chat').textContent=kind==='library'?'新讨论':'新开子对话';
    input.placeholder=kind==='library'?'说明补库需求、补充研究背景，或追问论文为什么相关…':'在这里查文献、解释概念，或展开一个旁支问题…';
    renderList();render();
    if(sending||current){controls();return;}
    operation(async ticket=>{if(!await refreshList(ticket))return;if(items.length)await load(items[0].id,ticket);else await create(ticket);});
  }
  $('#open-side-chat').onclick=()=>open('discussion');
  $('#close-side-chat').onclick=()=>dialog.close();
  $('#new-side-chat').onclick=()=>operation(create);
  select.onchange=()=>operation(ticket=>load(select.value,ticket));
  $('#side-chat-trash').onclick=()=>operation(async ticket=>{trash=!trash;current=null;input.value='';if(!await refreshList(ticket))return;if(items.length)await load(items[0].id,ticket);else{render();$('#side-chat-usage').textContent='';}});
  $('#delete-side-chat').onclick=()=>operation(async ticket=>{
    await api(sessionEndpoint(current.id,trash?'/restore':''),{method:trash?'POST':'DELETE'});if(ticket!==epoch)return;
    current=null;if(!await refreshList(ticket))return;if(items.length)await load(items[0].id,ticket);else{render();$('#side-chat-usage').textContent='';}
  });
  $('#side-chat-composer').onsubmit=e=>{e.preventDefault();send();};
  input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}};
  $('#side-chat-mode').onchange=()=>usage();
  let usageTimer;input.oninput=()=>{clearTimeout(usageTimer);usageTimer=setTimeout(()=>usage(),400);};
  window.sideChat={openLibrary:()=>open('library'),libraryTarget:()=>kind==='library'&&!trash?transcript.querySelector('.side-library-jobs'):null,notify:notice,update(){
    $('#open-side-chat').disabled=busy||!sessionId||viewingDeleted;
    if(ownerKey!==mainKey()){
      ownerKey=mainKey();owner={projectId,parentId:sessionId};epoch++;controller?.abort();controller=null;current=null;items=[];sending=false;loading=false;trash=false;
      kind='discussion';views.clear();
      clearTimeout(usageTimer);if(dialog.open)dialog.close();input.value='';notice('');render();controls();
    }
  }};
  window.sideChat.update();
})();
