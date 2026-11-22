import crypto from 'node:crypto';
import { resolveAgentProfile } from './profiles.mjs';
import { buildPromptSections, renderSystemPrompt } from '../prompt.mjs';
import { publicProject } from '../projects.mjs';
import { selectProjectContext } from './project-memory.mjs';
import { prepareContext } from './context.mjs';
import { DEFAULT_CONTEXT_CONTROLS, validateContextControls, controlledHistory, contextAccess, contextStateKey } from './context-controls.mjs';
import { chatRequestBody } from '../upstream.mjs';
import { toolDefinitions } from './tools.mjs';
import { tokenModelInfo, countRequestTokens } from './tokens.mjs';
import { selectMemoryContext } from './memory.mjs';
import { memoryView } from '../memory-store.mjs';
import { paperRevision } from '../papers/store.mjs';
import { proposalRoutingRequest } from './proposal-workflow.mjs';

export function contextSpec({ session, project, request, config }) {
  const controls = validateContextControls(request.contextControls ?? session.contextControls ?? DEFAULT_CONTEXT_CONTROLS, session, project);
  if(session.sideContext&&!session.sideContext.allowSourceLookup)controls.allowSourceLookup=false;
  const tokenModel = tokenModelInfo(config.model, config.contextWindow, config.tokenizerEncoding);
  const profile = resolveAgentProfile(request.responseMode, { rawMode: config.systemPrompt === 'off', reasoningSupported: config.reasoningSupported, contextWindow: tokenModel.contextWindow, tokenModel });
  if(project&&!profile.rawMode&&controls.allowSourceLookup){
    profile.allowedTools.push('paper_search','paper_read','paper_search_online','paper_import','paper_expand_library','paper_library_job');
    profile.maxToolCalls=Math.max(profile.maxToolCalls,3);
    profile.runtimeReserve=Math.max(profile.runtimeReserve,12000);
    profile.proposalWorkflow={version:'local-evidence-v1',maxSearches:2,maxPapers:2,maxBackgroundPapers:3};
  }
  if(session.sideContext&&!profile.rawMode){
    profile.allowedTools=profile.allowedTools.filter(tool=>!['project_memory_lookup','paper_import','paper_expand_library','paper_library_job'].includes(tool));
    if(controls.allowSourceLookup&&controls.includeHistory&&!profile.allowedTools.includes('conversation_lookup'))profile.allowedTools.push('conversation_lookup');
    profile.maxToolCalls=Math.max(profile.maxToolCalls,3);
    profile.runtimeReserve=Math.max(profile.runtimeReserve,5000);
    if(session.sideContext.purpose==='library'&&project&&controls.allowSourceLookup)profile.allowedTools.push('paper_library_job','paper_expand_library','paper_import');
  }
  profile.allowedTools = profile.allowedTools.filter((tool) => controls.allowSourceLookup
    && (tool !== 'project_memory_lookup' || project && controls.includeProjectMemories)
    && (tool !== 'conversation_lookup' || controls.includeHistory));
  const sections = profile.rawMode ? [] : buildPromptSections({ responseMode: profile.id, profile });
  if(session.sideContext&&!profile.rawMode){
    sections.push({id:'side_conversation',title:'Private side conversation',body:'这是独立子对话。你承接的是创建时允许使用的父对话历史与研究记忆快照，之后仅使用本子对话的新消息；不要声称知道父对话后来的进展。子对话消息和摘要只留在这里，不写入父对话、项目记忆或对话记忆。具体操作能力以本轮工具目录为准；记忆隔离不代表禁止用户明确要求的工具操作。不自动总结回父对话，不要求每轮解释隔离规则，正常回应当前问题。'});
    if(session.sideContext.purpose==='library')sections.push({id:'library_side_conversation',title:'Library task conversation',body:'这是具备完整补库权限的论文补库窗口。用户可以直接在此要求补库、上传后继续、补充研究背景、改变方向或篇数；调用paper_expand_library创建任务，或paper_library_job查询、暂停、继续、调整已有任务。单篇明确arXiv收录也可用paper_import。需要背景时在本窗口追问，用户补充后用resume/adjust继续，不要求回主对话。任务只属于这个父对话，不能访问其他对话；用户本轮请求以此窗口真实消息为来源，后台读取本窗口允许的历史和继承快照，不把这些话复制到父对话或研究记忆。查进度和收录理由先查询真实任务，讨论论文时按需读取原文。历史回复里的“只能查状态”“没有补库权限”“回主对话操作”等旧限制已失效，按当前工具权限执行。'});
  }
  const systemPrompt = profile.rawMode ? null : renderSystemPrompt(sections);
  const access = contextAccess(session, controls);
  const history = [...(session.sideContext&&controls.includeHistory?session.sideContext.messages:[]),...controlledHistory(session, controls)];
  access.allMessageIds=history.map(m=>m.id);
  profile.toolTokens = countRequestTokens([], toolDefinitions(profile, project?.id ?? null), tokenModel.encoding) - countRequestTokens([], [], tokenModel.encoding);
  const memory = config.automaticMemory&&!session.sideContext ? memoryView(project?.id ?? null, session.id) : null;
  return { controls, profile, sections, systemPrompt, access, history,
    effectiveSession: { ...session, messages: history,...(session.sideContext&&!session.lastTurnContext?{lastTurnContext:{responseMode:profile.rawMode?null:profile.id,systemPrompt:profile.rawMode?'off':'sections'}}:{}) },
    projectContext: session.sideContext ? (controls.includeProjectMemories?session.sideContext.projectContext:null) : config.automaticMemory
      ? selectMemoryContext({ projectId: project?.id ?? null, sessionId: session.id, question: request.message ?? '', access, encoding: tokenModel.encoding,
        budget: Math.min(6000, Math.floor(profile.inputBudget * 0.12)) })
      : project && (controls.includeProjectCard || controls.includeProjectMemories) ? selectProjectContext(project, request.message ?? '', 3600, access) : null,
    stateKey: contextStateKey({ session: { ...session, memoryVersion: memory ? [memory.project.version, memory.conversation.version] : null }, project: project ? {...publicProject(project),paperRevision:paperRevision(project.id)} : null, model: config.model, profile, systemPrompt, endpoint: config.baseUrl }),
  };
}

