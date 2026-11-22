(()=>{
  const markdown=window.markdownit({html:false,linkify:true,breaks:true});
  window.markdownMath(markdown);
  const escape=markdown.utils.escapeHtml;
  const safeLink=href=>{
    try{return ['http:','https:','mailto:'].includes(new URL(href,window.location.origin).protocol);}
    catch{return false;}
  };
  const validate=markdown.validateLink;
  markdown.validateLink=href=>validate(href)&&safeLink(href);
  const linkOpen=markdown.renderer.rules.link_open??((tokens,index,options,env,renderer)=>renderer.renderToken(tokens,index,options));
  markdown.renderer.rules.link_open=(tokens,index,options,env,renderer)=>{
    tokens[index].attrSet('target','_blank');tokens[index].attrSet('rel','noopener noreferrer');
    return linkOpen(tokens,index,options,env,renderer);
  };
  markdown.renderer.rules.table_open=()=>'<div class="markdown-table-scroll"><table>\n';
  markdown.renderer.rules.table_close=()=>'</table></div>\n';
  const image=markdown.renderer.rules.image;
  markdown.renderer.rules.image=(tokens,index,options,env,renderer)=>{
    const token=tokens[index],source=token.attrGet('src')??'';
    // Local paper figures can be displayed. External images remain links so
    // generated Markdown cannot silently make requests to arbitrary servers.
    if(/^\/api\/papers\/[0-9a-f-]+\/assets\/(?:page-\d+|figure-\d+)\.png(?:\?[^#]*)?$/.test(source))return image(tokens,index,options,env,renderer);
    return safeLink(source)?`<a href="${escape(source)}" target="_blank" rel="noopener noreferrer">${escape(token.content||'查看图片')}</a>`:escape(token.content);
  };
  const html=text=>markdown.render(String(text??''));
  window.markdownRenderer={html,renderInto(element,text){element.classList.add('markdown-body');element.innerHTML=html(text);}};
  if(typeof document!=='undefined')document.addEventListener('copy',event=>{
    if(event.target?.closest?.('input,textarea,[contenteditable="true"]'))return;
    const selection=window.getSelection();
    if(!event.clipboardData||!selection||selection.isCollapsed||!selection.rangeCount)return;
    const range=selection.getRangeAt(0).cloneRange();
    const element=node=>node.nodeType===1?node:node.parentElement;
    // Only handle selections inside one rendered message; inputs and code-only
    // selections retain the browser's ordinary copy behavior.
    const body=element(range.startContainer)?.closest('.markdown-body');
    if(!body||body!==element(range.endContainer)?.closest('.markdown-body'))return;
    const startMath=element(range.startContainer)?.closest('.katex');
    const endMath=element(range.endContainer)?.closest('.katex');
    const start=startMath?.closest('.katex-display')??startMath;
    const end=endMath?.closest('.katex-display')??endMath;
    if(start)range.setStartBefore(start);
    if(end)range.setEndAfter(end);
    const fragment=range.cloneContents();
    if(!fragment.querySelector('.katex-mathml'))return;
    event.clipboardData.setData('text/plain',window.mathSelectionSource(fragment));
    event.preventDefault();
  });
})();
