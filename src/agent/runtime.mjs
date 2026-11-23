import { streamChat } from '../upstream.mjs';
import { estimateTokens } from './context.mjs';
import { executeTool, toolDefinitions, limitBytes } from './tools.mjs';
import { runProposalWorkflow, proposalGuidance } from './proposal-workflow.mjs';
import { startProposalLibraryExpansion } from '../papers/library-jobs.mjs';

// Follow the observed workflow state, rather than turning every tool action
// into a new research diagnosis because of the selected response mode.
function libraryTaskState(name,outcome){
  if(!['paper_expand_library','paper_library_job'].includes(name)||outcome?.error)return null;
  const job=outcome?.job??outcome;
  const kinds={queued:'handoff',running:'handoff',needs_input:'clarification',completed:'results',partial:'results',paused:'paused',failed:'failed'};
  if(!job?.id||!Object.hasOwn(kinds,job.status))return null;
  return {kind:kinds[job.status],status:job.status,jobId:job.id};
}
const TASK_GUIDANCE={
  handoff:'后台已接手论文任务。简短回应任务已经启动或仍在执行，采用的范围可简述一次，进度和结果显示在侧边“论文补库”窗口；不要为了等待结果连续查状态。排队时没有论文是正常流程，不把这个中间状态当成研究结论来诊断或批评。关联理由等处理完成后由实际论文支持。',
  clarification:'任务需要用户补充研究信息。依据工具返回只追问缺少的关键内容，不自行编造主题，不展开实验诊断。',
  results:'任务已有处理结果。按真实新增、复用、缺全文和失败情况回应；要解释论文关联时依据返回的原文证据，必要时读取论文，不对草稿本身写评审。',
  paused:'任务已暂停。简短确认当前状态和已完成结果是否保留；不要擅自恢复或新增任务。',
  failed:'任务未能完成。说明工具返回的具体问题及可行下一步，不编造论文或将工具故障当作科研证据。',
};

