(()=>{
  const dialog=$('#memory-console');let tab='project',data=null,seq=0,timer;
  const notice=text=>$('#console-message').textContent=text;
  const query=()=>`${scopeQuery()}&sessionId=${encodeURIComponent(sessionId??'')}`;
  const categories={identity:'身份与偏好',topic:'研究主题',problem:'研究痛点',progress:'实验进展',plan:'决定与计划'};
  function budget(){
    if(!data)return;
    window.contextUsage.renderConsole($('#memory-window'),data);
  }
  async function refresh(){
    if(!dialog.open)return;const current=++seq,scope=`${projectId}/${sessionId}`;
    try{const value=await api(`/api/memory-console?${query()}&message=${encodeURIComponent($('#input').value)}&mode=${responseMode}`);if(current!==seq||scope!==`${projectId}/${sessionId}`)return;data=value;budget();render();}
    catch(e){if(current===seq)notice(e.message);}
  }
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  function button(text,fn,cls='ghost'){const n=el('button',cls,text);n.type='button';n.onclick=fn;n.disabled=busy;return n;}
  async function changeMemory(item,action,changes={}){
    if(busy)return;busy=true;updateControls();
    try{await api(`/api/memory-console/${item.id}?${query()}&scope=${tab}`,{method:action==='delete'?'DELETE':'PATCH',body:JSON.stringify({expectedVersion:data[tab].version,...changes})});notice(action==='delete'?'已删除，不会再次作为记忆使用。':'已保存，你的修改优先于自动整理。');await refresh();}
    catch(e){notice(e.message);}finally{busy=false;updateControls();}
  }
  function memoryCard(item){
    const card=el('article','console-memory');card.append(el('p','memory-certainty',`${categories[item.category]}${item.certainty==='hypothesis'?' · 待验证':item.certainty==='proposal'?' · 尚未执行的建议':' · 用户报告'}${item.userEdited?' · 你已编辑':''}`),el('p','memory-text',item.text));
    const actions=el('div','memory-actions');
    actions.append(button('编辑',()=>{
      card.replaceChildren();const topic=el('input');topic.value=item.topic;topic.setAttribute('aria-label','主题');
      const category=el('select');category.setAttribute('aria-label','类别');category.replaceChildren(...Object.entries(categories).map(([id,label])=>new Option(label,id)));category.value=item.category;
      const text=el('textarea');text.rows=4;text.value=item.text;text.setAttribute('aria-label','记忆内容');
      const controls=el('div','memory-actions');controls.append(button('保存',()=>changeMemory(item,'edit',{text:text.value,category:category.value,topic:topic.value})),button('取消',render));
      card.append(el('label',null,'主题'),topic,el('label',null,'类别'),category,el('label',null,'内容'),text,controls);
    }),button('删除',()=>changeMemory(item,'delete')));
    if(item.sourceSessionId)actions.append(button('来源',async()=>{
      try{const source=await api(`/api/memory-console/${item.id}/source?${query()}&scope=${tab}`);const previous=card.querySelector('pre');if(previous)previous.remove();else card.append(el('pre','source-text',source.sources.map(m=>`${m.role==='user'?'你':'助手'}：${m.content}`).join('\n\n')));}catch(e){notice(e.message);}
    }));card.append(actions);return card;
  }
  async function saveHistory(controls){
    if(busy)return;busy=true;updateControls();
    try{const result=await api('/api/context/controls',{method:'PUT',body:JSON.stringify({sessionId,projectId,expectedRevision:data.contextRevision,controls})});sessionId=result.sessionId;await refresh();notice('已保存，只影响当前对话；原始记录保留。');}
    catch(e){notice(e.message);}finally{busy=false;updateControls();}
  }
  function history(){
    const target=$('#memory-content');
    target.append(el('h3',null,'对话如何被使用'),el('p','console-description',`当前策略：${data.stats.needsCompaction&&data.stats.modeChanged?'切换回答方式，整理旧模式对话':data.stats.compression.label}。空间充足时保留原文；空间减少时整理较早对话；接近上限时按主题合并并压缩细节。重要信息会自动归入项目记忆或对话记忆，原始消息保留。`));
    if(data.summary){const details=el('details');details.append(el('summary',null,'已经整理的对话摘要'));for(const values of Object.values(data.summary.data??{}))for(const item of values)details.append(el('p','memory-text',item.text));target.append(details);}
    const grouping=el('label','console-field','对话整理方式');const strategy=el('select');strategy.setAttribute('aria-label','对话整理方式');strategy.replaceChildren(new Option('自动管理','auto'),new Option('保留原文，超限提醒','off'),new Option('使用我写的摘要','manual'));strategy.value=data.controls.summaryMode;strategy.disabled=busy;grouping.append(strategy);target.append(grouping);
    strategy.onchange=()=>saveHistory({...data.controls,summaryMode:strategy.value});
    if(strategy.value==='manual'){const text=el('textarea');text.rows=4;text.value=data.controls.summaryText;text.setAttribute('aria-label','我的对话摘要');target.append(text,button('保存摘要',()=>saveHistory({...data.controls,summaryText:text.value})));}
    target.append(el('h3',null,'聊天记录'),el('p','console-description','可以关闭某条消息或修正内容。关闭来源时，它在本对话里的相关记忆也停止读取。其他消息若引用相同信息，仍需一并处理。'));
    for(const [index,message] of data.history.entries()){
      const row=el('details','console-history');const head=el('summary',null,`${message.role==='user'?'你':'助手'} · ${message.content.slice(0,55)}${message.content.length>55?'…':''}`);row.append(head);
      const toggle=el('input');toggle.type='checkbox';toggle.checked=!data.controls.excludedMessageIds.includes(message.id);toggle.disabled=busy;
      const label=el('label','history-enable','使用这条消息');label.prepend(toggle);row.append(label);
      toggle.onchange=()=>saveHistory({...data.controls,excludedMessageIds:toggle.checked?data.controls.excludedMessageIds.filter(id=>id!==message.id):[...data.controls.excludedMessageIds,message.id]});
      const text=el('textarea');text.rows=4;text.value=data.controls.messageEdits[message.id]??message.content;text.setAttribute('aria-label',`第${index+1}条消息`);text.disabled=busy;
      row.append(text,button('保存更正',()=>{const edits={...data.controls.messageEdits};if(text.value===message.content)delete edits[message.id];else edits[message.id]=text.value;return saveHistory({...data.controls,messageEdits:edits});}));target.append(row);
    }
    if(!data.history.length)target.append(el('p','console-empty','新对话还没有聊天记录。'));
  }
  async function inputView(){
    const current=seq,scope=`${projectId}/${sessionId}`;const target=$('#memory-content');target.append(el('p','console-description','这里显示下一次回答将参考的材料。继续在聊天框输入即可，通常不需要手动管理。系统规则由回答方式统一控制。'));
    try{const value=await api('/api/context/inspect',{method:'POST',body:JSON.stringify({sessionId,projectId,responseMode,message:$('#input').value,details:false})});if(current!==seq||scope!==`${projectId}/${sessionId}`||tab!=='input')return;
      for(const [index,message] of value.messages.entries()){const d=el('details');d.append(el('summary',null,message.role==='system'?'助手规则':index===value.messages.length-1?'你的新问题':message.role==='assistant'?'近期回答':'研究背景与对话内容'),el('pre','source-text',message.content));target.append(d);}
      if(sessionId){const actual=await api(`/api/sessions/${sessionId}/context-requests?${scopeQuery()}`);if(current!==seq||tab!=='input')return;const outer=el('details');outer.append(el('summary',null,'最近的实际发送记录'));for(const r of actual.requests.slice(-8)){const d=el('details');d.append(el('summary',null,`${r.stage==='memory_update'?'自动整理记忆':r.stage==='summary'?'压缩对话':'回答请求'} · ${new Date(r.timestamp).toLocaleTimeString()}`),el('pre','source-text',JSON.stringify(r.payload,null,2)));outer.append(d);}target.append(outer);}
    }catch(e){notice(e.message);}
  }
  function render(){
    if(!data)return;const target=$('#memory-content');target.replaceChildren();target.dataset.view=tab;for(const b of dialog.querySelectorAll('[data-tab]'))b.classList.toggle('active',b.dataset.tab===tab);
    if(tab==='history'){history();return;}if(tab==='input'){inputView();return;}if(tab==='papers'){window.paperUI.render(target);return;}
    target.append(el('p','console-description',tab==='project'?'同项目的对话都能使用，按研究主题分组。':'只在当前对话使用，不会进入其他对话。'));
    const groups=new Map();for(const item of data[tab].items){const topic=item.topic||'其他';if(!groups.has(topic))groups.set(topic,[]);groups.get(topic).push(item);}
    if(!groups.size)target.append(el('p','console-empty',tab==='project'&&!projectId?'先选择或新建一个项目。背景和研究问题直接在对话里说即可。':'还没有记忆。继续聊天后会自动整理，无需手动提取或确认。'));
    for(const [topic,items] of groups){target.append(el('h3','memory-topic',topic));for(const category of Object.keys(categories)){const list=items.filter(i=>i.category===category);if(!list.length)continue;const section=el('section','memory-category');section.append(el('h4',null,categories[category]));for(const item of list)section.append(memoryCard(item));target.append(section);}}
  }
  function schedule(){clearTimeout(timer);if(dialog.open)timer=setTimeout(refresh,500);}
  $('#open-console').onclick=()=>{dialog.showModal();notice('');refresh();};
  for(const button of dialog.querySelectorAll('[data-tab]'))button.onclick=()=>{tab=button.dataset.tab;notice('');render();};
  window.memoryConsole={openPapers(){tab='papers';dialog.showModal();notice('');refresh();},reset(){seq++;data=null;clearTimeout(timer);if(dialog.open)dialog.close();},update(){for(const b of dialog.querySelectorAll('button:not([data-close]):not([data-tab]):not(.expand-panel)'))b.disabled=busy;},onChange:schedule,onRequest:schedule};
})();
