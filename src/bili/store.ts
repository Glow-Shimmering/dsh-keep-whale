import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BiliAttempt, BiliBlock, BiliRecommendation, BiliRecord, BiliSettings, BiliStats, BiliSubtitle, BiliVideo } from './types.js';

const DEFAULTS: BiliSettings = {enabled:false,paused:false,pausedUntil:null,shareEnabled:true,allowLike:true,allowFavorite:true,maxVideoMinutes:0};
const BV = /^BV[A-Za-z0-9]{10}$/;
const MID = /^[1-9][0-9]{0,19}$/;
const IDENT = /^[A-Za-z0-9:._-]{1,180}$/;
const day = (ms:number) => new Date(ms+8*3600000).toISOString().slice(0,10);
const clone = <T>(v:T):T => JSON.parse(JSON.stringify(v));
const parse = <T>(v:unknown):T => JSON.parse(String(v)) as T;
const text = (v:unknown,n:number,allowEmpty=false):string => {
  if(typeof v!=='string'||v.length>n||(!allowEmpty&&!v.trim()))throw new Error('B站数据内容无效');
  return v.trim();
};
const id = (v:unknown):string => {if(typeof v!=='string'||!IDENT.test(v))throw new Error('操作标识无效');return v;};
const finite = (v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number => {
  if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('B站数据数值无效');return v;
};
const flag = (v:unknown):boolean => {if(typeof v!=='boolean')throw new Error('B站设置必须是开关');return v;};
const bvid = (v:unknown):string => {if(typeof v!=='string'||!BV.test(v))throw new Error('视频编号无效');return v;};
const mid = (v:unknown):string => {if(typeof v!=='string'||!MID.test(v))throw new Error('账号编号无效');return v;};
const list = (v:unknown,maxItems:number,itemMax:number):string[] => {
  if(!Array.isArray(v)||v.length>maxItems)throw new Error('B站数据列表无效');
  return v.map(x=>text(x,itemMax));
};
const inputLink = (v:unknown):string => {
  const value=text(v,2048);
  if(BV.test(value))return value;
  let u:URL;try{u=new URL(value);}catch{throw new Error('请输入有效的 B 站视频链接或 BV 号');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!['www.bilibili.com','bilibili.com','m.bilibili.com','b23.tv'].includes(u.hostname.toLowerCase()))throw new Error('请输入有效的 B 站视频链接或 BV 号');
  const pages=u.searchParams.getAll('p');
  if(pages.length>1||pages.length===1&&pages[0]!=='1')throw new Error('暂不支持分 P 视频');
  return `${u.origin}${u.pathname}`; // never persist tracking parameters, tokens, or fragments
};
function validVideo(v:BiliVideo):BiliVideo {
  if(!v||typeof v!=='object')throw new Error('视频信息无效');
  const bv=bvid(v.bvid),aid=finite(v.aid,1),cid=finite(v.cid,1),duration=finite(v.duration,1,7*86400);
  if(!Number.isSafeInteger(aid)||!Number.isSafeInteger(cid))throw new Error('视频信息无效');
  return {bvid:bv,aid,cid,title:text(v.title,500),owner:text(v.owner,200),ownerId:mid(v.ownerId),duration,url:`https://www.bilibili.com/video/${bv}`,...(v.description?{description:text(v.description,4000)}:{})};
}
function validRecord(v:BiliRecord):BiliRecord {
  const video=validVideo(v.video);
  if(v.origin!=='autonomous'&&v.origin!=='recommended')throw new Error('浏览来源无效');
  if(!['pending','sent','skipped','expired'].includes(v.shareStatus))throw new Error('分享状态无效');
  if(!Array.isArray(v.excerpts)||v.excerpts.length>80||!Array.isArray(v.frameTimes)||v.frameTimes.length>100)throw new Error('理解范围无效');
  const excerpts:BiliSubtitle[]=v.excerpts.map(e=>{if(!e||typeof e!=='object')throw new Error('理解范围无效');const from=finite(e.from,0,video.duration+1),to=finite(e.to,from,video.duration+5);return {from,to,text:text(e.text,1000)};});
  const frameTimes=v.frameTimes.map(x=>finite(x,0,video.duration+1));
  if(!excerpts.length||!frameTimes.length)throw new Error('没有可核验的字幕或画面，不能保存为看过');
  const now=finite(v.createdAt);if(!Number.isSafeInteger(now))throw new Error('时间无效');
  return {id:id(v.id),video,origin:v.origin,...(v.recommendedAt===undefined?{}:{recommendedAt:finite(v.recommendedAt)}),createdAt:now,
    summary:text(v.summary,5000),opinion:text(v.opinion,5000),topics:list(v.topics,12,100),coverage:text(v.coverage,3000),limitations:list(v.limitations,20,1000),excerpts,frameTimes,
    liked:flag(v.liked),favorited:flag(v.favorited),actionReason:text(v.actionReason,2000,true),...(v.actionError?{actionError:text(v.actionError,1000)}:{}),
    shareText:text(v.shareText,2000,true),shareStatus:v.shareStatus,...(v.sharedAt===undefined?{}:{sharedAt:finite(v.sharedAt)}),
    ...(v.discussedAt===undefined?{}:{discussedAt:finite(v.discussedAt)}),version:finite(v.version,1)};
}
function validAttempt(v:BiliAttempt):BiliAttempt {
  if(!v||!['autonomous','recommended'].includes(v.origin)||!['running','succeeded','failed','interrupted','skipped'].includes(v.status))throw new Error('任务状态无效');
  return {id:id(v.id),...(v.bvid?{bvid:bvid(v.bvid)}:{}),...(v.title?{title:text(v.title,500)}:{}),origin:v.origin,status:v.status,stage:text(v.stage,300),reason:text(v.reason,1000,true),createdAt:finite(v.createdAt),updatedAt:finite(v.updatedAt),...(v.recordId?{recordId:id(v.recordId)}:{})};
}

/** Private, same database as companion data, so standard SQLite backup captures Bilibili state too. */
export class BiliStore {
  private readonly db: DatabaseSync;
  private closed=false;
  constructor(root:string,private readonly now:()=>number=Date.now) {
    mkdirSync(root,{recursive:true,mode:0o700});const path=join(root,'keep-whale.sqlite');
    this.db=new DatabaseSync(path);try{chmodSync(path,0o600);}catch{/* host may set stricter permissions */}
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bili_meta(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bili_records(id TEXT PRIMARY KEY,bvid TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bili_records_time ON bili_records(created_at DESC);
      CREATE INDEX IF NOT EXISTS bili_records_bvid ON bili_records(bvid);
      CREATE TABLE IF NOT EXISTS bili_deleted(id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bili_blocks(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS bili_attempts(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bili_attempts_time ON bili_attempts(created_at DESC);
      CREATE TABLE IF NOT EXISTS bili_recommendations(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bili_recommendations_time ON bili_recommendations(created_at DESC);`);
    this.tx(()=>{if(this.meta('schema')===undefined)this.putMeta('schema',1);if(this.meta('version')===undefined)this.putMeta('version',0);});
  }
  private tx<T>(fn:()=>T):T {
    try {this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
    catch(e){if(e instanceof Error && !/sqlite|constraint|database|SQLITE|\/Users\//i.test(e.message))throw e;throw new Error('B站数据操作未完成，请稍后重试');}
  }
  private meta<T>(key:string):T|undefined {const r=this.db.prepare('SELECT data FROM bili_meta WHERE key=?').get(key);return r?parse<T>(r.data):undefined;}
  private putMeta(key:string,value:unknown) {this.db.prepare('INSERT INTO bili_meta(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key,JSON.stringify(value));}
  private bump():number {const next=this.version()+1;this.putMeta('version',next);return next;}
  version():number {return this.meta<number>('version')??0;}
  settings():BiliSettings {return {...DEFAULTS,...this.meta<Partial<BiliSettings>>('settings')};}
  patchSettings(patch:Partial<BiliSettings>):BiliSettings {
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('B站设置无效');
    if(Object.keys(patch).some(k=>!(k in DEFAULTS)))throw new Error('B站设置包含未知项目');
    return this.tx(()=>{const next={...this.settings(),...clone(patch)};
      for(const key of ['enabled','paused','shareEnabled','allowLike','allowFavorite'] as const)flag(next[key]);
      if(next.pausedUntil!==null)finite(next.pausedUntil,0,8640000000000000);
      if(!Number.isInteger(next.maxVideoMinutes)||next.maxVideoMinutes<0||next.maxVideoMinutes>1440)throw new Error('视频时长设置无效');
      if(JSON.stringify(next)!==JSON.stringify(this.settings())){this.putMeta('settings',next);this.bump();}
      return next;
    });
  }
  accountMid():string|null {return this.meta<string|null>('accountMid')??null;}
  confirmAccount(value:string|null):string|null {
    const next=value===null?null:mid(value);
    return this.tx(()=>{if(next!==this.accountMid()){this.putMeta('accountMid',next);this.bump();}return next;});
  }
  private allRecords():BiliRecord[] {return this.db.prepare('SELECT data FROM bili_records ORDER BY created_at DESC,id DESC').all().map(r=>parse<BiliRecord>(r.data));}
  recordPage(query='',offset=0,limit=50,ids?:string[]):{items:BiliRecord[];total:number} {
    if(typeof query!=='string'||query.length>500)throw new Error('搜索内容无效');
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>500)throw new Error('分页参数无效');
    if(ids!==undefined&&(!Array.isArray(ids)||ids.length>5000))throw new Error('记录标识无效');
    const selected=ids===undefined?null:new Set(ids.map(id));
    const needle=query.trim().toLowerCase();
    const all=this.allRecords().filter(r=>(!selected||selected.has(r.id))&&(!needle||[r.video.title,r.video.owner,r.opinion,r.summary,...r.topics].some(v=>v.toLowerCase().includes(needle))));
    return {items:all.slice(offset,offset+limit).map(clone),total:all.length};
  }
  records(query='',offset=0,limit=50):BiliRecord[] {return this.recordPage(query,offset,limit).items;}
  pendingShares(limit=20):BiliRecord[] {
    if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('查询数量无效');
    return this.db.prepare("SELECT data FROM bili_records WHERE json_extract(data,'$.shareStatus')='pending' ORDER BY created_at ASC,id ASC LIMIT ?").all(limit).map(r=>parse<BiliRecord>(r.data));
  }
  newestPendingShare():BiliRecord|null {
    return this.tx(()=>{
      const row=this.db.prepare("SELECT data FROM bili_records WHERE json_extract(data,'$.shareStatus')='pending' ORDER BY created_at DESC,id DESC LIMIT 1").get();
      if(!row)return null;
      const newest=parse<BiliRecord>(row.data);
      this.db.prepare("UPDATE bili_records SET data=json_set(data,'$.shareStatus','skipped','$.shareText','','$.version',json_extract(data,'$.version')+1) WHERE id<>? AND json_extract(data,'$.shareStatus')='pending'").run(newest.id);
      return newest;
    });
  }
  discardPendingShares():void {
    this.tx(()=>this.db.prepare("UPDATE bili_records SET data=json_set(data,'$.shareStatus','expired','$.shareText','','$.version',json_extract(data,'$.version')+1) WHERE json_extract(data,'$.shareStatus')='pending'").run());
  }
  record(key:string):BiliRecord|null {const r=this.db.prepare('SELECT data FROM bili_records WHERE id=?').get(id(key));return r?parse<BiliRecord>(r.data):null;}
  hasVideo(value:string):boolean {return !!this.db.prepare('SELECT 1 FROM bili_records WHERE bvid=? LIMIT 1').get(bvid(value));}
  saveRecord(input:Omit<BiliRecord,'version'>,expectedVersion:number):BiliRecord|null {
    const v=validRecord({...input,version:1});
    return this.tx(()=>{
      if(expectedVersion!==this.version()||this.blocked(v.video)||this.db.prepare('SELECT 1 FROM bili_deleted WHERE id=?').get(v.id))return null;
      const old=this.db.prepare('SELECT data FROM bili_records WHERE id=?').get(v.id);if(old)return parse<BiliRecord>(old.data);
      this.db.prepare('INSERT INTO bili_records(id,bvid,created_at,data) VALUES(?,?,?,?)').run(v.id,v.video.bvid,v.createdAt,JSON.stringify(v));return v;
    });
  }
  updateRecord(key:string,patch:Partial<BiliRecord>,expectedVersion?:number):BiliRecord|null {
    id(key);if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('记录更新无效');
    const allowed=new Set(['liked','favorited','actionReason','actionError','shareText','shareStatus','sharedAt','discussedAt']);
    if(Object.keys(patch).some(k=>!allowed.has(k)))throw new Error('记录更新包含未知项目');
    return this.tx(()=>{if(expectedVersion!==undefined&&expectedVersion!==this.version())return null;const old=this.record(key);if(!old||this.blocked(old.video))return null;
      if(old.shareStatus!=='pending'&&patch.shareStatus==='pending')throw new Error('已结束的分享不能重新排队');
      const next=validRecord({...old,...patch,id:old.id,version:old.version+1});this.db.prepare('UPDATE bili_records SET data=? WHERE id=?').run(JSON.stringify(next),key);return next;});
  }
  deleteRecords(ids:string[],confirm=false):number {
    if(!Array.isArray(ids)||ids.length>5000)throw new Error('请选择要删除的记录');const keys=[...new Set(ids.map(id))];
    if(keys.length>1&&!confirm)throw new Error('请确认批量删除浏览记录');
    return this.tx(()=>{let removed=0;for(const key of keys){const exists=this.db.prepare('SELECT 1 FROM bili_records WHERE id=?').get(key);if(!exists)continue;
      this.db.prepare('INSERT OR IGNORE INTO bili_deleted(id,deleted_at) VALUES(?,?)').run(key,this.now());removed+=Number(this.db.prepare('DELETE FROM bili_records WHERE id=?').run(key).changes);}
      if(removed){if(keys.includes(this.selectedKey()??''))this.putMeta('selected',null);this.bump();}return removed;});
  }
  clearRecords(confirm=false):number {
    if(!confirm)throw new Error('请确认清空浏览记录');
    return this.tx(()=>{const count=Number(this.db.prepare('SELECT COUNT(*) AS n FROM bili_records').get()?.n??0);
      this.db.prepare('INSERT OR IGNORE INTO bili_deleted(id,deleted_at) SELECT id,? FROM bili_records').run(this.now());this.db.exec('DELETE FROM bili_records');this.putMeta('selected',null);this.bump();return count;});
  }
  block(kind:BiliBlock['kind'],key:string,label:string):BiliBlock {
    if(kind!=='video'&&kind!=='owner')throw new Error('屏蔽类型无效');const value=kind==='video'?bvid(key):mid(key), name=text(label,500);const block={kind,id:value,label:name,createdAt:this.now()};
    return this.tx(()=>{
      this.db.prepare('INSERT INTO bili_blocks(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value,JSON.stringify(block));
      const where=kind==='video'?'bvid=?':"json_extract(data,'$.video.ownerId')=?";
      for(const row of this.db.prepare(`SELECT data FROM bili_records WHERE ${where} AND json_extract(data,'$.shareStatus')='pending'`).all(value)){
        const record=parse<BiliRecord>(row.data);record.shareStatus='skipped';record.version++;
        this.db.prepare('UPDATE bili_records SET data=? WHERE id=?').run(JSON.stringify(record),record.id);
      }
      this.bump();return block;
    });
  }
  unblock(kind:BiliBlock['kind'],key:string):boolean {
    if(kind!=='video'&&kind!=='owner')throw new Error('屏蔽类型无效');const value=kind==='video'?bvid(key):mid(key);
    return this.tx(()=>{const changed=Number(this.db.prepare('DELETE FROM bili_blocks WHERE kind=? AND id=?').run(kind,value).changes)>0;if(changed)this.bump();return changed;});
  }
  blocks():BiliBlock[] {return this.db.prepare('SELECT data FROM bili_blocks ORDER BY kind,id').all().map(x=>parse<BiliBlock>(x.data));}
  blocked(video:BiliVideo):boolean {return !!this.db.prepare("SELECT 1 FROM bili_blocks WHERE (kind='video' AND id=?) OR (kind='owner' AND id=?) LIMIT 1").get(video.bvid,video.ownerId);}
  attempts(limit=50):BiliAttempt[] {if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('查询数量无效');return this.db.prepare('SELECT data FROM bili_attempts ORDER BY created_at DESC,id DESC LIMIT ?').all(limit).map(x=>parse<BiliAttempt>(x.data));}
  putAttempt(value:BiliAttempt):boolean {const v=validAttempt(value);return this.tx(()=>Number(this.db.prepare('INSERT OR IGNORE INTO bili_attempts(id,created_at,data) VALUES(?,?,?)').run(v.id,v.createdAt,JSON.stringify(v)).changes)>0);}
  updateAttempt(key:string,patch:Partial<BiliAttempt>):BiliAttempt|null {
    id(key);return this.tx(()=>{const row=this.db.prepare('SELECT data FROM bili_attempts WHERE id=?').get(key);if(!row)return null;const old=parse<BiliAttempt>(row.data);
      if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!['bvid','title','status','stage','reason','recordId'].includes(k)))throw new Error('任务更新无效');
      if(old.status!=='running'&&patch.status&&patch.status!==old.status)throw new Error('任务已经结束');
      const next=validAttempt({...old,...patch,id:old.id,origin:old.origin,createdAt:old.createdAt,updatedAt:this.now()});this.db.prepare('UPDATE bili_attempts SET data=? WHERE id=?').run(JSON.stringify(next),key);return next;});
  }
  recommend(input:string,bv:string|null):BiliRecommendation {
    const value=inputLink(input);if(bv!==null)bvid(bv);
    return this.tx(()=>{const row:BiliRecommendation={id:randomUUID(),input:value,bvid:bv,createdAt:this.now(),status:'pending',reason:''};this.db.prepare('INSERT INTO bili_recommendations(id,created_at,data) VALUES(?,?,?)').run(row.id,row.createdAt,JSON.stringify(row));return row;});
  }
  recommendations():BiliRecommendation[] {return this.db.prepare('SELECT data FROM bili_recommendations ORDER BY created_at DESC,id DESC LIMIT 200').all().map(r=>parse<BiliRecommendation>(r.data));}
  updateRecommendation(key:string,patch:Partial<BiliRecommendation>):BiliRecommendation|null {
    id(key);if(!patch||typeof patch!=='object'||Object.keys(patch).some(k=>!['status','reason','bvid'].includes(k)))throw new Error('推荐更新无效');
    return this.tx(()=>{const row=this.db.prepare('SELECT data FROM bili_recommendations WHERE id=?').get(key);if(!row)return null;const old=parse<BiliRecommendation>(row.data);const next={...old,...patch,id:old.id,input:old.input,createdAt:old.createdAt};
      if(!['pending','started','done','failed'].includes(next.status))throw new Error('推荐状态无效');if(next.bvid!==null)bvid(next.bvid);next.reason=text(next.reason,1000,true);
      if(['done','failed'].includes(old.status)&&next.status!==old.status)throw new Error('推荐已结束');
      this.db.prepare('UPDATE bili_recommendations SET data=? WHERE id=?').run(JSON.stringify(next),key);return next;});
  }
  stats():BiliStats {
    const today=day(this.now()),s:BiliStats={attempted:0,succeeded:0,failed:0,interrupted:0,skipped:0};
    for(const row of this.db.prepare('SELECT data FROM bili_attempts WHERE created_at>=? AND created_at<?').all(Date.parse(today+'T00:00:00+08:00'),Date.parse(today+'T00:00:00+08:00')+86400000)){
      const attempt=parse<BiliAttempt>(row.data);s.attempted++;if(attempt.status!=='running')s[attempt.status]++;
    }return s;
  }
  interests():Array<{topic:string;recordIds:string[]}> {
    const groups=new Map<string,Map<string,{id:string;date:string}>>();
    for(const row of this.db.prepare('SELECT data FROM bili_records ORDER BY created_at DESC').all()){
      const rec=parse<BiliRecord>(row.data);for(const topic of new Set(rec.topics)){const k=topic.trim();if(!k)continue;const item=groups.get(k)??new Map<string,{id:string;date:string}>();if(!item.has(rec.video.bvid))item.set(rec.video.bvid,{id:rec.id,date:day(rec.createdAt)});groups.set(k,item);}
    }
    return [...groups].filter(([,v])=>v.size>=3&&new Set([...v.values()].map(x=>x.date)).size>=2).map(([topic,v])=>({topic,recordIds:[...v.values()].map(x=>x.id)})).sort((a,b)=>b.recordIds.length-a.recordIds.length).slice(0,20);
  }
  private selectedKey():string|null {
    const selected=this.meta<unknown>('selected');
    if(typeof selected==='string')return IDENT.test(selected)?selected:null;
    if(selected&&typeof selected==='object'&&!Array.isArray(selected)){
      const value=(selected as {id?:unknown}).id;return typeof value==='string'&&IDENT.test(value)?value:null;
    }
    return null;
  }
  selectContext(key:string|null):void {
    if(key!==null&&!this.record(id(key)))throw new Error('浏览记录不存在');
    this.tx(()=>this.putMeta('selected',key===null?null:{id:key,at:this.now()}));
  }
  selectedContext():string|null {
    const selected=this.meta<unknown>('selected');if(selected===undefined||selected===null)return null;
    // A pre-upgrade string has no selection timestamp: do not renew it or revive an old topic.
    const item=selected&&typeof selected==='object'&&!Array.isArray(selected)?selected as {id?:unknown;at?:unknown}:null;
    const key=this.selectedKey(),at=item?.at,age=typeof at==='number'?this.now()-at:NaN;
    if(key&&Number.isSafeInteger(at)&&age>=0&&age<30*60_000&&this.record(key))return key;
    this.tx(()=>this.putMeta('selected',null));return null;
  }
  context(query:string,selectedId?:string|null):string {
    if(typeof query!=='string'||query.length>30000)throw new Error('检索内容无效');
    const selected=selectedId===undefined?this.selectedContext():selectedId;const chosen=selected?this.record(id(selected)):null;
    // Cues are deliberately bounded; never turn substring similarity into evidence of a shared experience.
    const pieces=query.toLowerCase().match(/BV[A-Za-z0-9]{10}|[\u4e00-\u9fff]{2,16}|[a-z0-9]{3,30}/gi)??[];
    const cues=[...new Set(pieces.flatMap(x=>[x,...(x.length>4&&/[\u4e00-\u9fff]/.test(x)?x.match(/[\u4e00-\u9fff]{2,4}/g)??[]:[])]))].slice(0,20);
    const candidates=this.allRecords().filter(r=>r.id!==chosen?.id).map(r=>{
      const fields=[r.video.bvid,r.video.title,r.video.owner,...r.topics].map(s=>s.toLowerCase());
      const matches=cues.filter(c=>fields.some(s=>s.includes(c.toLowerCase())));
      const score=matches.reduce((n,c)=>n+c.length*c.length,0)+(query.trim().length>=2&&r.video.title.toLowerCase().includes(query.trim().toLowerCase())?200:0);
      return {r,score};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.r.createdAt-a.r.createdAt).slice(0,4).map(x=>x.r);
    const rows=[...(chosen?[chosen]:[]),...candidates].map(r=>({id:r.id,title:r.video.title.slice(0,200),url:r.video.url,owner:r.video.owner.slice(0,100),watchedAt:r.createdAt,origin:r.origin==='recommended'?'用户推荐，伙伴自行了解':'伙伴自行了解',discussedAt:r.discussedAt,opinion:r.opinion.slice(0,800),coverage:r.coverage.slice(0,400),limitations:r.limitations.slice(0,4).map(x=>x.slice(0,200))}));
    const out={kind:'伙伴个人浏览经历，不能称作与用户一起观看',records:[] as typeof rows};
    for(const row of rows){out.records.push(row);if(JSON.stringify(out).length>10000)out.records.pop();}
    return out.records.length?JSON.stringify(out):'';
  }
  recover():void {
    this.tx(()=>{for(const row of this.db.prepare('SELECT data FROM bili_attempts').all()) {const a=parse<BiliAttempt>(row.data);if(a.status==='running'){a.status='interrupted';a.stage='已中断';a.reason='DSH 已退出，本次未继续';a.updatedAt=this.now();this.db.prepare('UPDATE bili_attempts SET data=? WHERE id=?').run(JSON.stringify(a),a.id);}}
      for(const row of this.db.prepare('SELECT data FROM bili_records').all()){const r=parse<BiliRecord>(row.data);if(r.shareStatus==='pending'){r.shareStatus='expired';r.shareText='';r.version++;this.db.prepare('UPDATE bili_records SET data=? WHERE id=?').run(JSON.stringify(r),r.id);}}
      for(const row of this.db.prepare('SELECT data FROM bili_recommendations').all()){const r=parse<BiliRecommendation>(row.data);if(r.status==='pending'||r.status==='started'){r.status='failed';r.reason='DSH 已退出，请重新推荐';this.db.prepare('UPDATE bili_recommendations SET data=? WHERE id=?').run(JSON.stringify(r),r.id);}}
      this.bump();
    });
  }
  close():void {if(!this.closed){this.closed=true;this.db.close();}}
}
