import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { createProject } from '../src/projects.mjs';
import { createSession, appendMessage, readSession, saveContextControls } from '../src/session.mjs';
import { createSideConversation } from '../src/side-conversations.mjs';
import { DEFAULT_CONTEXT_CONTROLS } from '../src/agent/context-controls.mjs';
import { contextSpec } from '../src/agent/context-manager.mjs';
import { runAgent } from '../src/agent/runtime.mjs';
import { getAgentProfile } from '../src/agent/profiles.mjs';
import { startLibraryExpansion, startProposalLibraryExpansion } from '../src/papers/library-jobs.mjs';
import { getLibraryJob, listLibraryJobs } from '../src/papers/library-jobs-store.mjs';
import { registerPaper, saveChunks, updatePaper, paperDatabase } from '../src/papers/store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-workflow-'));
config.projectsDir = path.join(dir,'projects'); config.sessionsDir = path.join(dir,'sessions'); config.papersDir = path.join(dir,'papers');
test.after(()=>{paperDatabase().close();fs.rmSync(dir,{recursive:true,force:true});});
const gap = {direction:'光学–SAR局部描述子的困难负样本区分',query:'optical SAR local descriptors hard negative contrastive',reason:'现有原文未验证跨模态细粒度区分'};
function fixture(request='请给出提高跨模态区分能力的具体改进方案') {
  const project=createProject({name:'虚构方案验收'}),sessionId=createSession(config.model,project.id);
  const source=appendMessage(sessionId,'user',request);
  return {projectId:project.id,sessionId,sourceId:source.id,request};
}
function seed(projectId) {
  const {paper}=registerPaper({projectId,bytes:Buffer.from('%PDF-1.4\nCONTRASTIVE_FIXTURE\n%%EOF'),name:'Fixture contrastive.pdf'});
  saveChunks(projectId,paper.id,[{id:'p3-b0',page:3,text:'Contrastive learning aligns representations across modalities. Method: use a shared embedding with contrastive negatives.',section:'Method'}]);
  return updatePaper(projectId,paper.id,{title:'Fixture cross modal contrastive representations',status:'ready',analysis:{method:[{text:'shared embedding',sourceIds:['p3-b0']}]}});
}
function profile() {return {...getAgentProfile(),inputBudget:50000,allowedTools:['paper_search','paper_read','paper_expand_library','paper_search_online','paper_import','paper_library_job'],maxToolCalls:3};}
function model({paperId,route='proposal',gaps=[],allowBackground=true,invent=false,onFinal}={}) {
  const requests=[];
  const complete=async request=>{
    requests.push(request); assert.equal(request.model,'gpt-6.1-sol');
    const forced=request.toolChoice?.function?.name;
    if(forced) {
      const value=forced==='proposal_route'?{route,objective:route==='proposal'?'提高跨模态细粒度区分':'',queries:route==='proposal'?['cross modal contrastive','local discriminative descriptors']:[],allowBackground}:
        {findings:paperId?[{paperId,sourceIds:[invent?'p99-b0':'p3-b0'],mechanism:'跨模态对比表征',limitation:'并非光学SAR定位验证'}]:[],gaps,synthesisNotes:'模型自行提出局部困难负样本与细尺度适配，属于针对用户结构的待验证改法。'};
      return {toolCalls:[{id:forced,type:'function',function:{name:forced,arguments:JSON.stringify(value)}}],usage:{prompt_tokens:100,completion_tokens:30}};
    }
    await onFinal?.(request);
    request.onDelta('建议增加局部困难负样本对比适配。这是针对你结构的待验证改法。');
    return {toolCalls:[],usage:{prompt_tokens:200,completion_tokens:50}};
  };
  return {requests,complete};
}
async function run(f,options={}) {
  const output=[],events=[];
  const result=await runAgent({messages:[{role:'user',content:f.request}],profile:profile(),history:[],...f,model:config.model,
    onDelta:t=>output.push(t),onEvent:e=>events.push(e),dispatchProposal:args=>startProposalLibraryExpansion({...args,enqueue:false}),...options});
  return {result,output,events};
}
test('a proposal cannot emit before deterministic local search and method reads; the model may extend beyond the paper',async()=>{
  const f=fixture(),paper=seed(f.projectId);
  const mock=model({paperId:paper.id,onFinal:request=>{
    const names=request.messages.filter(m=>m.role==='assistant').flatMap(m=>(m.tool_calls??[]).map(t=>t.function.name));
    assert.deepEqual(names,['paper_search','paper_search','paper_read']);
    assert.match(JSON.stringify(request.messages),/p3-b0|模型自行提出/);
    assert.ok(!request.tools.some(t=>['paper_search_online','paper_import','paper_expand_library','paper_library_job'].includes(t.function.name)));
  }});
  const {result,output,events}=await run(f,{complete:mock.complete});
  assert.equal(result.proposalWorkflow.route,'proposal');assert.equal(result.proposalWorkflow.papersRead,1);
  assert.equal(result.toolCalls,3);assert.equal(result.modelCalls,3);assert.equal(result.callsUsage.length,3);
  assert.equal(output.length,1);assert.match(output[0],/待验证改法/);
  assert.ok(events.findIndex(e=>e.stage==='ready')<events.findIndex(e=>e.stage==='draft_or_tool'));
  assert.equal(listLibraryJobs(f.projectId,f.sessionId).length,0);
});
test('empty local evidence still allows a proposal and dispatches only a queued, scoped background job',async()=>{
  const f=fixture(),mock=model({gaps:[gap]});
  const {result,output}=await run(f,{complete:mock.complete});
  assert.equal(output.length,1);assert.equal(result.proposalWorkflow.papersRead,0);
  assert.equal(result.proposalWorkflow.background.job.status,'queued');
  const job=getLibraryJob(f.projectId,f.sessionId,result.proposalWorkflow.background.job.id);
  assert.equal(job.data.sourceId,f.sourceId);assert.equal(job.data.proposalEvidence.trigger,'proposal_evidence_gap');
  assert.match(job.data.request,/困难负样本/);assert.equal(job.data.plan,null);assert.equal(job.data.snapshot,null);
  assert.deepEqual(job.data.searches,[]);assert.equal(job.data.maxPapers,3);
  assert.equal(readSession(f.sessionId).messages.length,1);
  assert.throws(()=>startLibraryExpansion({...f,enqueue:false}),/明确要求/);
  const twice=startProposalLibraryExpansion({...f,details:job.data.proposalEvidence,enqueue:false});
  assert.equal(twice.job.id,job.id);assert.equal(listLibraryJobs(f.projectId,f.sessionId).length,1);
});
test('local-only requests block dispatch even if the route model mistakenly allows background expansion',async()=>{
  const f=fixture('只看本地论文，不要联网和自动补库，但请给具体改法');
  const {result}=await run(f,{complete:model({gaps:[gap]}).complete});
  assert.match(result.proposalWorkflow.background.skipped,/限制/);
  assert.equal(listLibraryJobs(f.projectId,f.sessionId).length,0);
  const allowed=fixture(),another=await run(allowed,{complete:model({gaps:[gap],allowBackground:false}).complete});
  assert.equal(another.result.proposalWorkflow.background,null);
  assert.equal(listLibraryJobs(allowed.projectId,allowed.sessionId).length,0);
});
test('pure explanations route directly with no retrieval or job; invalid evidence cannot become a visible answer',async()=>{
  const f=fixture('对比学习是什么？'),mock=model({route:'direct'});
  const {result}=await run(f,{complete:mock.complete});
  assert.equal(result.toolCalls,0);assert.equal(result.modelCalls,2);assert.equal(result.proposalWorkflow.route,'direct');
  const g=fixture(),paper=seed(g.projectId);let emissions=0;
  await assert.rejects(run(g,{complete:model({paperId:paper.id,invent:true}).complete,onDelta:()=>{emissions++;}}),/未读取/);
  assert.equal(emissions,0);assert.equal(listLibraryJobs(g.projectId,g.sessionId).length,0);
});
test('ordinary private side chats retrieve but never write into the paper library or parent',async()=>{
  const f=fixture(),child=createSideConversation(f.sessionId,f.projectId,{purpose:'discussion'});
  const source=appendMessage(child.id,'user','给具体改法'),before=fs.readFileSync(path.join(config.sessionsDir,f.sessionId+'.jsonl'),'utf8');
  const p=profile();p.allowedTools=p.allowedTools.filter(t=>!['paper_expand_library','paper_import','paper_library_job'].includes(t));
  const {result}=await run({...f,sessionId:child.id,sourceId:source.id},{profile:p,complete:model({gaps:[gap]}).complete});
  assert.match(result.proposalWorkflow.background.skipped,/只读/);assert.equal(listLibraryJobs(f.projectId,f.sessionId).length,0);
  assert.equal(fs.readFileSync(path.join(config.sessionsDir,f.sessionId+'.jsonl'),'utf8'),before);
});
test('cross-project and excluded source requests cannot authorize automatic jobs; raw and source-off profiles skip the workflow',async()=>{
  const f=fixture(),other=createProject({name:'其他项目'});
  const details={objective:'局部匹配',gaps:[gap],searched:1,paperIds:[]};
  assert.throws(()=>startProposalLibraryExpansion({...f,projectId:other.id,details,enqueue:false}),/Session not found/);
  saveContextControls(f.sessionId,f.projectId,0,{...DEFAULT_CONTEXT_CONTROLS,excludedMessageIds:[f.sourceId]});
  assert.throws(()=>startProposalLibraryExpansion({...f,details,enqueue:false}),/有效/);
  const project=createProject({name:'禁用工具'}),sessionId=createSession(config.model,project.id);
  for(const raw of [true,false]) {
    const spec=contextSpec({session:readSession(sessionId),project,request:{responseMode:'concise',message:'给方案',contextControls:{...DEFAULT_CONTEXT_CONTROLS,allowSourceLookup:false}},config:{...config,systemPrompt:raw?'off':'sections'}});
    assert.equal(spec.profile.allowedTools.length,0);
    const result=await run({...f,projectId:project.id,sessionId},{profile:spec.profile,complete:model().complete});
    assert.equal(result.result.proposalWorkflow,null);assert.equal(result.result.modelCalls,1);
  }
});
test('review runs after evidence and does not turn background dispatch into a handoff-only answer',async()=>{
  const f=fixture(),p={...profile(),id:'experiment',reviewPasses:1};
  const mock=model({gaps:[gap]});
  const {result,output}=await run(f,{profile:p,complete:mock.complete});
  assert.equal(result.modelCalls,4);assert.equal(result.taskState,null);assert.equal(output.length,1);
  assert.equal(result.proposalWorkflow.background.job.status,'queued');
  assert.match(mock.requests.at(-1).messages.findLast(m=>m.role==='user').content,/具体改进/);
});


