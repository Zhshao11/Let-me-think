import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {config} from '../src/config.mjs';
import {createProject} from '../src/projects.mjs';
import {createSession,appendMessage,readSession,saveContextControls,deleteSession} from '../src/session.mjs';
import {DEFAULT_CONTEXT_CONTROLS} from '../src/agent/context-controls.mjs';
import {registerPaper,getPaper,listPapers,saveChunks,updatePaper,paperDatabase,identifyPaper,associatePaperIdentity} from '../src/papers/store.mjs';
import {processPaper} from '../src/papers/pipeline.mjs';
import {startLibraryExpansion,runLibraryExpansion,controlLibraryExpansion,expansionSnapshot,isLibraryExpansionRequest,validateResearchAssociation} from '../src/papers/library-jobs.mjs';
import {getLibraryJob,listLibraryJobs,publicLibraryJob} from '../src/papers/library-jobs-store.mjs';
import {verifyPaperMetadata} from '../src/papers/metadata.mjs';
import {applyAutomaticMemories,memoryView,editMemory} from '../src/memory-store.mjs';
import {createSideConversation} from '../src/side-conversations.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'library-jobs-'));
config.projectsDir=path.join(directory,'projects');config.sessionsDir=path.join(directory,'sessions');config.papersDir=path.join(directory,'papers');
test.after(()=>{paperDatabase().close();fs.rmSync(directory,{recursive:true,force:true});});
function fixture(request='围绕低纹理匹配瓶颈，给当前项目知识库补充最多1篇论文'){
  const project=createProject({name:'补库测试'}),sessionId=createSession(config.model,project.id),source=appendMessage(sessionId,'user',request);
  const {job}=startLibraryExpansion({projectId:project.id,sessionId,sourceId:source.id,maxNewPapers:1,enqueue:false});
  return {projectId:project.id,sessionId,sourceId:source.id,id:job.id};
}
const blocks=[{id:'p1-b0',page:1,text:'The method studies local feature matching and low texture regions.',kind:'text',section:'Method'}];
const paperFields=()=>Object.fromEntries(['summary','problem','method','contributions','experiments','limitations'].map(key=>[key,[{text:'测试原文的研究说明',sourceIds:['p1-b0']}]]));
function seed(projectId,title,key='seed'){
  const {paper}=registerPaper({projectId,bytes:Buffer.from('%PDF-1.4\nMOCK PAPER '+key+'\n%%EOF'),name:title+'.pdf'});
  saveChunks(projectId,paper.id,blocks);return updatePaper(projectId,paper.id,{title,status:'ready',step:'测试已入库',pageCount:1,analysis:paperFields()});
}
function dependencies(papers,{process:overrideProcess,onModel,onSearch}={}){
  const counters={models:[],searches:0,imports:0,processes:0};
  const complete=async request=>{
    counters.models.push(request.model);onModel?.(request);
    const prompt=request.messages[0].content,payload=JSON.parse(request.messages[1].content);let answer;
    if(prompt.includes('补库规划器'))answer={topic:'图像匹配',bottleneck:'低纹理区域对应不稳定，原因待验证',sourceIds:[payload.snapshot.messages.at(-1).id],clarification:null,queries:[{query:'local feature matching low texture',recent:false,purpose:'寻找方法和竞争解释'}]};
    else if(prompt.includes('筛选器'))answer={selected:payload.candidates.map(c=>({candidateId:c.candidateId,reason:'可能针对低纹理匹配',use:'可以做低纹理子集对照'}))};
    else if(prompt.includes('关联复核器'))answer={relevant:!payload.paperTitle.includes('Irrelevant'),reason:'原文讨论低纹理匹配，尚未证明适用于用户场景',experiment:'固定匹配预算，比较低纹理子集结果',limitations:'原文并非用户自己的实验',sourceIds:[payload.sources[0].id]};
    else answer=paperFields();
    request.onDelta(JSON.stringify(answer));return {usage:{prompt_tokens:100,completion_tokens:50},finishReason:'stop'};
  };
  const search=async(query,options)=>{counters.searches++;if(onSearch)return onSearch(query,options);return {source:'arXiv',papers};};
  const importPaper=async(projectId,id)=>{counters.imports++;return registerPaper({projectId,bytes:Buffer.from('%PDF-1.4\nMOCK '+id+'\n%%EOF'),name:id+'.pdf',sourceUrl:'https://arxiv.org/abs/'+id});};
  const process=async(projectId,id,options)=>{
    counters.processes++;if(overrideProcess)return overrideProcess(projectId,id,options,counters);
    const title=papers.find(p=>p.url?.endsWith(getPaper(projectId,id).name.replace('.pdf','')))?.title??'Fixture new paper';
    return processPaper(projectId,id,{...options,complete,parse:async()=>({title,pageCount:1,parser:'mock-docling',chunks:blocks})});
  };
  return {counters,options:{complete,search,importPaper,process,verify:async c=>({...c,metadataVerified:true})}};
}

