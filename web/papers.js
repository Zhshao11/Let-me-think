(()=>{
  let timer,epoch=0,uploading=false,lastVersion='',conversationJobs=[],jobScope='';
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const endpoint=(suffix='')=>`/api/papers${suffix}?${scopeQuery()}`;
  const asset=(paper,name)=>`${endpoint('/'+paper.id+'/assets/'+name)}`;
  const statusLabels={queued:'等待处理',parsing:'解析中',extracting:'整理中',ready:'已入库',failed:'未完成',paused:'已暂停'};
  const scope=()=>`${projectId}/${sessionId}/${viewingDeleted}`;
  const jobsEndpoint=(suffix='')=>`/api/library-jobs${suffix}?${scopeQuery()}&sessionId=${encodeURIComponent(sessionId??'')}`;
  function renderLibraryJobs(){
    const transcript=window.sideChat?.libraryTarget();if(!transcript)return;
    const scroller=$('#side-chat-transcript'),bottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<90;
    const jobs=jobScope===scope()?conversationJobs:[],ids=new Set(jobs.map(j=>j.id));
    transcript.querySelector('.library-empty')?.remove();
    for(const old of transcript.querySelectorAll('.library-job'))if(!ids.has(old.dataset.jobId))old.remove();
    for(const job of [...jobs].reverse()){
      const old=transcript.querySelector(`[data-job-id="${job.id}"]`);if(old?.dataset.revision===String(job.revision))continue;
      const message=el('div','message assistant library-job');message.dataset.jobId=job.id;message.dataset.revision=String(job.revision);message.dataset.status=job.status;
      message.append(el('div','role','论文补库'));
      const body=el('div','body markdown-body');message.append(body);
      const title=el('p');title.append(el('strong',null,job.topic?`围绕「${job.topic}」补充论文`:'正在整理当前研究问题'));body.append(title,el('p','library-phase',job.phase));
      if(job.bottleneck)body.append(el('p','console-description',`研究问题：${job.bottleneck}`));
      if(job.origin==='proposal_evidence_gap'){
        body.append(el('p','console-description','为当前改进方案补充依据，后台独立执行。'));
        for(const gap of job.directions??[])body.append(el('p','console-description',`补充方向：${gap.direction}。${gap.reason}`));
      }
      if(job.clarification)body.append(el('p','library-question',job.clarification+' 直接在下方补充研究背景即可继续。'));
      const c=job.counts;body.append(el('p','library-counts',`新增完成 ${c.added} · 复用 ${c.reused} · 缺全文 ${c.needsFulltext} · 未完成 ${c.failed}`));
      if(job.error)body.append(el('p','paper-error',job.error));
      if(job.results.length){
        const details=el('details','library-results');details.open=old?Boolean(old.querySelector('.library-results')?.open):job.status==='failed';details.append(el('summary',null,'论文与收录理由'));
        const labels={added:'新增完成',reused:'复用已有论文',needs_fulltext:'需提供 PDF',not_relevant:'关联不足，未纳入本次结果',failed:'未完成',downloading:'获取中',processing:'处理中'};
        for(const result of job.results){
          const item=el('section','library-result');const heading=el('p');heading.append(el('strong',null,`${labels[result.state]??result.state}：${result.title}`));item.append(heading);
          for(const [label,value] of [['关联理由',result.reason],['可做的实验',result.experiment],['适用限制',result.limitations]])if(value){const p=el('p');p.append(el('strong',null,label+'：'),document.createTextNode(value));item.append(p);}
          if(result.error)item.append(el('p','console-description',result.error));
          if(result.metadataVerified===false)item.append(el('p','console-description','原始元数据尚未完全核实；请结合原 PDF 检查。'));
          const links=el('div','memory-actions');
          if(result.paperId){const a=el('a',null,'查看原 PDF');a.href=asset({id:result.paperId},'original.pdf');a.target='_blank';a.rel='noopener noreferrer';links.append(a);
            for(const id of (result.sourceIds??[]).slice(0,3)){const page=id.match(/^p(\d+)-b/)?.[1];if(!page)continue;const a=el('a',null,`第 ${page} 页 · ${id}`);a.href=asset({id:result.paperId},`page-${page}.png`);a.target='_blank';a.rel='noopener noreferrer';links.append(a);}
          }else if(/^https?:\/\//.test(result.url??'')){const a=el('a',null,'论文来源');a.href=result.url;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}
          item.append(links);details.append(item);
        }body.append(details);
      }
      const actions=el('div','memory-actions');
      const actionButton=(label,action)=>{const button=el('button','ghost',label);button.type='button';button.onclick=async()=>{
        const selection=scope();button.disabled=true;
        try{await api(jobsEndpoint('/'+job.id+'/control'),{method:'POST',body:JSON.stringify({action})});if(selection===scope())schedule();}
        catch(e){if(selection===scope()){button.disabled=false;window.sideChat?.notify(e.message);}}
      };actions.append(button);};
      if(['queued','running'].includes(job.status))actionButton('暂停补库','pause');
      else if(['paused','failed','partial'].includes(job.status))actionButton('继续补库','resume');
      const usage=el('details','library-usage');usage.append(el('summary',null,'任务范围与用量'));
      const input=job.usage.reduce((n,u)=>n+(u.prompt_tokens??0),0),output=job.usage.reduce((n,u)=>n+(u.completion_tokens??0),0);
      usage.append(el('p','console-description',`最多新增 ${job.maxPapers} 篇 · ${job.model} · ${job.reasonScope==='current_conversation_only'?'关联说明仅本对话可见':'当前项目'}。${job.usage.length?`已返回的实际输入 ${input.toLocaleString()} tokens，输出 ${output.toLocaleString()} tokens。`:'实际用量尚未返回。'}`));
      for(const search of job.searches)usage.append(el('p','console-description',`${search.query} · ${search.source??search.error??'处理中'}`));
      body.append(actions,usage);if(old)old.replaceWith(message);else transcript.append(message);
    }
    if(!jobs.length)transcript.append(el('p','console-description library-empty','当前对话还没有补库任务。直接在下方说明主题并要求补充论文到知识库，即可启动任务。'));
    if(bottom)scroller.scrollTop=scroller.scrollHeight;
  }
  async function refresh(ticket){
    if(!projectId){$('#paper-status').replaceChildren();conversationJobs=[];jobScope=scope();renderLibraryJobs();updateLibraryButton();return;}
    try{
      const [result,jobResult]=await Promise.all([api(endpoint()),sessionId&&!viewingDeleted?api(jobsEndpoint()):Promise.resolve({jobs:[]})]);if(ticket!==epoch)return;
      conversationJobs=jobResult.jobs;jobScope=scope();renderLibraryJobs();
      const version=result.papers.map(p=>`${p.id}:${p.revision}`).join('|');
      if(version!==lastVersion&&$('#memory-console').open&&$('#memory-content').dataset.view==='papers')render($('#memory-content'));
      lastVersion=version;
      const target=$('#paper-status');target.replaceChildren();
      if(result.papers.length){const ready=result.papers.filter(p=>p.status==='ready').length;const button=el('button','paper-chip',ready===result.papers.length?`论文资料 ${ready} 篇可用`:`论文资料 ${result.papers.length} 篇 · ${ready} 篇可用`);button.type='button';button.onclick=()=>window.memoryConsole.openPapers();target.append(button);}

      updateLibraryButton();
      if(result.papers.some(p=>['queued','parsing','extracting'].includes(p.status))||conversationJobs.some(j=>['queued','running'].includes(j.status)))timer=setTimeout(()=>refresh(ticket),2500);
    }catch(e){if(ticket===epoch)$('#paper-status').textContent=e.message;}
  }
  function schedule(){
    clearTimeout(timer);const ticket=++epoch;
    if(jobScope!==scope()){
      conversationJobs=[];jobScope=scope();lastVersion='';
      $('#paper-status').replaceChildren();renderLibraryJobs();updateLibraryButton();
    }
    updateLibraryButton();$('#attach-paper').disabled=busy||uploading||viewingDeleted;timer=setTimeout(()=>refresh(ticket),300);
  }
  $('#attach-paper').onclick=()=>{if(!projectId){progress('先选择或新建一个项目，论文将保存在项目内。');return;}$('#paper-file').click();};
  $('#paper-file').onchange=async()=>{
    const selection=projectId,files=[...$('#paper-file').files];if(!selection||uploading)return;uploading=true;$('#attach-paper').disabled=true;
    try{for(const file of files){if(file.size>35*1024*1024)throw new Error('PDF 大小不能超过 35 MB');
      const response=await fetch(`/api/papers/upload?projectId=${encodeURIComponent(selection)}&name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:file});const value=await response.json();if(!response.ok)throw new Error(value.error);
      if(projectId===selection)status(value.duplicate?'论文已存在，复用已保存的材料。':'论文已上传，正在后台处理；完成后直接在对话中提问。');
    }}catch(e){if(projectId===selection)status(e.message);}finally{uploading=false;$('#paper-file').value='';schedule();window.memoryConsole?.onChange();}
  };
  async function render(target){
    if(!projectId){target.append(el('p','console-description','先选择一个项目，上传或在聊天中提供 arXiv 论文链接。'));return;}
    const selection=projectId;
    try{
      const data=await api(endpoint());if(selection!==projectId||!target.isConnected||target.dataset.view!=='papers')return;target.replaceChildren();
      target.append(el('p','console-description','上传 PDF 或在聊天中提供 arXiv 链接。原文和提取信息保存在当前项目。贡献属于作者主张，尚未独立验证新颖性；图片与公式需要结合原页核对。'));
      if(!data.papers.length)target.append(el('p','console-empty','还没有论文，在顶部功能区点击“添加论文”即可。'));
      for(const paper of data.papers){
        const card=el('article','console-memory');card.append(el('h3',null,paper.title),el('p','memory-certainty',`${statusLabels[paper.status]} · ${paper.pageCount||'—'} 页 · ${paper.step}`));
        if(paper.error)card.append(el('p','paper-error',paper.error));
        const links=el('div','memory-actions');const pdf=el('a',null,'查看原 PDF');pdf.href=asset(paper,'original.pdf');pdf.target='_blank';pdf.rel='noopener noreferrer';links.append(pdf);
        if(['failed','paused'].includes(paper.status)){const retry=el('button','ghost','重试处理');retry.type='button';retry.onclick=async()=>{retry.disabled=true;try{await api(endpoint('/'+paper.id+'/retry'),{method:'POST',body:'{}'});await render(target);schedule();}catch(e){retry.disabled=false;status(e.message);}};links.append(retry);}card.append(links);
        for(const [key,label] of Object.entries(data.fields)){
          const items=paper.analysis?.[key]??[];if(!items.length)continue;const details=el('details','paper-section');details.append(el('summary',null,`${label}（${items.length}）`));
          for(const item of items){const row=el('div','paper-note');row.append(el('p','memory-text',item.text));const button=el('button','ghost','查看来源');button.type='button';button.onclick=async()=>{
            const existing=row.querySelector('.paper-source');if(existing){existing.remove();return;}
            const box=el('div','paper-source');row.append(box);
            try{for(const id of item.sourceIds){const result=await api(`${endpoint('/'+paper.id+'/source')}&sourceId=${encodeURIComponent(id)}`);for(const source of result.sources){box.append(el('p','memory-certainty',`第 ${source.page} 页 · ${source.id}`),el('pre','source-text',source.text));const a=el('a',null,'查看这一页');a.href=asset(paper,`page-${source.page}.png`);a.target='_blank';a.rel='noopener noreferrer';box.append(a);}}}catch(e){box.textContent=e.message;}
          };row.append(button);details.append(row);}card.append(details);
        }target.append(card);
      }
    }catch(e){target.textContent=e.message;}
  }
  function updateLibraryButton(){
    const jobs=jobScope===scope()?conversationJobs:[],active=jobs.filter(j=>['queued','running'].includes(j.status)).length;
    const failed=['failed','partial'].includes(jobs[0]?.status)?jobs[0].counts.failed:0;
    $('#library-launcher-status').textContent=active?`${active} 项进行中`:failed?`${failed} 篇未完成`:jobs.length?'查看结果':'';
    $('#open-library').disabled=!projectId||!sessionId||viewingDeleted||busy;
  }
  $('#open-library').onclick=()=>window.sideChat?.openLibrary();
  window.paperUI={schedule,render,renderLibraryJobs};schedule();
})();