export async function assembleManagedContext({ session, project, request, config, dryRun = false, ...callbacks }) {
  const spec = contextSpec({ session, project, request, config });
  const context = await prepareContext({ ...callbacks, session: spec.effectiveSession, currentMessage: request.message ?? '',
    systemPrompt: spec.systemPrompt, projectContext: spec.projectContext, profile: spec.profile, model: config.model,
    reasoningSupported: config.reasoningSupported, dryRun, summaryMode: spec.controls.summaryMode,
    summaryText: spec.controls.summaryText, extraContext: spec.controls.extraContext,
  });
  context.stats.excludedMessages = session.messages.length - spec.history.length;
  context.stats.editedMessages = spec.history.filter((message) => message.contextEdited).length;
  const tools=toolDefinitions(spec.profile,project?.id??null);
  const first=project&&!spec.profile.rawMode&&['paper_search','paper_read'].every(name=>tools.some(t=>t.function.name===name))
    ? proposalRoutingRequest(context.messages,spec.profile) : {messages:context.messages,tools,maxCompletionTokens:spec.profile.maxCompletionTokens};
  return { ...spec, context, plannedRequest: chatRequestBody({ model: config.model,
    reasoningEffort: spec.profile.reasoningEffort, ...first }) };
}

export class ContextPreviews {
  constructor({ ttl = 10 * 60_000, limit = 32 } = {}) { this.ttl = ttl; this.limit = limit; this.items = new Map(); }
  put(value) {
    for (const [id, item] of this.items) if (item.expiresAt <= Date.now()) this.items.delete(id);
    while (this.items.size >= this.limit) this.items.delete(this.items.keys().next().value);
    const id = crypto.randomUUID();
    this.items.set(id, { ...structuredClone(value), expiresAt: Date.now() + this.ttl });
    return id;
  }
  get(id) {
    const item = this.items.get(id);
    if (!item || item.expiresAt <= Date.now()) throw Object.assign(new Error('发送预览已过期，请重新生成。'), { status: 409 });
    return structuredClone(item);
  }
  consume(id) { this.items.delete(id); }
}