test('one bounded expansion reuses existing papers, reports missing full text, rejects weak relevance and adds grounded new material',async()=>{
  const f=fixture();seed(f.projectId,'Fixture reusable paper');
  const papers=[
    {title:'Publisher paper without available PDF',doi:'10.1234/fixture',url:'https://doi.org/10.1234/fixture',abstract:'A related study'},
    {title:'Fixture reusable paper',url:'https://arxiv.org/abs/2301.00001'},
    {title:'Irrelevant paper',url:'https://arxiv.org/abs/2401.00002'},
    {title:'Fixture new paper',url:'https://arxiv.org/abs/2401.00003'},
  ];
  const {options,counters}=dependencies(papers);
  const result=await runLibraryExpansion(f,options);
  assert.equal(result.status,'completed');assert.deepEqual(result.counts,{added:1,reused:1,needsFulltext:1,failed:0,notRelevant:1});
  assert.equal(counters.imports,2);assert.equal(counters.searches,1);assert.ok(counters.models.every(m=>m==='gpt-6.1-sol'));
  const added=result.results.find(c=>c.state==='added');assert.equal(added.sourceIds[0],'p1-b0');assert.equal(getPaper(f.projectId,added.paperId).status,'ready');
  const links=paperDatabase().prepare('SELECT * FROM paper_research_links WHERE job_id=?').all(f.id);
  assert.equal(links.length,2);assert.ok(links.every(link=>link.session_id===f.sessionId));
  await runLibraryExpansion(f,options);assert.equal(counters.imports,2);
  const same=startLibraryExpansion({projectId:f.projectId,sessionId:f.sessionId,sourceId:f.sourceId,maxNewPapers:1,enqueue:false});assert.equal(same.job.id,f.id);
});

test('failed processing resumes from persisted checkpoints without another search, download or candidate plan',async()=>{
  const f=fixture(),papers=[{title:'Fixture new paper',url:'https://arxiv.org/abs/2402.00001'}];let processCalls=0;
  const dep=dependencies(papers,{process:async(projectId,id)=>{
    if(++processCalls===1)throw new Error('simulated processing interruption');
    saveChunks(projectId,id,blocks);return updatePaper(projectId,id,{title:'Fixture new paper',status:'ready',step:'测试恢复',pageCount:1,analysis:paperFields()});
  }});
  const first=await runLibraryExpansion(f,dep.options);assert.equal(first.status,'failed');assert.equal(first.counts.failed,1);
  const persisted=execFileSync(process.execPath,['--input-type=module','-e',`import {getLibraryJob} from './src/papers/library-jobs-store.mjs';process.stdout.write(getLibraryJob('${f.projectId}','${f.sessionId}','${f.id}').status);`],{cwd:new URL('..',import.meta.url),env:{...process.env,PROJECTS_DIR:config.projectsDir,SESSIONS_DIR:config.sessionsDir,PAPERS_DIR:config.papersDir},encoding:'utf8'});
  assert.equal(persisted,'failed');
  controlLibraryExpansion({...f,jobId:f.id,action:'resume',enqueue:false});
  const second=await runLibraryExpansion(f,dep.options);assert.equal(second.status,'completed');assert.equal(second.counts.added,1);
  assert.equal(dep.counters.searches,1);assert.equal(dep.counters.imports,1);assert.equal(processCalls,2);
});

