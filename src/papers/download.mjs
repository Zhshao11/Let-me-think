const MAX_PDF_BYTES=35*1024*1024;
const transient=error=>error.name==='TimeoutError'||[408,425,429].includes(error.status)||error.status>=500||/fetch failed|network|timed? ?out|timeout|ECONNRESET|ETIMEDOUT/i.test(error.message+' '+(error.cause?.code??''));

// Only use official arXiv hosts. Each alternate starts a fresh, bounded transfer.
export async function downloadArxivPdf(id,{fetcher=fetch,signal,timeoutMs=180000,headersTimeoutMs=20000}={}){
  const urls=[`https://arxiv.org/pdf/${id}`,`https://export.arxiv.org/pdf/${id}`];
  let last;
  for(const url of urls){
    signal?.throwIfAborted();
    const controller=new AbortController();
    const transferSignal=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(timeoutMs)].filter(Boolean));
    const headersTimer=setTimeout(()=>controller.abort(new DOMException('PDF response timed out','TimeoutError')),headersTimeoutMs);headersTimer.unref();
    let reader;
    try{
      const response=await fetcher(url,{signal:transferSignal,redirect:'error'});clearTimeout(headersTimer);
      if(!response.ok){await response.body?.cancel().catch(()=>{});throw Object.assign(new Error(`HTTP ${response.status}`),{status:response.status});}
      if(Number(response.headers.get('content-length'))>MAX_PDF_BYTES)throw new Error('PDF 大小不能超过 35 MB');
      if(!response.body)throw new Error('论文下载没有返回文件内容');
      reader=response.body.getReader();let size=0;const parts=[];
      for(;;){transferSignal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_PDF_BYTES)throw new Error('PDF 大小不能超过 35 MB');parts.push(value);}
      transferSignal.throwIfAborted();const bytes=Buffer.concat(parts);
      if(bytes.length<8||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('来源返回的内容不是有效 PDF');
      return bytes;
    }catch(error){
      signal?.throwIfAborted();last=transferSignal.aborted?transferSignal.reason:error;
      if(!transient(last))throw last;
    }finally{clearTimeout(headersTimer);controller.abort();if(reader)await reader.cancel().catch(()=>{});}
  }
  const reason=last?.name==='TimeoutError'||/timeout|timed? ?out/i.test(last?.message??'')?'下载 PDF 超时（已尝试 arXiv 两个官方入口）':`下载 PDF 失败（${last?.message??'网络错误'}）`;
  throw new Error(reason+'；可继续重试或上传原文。',{cause:last});
}
