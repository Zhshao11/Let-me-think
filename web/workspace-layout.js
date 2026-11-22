(()=>{
  const root=document.documentElement,body=document.body,sidebar=document.querySelector('#sidebar');
  const panel=document.querySelector('#side-chat'),mobile=matchMedia('(max-width:700px)');
  const storageKey='research.workspace-layout.v1';
  let saved={};try{const value=JSON.parse(localStorage.getItem(storageKey)??'{}');if(value&&typeof value==='object'&&!Array.isArray(value))saved=value;}catch{}
  const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify(saved));}catch{}};
  const numeric=(value,fallback)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
  const clamp=(value,min,max)=>Math.max(Math.min(min,max),Math.min(max,value));
  const px=value=>Math.round(value)+'px';
  let mobileOpen=false,sideExpanded=false,sideNormal=null;
  const sidebarMax=()=>Math.min(480,mobile.matches?innerWidth*.85:innerWidth-320);
  const sideMax=()=>Math.max(220,innerWidth-76);
  const sideHeightMax=()=>Math.max(180,innerHeight-24);
  function sidebarState(){
    const visible=mobile.matches?mobileOpen:saved.sidebarCollapsed!==true;
    sidebar.hidden=!visible;
    body.classList.toggle('sidebar-overlay',mobile.matches&&visible);
    const toggle=document.querySelector('#toggle-sidebar');
    toggle.setAttribute('aria-expanded',String(visible));
    toggle.setAttribute('aria-label',visible?'收起侧栏':'展开侧栏');
    toggle.title=visible?'收起侧栏':'展开侧栏';
    sideState();
  }
  function sideState(){
    const open=panel.open,kind=panel.dataset.purpose??'discussion';
    const sideWidth=sideExpanded?sideMax():clamp(numeric(saved.sideWidth,480),Math.min(320,sideMax()),sideMax());
    const sideHeight=sideExpanded?sideHeightMax():clamp(numeric(saved.sideHeight,sideHeightMax()),480,sideHeightMax());
    root.style.setProperty('--side-panel-width',px(sideWidth));
    root.style.setProperty('--side-panel-height',px(sideHeight));
    const leftWidth=sidebar.hidden||mobile.matches?0:sidebar.getBoundingClientRect().width;
    body.classList.toggle('side-docked',open&&!mobile.matches&&!sideExpanded&&innerWidth-leftWidth-sideWidth-64>=360);
    body.classList.toggle('has-side-panel',open);
    for(const [id,purpose] of [['open-side-chat','discussion'],['open-library','library']]){
      const button=document.getElementById(id),active=open&&kind===purpose;
      button.classList.toggle('active',active);button.setAttribute('aria-expanded',String(active));
    }
    const expand=panel.querySelector('.expand-panel');
    if(expand){expand.textContent=sideExpanded?'还原':'放大';expand.setAttribute('aria-label',sideExpanded?'还原辅助窗口':'放大辅助窗口');}
    sizeInputs();
  }
  function sizeInputs(){
    for(const [id,key,fallback,maximum] of [
      ['input','mainInputHeight',88,Math.min(innerHeight*.5,innerHeight-280)],
      ['side-chat-input','sideInputHeight',80,(panel.open?panel.getBoundingClientRect().height:innerHeight)-360],
    ]){
      const input=document.getElementById(id),max=Math.max(64,maximum);
      input.style.height=px(clamp(numeric(saved[key],fallback),64,max));
      input.style.maxHeight=px(max);
    }
  }
  function sidebarWidth(value){
    saved.sidebarWidth=clamp(value,180,sidebarMax());
    root.style.setProperty('--sidebar-width',px(saved.sidebarWidth));sideState();
  }
  const toggleSidebar=()=>{
    if(mobile.matches)mobileOpen=!mobileOpen;
    else {saved.sidebarCollapsed=saved.sidebarCollapsed!==true;persist();}
    sidebarState();
  };
  document.querySelector('#toggle-sidebar').onclick=toggleSidebar;
  document.querySelector('#collapse-sidebar').onclick=toggleSidebar;
  const scrim=document.createElement('button');
  scrim.className='sidebar-scrim';scrim.type='button';scrim.setAttribute('aria-label','收起侧栏');
  scrim.onclick=()=>{mobileOpen=false;sidebarState();};body.append(scrim);
  window.workspaceLayout={closeSidebarOnMobile(){if(mobile.matches){mobileOpen=false;sidebarState();}}};

  // Pointer capture keeps the drag working when the cursor crosses a panel or
  // leaves its edge. Each handle also supports arrow keys and double-click reset.
  function resizer(target,{label,axes='x',className,read,write,reset,begin=()=>{},finish=persist}){
    const handle=document.createElement('div');
    handle.className='resize-handle '+className;handle.tabIndex=0;
    handle.setAttribute('role',axes.length===1?'separator':'button');
    handle.setAttribute('aria-label',label);
    if(axes.length===1)handle.setAttribute('aria-orientation',axes==='x'?'vertical':'horizontal');
    handle.title=label+'；方向键微调，双击恢复默认';
    target.append(handle);
    if(axes.length===1){
      const updateValue=()=>{const measured=read(),value=typeof measured==='number'?measured:axes==='x'?measured.width:measured.height;handle.setAttribute('aria-valuemin','0');handle.setAttribute('aria-valuemax',String(axes==='x'?innerWidth:innerHeight));handle.setAttribute('aria-valuenow',String(Math.round(value)));handle.setAttribute('aria-valuetext',Math.round(value)+' 像素');};
      new ResizeObserver(updateValue).observe(target);updateValue();
    }
    const pointerDown=event=>{
      if(event.button!==0)return;
      event.preventDefault();begin();
      const origin=read(),x=event.clientX,y=event.clientY;
      handle.setPointerCapture(event.pointerId);
      body.classList.add('resizing');body.style.cursor=getComputedStyle(handle).cursor;
      const move=e=>{if(e.pointerId===event.pointerId)write(origin,e.clientX-x,e.clientY-y);};
      const stop=e=>{
        if(e.pointerId!==event.pointerId)return;
        handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',stop);handle.removeEventListener('pointercancel',stop);handle.removeEventListener('lostpointercapture',stop);
        if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
        body.classList.remove('resizing');body.style.cursor='';finish();
      };
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop);handle.addEventListener('lostpointercapture',stop);
    };
    handle.addEventListener('pointerdown',pointerDown);
    handle.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key))return;
      event.preventDefault();
      if(event.key==='Home'){reset();finish();return;}
      begin();const step=event.shiftKey?40:12;
      write(read(),event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0);finish();
    });
    handle.addEventListener('dblclick',()=>{reset();finish();});
  }
  resizer(sidebar,{label:'拖动调整侧栏宽度',className:'resize-right',read:()=>sidebar.getBoundingClientRect().width,write:(width,dx)=>sidebarWidth(width+dx),reset:()=>sidebarWidth(240)});
  for(const [id,container,key,fallback] of [['input','composer','mainInputHeight',88],['side-chat-input','side-chat-composer','sideInputHeight',80]]){
    const input=document.getElementById(id);
    resizer(document.getElementById(container),{label:id==='input'?'拖动调整主对话输入框高度':'拖动调整子对话输入框高度',axes:'y',className:'resize-top',read:()=>input.getBoundingClientRect().height,write:(height,_dx,dy)=>{saved[key]=height-dy;sizeInputs();saved[key]=input.getBoundingClientRect().height;},reset:()=>{saved[key]=fallback;sizeInputs();}});
  }
  function sideWrite(rect,dx,dy){
    sideExpanded=false;saved.sideWidth=clamp(rect.width-dx,320,sideMax());
    if(dy!==null)saved.sideHeight=clamp(rect.height+dy,480,sideHeightMax());
    sideState();
  }
  resizer(panel,{label:'拖动调整辅助窗口宽度',className:'resize-left',read:()=>panel.getBoundingClientRect(),write:(rect,dx)=>sideWrite(rect,dx,null),reset:()=>{sideExpanded=false;delete saved.sideWidth;sideState();}});
  resizer(panel,{label:'拖动调整辅助窗口大小',axes:'xy',className:'resize-bottom-left',read:()=>panel.getBoundingClientRect(),write:sideWrite,reset:()=>{sideExpanded=false;delete saved.sideWidth;delete saved.sideHeight;sideState();}});
  function expandButton(dialog,action){
    const header=dialog.querySelector('.settings-head'),button=document.createElement('button');
    button.type='button';button.className='ghost expand-panel';button.textContent='放大';button.setAttribute('aria-label','放大窗口');button.onclick=action;
    header.insertBefore(button,header.lastElementChild);return button;
  }
  expandButton(panel,()=>{
    if(!sideExpanded){sideNormal={width:saved.sideWidth,height:saved.sideHeight};sideExpanded=true;}
    else {sideExpanded=false;saved.sideWidth=sideNormal?.width;saved.sideHeight=sideNormal?.height;}
    sideState();
  });
  const dialogs=[];
  for(const dialog of document.querySelectorAll('.project-dialog')){
    const header=dialog.querySelector('.settings-head'),scroll=document.createElement('div');scroll.className='dialog-scroll';
    for(const child of [...dialog.childNodes])if(child!==header)scroll.append(child);
    dialog.append(scroll);
    const defaults={width:dialog.classList.contains('memory-console')?860:440,height:null};
    const stored=saved.dialogs?.[dialog.id];let expanded=false,normal=null;
    function constrain(){
      if(expanded){dialog.style.width=px(innerWidth-24);dialog.style.height=px(innerHeight-24);dialog.style.left='12px';dialog.style.top='12px';return;}
      if(dialog.style.width)dialog.style.width=px(clamp(parseFloat(dialog.style.width),320,innerWidth-24));
      if(dialog.style.height)dialog.style.height=px(clamp(parseFloat(dialog.style.height),220,innerHeight-24));
      if(dialog.style.left&&dialog.open){const rect=dialog.getBoundingClientRect();dialog.style.left=px(clamp(rect.left,12,innerWidth-rect.width-12));dialog.style.top=px(clamp(rect.top,12,innerHeight-rect.height-12));}
    }
    const set=(rect,dx,dy)=>{
      expanded=false;expand.textContent='放大';expand.setAttribute('aria-label','放大窗口');
      dialog.style.width=px(rect.width+dx);dialog.style.height=px(rect.height+dy);constrain();
    };
    const freeze=()=>{const rect=dialog.getBoundingClientRect();dialog.style.width=px(rect.width);dialog.style.height=px(rect.height);dialog.style.left=px(rect.left);dialog.style.top=px(rect.top);dialog.style.margin='0';};
    const remember=()=>{saved.dialogs??={};saved.dialogs[dialog.id]={width:parseFloat(dialog.style.width)||defaults.width,height:parseFloat(dialog.style.height)||null};persist();};
    const reset=()=>{expanded=false;expand.textContent='放大';expand.setAttribute('aria-label','放大窗口');dialog.style.width='';dialog.style.height='';dialog.style.left='';dialog.style.top='';dialog.style.margin='';};
    const expand=expandButton(dialog,()=>{
      if(!expanded){normal={width:dialog.style.width,height:dialog.style.height,left:dialog.style.left,top:dialog.style.top,margin:dialog.style.margin};expanded=true;dialog.style.margin='0';}
      else {expanded=false;Object.assign(dialog.style,normal);}
      expand.textContent=expanded?'还原':'放大';expand.setAttribute('aria-label',expanded?'还原窗口':'放大窗口');constrain();
    });
    if(stored){if(typeof stored.width==='number'&&Number.isFinite(stored.width))dialog.style.width=px(stored.width);if(typeof stored.height==='number'&&Number.isFinite(stored.height))dialog.style.height=px(stored.height);constrain();}
    resizer(dialog,{label:'拖动调整窗口大小',axes:'xy',className:'resize-bottom-right',begin:freeze,read:()=>dialog.getBoundingClientRect(),write:set,reset,finish:remember});
    dialogs.push({dialog,constrain});
  }
  new MutationObserver(()=>sideState()).observe(panel,{attributes:true,attributeFilter:['open','data-purpose']});
  panel.addEventListener('close',sideState);
  const refresh=()=>{sidebarWidth(numeric(saved.sidebarWidth,240));sidebarState();for(const item of dialogs)item.constrain();};
  mobile.addEventListener('change',()=>{mobileOpen=false;refresh();});
  window.addEventListener('resize',refresh);
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||document.querySelector('dialog:modal'))return;
    if(panel.open){panel.close();event.preventDefault();}
    else if(mobileOpen){mobileOpen=false;sidebarState();}
  });
  refresh();
})();
