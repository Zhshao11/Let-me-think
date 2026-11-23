(()=>{
  const drafts=new Map();
  let confirming=false;
  function confirmRegeneration(){
    if(confirming)return Promise.resolve(false);
    confirming=true;
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='regenerate-confirm';dialog.setAttribute('aria-labelledby','regenerate-confirm-title');
      const title=document.createElement('h2');title.id='regenerate-confirm-title';title.textContent='确定要重新生成这条回复吗？';
      const description=document.createElement('p');description.textContent='确认后会重新回答上一条问题，并替换当前回复。';
      const actions=document.createElement('div');actions.className='confirm-actions';
      const cancel=button('取消',()=>dialog.close('cancel'),false);cancel.autofocus=true;
      const confirm=button('确定重新生成',()=>dialog.close('confirm'),false);confirm.className='confirm-primary';
      actions.append(cancel,confirm);dialog.append(title,description,actions);document.body.append(dialog);
      dialog.addEventListener('close',()=>{const accepted=dialog.returnValue==='confirm';dialog.remove();confirming=false;resolve(accepted);},{once:true});
      dialog.showModal();
    });
  }
  function button(label,action,disabled){const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent=label;b.disabled=disabled;b.onclick=action;return b;}
  function appendPaperSupplement(actions,message){
    if(message.status==='streaming')return;
    const value=message.paperSupplement;
    const needed=value?.needed===true?true:value?.needed===false?false:null;
    const label=needed===true?'参考论文：需补充':needed===false?'参考论文：无需补充':'参考论文：未评估';
    const status=button(label,()=>showPaperSupplement(value),false);
    status.className='paper-supplement-status';status.dataset.needed=String(needed);status.setAttribute('aria-haspopup','dialog');status.title='查看本条回复的补库判断与具体要求';
    actions.append(status);
  }
  function showPaperSupplement(value){
    const dialog=document.createElement('dialog');dialog.className='paper-supplement-dialog';dialog.setAttribute('aria-labelledby','paper-supplement-title');
    const element=(tag,text,cls)=>{const node=document.createElement(tag);node.textContent=text;if(cls)node.className=cls;return node;};
    const header=document.createElement('header');header.className='settings-head';
    const title=element('h2','参考论文补库要求');title.id='paper-supplement-title';
    header.append(title,button('关闭',()=>dialog.close(),false));dialog.append(header);
    dialog.append(element('p','这是这条回复生成时的判断；任务实时进展在右侧“论文补库”查看。','console-description'));
    dialog.append(element('p',value?.needed===true?'需要补充参考论文':value?.needed===false?'本轮无需补充参考论文':'本轮未记录补库判断','supplement-verdict'));
    dialog.append(element('p',value?.reason||'这条回复尚无补库判断记录，不能据此认定需要或不需要。'));
    if(value?.objective)dialog.append(element('p','研究目标：'+value.objective));
    if(Number.isInteger(value?.localSearches))dialog.append(element('p',`本轮本地检索 ${value.localSearches} 次，读取 ${value.papersRead??0} 篇论文的方法原文。`,'console-description'));
    const requirements=Array.isArray(value?.requirements)?value.requirements:[];
    for(const [index,item] of requirements.entries()){
      const section=document.createElement('section');section.className='supplement-requirement';
      section.append(element('h3',`${index+1}. ${item.direction}`));
      if(item.reason)section.append(element('p','补充原因：'+item.reason));
      if(item.query)section.append(element('p','检索方向：'+item.query,'supplement-query'));
      dialog.append(section);
    }
    if(value?.needed===true&&!requirements.length&&value.request)dialog.append(element('p','补库要求：'+value.request,'supplement-request'));
    if(value?.needed===true&&!requirements.length)dialog.append(element('p','具体论文与检索方向由后台任务进一步整理。','console-description'));
    if(value?.background?.detail)dialog.append(element('p','任务情况：'+value.background.detail,'supplement-task'));
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  }
  function decorate(node,message,{question,reply,revision,disabled=false,responding=false,retry}){
    if(!question?.id)return;
    const run=(text=question.content)=>retry(text,{messageId:question.id,expectedRevision:revision});
    if(message===question){
      const unfinished=!reply||reply.status==='incomplete'||question.replyStatus==='failed'||question.replyStatus==='running';
      if(unfinished){
        const note=document.createElement('p');note.className='turn-notice';
        note.textContent=responding?'正在回复…':question.replyError?'回复未完成：'+question.replyError:'上一轮尚未完成回复，可以重新发送或编辑后重发。';
        node.append(note);
      }
      const actions=document.createElement('div');actions.className='message-actions turn-actions';
      const edit=()=>{
        if(node.querySelector('.message-editor'))return;
        const original=node.querySelector('.body');original.hidden=true;actions.hidden=true;
        const form=document.createElement('form');form.className='message-editor';
        const input=document.createElement('textarea');input.rows=5;input.setAttribute('aria-label','编辑上一轮问题');input.value=drafts.get(question.id)??question.content;
        input.oninput=()=>drafts.set(question.id,input.value);
        const controls=document.createElement('div');controls.className='turn-actions';
        const save=button('保存并重发',null,false);save.type='submit';
        controls.append(save,button('取消',()=>{form.remove();original.hidden=false;actions.hidden=false;},false));
        form.append(input,controls);
        form.onsubmit=event=>{event.preventDefault();if(!input.value.trim())return;drafts.set(question.id,input.value);run(input.value.trim());};
        node.append(form);input.focus();
      };
      actions.append(button('编辑后重发',edit,disabled));
      if(unfinished)actions.append(button('重新发送',()=>run(),disabled));
      node.append(actions);
    }
    if(message===reply){
      if(message.status==='incomplete'){
        const note=document.createElement('p');note.className='turn-notice';note.textContent='未完成回复，重试后会重新生成。';node.append(note);
      }else{
        const actions=node.querySelector('.response-actions')??document.createElement('div');actions.classList.add('message-actions','turn-actions','response-actions');
        actions.insertBefore(button('重新生成',async()=>{if(await confirmRegeneration())run();},disabled),actions.querySelector('.paper-supplement-status'));node.append(actions);
      }
    }
  }
  window.turnActions={decorate,appendPaperSupplement};
})();
