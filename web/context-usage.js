(()=>{
  let timer,revision=0;
  const number=value=>Math.round(value).toLocaleString();
  const percent=(value,total)=>`${(100*value/total).toFixed(2)}%`;
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  function values(data){
    const s=data.stats,window=data.tokenModel.contextWindow;
    const parts=[
      {label:'预计输入',value:s.estimatedTokens,cls:'input'},
      {label:'输出预留',value:s.outputReserve,cls:'output'},
      {label:'工具与复核预留',value:s.executionReserve,cls:'execution'},
      {label:'安全余量',value:s.safetyReserve,cls:'safety'},
    ];
    const reserved=parts.slice(1).reduce((n,p)=>n+p.value,0);
    const remaining=window?Math.max(0,window-s.estimatedTokens-reserved):null;
    return {s,window,parts,reserved,remaining};
  }
  function track(target,data,markers=false){
    const {s,window,parts}=values(data);target.replaceChildren();target.hidden=!window;
    if(!window)return;
    let remaining=100;
    for(const p of parts){const span=node('span',`window-part ${p.cls}`);const width=Math.max(0,Math.min(remaining,100*p.value/window));remaining-=width;span.style.width=`${width}%`;span.title=`${p.label}：${number(p.value)} tokens`;target.append(span);}
    if(markers)for(const threshold of s.compressionThresholds){const mark=node('span','window-threshold');mark.style.left=`${100*(threshold.tokens+(s.uncompressedTokens-s.compressionBasisTokens))/window}%`;mark.title=`${threshold.label}：${number(threshold.tokens)} tokens（可用输入空间的 ${threshold.ratio*100}%）`;target.append(mark);}
  }
  function renderCompact(data){
    const {s,window,remaining}=values(data),target=$('#context-usage');
    $('#context-usage-label').textContent=window
      ?`上下文约 ${number(s.estimatedTokens)} / ${number(window)} tokens · ${percent(s.estimatedTokens,window)} · ${s.needsCompaction?'发送时自动压缩':s.summarizedMessages?'已使用历史摘要':'保留原文'}`
      :`上下文约 ${number(s.estimatedTokens)} tokens · 模型窗口未确认`;
    target.title=window?`预计输入 ${number(s.estimatedTokens)}，扣除预留后剩余 ${number(remaining)} tokens。点击查看压缩阈值与实际用量。`:'点击查看用量；可在设置中填写服务商实际窗口。';
    target.dataset.over=String(s.overBudget);track($('#context-usage-bar'),data);
  }
  function renderConsole(target,data){
    const {s,window,parts,remaining}=values(data);target.replaceChildren();renderCompact(data);
    target.append(node('div','window-title',window?`上下文窗口 ${number(window)} tokens`:'模型上下文窗口未确认'));
    if(window){
      target.append(node('div','window-total',`预计输入 ${number(s.estimatedTokens)} · 占窗口 ${percent(s.estimatedTokens,window)}`));
      const bar=node('div','window-track window-large');bar.setAttribute('role','img');bar.setAttribute('aria-label',`预计输入占 ${percent(s.estimatedTokens,window)}，扣除预留后剩余 ${number(remaining)} tokens`);track(bar,data,true);target.append(bar);
      const legend=node('div','window-legend');
      for(const p of [...parts,{label:'剩余可用',value:remaining,cls:'free'}]){if(!p.value&&p.cls==='execution')continue;const item=node('span');item.append(node('i',`window-dot ${p.cls}`),document.createTextNode(`${p.label} ${number(p.value)}`));legend.append(item);}target.append(legend);
      const thresholds=node('p','window-strategy');thresholds.textContent=`按可用输入空间 ${number(s.availableInputBudget)} tokens 判断：55%（${number(s.compressionThresholds[0].tokens)}）整理较早对话，80%（${number(s.compressionThresholds[1].tokens)}）按主题压缩，93%（${number(s.compressionThresholds[2].tokens)}）深度整理。`;target.append(thresholds);
    }
    const current=s.summaryMode==='off'?'保留原文，超限提醒':s.summaryMode==='manual'?'使用你写的摘要':s.needsCompaction?s.modeChanged?'切换回答方式，发送时整理旧模式对话':`发送时将${s.compression.label}`:s.summarizedMessages?'已经使用历史摘要':'保留完整对话';
    target.append(node('p','window-strategy',`当前：${current}。${s.summarizedMessages?`原始材料 ${number(s.uncompressedTokens)} tokens。`:''}${s.needsCompaction?'上方为压缩后的预计输入，实际压缩完成后会更新。':''}`));
    if(s.overBudget)target.append(node('p','window-warning','当前输入预计超过可用空间，请减少材料或启用自动整理。'));
    const actual=data.lastUsage;
    target.append(node('p','window-actual',actual?.prompt_tokens!==undefined?`最近一次回答实际输入 ${number(actual.prompt_tokens)} tokens${window?`（${percent(actual.prompt_tokens,window)}）`:''} · 实际输出 ${actual.completion_tokens===undefined?'未知':number(actual.completion_tokens)} tokens。`:'上游尚未返回实际 token 用量。'));
    const details=node('details','window-notes');details.append(node('summary',null,'计数依据'));
    details.append(node('p',null,`发送前采用 ${data.tokenModel.encoding} 分词与消息封装估算${data.tokenModel.encodingSource==='fallback_estimate'?'；该模型的专用分词器未确认，使用替代分词器':''}。实际用量以接口返回为准。${!window?'临时输入工作预算为 24,000 tokens，不代表模型窗口。':data.tokenModel.windowSource==='configured'?'窗口采用你的服务配置。':'窗口采用模型 API 规格。'}`));
    if(data.tokenModel.windowSourceUrl){const source=node('a',null,'模型官方规格');source.href=data.tokenModel.windowSourceUrl;source.target='_blank';source.rel='noopener noreferrer';details.append(source);}target.append(details);
  }
  function schedule(){
    clearTimeout(timer);const ticket=++revision;if(busy)return;
    $('#context-usage-label').textContent=viewingDeleted?'回收站对话，恢复后查看上下文用量':'正在计算上下文…';
    $('#context-usage-bar').hidden=true;if(viewingDeleted)return;
    timer=setTimeout(async()=>{
      try{const data=await api('/api/context/usage',{method:'POST',body:JSON.stringify({projectId,sessionId,responseMode,message:$('#input').value})});if(ticket===revision)renderCompact(data);}
      catch(e){if(ticket===revision){$('#context-usage-label').textContent=`上下文用量暂不可用：${e.message}`;$('#context-usage-bar').hidden=true;}}
    },400);
  }
  $('#context-usage').onclick=()=>{if(!viewingDeleted)$('#open-console').click();};
  window.contextUsage={schedule,renderConsole};schedule();
})();
