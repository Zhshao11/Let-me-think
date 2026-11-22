import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { paperDatabase } from './store.mjs';
import { scopedSession } from '../session.mjs';

export const ACTIVE_LIBRARY_STATES=['queued','running'];
export const TERMINAL_LIBRARY_STATES=['completed','partial','failed','paused','needs_input'];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function database(){
  const db=paperDatabase();db.exec(`CREATE TABLE IF NOT EXISTS library_jobs (
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL,session_id TEXT NOT NULL,request_id TEXT NOT NULL,
    status TEXT NOT NULL,phase TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,session_id,request_id));
    CREATE INDEX IF NOT EXISTS library_jobs_scope ON library_jobs(project_id,session_id,created_at);
    CREATE TABLE IF NOT EXISTS paper_research_links (
      job_id TEXT NOT NULL REFERENCES library_jobs(id),paper_id TEXT NOT NULL REFERENCES papers(id),
      project_id TEXT NOT NULL,session_id TEXT NOT NULL,topic TEXT NOT NULL,reason TEXT NOT NULL,
      experiment TEXT NOT NULL,limitations TEXT NOT NULL,source_ids TEXT NOT NULL,
      PRIMARY KEY(job_id,paper_id));`);return db;
}
const exists=()=>fs.existsSync(path.join(config.papersDir,'library.sqlite'));
const decode=row=>row?{id:row.id,projectId:row.project_id,sessionId:row.session_id,requestId:row.request_id,status:row.status,phase:row.phase,data:JSON.parse(row.data),revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at}:null;
export function createLibraryJob({projectId,sessionId,requestId,data}){
  scopedSession(sessionId,projectId);const db=database();
  const old=db.prepare('SELECT * FROM library_jobs WHERE project_id=? AND session_id=? AND request_id=?').get(projectId,sessionId,requestId);
  if(old)return {job:decode(old),duplicate:true};
  const id=crypto.randomUUID(),now=new Date().toISOString();
  db.prepare('INSERT INTO library_jobs(id,project_id,session_id,request_id,status,phase,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,projectId,sessionId,requestId,'queued','等待整理研究问题',JSON.stringify(data),now,now);
  return {job:getLibraryJob(projectId,sessionId,id),duplicate:false};
}
export function getLibraryJob(projectId,sessionId,id){
  scopedSession(sessionId,projectId);const row=exists()?database().prepare('SELECT * FROM library_jobs WHERE id=? AND project_id=? AND session_id=?').get(id,projectId,sessionId):null;
  if(!row)fail('当前对话找不到这项补库任务',404);return decode(row);
}
export function listLibraryJobs(projectId,sessionId){
  if(!projectId||!sessionId)return [];scopedSession(sessionId,projectId);if(!exists())return [];
  return database().prepare('SELECT * FROM library_jobs WHERE project_id=? AND session_id=? ORDER BY created_at DESC LIMIT 20').all(projectId,sessionId).map(decode);
}
export function updateLibraryJob(projectId,sessionId,id,{status,phase,data}){
  const current=getLibraryJob(projectId,sessionId,id);
  return recordLibraryJob(current,{status,phase,data});
}
// Worker-only persistence also records a pause after its source chat is deleted.
// Public reads and mutations still require getLibraryJob's session checks.
export function recordLibraryJob(current,{status,phase,data}){
  database().prepare('UPDATE library_jobs SET status=?,phase=?,data=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND session_id=?').run(status??current.status,phase??current.phase,JSON.stringify(data??current.data),new Date().toISOString(),current.id,current.projectId,current.sessionId);
  return decode(database().prepare('SELECT * FROM library_jobs WHERE id=?').get(current.id));
}
export function recoverableLibraryJobs(){if(!exists())return [];return database().prepare("SELECT * FROM library_jobs WHERE status IN ('queued','running') ORDER BY created_at").all().map(decode);}
export function savePaperResearchLink(job,paperId,association){
  getLibraryJob(job.projectId,job.sessionId,job.id);
  database().prepare(`INSERT OR REPLACE INTO paper_research_links(job_id,paper_id,project_id,session_id,topic,reason,experiment,limitations,source_ids) VALUES(?,?,?,?,?,?,?,?,?)`).run(job.id,paperId,job.projectId,job.sessionId,job.data.plan.topic,association.reason,association.experiment,association.limitations,JSON.stringify(association.sourceIds));
}
export function publicLibraryJob(job){
  const counts=job.data.counts??{added:0,reused:0,needsFulltext:0,failed:0,notRelevant:0};
  const terminal=['partial','failed'].includes(job.status),allFailed=terminal&&counts.failed>0&&!counts.added&&!counts.reused;
  const status=allFailed?'failed':job.status;
  const phase=allFailed?`补库失败：新增 0 篇，${counts.failed} 篇未完成`:job.status==='partial'&&job.phase.startsWith('补库结束')?`补库未完成：新增 ${counts.added} 篇，复用 ${counts.reused} 篇，失败 ${counts.failed} 篇，缺全文 ${counts.needsFulltext} 篇`:job.phase;
  return {id:job.id,status,phase,revision:job.revision,createdAt:job.createdAt,updatedAt:job.updatedAt,
    origin:job.data.proposalEvidence?.trigger??'user_request',directions:job.data.proposalEvidence?.gaps??[],
    request:job.data.request,topic:job.data.plan?.topic??null,bottleneck:job.data.plan?.bottleneck??null,
    maxPapers:job.data.maxPapers,queries:job.data.plan?.queries??[],results:[...(job.data.retained??[]),...(job.data.candidates??[])].filter(c=>c.state&&c.state!=='pending').map(({candidateId,title,url,published,state,paperId,reason,experiment,limitations,sourceIds,error,failedStage,metadataVerified})=>({candidateId,title,url,published,state,paperId,reason,experiment,limitations,sourceIds,error:state==='failed'&&/timeout|timed? ?out/i.test(error??'')?`${failedStage==='download'||!paperId?'下载 PDF':'论文处理'}超时，可继续重试。`:error,failedStage,metadataVerified})),
    counts,
    searches:(job.data.searches??[]).map(({query,source,error})=>({query,source,error})),
    error:job.data.error??(terminal&&counts.failed?`${counts.failed} 篇未处理完成，本次成功新增 ${counts.added} 篇。`:null),clarification:job.data.clarification??null,usage:job.data.usage??[],
    reasonScope:'current_conversation_only',model:config.model};
}
