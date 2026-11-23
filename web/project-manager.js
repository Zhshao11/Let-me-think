(()=>{
  const dialog=$('#project-manager'),list=$('#project-manager-list');
  let trash=false,revision=0,mutating=false,timer;
  const notice=text=>{$('#project-manager-notice').textContent=text;};
  const element=(tag,text,cls)=>{const node=document.createElement(tag);node.textContent=text;if(cls)node.className=cls;return node;};
  const button=(text,action,cls='ghost')=>{const node=element('button',text,cls);node.type='button';node.onclick=action;return node;};
  function confirmDelete(project){
    return new Promise(resolve=>{
      const confirm=document.createElement('dialog');confirm.className='regenerate-confirm project-delete-confirm';confirm.setAttribute('aria-labelledby','project-delete-title');
      const title=element('h2',`删除项目“${project.name}”？`);title.id='project-delete-title';
      const text=element('p','项目及其对话、记忆和论文会移入项目回收站，后台论文任务会暂停。之后可以恢复。');
      const actions=element('div','','confirm-actions'),cancel=button('取消',()=>confirm.close('cancel'));cancel.autofocus=true;
      actions.append(cancel,button('确定删除',()=>confirm.close('delete'),'confirm-primary'));confirm.append(title,text,actions);document.body.append(confirm);
      confirm.addEventListener('close',()=>{const accepted=confirm.returnValue==='delete';confirm.remove();resolve(accepted);},{once:true});confirm.showModal();
    });
  }
  async function change(project){
    if(mutating)return;mutating=true;clearTimeout(timer);revision++;notice('');
    const restoring=trash;
    try{
      if(!restoring&&!await confirmDelete(project))return;
      for(const b of list.querySelectorAll('button'))b.disabled=true;
      await api(`/api/projects/${project.id}${restoring?'/restore':''}`,{method:restoring?'POST':'DELETE',body:JSON.stringify({expectedVersion:project.version})});
      if(!restoring){
        if(projectId===project.id){resetConversationForProject(null);viewingTrash=false;localStorage.setItem('research.projectId','');}
        for(const [key,view] of conversationViews)if(view.projectId===project.id)conversationViews.delete(key);
      }
      await loadProjects();await loadSessions();
      notice(restoring?'项目已恢复，对话、记忆和论文均已保留。后台任务保持暂停，可按需继续。':'项目已移入回收站，可在“项目回收站”中恢复。');
    }catch(error){notice(error.message);}
    finally{mutating=false;await refresh();}
  }
  async function refresh(){
    clearTimeout(timer);if(!dialog.open||mutating)return;const ticket=++revision,deleted=trash;
    $('#project-manager-active').classList.toggle('active',!trash);$('#project-manager-trash').classList.toggle('active',trash);
    try{
      const {projects}=await api(`/api/projects?deleted=${deleted}`);if(ticket!==revision||!dialog.open)return;
      list.replaceChildren();
      if(!projects.length)list.append(element('p',deleted?'项目回收站为空。':'还没有项目，可在左侧新建。','console-empty'));
      for(const project of projects){
        const row=element('div','','project-manager-row'),info=element('div','','project-manager-info'),actions=element('div','','project-manager-actions');
        info.append(element('strong',project.name));
        info.append(element('p',deleted?`删除于 ${new Date(project.deletedAt).toLocaleString()}`:project.isResponding?'正在回复，完成后可删除':project.id===projectId?'当前项目':'对话、记忆和论文保存在项目内'));
        if(!deleted)actions.append(button('打开',async()=>{
          resetConversationForProject(project.id);viewingTrash=false;$('#project-select').value=project.id;localStorage.setItem('research.projectId',project.id);dialog.close();await loadSessions();
        }));
        const action=button(deleted?'恢复':'删除',()=>change(project),deleted?'ghost':'ghost project-delete');
        action.setAttribute('aria-label',`${deleted?'恢复':'删除'}项目：${project.name}`);action.disabled=Boolean(project.isResponding);actions.append(action);row.append(info,actions);list.append(row);
      }
      if(projects.some(project=>project.isResponding))timer=setTimeout(refresh,1500);
    }catch(error){if(ticket===revision)notice(error.message);}
  }
  $('#manage-projects').onclick=()=>{trash=false;notice('');dialog.showModal();refresh();};
  $('#project-manager-active').onclick=()=>{if(mutating)return;trash=false;notice('');refresh();};
  $('#project-manager-trash').onclick=()=>{if(mutating)return;trash=true;notice('');refresh();};
  dialog.addEventListener('close',()=>{revision++;clearTimeout(timer);});
  window.projectManager={update(){if(dialog.open&&!mutating){clearTimeout(timer);timer=setTimeout(refresh,200);}}};
})();
