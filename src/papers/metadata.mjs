import { paperIdentity } from './store.mjs';

const decode=text=>String(text).replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,entity=>{
  const known={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};
  if(known[entity.toLowerCase()])return known[entity.toLowerCase()];
  const number=entity.toLowerCase().startsWith('&#x')?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);
  return number>=0&&number<=0x10ffff?String.fromCodePoint(number):entity;
});
export async function verifyPaperMetadata(candidate,{fetcher=fetch,signal}={}){
  signal?.throwIfAborted();const identity=paperIdentity(candidate);
  if(identity.arxivId){
    const url=`https://arxiv.org/abs/${identity.arxivId}${identity.version}`;
    const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)].filter(Boolean)),redirect:'error'});
    if(!response.ok)throw new Error(`原始 arXiv 页面暂不可用（${response.status}）`);
    const html=await response.text();if(html.length>2000000)throw new Error('原始元数据页面过大');
    const meta=new Map();
    for(const tag of html.match(/<meta\b[^>]*>/gi)??[]){
      const attributes=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),decode(m[2]??m[3])]));
      if(attributes.name){const values=meta.get(attributes.name)??[];values.push(attributes.content??'');meta.set(attributes.name,values);}
    }
    const title=meta.get('citation_title')?.[0];if(!title)throw new Error('原始页面没有可核对的论文标题');
    return {...candidate,title:title.slice(0,500),url,authors:meta.get('citation_author')??candidate.authors,published:(meta.get('citation_date')?.[0]??candidate.published)?.replaceAll('/','-'),doi:meta.get('citation_doi')?.[0]??candidate.doi,metadataVerified:true,metadataSource:url};
  }
  if(identity.doi&&/^10\.\d{4,9}\/\S+$/i.test(identity.doi)&&identity.doi.length<=240){
    const url=`https://api.crossref.org/works/${encodeURIComponent(identity.doi)}`;
    const response=await fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)].filter(Boolean))});
    if(!response.ok)throw new Error(`Crossref 元数据暂不可用（${response.status}）`);
    const {message}=await response.json();if(!message?.title?.[0])throw new Error('DOI 记录没有标题');
    return {...candidate,title:String(message.title[0]).slice(0,500),doi:identity.doi,metadataVerified:true,metadataSource:url};
  }
  return {...candidate,metadataVerified:false};
}
