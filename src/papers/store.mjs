import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let connection,location;
const fail=(text,status=400)=>{throw Object.assign(new Error(text),{status});};
export function paperDirectory(id){if(!UUID.test(id??''))fail('论文 ID 无效');return path.join(config.papersDir,'documents',id);}
export function paperDatabase(){
  const file=path.join(config.papersDir,'library.sqlite');
  if(connection&&location===file)return connection;
  connection?.close();fs.mkdirSync(config.papersDir,{recursive:true});
  location=file;connection=new DatabaseSync(file);
  connection.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, hash TEXT NOT NULL, name TEXT NOT NULL,
      title TEXT NOT NULL, source_url TEXT, status TEXT NOT NULL, step TEXT NOT NULL,
      error TEXT, page_count INTEGER DEFAULT 0, parser TEXT, model TEXT, analysis TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER DEFAULT 1,
      UNIQUE(project_id,hash)
    );
    CREATE TABLE IF NOT EXISTS chunks (
      rowid INTEGER PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL, source_id TEXT NOT NULL, page INTEGER NOT NULL,
      text TEXT NOT NULL, kind TEXT NOT NULL, section TEXT NOT NULL, asset TEXT,
      UNIQUE(paper_id,source_id)
    );
    CREATE TABLE IF NOT EXISTS paper_identities (
      project_id TEXT NOT NULL, identity TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      PRIMARY KEY(project_id,identity,version)
    );
    CREATE INDEX IF NOT EXISTS papers_scope ON papers(project_id,status);
    CREATE INDEX IF NOT EXISTS chunks_scope ON chunks(project_id,paper_id,page);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text,section,content='chunks',content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,text,section) VALUES(new.rowid,new.text,new.section); END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,text,section) VALUES('delete',old.rowid,old.text,old.section); END;
  `);return connection;
}
function available(){return fs.existsSync(path.join(config.papersDir,'library.sqlite'));}
function publicPaper(row){if(!row)return null;const {project_id,source_url,page_count,created_at,updated_at,...rest}=row;return {...rest,projectId:project_id,sourceUrl:source_url,pageCount:page_count,createdAt:created_at,updatedAt:updated_at,analysis:row.analysis?JSON.parse(row.analysis):null};}
export function listPapers(projectId){if(!projectId||!available())return [];return paperDatabase().prepare('SELECT * FROM papers WHERE project_id=? ORDER BY created_at DESC').all(projectId).map(publicPaper);}
export function paperRevision(projectId){return listPapers(projectId).map(p=>`${p.id}:${p.revision}`).join('|');}
export function getPaper(projectId,id){
  if(!UUID.test(id??''))fail('找不到这篇论文',404);
  const row=available()?paperDatabase().prepare('SELECT * FROM papers WHERE id=? AND project_id=?').get(id,projectId??''):null;
  if(!row)fail('当前项目找不到这篇论文',404);return publicPaper(row);
}
export function registerPaper({projectId,bytes,name,sourceUrl=null}){
  if(!UUID.test(projectId??''))fail('请先选择一个研究项目');
  if(bytes.length<8||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))fail('文件不是有效的 PDF');
  if(bytes.length>35*1024*1024)fail('PDF 大小不能超过 35 MB',413);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex'),db=paperDatabase();
  const old=db.prepare('SELECT * FROM papers WHERE project_id=? AND hash=?').get(projectId,hash);
  if(old)return {paper:publicPaper(old),duplicate:true};
  const id=crypto.randomUUID(),now=new Date().toISOString();
  const safeName=path.basename(String(name||'paper.pdf')).replace(/[\x00-\x1f]/g,'').slice(0,200)||'paper.pdf';
  const dir=paperDirectory(id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'original.pdf'),bytes,{mode:0o600});
  db.prepare('INSERT INTO papers(id,project_id,hash,name,title,source_url,status,step,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,projectId,hash,safeName,safeName,sourceUrl,'queued','等待处理',now,now);
  return {paper:getPaper(projectId,id),duplicate:false};
}
export function updatePaper(projectId,id,patch){
  getPaper(projectId,id);const fields={title:'title',status:'status',step:'step',error:'error',pageCount:'page_count',parser:'parser',model:'model',analysis:'analysis'};
  const pairs=Object.entries(patch).map(([key,value])=>{if(!fields[key])fail('无效的论文字段');return [fields[key],key==='analysis'?JSON.stringify(value):value];});
  paperDatabase().prepare(`UPDATE papers SET ${pairs.map(([key])=>`${key}=?`).join(',')},updated_at=?,revision=revision+1 WHERE id=? AND project_id=?`).run(...pairs.map(([,value])=>value),new Date().toISOString(),id,projectId);
  return getPaper(projectId,id);
}
export function saveChunks(projectId,id,chunks){
  getPaper(projectId,id);const db=paperDatabase();db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('DELETE FROM chunks WHERE paper_id=? AND project_id=?').run(id,projectId);
    const insert=db.prepare('INSERT INTO chunks(paper_id,project_id,source_id,page,text,kind,section,asset) VALUES(?,?,?,?,?,?,?,?)');
    for(const c of chunks){
      if(typeof c.id!=='string'||!/^p\d+-b\d+(?:-\d+)?$/.test(c.id)||!Number.isInteger(c.page)||c.page<1||typeof c.text!=='string'||c.text.length>20000)fail('解析来源结构无效');
      insert.run(id,projectId,c.id,c.page,c.text,c.kind??'text',c.section??'',c.asset??null);
    }db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function paperChunks(projectId,id,{page,sourceIds,limit=20}={}){
  getPaper(projectId,id);let sql='SELECT source_id AS id,page,text,kind,section,asset FROM chunks WHERE project_id=? AND paper_id=?';const args=[projectId,id];
  if(page!==undefined){if(!Number.isInteger(page)||page<1)fail('页码无效');sql+=' AND page=?';args.push(page);}
  if(sourceIds){if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.length>20||sourceIds.some(s=>typeof s!=='string'))fail('来源 ID 无效');sql+=` AND source_id IN (${sourceIds.map(()=>'?').join(',')})`;args.push(...sourceIds);}
  return paperDatabase().prepare(sql+' ORDER BY rowid LIMIT ?').all(...args,Math.min(10000,limit));
}
export function searchPapers(projectId,query='',{limit=6,paperId=null}={}){
  if(!projectId||!available())return [];
  const tokens=[...new Set(String(query).match(/[a-zA-Z0-9_-]{2,}|[\p{Script=Han}]{1,2}/gu)??[])].slice(0,20);
  const db=paperDatabase(),params=[projectId];let condition='';
  if(paperId){getPaper(projectId,paperId);condition+=' AND c.paper_id=?';params.push(paperId);}
  let rows=[];
  if(tokens.length){
    rows=db.prepare(`SELECT c.source_id AS sourceId,c.page,c.text,c.section,c.kind,c.paper_id AS paperId,p.title
      FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid JOIN papers p ON p.id=c.paper_id
      WHERE c.project_id=? AND p.status='ready' ${condition} AND chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`).all(...params,tokens.map(t=>`"${t.replaceAll('"','""')}"`).join(' OR '),limit);
  }
  if(!rows.length){
    const papers=listPapers(projectId).filter(p=>p.status==='ready'&&(!paperId||p.id===paperId)).sort((a,b)=>tokens.filter(t=>(b.title+JSON.stringify(b.analysis)).toLowerCase().includes(t.toLowerCase())).length-tokens.filter(t=>(a.title+JSON.stringify(a.analysis)).toLowerCase().includes(t.toLowerCase())).length).slice(0,3);
    for(const p of papers){for(const item of [...(p.analysis?.summary??[]),...(p.analysis?.method??[])].slice(0,2)){
      const source=paperChunks(projectId,p.id,{sourceIds:item.sourceIds,limit:1})[0];
      if(source)rows.push({sourceId:source.id,page:source.page,text:source.text,section:source.section,kind:source.kind,paperId:p.id,title:p.title});
    }}
  }
  return rows.slice(0,limit).map(r=>({...r,text:r.text.slice(0,2500),citation:`《${r.title}》第${r.page}页 [${r.sourceId}]`,origin:'paper_not_user_experiment'}));
}
export function pendingPapers(){if(!available())return [];return paperDatabase().prepare("SELECT * FROM papers WHERE status IN ('queued','parsing','extracting') ORDER BY created_at").all().map(publicPaper);}

