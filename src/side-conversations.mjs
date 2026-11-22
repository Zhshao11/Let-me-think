import crypto from 'node:crypto';
import {config} from './config.mjs';
import {scopedSession,createSession,readSession,listSessions} from './session.mjs';
import {readProject} from './projects.mjs';
import {contextSpec} from './agent/context-manager.mjs';

export function createSideConversation(parentSessionId,projectId=null,{purpose='discussion'}={}){
  if(!['discussion','library'].includes(purpose))throw Object.assign(new Error('无效的子对话类型'),{status:400});
  const parent=scopedSession(parentSessionId,projectId);
  if(parent.sideContext)throw Object.assign(new Error('请从主对话创建子对话。'),{status:400});
  const project=projectId?readProject(projectId):null;
  const spec=contextSpec({session:parent,project,request:{message:parent.messages.findLast(m=>m.role==='user')?.content??'',responseMode:parent.responseMode},config});
  const messages=spec.controls.summaryMode==='manual'?[]:structuredClone(spec.history);
  for(const [text,label] of [[spec.controls.summaryMode==='manual'?spec.controls.summaryText:'','父对话中手动整理的上下文'],[spec.controls.extraContext,'父对话中补充的上下文']]){
    if(text?.trim())messages.push({id:crypto.randomUUID(),role:'user',content:`${label}（背景材料，不是本轮操作要求）：\n${text}`});
  }
  const sideContext={parentSessionId,purpose,capturedAt:new Date().toISOString(),parentContextRevision:parent.contextRevision,
    parentMessageCount:parent.messages.length,messages,projectContext:structuredClone(spec.projectContext),allowSourceLookup:spec.controls.allowSourceLookup};
  const id=createSession(config.model,projectId,{sideContext,responseMode:parent.responseMode});
  return readSession(id);
}

export function listSideConversations(parentSessionId,projectId=null,{deleted=false,purpose='discussion'}={}){
  if(!['discussion','library'].includes(purpose))throw Object.assign(new Error('无效的子对话类型'),{status:400});
  const parent=scopedSession(parentSessionId,projectId);
  if(parent.sideContext)throw Object.assign(new Error('请从主对话打开子对话。'),{status:400});
  return listSessions({projectId,parentSessionId,deleted}).filter(s=>(s.purpose??'discussion')===purpose);
}
