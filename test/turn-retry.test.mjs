import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.mjs';
import {createProject} from '../src/projects.mjs';
import {createSession,appendMessage,appendSummary,readSession,reviseLastTurn,saveContextControls} from '../src/session.mjs';
import {applyAutomaticMemories,memoryView} from '../src/memory-store.mjs';
import {DEFAULT_CONTEXT_CONTROLS,controlledHistory} from '../src/agent/context-controls.mjs';
import {contextSpec} from '../src/agent/context-manager.mjs';
import {createSideConversation} from '../src/side-conversations.mjs';
import {startLibraryExpansion} from '../src/papers/library-jobs.mjs';
import {listLibraryJobs} from '../src/papers/library-jobs-store.mjs';
import {paperDatabase} from '../src/papers/store.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'turn-revisions-'));
config.projectsDir=path.join(dir,'projects');config.sessionsDir=path.join(dir,'sessions');config.papersDir=path.join(dir,'papers');
test.after(()=>{paperDatabase().close();fs.rmSync(dir,{recursive:true,force:true});});
function fixture(text='OLD_RESEARCH_RESULT'){
  const p=createProject({name:'上一轮修订验收'}),id=createSession(config.model,p.id),u=appendMessage(id,'user',text),a=appendMessage(id,'assistant','OLD_ASSISTANT_PROPOSAL');
  return {projectId:p.id,id,u,a,project:p};
}
test('editing the latest question retires old answer and derived memories, clears summaries and keeps raw audit events',()=>{
  const f=fixture();
  applyAutomaticMemories({projectId:f.projectId,sessionId:f.id,throughId:f.a.id,values:[
    {scope:'project',category:'progress',topic:'匹配',key:'result',text:'OLD_RESEARCH_RESULT',certainty:'user_report',sourceMessageIds:[f.u.id]},
    {scope:'conversation',category:'plan',topic:'匹配',key:'proposal',text:'OLD_ASSISTANT_PROPOSAL',certainty:'proposal',sourceMessageIds:[f.a.id]},
  ]});
  const child=createSideConversation(f.id,f.projectId);
  appendSummary(f.id,{data:{userReports:[{text:'OLD_RESEARCH_RESULT',sourceIds:[f.u.id]}]},coveredCount:2});
  saveContextControls(f.id,f.projectId,0,{...DEFAULT_CONTEXT_CONTROLS,excludedMessageIds:[f.u.id],messageEdits:{[f.a.id]:'OLD_OVERRIDE'}});
  const result=reviseLastTurn(f.id,f.projectId,{messageId:f.u.id,message:'CORRECTED_RESULT',expectedRevision:0});
  assert.notEqual(result.source.id,f.u.id);assert.equal(result.session.messages.length,1);assert.equal(result.session.summary,null);
  assert.equal(result.session.contextRevision,1);assert.equal(result.session.messageRevision,1);
  assert.deepEqual(result.session.contextControls.excludedMessageIds,[]);assert.deepEqual(result.session.contextControls.messageEdits,{});
  const memory=memoryView(f.projectId,f.id);assert.equal(memory.project.items.length,0);assert.equal(memory.conversation.items.length,0);
  const spec=contextSpec({session:result.session,project:f.project,request:{responseMode:'concise',message:'CORRECTED_RESULT',omitMessageId:result.source.id},config});
  assert.equal(spec.history.length,0);assert.doesNotMatch(JSON.stringify(spec.projectContext),/OLD_/);
  assert.match(fs.readFileSync(path.join(config.sessionsDir,f.id+'.jsonl'),'utf8'),/OLD_ASSISTANT_PROPOSAL/);
  assert.match(JSON.stringify(readSession(child.id).sideContext),/OLD_RESEARCH_RESULT/);
});
test('same-text regeneration preserves the user source and background job identity while replacing the answer',()=>{
  const f=fixture('根据低纹理匹配瓶颈补充论文到知识库');
  const job=startLibraryExpansion({projectId:f.projectId,sessionId:f.id,sourceId:f.u.id,enqueue:false});
  const retry=reviseLastTurn(f.id,f.projectId,{messageId:f.u.id,message:f.u.content,expectedRevision:0});
  assert.equal(retry.source.id,f.u.id);assert.equal(retry.session.messages.length,1);assert.equal(retry.changed,false);
  const twice=startLibraryExpansion({projectId:f.projectId,sessionId:f.id,sourceId:retry.source.id,enqueue:false});
  assert.equal(twice.job.id,job.job.id);assert.equal(listLibraryJobs(f.projectId,f.id).length,1);
  assert.throws(()=>reviseLastTurn(f.id,f.projectId,{messageId:f.u.id,message:f.u.content,expectedRevision:0}),/已更新/);
});
test('old, foreign and deleted message targets cannot revise another turn or project',()=>{
  const f=fixture(),foreign=createProject({name:'另一个项目'}),latest=appendMessage(f.id,'user','NEW_LATEST');
  assert.throws(()=>reviseLastTurn(f.id,f.projectId,{messageId:f.u.id,message:'bad',expectedRevision:0}),/最后一轮/);
  assert.throws(()=>reviseLastTurn(f.id,foreign.id,{messageId:latest.id,message:'bad',expectedRevision:0}),/Session not found/);
  assert.throws(()=>reviseLastTurn(f.id,f.projectId,{messageId:latest.id,message:' ',expectedRevision:0}),/不能为空/);
  assert.equal(readSession(f.id).messageRevision,0);assert.equal(readSession(f.id).messages.length,3);
});
test('unfinished assistant fragments are retained for display but excluded from model history',()=>{
  const p=createProject({name:'失败回复'}),id=createSession(config.model,p.id);
  appendMessage(id,'user','当前问题');appendMessage(id,'assistant','PARTIAL_RESPONSE',{status:'incomplete'});
  const state=readSession(id),history=controlledHistory(state,DEFAULT_CONTEXT_CONTROLS);
  assert.equal(state.messages.length,2);assert.equal(history.length,1);assert.equal(history[0].role,'user');
});
