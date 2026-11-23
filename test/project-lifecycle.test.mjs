import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {config} from '../src/config.mjs';
import {createProject,readProject,listProjects,deleteProject,restoreProject} from '../src/projects.mjs';
import {createSession,appendMessage,readSession} from '../src/session.mjs';
import {startLibraryExpansion,pauseLibraryJobsForProject} from '../src/papers/library-jobs.mjs';
import {getLibraryJob} from '../src/papers/library-jobs-store.mjs';
import {registerPaper,getPaper,paperDatabase} from '../src/papers/store.mjs';
import {processPaper,pausePaperJobsForProject,enqueuePaper} from '../src/papers/pipeline.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'project-lifecycle-'));
config.projectsDir=path.join(dir,'projects');config.sessionsDir=path.join(dir,'sessions');config.papersDir=path.join(dir,'papers');
test.after(()=>{paperDatabase().close();fs.rmSync(dir,{recursive:true,force:true});});

test('project trash is durable, versioned and leaves its conversations intact for restoration',()=>{
  const a=createProject({name:'同名项目'}),b=createProject({name:'同名项目'});
  const sid=createSession(config.model,a.id);appendMessage(sid,'user','研究原始记录');
  assert.throws(()=>deleteProject(a.id,{expectedVersion:0}),{status:409});
  const deleted=deleteProject(a.id,{expectedVersion:a.version});
  assert.throws(()=>readProject(a.id),{status:404});
  assert.ok(!listProjects().some(p=>p.id===a.id));assert.ok(listProjects().some(p=>p.id===b.id));
  assert.equal(listProjects({deleted:true}).find(p=>p.id===a.id).deletedAt,deleted.deletedAt);
  assert.equal(readSession(sid).messages[0].content,'研究原始记录');
  assert.throws(()=>restoreProject(a.id,{expectedVersion:a.version}),{status:409});
  const restored=restoreProject(a.id,{expectedVersion:deleted.version});
  assert.equal(readProject(a.id).deletedAt,null);assert.equal(restored.version,a.version+2);
  assert.throws(()=>restoreProject(a.id,{expectedVersion:restored.version}),{status:409});
});

test('deleting one project pauses only its queued library jobs and restoration does not resume them',()=>{
  const a=createProject({name:'暂停补库A'}),b=createProject({name:'暂停补库B'});
  const jobFor=p=>{const sid=createSession(config.model,p.id),source=appendMessage(sid,'user','补充图像匹配论文到知识库');return {sid,job:startLibraryExpansion({projectId:p.id,sessionId:sid,sourceId:source.id,enqueue:false}).job};};
  const x=jobFor(a),y=jobFor(b);pauseLibraryJobsForProject(a.id);
  const deleted=deleteProject(a.id,{expectedVersion:a.version});
  assert.equal(getLibraryJob(a.id,x.sid,x.job.id).status,'paused');assert.equal(getLibraryJob(b.id,y.sid,y.job.id).status,'queued');
  restoreProject(a.id,{expectedVersion:deleted.version});assert.equal(getLibraryJob(a.id,x.sid,x.job.id).status,'paused');
});

test('project deletion aborts its active PDF parser, preserves the PDF and never restarts deleted work',async()=>{
  const a=createProject({name:'暂停论文A'}),b=createProject({name:'暂停论文B'});
  const bytes=Buffer.from('%PDF-1.4\nproject deletion fixture\n%%EOF');
  const x=registerPaper({projectId:a.id,bytes,name:'a.pdf'}).paper,y=registerPaper({projectId:b.id,bytes,name:'b.pdf'}).paper;
  let parserSignal;
  const task=processPaper(a.id,x.id,{parse:(_paper,{signal})=>{parserSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  pausePaperJobsForProject(a.id);deleteProject(a.id,{expectedVersion:a.version});
  await assert.rejects(task);assert.equal(parserSignal.aborted,true);assert.equal(getPaper(a.id,x.id).status,'paused');assert.equal(getPaper(b.id,y.id).status,'queued');
  enqueuePaper(a.id,x.id);assert.equal(getPaper(a.id,x.id).status,'paused');
  assert.throws(()=>processPaper(a.id,x.id),{status:404});
  assert.deepEqual(fs.readFileSync(path.join(config.papersDir,'documents',x.id,'original.pdf')),bytes);
});