export async function runAgent({ messages, profile, history, projectId = null, sessionId=null,sourceId=null,contextAccess = null, model, signal, onDelta, onProgress, onEvent, onRequest, complete = streamChat, dispatchProposal = startProposalLibraryExpansion }) {
  let working = messages.map((message) => ({ ...message }));
  let modelCalls = 0;
  let toolCalls = 0;
  let ordinaryToolCalls = 0;
  let taskState = null;
  let proposalWorkflow = null;
  let libraryRequest = null;
  const usages = [];
  const call = async ({ tools = [], visible = false, extraMessages = [], stage = visible ? 'final' : 'draft_or_tool', toolChoice, maxCompletionTokens = profile.maxCompletionTokens }) => {
    signal?.throwIfAborted();
    const callMessages = [...working, ...extraMessages];
    if (estimateTokens(callMessages, tools, profile.tokenModel?.encoding) > profile.inputBudget) throw new Error('本轮执行已达到上下文预算，停止额外调用。');
    let answer = '';
    modelCalls++;
    onEvent?.({ event: 'model_call', index: modelCalls, stage, reasoningEffort: profile.reasoningEffort });
    const result = await complete({
      messages: callMessages, tools, toolChoice, model, signal,
      reasoningEffort: profile.reasoningEffort, maxCompletionTokens: Math.min(maxCompletionTokens, profile.maxCompletionTokens),
      onRequest: (payload) => onRequest?.({ stage, payload }),
      onDelta: (text) => { answer += text; if (visible) onDelta(text); },
      onProgress: visible ? onProgress : () => {},
    });
    if (result?.finishReason === 'length') throw new Error('模型达到本模式输出预算，回答未完成；可缩小问题或切换模式。');
    if (result?.usage) usages.push({ call: modelCalls, stage, ...result.usage });
    return { answer, calls: result?.toolCalls ?? [] };
  };
  const tools = toolDefinitions(profile, projectId);
  if (projectId && !profile.rawMode && ['paper_search', 'paper_read'].every(name => tools.some(t => t.function.name === name))) {
    proposalWorkflow = await runProposalWorkflow({ ask: call, onProgress, onEvent,
      invoke: async (name, args) => {
        signal?.throwIfAborted();
        const request = { id: `proposal_evidence_${toolCalls + 1}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
        let outcome;
        try { outcome = await executeTool(request, { profile, history, projectId, contextAccess, sessionId, sourceId }); }
        catch (error) { outcome = { error: error.message.slice(0, 500) }; }
        // Keep method evidence and references, with a bounded workflow context.
        if (outcome.matches) outcome = { ...outcome, matches: outcome.matches.slice(0, 4).map(m => ({ ...m, text: m.text.slice(0, 1200) })) };
        if (outcome.evidence) {
          let remaining = 5000;
          outcome = { ...outcome, evidence: outcome.evidence.map(e => { const text = e.text.slice(0, remaining); remaining -= text.length; return { ...e, text }; }).filter(e => e.text) };
        }
        toolCalls++;
        working.push({ role: 'assistant', content: null, tool_calls: [request] }, { role: 'tool', tool_call_id: request.id, content: JSON.stringify(outcome) });
        onEvent?.({ event: 'tool_call', tool: name, index: toolCalls, ok: !outcome.error, workflow: 'proposal' });
        return outcome;
      },
      dispatch: details => {
        signal?.throwIfAborted();
        if (!tools.some(t => t.function.name === 'paper_expand_library')) return { skipped: '本窗口只读，不自动补库' };
        return dispatchProposal({ projectId, sessionId, sourceId, responseMode: profile.id, details });
      },
    });
    if (proposalWorkflow.route === 'proposal') working.push({ role: 'system', content: proposalGuidance(proposalWorkflow) });
  }
  const responseTools = proposalWorkflow?.route === 'proposal'
    ? tools.filter(t => !['paper_expand_library', 'paper_import', 'paper_search_online', 'paper_library_job'].includes(t.function.name)) : tools;
  let draft = '';
  // Tool-enabled passes buffer text until it is known to be an answer rather
  // than a tool preamble. Final review has no tools and streams normally.
  for (;;) {
    const visible = profile.reviewPasses === 0 && responseTools.length === 0;
    const result = await call({ tools: ordinaryToolCalls < profile.maxToolCalls ? responseTools : [], visible });
    if (!result.calls.length) {
      draft = result.answer;
      if (!draft.trim()) throw new Error('模型未返回回答正文。');
      if (!profile.reviewPasses) {
        if (!visible) onDelta(draft);
        return { modelCalls, toolCalls, reviewPasses: 0, taskState, proposalWorkflow, libraryRequest, usage: usages.at(-1) ?? null, callsUsage: usages };
      }
      break;
    }
    if (!responseTools.length || result.calls.some(c => !responseTools.some(t => t.function.name === c.function.name)) || result.calls.length > profile.maxToolCalls - ordinaryToolCalls) throw new Error('模型请求超出当前模式工具权限或调用次数，未执行越权工具。');
    working.push({ role: 'assistant', content: result.answer || null, tool_calls: result.calls });
    for (const request of result.calls) {
      let outcome;
      try { outcome = await executeTool(request, { profile, history, projectId, contextAccess,sessionId,sourceId }); }
      catch(error) { outcome = { error: error.message.slice(0,500) }; }
      toolCalls++;
      ordinaryToolCalls++;
      if(!outcome.error&&request.function.name==='paper_expand_library'){
        const job=outcome.job??outcome;
        libraryRequest={objective:job.topic??'',request:job.request??'',requirements:job.directions??[],background:outcome};
      }
      if(!outcome.error&&request.function.name==='paper_import')libraryRequest={needed:!outcome.fullTextRead,reason:outcome.fullTextRead?'指定论文已在库中，无需重复补充。':'本轮明确要求收录指定论文。',objective:`收录参考论文：${outcome.title??''}`,request:'用户明确要求收录指定论文。',requirements:[{direction:outcome.title??'指定论文',query:'',reason:'用户本轮要求收录。'}],background:{submission:outcome.fullTextRead?'existing':'submitted',detail:outcome.fullTextRead?'指定论文已在库中。':'单篇论文处理已启动，可在论文资料中查看状态。'}};
      onProgress?.(request.function.name.startsWith('paper_')?'正在查阅论文资料…':'正在核对本会话历史原文…');
      onEvent?.({ event: 'tool_call', tool: request.function.name, index: toolCalls, ok: !outcome.error });
      working.push({ role: 'tool', tool_call_id: request.id, content: JSON.stringify(outcome) });
      const state=libraryTaskState(request.function.name,outcome);
      if(state){taskState=state;onEvent?.({event:'task_state',...state});}
    }
    if(taskState)working.push({role:'system',content:`执行决策：以本轮真实用户请求和刚才工具返回的状态为准。${TASK_GUIDANCE[taskState.kind]} 用户在同一轮明确提出的其他实质问题仍须回应。模式只影响分析深度，不强制研究诊断格式。`});
  }
  for (let pass = 0; pass < profile.reviewPasses; pass++) {
    onProgress?.('正在检查回复是否准确回应本轮请求…');
    // Keep the actual user request in its original role. A new synthetic user
    // asking to critique a draft can accidentally replace the user's task.
    const userIndex=working.findLastIndex(message=>message.role==='user');
    working.splice(userIndex<0?working.length:userIndex,0,
      { role: 'system', content: `进行一次内部答复检查，只输出给用户的最终答复。回答对话中最后一条真实用户请求，不要把先前的研究背景当成本轮任务，也不要把草稿当作待用户评审的研究主张或新增证据。检查是否准确完成本轮要求、是否符合工具结果，修正错误并去掉重复内容；正确简短的答复保持简短。只有本轮在问研究判断或实验诊断时才检查相应证据、指标和实验控制；不为形式完整新增评审、反例或实验方案。${taskState?TASK_GUIDANCE[taskState.kind]:''} 不提草稿、候选答案、复核过程或内部检查，不使用固定章节模板。` },
      { role: 'assistant', content: `内部草稿，仅供检查，不是新增证据或用户请求：\n${limitBytes(draft, 4500)}` },
    );
    const result = await call({ visible: pass === profile.reviewPasses - 1 });
    if (result.calls.length) throw new Error('复核阶段不允许工具调用。');
    if (!result.answer.trim()) throw new Error('复核未返回正文。');
    draft = result.answer;
  }
  return { modelCalls, toolCalls, reviewPasses: profile.reviewPasses, taskState, proposalWorkflow, libraryRequest, usage: usages.at(-1) ?? null, callsUsage: usages };
}
