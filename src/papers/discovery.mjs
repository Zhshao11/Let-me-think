import { XMLParser } from 'fast-xml-parser';

async function arxiv(query,{fetcher=fetch,recent=false,signal}={}){
  if(typeof query!=='string'||!query.trim()||query.length>200)throw new Error('论文搜索词须为 1–200 字符');
  const url=new URL('https://export.arxiv.org/api/query');
  url.search=new URLSearchParams({search_query:`all:${query.trim()}`,start:'0',max_results:'5',sortBy:recent?'submittedDate':'relevance',sortOrder:'descending'});
  const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)].filter(Boolean))});
  if(!response.ok)throw new Error(`arXiv 搜索暂不可用（${response.status}）；可上传 PDF 或提供 arXiv 链接。`);
  const xml=await response.text();if(xml.length>2000000)throw new Error('搜索结果过大');
  const parsed=new XMLParser({ignoreAttributes:false,processEntities:false,isArray:(_name,jpath)=>['feed.entry','feed.entry.author'].includes(jpath)}).parse(xml);
  const results=(parsed.feed?.entry??[]).map(e=>({title:String(e.title??'').replace(/\s+/g,' ').trim(),authors:(e.author??[]).map(a=>a.name),published:e.published,updated:e.updated,abstract:String(e.summary??'').replace(/\s+/g,' ').trim(),url:String(e.id??'').replace(/^http:/,'https:'),fullTextRead:false}));
  return {source:'arXiv',order:recent?'submittedDate descending':'relevance',papers:results};
}

const cache=new Map();
export async function searchArxiv(query,{fetcher=fetch,recent=false,signal}={}){
  signal?.throwIfAborted();
  if(typeof query!=='string'||!query.trim()||query.length>200)throw new Error('论文搜索词须为 1–200 字符');
  const key=`${recent}:${query}`;const cached=fetcher===fetch?cache.get(key):null;if(cached&&cached.until>Date.now())return cached.value;
  const unavailable=[];let value;
  try{value=await arxiv(query,{fetcher,recent,signal});}
  catch(e){
    signal?.throwIfAborted();
    unavailable.push({source:'arXiv',reason:e.message});
    try{
      const url=new URL(`https://api.semanticscholar.org/graph/v1/paper/search${recent?'/bulk':''}`);url.search=new URLSearchParams({query,fields:'title,authors,publicationDate,abstract,url,externalIds',...(recent?{sort:'publicationDate:desc'}:{limit:'5'})});
      const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)].filter(Boolean))});if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json();value={source:'Semantic Scholar',order:recent?'publicationDate descending':'relevance',papers:(data.data??[]).slice(0,5).map(p=>({title:p.title,authors:p.authors?.map(a=>a.name),published:p.publicationDate,abstract:p.abstract,url:p.externalIds?.ArXiv?`https://arxiv.org/abs/${p.externalIds.ArXiv}`:p.url,doi:p.externalIds?.DOI,fullTextRead:false,metadataNeedsOriginalVerification:true}))};
    }catch(error){
      signal?.throwIfAborted();
      unavailable.push({source:'Semantic Scholar',reason:error.message});
      const url=new URL('https://api.openalex.org/works');url.search=new URLSearchParams({search:query,sort:recent?'publication_date:desc':'relevance_score:desc','per-page':'5'});
      const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)].filter(Boolean))});if(!response.ok)throw new Error('学术来源暂不可用，可上传 PDF 或提供 arXiv 链接。');
      const data=await response.json();value={source:'OpenAlex',order:recent?'publication_date descending':'relevance',papers:(data.results??[]).map(p=>{
        const locations=p.locations??[],arxivUrl=locations.flatMap(l=>[l.landing_page_url,l.pdf_url]).find(u=>/^https?:\/\/(?:www\.)?arxiv\.org\/(abs|pdf)\//.test(u??''));
        const words=[];for(const [word,positions] of Object.entries(p.abstract_inverted_index??{}))for(const position of positions)words[position]=word;
        return {title:p.title,authors:p.authorships?.map(a=>a.author?.display_name),published:p.publication_date,abstract:words.join(' '),url:arxivUrl?.replace(/^http:/,'https:')??p.doi??p.id,doi:p.doi,fullTextRead:false,metadataNeedsOriginalVerification:true};
      })};
    }
  }
  value.unavailable=unavailable;
  if(fetcher===fetch){if(cache.size>100)cache.clear();cache.set(key,{value,until:Date.now()+10*60000});}return value;
}
