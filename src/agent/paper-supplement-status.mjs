// User-facing per-reply decision; never infer it from generated prose.
const text=(value,limit=1600)=>typeof value==='string'?value.slice(0,limit):'';
function background(value){
  const job=value?.job??null;
  if(job?.id)return {submission:'submitted',jobId:job.id,initialStatus:job.status??null,detail:'已提交后台任务，实时进展请查看右侧“论文补库”。'};
  if(value?.error)return {submission:'failed',detail:text(value.error,500)};
  if(value?.submission&&value?.detail)return {submission:value.submission,detail:text(value.detail,500)};
  return {submission:'not_submitted',detail:text(value?.skipped,500)||'本轮没有提交后台补库任务。'};
}
export function paperSupplementStatus({proposalWorkflow=null,libraryRequest=null}={}){
  if(libraryRequest){
    return {version:1,needed:libraryRequest.needed!==false,source:'user_request',reason:text(libraryRequest.reason,800)||'本轮明确要求补充或收录参考论文。',objective:text(libraryRequest.objective,600),
      requirements:(Array.isArray(libraryRequest.requirements)?libraryRequest.requirements:[]).slice(0,3).map(g=>({direction:text(g.direction,600),query:text(g.query,400),reason:text(g.reason,800)})),
      request:text(libraryRequest.request,4000),background:background(libraryRequest.background)};
  }
  if(proposalWorkflow?.route==='proposal'){
    const gaps=Array.isArray(proposalWorkflow.gaps)?proposalWorkflow.gaps:[];
    return {version:1,needed:gaps.length>0,source:'proposal_workflow',
      reason:gaps.length?'本轮提出了值得进一步查证的具体知识缺口。':'本轮参考检查没有提出需要补充的具体知识缺口。',
      objective:text(proposalWorkflow.objective,600),
      requirements:gaps.slice(0,3).map(g=>({direction:text(g.direction,400),query:text(g.query,200),reason:text(g.reason,600)})),
      localSearches:proposalWorkflow.searches??0,papersRead:proposalWorkflow.papersRead??0,
      background:gaps.length?background(proposalWorkflow.background):null};
  }
  if(proposalWorkflow?.route==='direct')return {version:1,needed:false,source:'not_applicable',reason:'本轮没有进入具体方案的论文参考流程，也没有提出补库要求。',requirements:[],background:null};
  return {version:1,needed:null,source:'unavailable',reason:'本轮没有可用的补库判断记录；可能未启用论文工具，或这是尚未记录该信息的历史回复。',requirements:[],background:null};
}