test('pause aborts in-flight search, immediate resume is not overwritten by the old run, and no unrequested download starts',async()=>{
  const f=fixture();let enteredResolve;const entered=new Promise(r=>{enteredResolve=r;});let first=true;
  const papers=[{title:'Fixture new paper',url:'https://arxiv.org/abs/2403.00001'}];
  const dep=dependencies(papers,{onSearch:async(_query,{signal})=>{
    if(first){first=false;enteredResolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
    return {source:'arXiv',papers};
  }});
  const running=runLibraryExpansion(f,dep.options);await entered;
  assert.equal(controlLibraryExpansion({...f,jobId:f.id,action:'pause'}).status,'paused');
  assert.equal(controlLibraryExpansion({...f,jobId:f.id,action:'resume',enqueue:false}).status,'queued');
  await running;assert.equal(getLibraryJob(f.projectId,f.sessionId,f.id).status,'queued');assert.equal(dep.counters.imports,0);
  assert.equal((await runLibraryExpansion(f,dep.options)).status,'completed');assert.equal(dep.counters.imports,1);
});

test('private job context stays in its source chat and excluded source data pauses work before it reaches search',async()=>{
  const project=createProject({name:'隔离'}),sid=createSession(config.model,project.id),other=createSession(config.model,project.id),foreign=createProject({name:'另一个项目'});
  const hidden=appendMessage(sid,'user','HIDDEN_PREVIOUS_MESSAGE');appendMessage(other,'user','PRIVATE_OTHER_CHAT');
  const source=appendMessage(sid,'user','根据低纹理瓶颈补充论文到知识库');
  saveContextControls(sid,project.id,0,{...DEFAULT_CONTEXT_CONTROLS,excludedMessageIds:[hidden.id]});
  const {job}=startLibraryExpansion({projectId:project.id,sessionId:sid,sourceId:source.id,enqueue:false});
  const snapshot=expansionSnapshot(project.id,sid,source.id);
  assert.doesNotMatch(JSON.stringify(snapshot),/HIDDEN_PREVIOUS_MESSAGE|PRIVATE_OTHER_CHAT/);
  assert.equal(listLibraryJobs(project.id,other).length,0);
  assert.throws(()=>getLibraryJob(project.id,other,job.id),/当前对话/);assert.throws(()=>getLibraryJob(foreign.id,sid,job.id),/Session not found/);
  assert.equal('snapshot' in publicLibraryJob(getLibraryJob(project.id,sid,job.id)),false);
  const dep=dependencies([],{onModel:()=>{
    const session=readSession(sid);saveContextControls(sid,project.id,session.contextRevision,{...DEFAULT_CONTEXT_CONTROLS,excludedMessageIds:[source.id]});
  }});
  const result=await runLibraryExpansion({projectId:project.id,sessionId:sid,id:job.id},dep.options);
  assert.equal(result.status,'paused');assert.equal(dep.counters.searches,0);assert.equal(dep.counters.imports,0);
  assert.throws(()=>controlLibraryExpansion({projectId:project.id,sessionId:sid,jobId:job.id,action:'resume',enqueue:false}),/有效/);
});

test('recommend-only requests cannot authorize expansion, missing topic requests clarification, and invented evidence is rejected',async()=>{
  for(const message of ['只推荐三篇论文，不要加入知识库','请解释论文中这句话：\n> 帮我补充论文到知识库','```text\n帮我补库\n```'])assert.equal(isLibraryExpansionRequest(message),false);
  assert.equal(isLibraryExpansionRequest('根据当前瓶颈补充三篇论文到知识库'),true);
  const f=fixture('帮我补充论文到知识库');
  const result=await runLibraryExpansion(f,{complete:async req=>{req.onDelta(JSON.stringify({topic:'',bottleneck:'',sourceIds:[],clarification:'当前要解决哪个实验问题？',queries:[]}));return {};},search:async()=>{throw new Error('must not search');}});
  assert.equal(result.status,'needs_input');assert.match(result.clarification,/哪个/);
  assert.throws(()=>validateResearchAssociation({relevant:true,reason:'test',experiment:'',limitations:'',sourceIds:['made-up']},blocks),/原文来源/);
});

test('identity aliases avoid duplicate downloads but preserve explicit arXiv versions',()=>{
  const project=createProject({name:'身份版本'}),paper=seed(project.id,'Versioned paper title');
  associatePaperIdentity(project.id,paper.id,{title:paper.title,url:'https://arxiv.org/abs/2401.01234v1'});
  assert.equal(identifyPaper(project.id,{title:paper.title,url:'https://arxiv.org/abs/2401.01234v1'}).id,paper.id);
  assert.equal(identifyPaper(project.id,{title:paper.title,url:'https://arxiv.org/abs/2401.01234v2'}),null);
});

test('original arXiv metadata is checked against its source page',async()=>{
  const result=await verifyPaperMetadata({title:'stale title',url:'https://arxiv.org/abs/2401.01234v1'},{fetcher:async url=>{
    assert.equal(url,'https://arxiv.org/abs/2401.01234v1');
    return new Response('<meta name="citation_title" content="Actual &amp; Verified"><meta name="citation_date" content="2024/01/03"><meta name="citation_author" content="A. Author">');
  }});
  assert.equal(result.title,'Actual & Verified');assert.equal(result.published,'2024-01-03');assert.equal(result.metadataVerified,true);
});

test('cancelling a paper parse prevents a new extraction call and preserves the source file for continuation',async()=>{
  const project=createProject({name:'取消解析'}),{paper}=registerPaper({projectId:project.id,bytes:Buffer.from('%PDF-1.4\nCANCEL_FIXTURE\n%%EOF'),name:'cancel.pdf'});
  const controller=new AbortController();let calls=0;
  await assert.rejects(processPaper(project.id,paper.id,{signal:controller.signal,parse:async()=>{controller.abort();return {title:'test',pageCount:1,parser:'mock',chunks:blocks};},complete:async()=>{calls++;}}));
  assert.equal(calls,0);assert.equal(getPaper(project.id,paper.id).status,'paused');assert.equal(listPapers(project.id).length,1);
});

test('a missing full text is rechecked after upload and resume without repeating search',async()=>{
  const f=fixture();const title='Previously missing full text';
  const dep=dependencies([{title,doi:'10.1234/missing',url:'https://doi.org/10.1234/missing'}]);
  const first=await runLibraryExpansion(f,dep.options);
  assert.equal(first.counts.needsFulltext,1);
  seed(f.projectId,title);
  controlLibraryExpansion({...f,jobId:f.id,action:'resume',enqueue:false});
  const result=await runLibraryExpansion(f,dep.options);
  assert.equal(result.counts.needsFulltext,0);assert.equal(result.counts.reused,1);
  assert.equal(result.status,'completed');
  assert.equal(dep.counters.searches,1);assert.equal(dep.counters.imports,0);
});

test('editing a research memory pauses the task before sending another search',async()=>{
  const f=fixture();
  applyAutomaticMemories({projectId:f.projectId,sessionId:f.sessionId,throughId:f.sourceId,values:[{scope:'conversation',key:'bottleneck',category:'problem',topic:'匹配',text:'低纹理匹配待诊断',certainty:'user_report',sourceMessageIds:[f.sourceId]}]});
  const dep=dependencies([],{onModel:()=>{
    const view=memoryView(f.projectId,f.sessionId),memory=view.conversation.items[0];
    editMemory({projectId:f.projectId,sessionId:f.sessionId,scope:'conversation',memoryId:memory.id,expectedVersion:view.conversation.version,action:'edit',text:'实际要关注计算开销',category:'problem',topic:'匹配'});
  }});
  const result=await runLibraryExpansion(f,dep.options);
  assert.equal(result.status,'paused');assert.equal(dep.counters.searches,0);
});

test('library-window expansion runs against its own real source and frozen parent context, and logs only in that window',async()=>{
  const project=createProject({name:'完整补库子窗口'}),parentId=createSession(config.model,project.id);
  appendMessage(parentId,'user','PARENT_INHERITED_FROZEN 假设研究低纹理匹配');
  const child=createSideConversation(parentId,project.id,{purpose:'library'});
  const source=appendMessage(child.id,'user','SIDE_REQUEST_ONLY 根据继承背景补充1篇论文到知识库');
  const rootFile=path.join(config.sessionsDir,parentId+'.jsonl'),before=fs.readFileSync(rootFile,'utf8');
  const created=startLibraryExpansion({projectId:project.id,sessionId:child.id,sourceId:source.id,maxNewPapers:1,enqueue:false});
  const owned=getLibraryJob(project.id,parentId,created.job.id);
  assert.equal(owned.data.sourceSessionId,child.id);
  seed(project.id,'Library window existing paper');
  const dep=dependencies([{title:'Library window existing paper',url:'https://arxiv.org/abs/2401.09999'}],{onModel:req=>req.onRequest?.({model:req.model,messages:req.messages})});
  const result=await runLibraryExpansion({projectId:project.id,sessionId:parentId,id:owned.id},dep.options);
  assert.equal(result.status,'completed');assert.equal(result.counts.reused,1);
  const finished=getLibraryJob(project.id,parentId,owned.id);
  assert.match(JSON.stringify(finished.data.snapshot.messages),/PARENT_INHERITED_FROZEN/);
  assert.match(JSON.stringify(finished.data.snapshot.messages),/SIDE_REQUEST_ONLY/);
  assert.equal(fs.readFileSync(rootFile,'utf8'),before);
  assert.equal(fs.existsSync(path.join(config.sessionsDir,'requests',parentId+'.jsonl')),false);
  assert.ok(fs.existsSync(path.join(config.sessionsDir,'requests',child.id+'.jsonl')));
});

test('clarification and research-direction adjustment use new library-window messages without inserting them in the parent',async()=>{
  const project=createProject({name:'补库子窗口补充背景'}),parentId=createSession(config.model,project.id);
  appendMessage(parentId,'user','父对话背景');const child=createSideConversation(parentId,project.id,{purpose:'library'});
  const first=appendMessage(child.id,'user','帮我补库');
  const initial=startLibraryExpansion({projectId:project.id,sessionId:child.id,sourceId:first.id,enqueue:false});
  await runLibraryExpansion({projectId:project.id,sessionId:parentId,id:initial.job.id},{complete:async req=>{req.onDelta(JSON.stringify({topic:'',bottleneck:'',sourceIds:[],clarification:'具体要查哪个瓶颈？',queries:[]}));return {};}});
  const update=appendMessage(child.id,'user','SIDE_NEW_TOPIC 主题是低纹理图像匹配，调整为最多1篇，继续');
  const next=controlLibraryExpansion({projectId:project.id,sessionId:child.id,jobId:initial.job.id,action:'resume',sourceId:update.id,maxNewPapers:1,enqueue:false});
  assert.notEqual(next.id,initial.job.id);
  const stored=getLibraryJob(project.id,parentId,next.id);
  assert.equal(stored.data.sourceSessionId,child.id);assert.match(stored.data.request,/SIDE_NEW_TOPIC/);
  assert.deepEqual(stored.data.authorizationSources,[{sessionId:child.id,sourceId:first.id}]);
  seed(project.id,'A matched clarification paper');const dep=dependencies([{title:'A matched clarification paper',url:'https://arxiv.org/abs/2401.08888'}]);
  const done=await runLibraryExpansion({projectId:project.id,sessionId:parentId,id:next.id},dep.options);
  assert.equal(done.status,'completed');assert.equal(done.counts.reused,1);
  const direction=appendMessage(child.id,'user','SIDE_ADJUST_ONLY 改为匹配更新稳定性，最多1篇');
  const adjusted=controlLibraryExpansion({projectId:project.id,sessionId:child.id,jobId:next.id,action:'adjust',sourceId:direction.id,maxNewPapers:1,enqueue:false});
  const changed=getLibraryJob(project.id,parentId,adjusted.id);
  assert.equal(changed.data.sourceSessionId,child.id);assert.match(changed.data.request,/SIDE_ADJUST_ONLY/);
  assert.equal((await runLibraryExpansion({projectId:project.id,sessionId:parentId,id:adjusted.id},dep.options)).status,'completed');
  assert.doesNotMatch(JSON.stringify(readSession(parentId)),/SIDE_NEW_TOPIC/);
  assert.doesNotMatch(JSON.stringify(readSession(parentId)),/SIDE_ADJUST_ONLY/);
});

test('all failed downloads are reported as failure, including old partial records, and retry does not repeat planning',async()=>{
  const f=fixture(),dep=dependencies([{title:'Download failure fixture',url:'https://arxiv.org/abs/2402.09999'}]);
  dep.options.importPaper=async()=>{throw new DOMException('The operation was aborted due to timeout','TimeoutError');};
  const result=await runLibraryExpansion(f,dep.options);
  assert.equal(result.status,'failed');assert.match(result.phase,/失败/);assert.equal(result.counts.added,0);assert.equal(result.counts.failed,1);
  assert.match(result.results[0].error,/下载 PDF.*超时/);assert.equal(result.results[0].failedStage,'download');
  const stored=getLibraryJob(f.projectId,f.sessionId,f.id);
  const oldView=publicLibraryJob({...stored,status:'partial',phase:'补库结束：新增 0 篇，复用 0 篇',data:{...stored.data,error:null}});
  assert.equal(oldView.status,'failed');assert.match(oldView.error,/1 篇未处理完成/);
  const retry=controlLibraryExpansion({...f,jobId:f.id,action:'resume',enqueue:false});
  assert.equal(retry.counts.failed,0);
  const newDep=dependencies([{title:'Download failure fixture',url:'https://arxiv.org/abs/2402.09999'}]);
  const success=await runLibraryExpansion(f,newDep.options);
  assert.equal(success.status,'completed');assert.equal(success.counts.added,1);assert.equal(newDep.counters.searches,0);
});