export function paperIdentity(candidate){
  const url=String(candidate.url??candidate.sourceUrl??'');
  const arxiv=url.match(/https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?(?:[?#]|$)/i);
  const doi=String(candidate.doi??'').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').trim().toLowerCase();
  return {arxivId:arxiv?.[1]??null,version:arxiv?.[2]??'',doi:doi||null,key:arxiv?`arxiv:${arxiv[1]}`:doi?`doi:${doi}`:`title:${normalizePaperTitle(candidate.title??'')}`};
}
export function normalizePaperTitle(title){return String(title).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function identifyPaper(projectId,candidate){
  if(!available())return null;
  const identity=paperIdentity(candidate),db=paperDatabase();
  if(!identity.key.endsWith(':')){
    const alias=db.prepare('SELECT paper_id FROM paper_identities WHERE project_id=? AND identity=? AND version=?').get(projectId,identity.key,identity.version);
    if(alias)return getPaper(projectId,alias.paper_id);
  }
  const title=normalizePaperTitle(candidate.title??'');
  return listPapers(projectId).find(p=>{
    const old=paperIdentity({url:p.sourceUrl});
    if(identity.arxivId&&old.arxivId===identity.arxivId&&(!identity.version||old.version===identity.version))return true;
    return !identity.version&&title.length>12&&normalizePaperTitle(p.title)===title;
  })??null;
}
export function associatePaperIdentity(projectId,paperId,candidate){
  getPaper(projectId,paperId);const identity=paperIdentity(candidate);
  for(const key of [identity.arxivId?`arxiv:${identity.arxivId}`:null,identity.doi?`doi:${identity.doi}`:null].filter(Boolean)){
    paperDatabase().prepare('INSERT OR IGNORE INTO paper_identities(project_id,identity,version,paper_id) VALUES(?,?,?,?)').run(projectId,key,identity.version,paperId);
  }
}
