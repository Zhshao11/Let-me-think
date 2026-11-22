import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {config} from '../src/config.mjs';
import {registerPaper,getPaper,listPapers,paperDirectory,searchPapers,paperChunks,pendingPapers,paperDatabase} from '../src/papers/store.mjs';
import {processPaper,validatePaperAnalysis,arxivIdentifier,readPaperEvidence} from '../src/papers/pipeline.mjs';
import {searchArxiv} from '../src/papers/discovery.mjs';
import {executeTool,toolDefinitions} from '../src/agent/tools.mjs';
import {getAgentProfile} from '../src/agent/profiles.mjs';
import {downloadArxivPdf} from '../src/papers/download.mjs';

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'paper-pipeline-'));config.papersDir=temporary;
test.after(()=>{paperDatabase().close();fs.rmSync(temporary,{recursive:true,force:true});});
const project=()=>crypto.randomUUID();
const bytes=Buffer.from('%PDF-1.4\nTHIS_IS_A_UNIT_TEST_FIXTURE_NOT_A_REAL_PDF\n%%EOF');
const chunks=[{id:'p1-b0',page:1,kind:'section_header',text:'Research fixture title',section:'Title'},{id:'p2-b1',page:2,kind:'text',section:'Method',text:'The transformer uses self attention and cross attention for coarse to fine matching.'}];
const fields=sources=>Object.fromEntries(['summary','problem','method','contributions','experiments','limitations'].map(k=>[k,k==='experiments'?[]:[{text:`${k}来自论文，非用户实验`,sourceIds:[sources.at(-1).id]}]]));
const complete=async request=>{const {sources}=JSON.parse(request.messages.at(-1).content);request.onDelta(JSON.stringify(fields(sources)));return {usage:{prompt_tokens:100,completion_tokens:50},finishReason:'stop'};};
const parse=async()=>({title:'Research fixture',pageCount:2,parser:'docling-mock',chunks});

test('paper pipeline persists source PDF, cited analysis and scoped full-text index; duplicate content is reused within its project',async()=>{
  const a=project(),b=project(),first=registerPaper({projectId:a,bytes,name:'../../paper.pdf'});
  assert.equal(first.paper.name,'paper.pdf');
  assert.equal(registerPaper({projectId:a,bytes,name:'again.pdf'}).paper.id,first.paper.id);
  const other=registerPaper({projectId:b,bytes,name:'other.pdf'});assert.notEqual(other.paper.id,first.paper.id);
  assert.ok(fs.readFileSync(path.join(paperDirectory(first.paper.id),'original.pdf')).equals(bytes));
  const ready=await processPaper(a,first.paper.id,{parse,complete});
  assert.equal(ready.status,'ready');assert.equal(ready.pageCount,2);assert.ok(ready.analysis.method.length);
  assert.equal(searchPapers(a,'transformer')[0].sourceId,'p2-b1');
  assert.equal(searchPapers(a,'transformer')[0].origin,'paper_not_user_experiment');
  assert.equal(searchPapers(b,'transformer').length,0);
  assert.throws(()=>getPaper(b,first.paper.id),/当前项目/);
  assert.throws(()=>paperChunks(b,first.paper.id),/当前项目/);
  const evidence=readPaperEvidence(a,first.paper.id,{sourceIds:['p2-b1']});
  assert.equal(evidence.evidence[0].page,2);assert.equal(evidence.noveltyVerified,false);
  assert.equal(evidence.visualSemanticsVerified,false);
  assert.match(fs.readFileSync(path.join(paperDirectory(first.paper.id),'analysis.json'),'utf8'),/sourceIds/);
  assert.equal(listPapers(a).length,1);
});

test('unknown citations fail extraction without losing PDF; failed jobs can be processed again and unfinished state is durable',async()=>{
  const a=project(),{paper}=registerPaper({projectId:a,bytes,name:'failed.pdf'});
  assert.ok(pendingPapers().some(p=>p.id===paper.id));
  const bad=async request=>{const data=fields(chunks);data.method[0].sourceIds=['invented-page'];request.onDelta(JSON.stringify(data));return {};};
  await assert.rejects(processPaper(a,paper.id,{parse,complete:bad}),/来源/);
  assert.equal(getPaper(a,paper.id).status,'failed');assert.ok(fs.existsSync(path.join(paperDirectory(paper.id),'original.pdf')));
  assert.equal(searchPapers(a,'transformer').length,0);
  await processPaper(a,paper.id,{parse,complete});assert.equal(getPaper(a,paper.id).status,'ready');
  assert.throws(()=>validatePaperAnalysis({...fields(chunks),unexpected:[]},chunks),/结构/);
});