test('irrelevant local papers impose no dependency, citation quota or automatic expansion',async()=>{
  const f=fixture(),paper=seed(f.projectId);
  const mock=model({onFinal:request=>{
    const guidance=request.messages.findLast(m=>m.role==='system').content;
    assert.match(guidance,/"findings":\[\]/);
    assert.match(guidance,/不强制采纳或引用/);
  }});
  const {result,output}=await run(f,{complete:mock.complete});
  assert.equal(result.proposalWorkflow.papersRead,1);
  assert.deepEqual(result.proposalWorkflow.findings,[]);assert.deepEqual(result.proposalWorkflow.gaps,[]);
  assert.equal(result.proposalWorkflow.background,null);assert.equal(listLibraryJobs(f.projectId,f.sessionId).length,0);
  assert.equal(output.length,1);
});

test('an unavailable background dispatcher does not block the concrete proposal or pretend a task exists',async()=>{
  const f=fixture(),mock=model({gaps:[gap]});
  const {result,output}=await run(f,{complete:mock.complete,dispatchProposal:()=>{throw new Error('任务队列暂不可用');}});
  assert.match(result.proposalWorkflow.background.error,/队列/);
  assert.equal(result.proposalWorkflow.background.job,undefined);assert.equal(output.length,1);
});


test('a request not to wait for ingestion still authorizes independent background work',async()=>{
  const f=fixture('请给具体方案；需要的机制资料派后台补论文，不要等待入库，主对话继续');
  const {result,output}=await run(f,{complete:model({gaps:[gap]}).complete});
  assert.equal(result.proposalWorkflow.background.job.status,'queued');
  assert.equal(output.length,1);
});