test('paper tools stay scoped and URL import cannot request localhost or arbitrary origins',async()=>{
  const a=project(),b=project(),{paper}=registerPaper({projectId:a,bytes,name:'tools.pdf'});await processPaper(a,paper.id,{parse,complete});
  const profile={...getAgentProfile('concise'),allowedTools:['paper_search','paper_read'],maxToolCalls:3};
  const call=(name,args)=>({function:{name,arguments:JSON.stringify(args)}});
  assert.ok(toolDefinitions(profile,a).some(t=>t.function.name==='paper_read'));
  assert.equal(toolDefinitions(profile).length,0);
  assert.throws(()=>executeTool(call('paper_read',{paperId:paper.id}),{profile,history:[],projectId:b}),/当前项目/);
  assert.throws(()=>executeTool(call('paper_search',{query:'transformer',projectId:b}),{profile,history:[],projectId:a}),/参数/);
  assert.equal(arxivIdentifier('https://arxiv.org/abs/2104.00680v1'),'2104.00680v1');
  assert.equal(arxivIdentifier('https://arxiv.org/pdf/2104.00680.pdf'),'2104.00680');
  for(const url of ['http://127.0.0.1/a.pdf','https://arxiv.org.evil.test/pdf/2104.00680','https://user:pass@arxiv.org/pdf/2104.00680','file:///etc/passwd'])assert.throws(()=>arxivIdentifier(url));
  assert.throws(()=>registerPaper({projectId:a,bytes:Buffer.from('not a PDF'),name:'a.pdf'}),/有效/);
});

test('academic search uses permitted alternate sources after rate limiting and never claims abstracts are full-text reading',async()=>{
  const requested=[];
  const response=await searchArxiv('test-method',{recent:true,fetcher:async url=>{
    requested.push(String(url));
    if(!String(url).includes('api.openalex.org'))return new Response('rate limited',{status:429});
    return Response.json({results:[{title:'Test paper',publication_date:'2026-11-01',doi:'https://doi.org/10.test/fixture',authorships:[],locations:[],abstract_inverted_index:{Hello:[0],paper:[1]}}]});
  }});
  assert.equal(response.source,'OpenAlex');assert.equal(response.unavailable.length,2);
  assert.equal(response.papers[0].fullTextRead,false);assert.equal(response.papers[0].abstract,'Hello paper');
  assert.match(requested[0],/sortBy=submittedDate/);assert.match(requested[1],/publicationDate/);assert.match(requested[2],/publication_date/);
  assert.ok(requested.every(url=>!/sourcemux/i.test(url)));
});

test('looking up a named method defaults to relevance so an older original paper is not displaced by newer mentions',async()=>{
  let requested;
  const result=await searchArxiv('LoFTR',{fetcher:async url=>{requested=String(url);return new Response('<feed><entry><id>http://arxiv.org/abs/2104.00680v1</id><title>LoFTR: Detector-Free Local Feature Matching with Transformers</title><published>2021-04-01</published><author><name>Test author</name></author><summary>Original method.</summary></entry></feed>');}});
  assert.match(requested,/sortBy=relevance/);assert.equal(result.order,'relevance');assert.equal(result.papers[0].authors[0],'Test author');assert.equal(result.papers[0].url,'https://arxiv.org/abs/2104.00680v1');
  assert.equal(result.papers[0].fullTextRead,false);
});

test('PDF downloads recover from timeouts and interrupted bodies using the second official arXiv endpoint',async()=>{
  const requested=[];
  const recovered=await downloadArxivPdf('2006.12797v3',{fetcher:async(url,options)=>{
    requested.push(url);assert.equal(options.redirect,'error');
    if(requested.length===1)throw new DOMException('transfer timeout','TimeoutError');
    return new Response(bytes);
  }});
  assert.deepEqual(recovered,bytes);assert.deepEqual(requested,['https://arxiv.org/pdf/2006.12797v3','https://export.arxiv.org/pdf/2006.12797v3']);
  let calls=0;
  const recoveredBody=await downloadArxivPdf('2006.06325v2',{fetcher:async()=>{
    if(++calls===1)return new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('%PDF-'));c.error(new DOMException('body timeout','TimeoutError'));}}));
    return new Response(bytes);
  }});
  assert.deepEqual(recoveredBody,bytes);assert.equal(calls,2);
});

test('PDF cancellation, permanent failures and oversized responses do not start another transfer',async()=>{
  for(const scenario of ['cancel','missing','oversize','html']){
    const controller=new AbortController();let calls=0;
    await assert.rejects(downloadArxivPdf('2006.06325v2',{signal:controller.signal,fetcher:async()=>{
      calls++;if(scenario==='cancel'){controller.abort();throw controller.signal.reason;}
      if(scenario==='missing')return new Response('missing',{status:404});
      if(scenario==='oversize')return new Response(bytes,{headers:{'content-length':String(36*1024*1024)}});
      return new Response('<html>Not a PDF</html>');
    }}));
    assert.equal(calls,1,scenario);
  }
  await assert.rejects(downloadArxivPdf('2006.06325v2',{fetcher:async()=>{throw new DOMException('timeout','TimeoutError');}}),/下载 PDF 超时/);
});

test('a transfer deadline that aborts a response body still falls back, while an explicit user abort does not',async()=>{
  let calls=0;const keepAlive=setTimeout(()=>{},500);
  try{
    const result=await downloadArxivPdf('2006.06325v2',{timeoutMs:10,fetcher:async(_url,{signal})=>{
      if(++calls>1)return new Response(bytes);
      return new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('%PDF-'));signal.addEventListener('abort',()=>c.error(new DOMException('The operation was aborted','AbortError')),{once:true});}}));
    }});
    assert.deepEqual(result,bytes);assert.equal(calls,2);
  }finally{clearTimeout(keepAlive);}
});
