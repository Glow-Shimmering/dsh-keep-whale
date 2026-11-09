import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CostDetails, EmbeddingSettings, EmbeddingStatus, Memory } from './types.js';
import type { Store } from './core/store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Ark vision embeddings use a fused multimodal request/response, even for text.
// An explicit endpoint also supports deployments whose model ID is opaque (ep-*).
function embeddingRequest(c: EmbeddingSettings) {
  const url = new URL(c.endpoint);
  let path = url.pathname.replace(/\/+$/, '');
  const multimodal = path.endsWith('/embeddings/multimodal') || /^doubao-embedding-vision(?:-|$)/.test(c.model);
  if (multimodal && !path && url.hostname === 'ark.cn-beijing.volces.com') path = '/api/v3';
  if (multimodal) {
    if (!path.endsWith('/embeddings/multimodal')) path = path.replace(/\/embeddings$/, '') + '/embeddings/multimodal';
  } else if (!path.endsWith('/embeddings')) path += '/embeddings';
  url.pathname = path;
  return { url: url.href, multimodal };
}
// Only locally constructed diagnostics may cross the API boundary. Never echo
// provider bodies, headers, URLs, or fetch errors, which may contain credentials.
class EmbeddingFailure extends Error {}
function validConfig(value: EmbeddingSettings): EmbeddingSettings {
  let endpoint: URL;
  try { endpoint = new URL(value.endpoint); } catch { throw new Error('嵌入服务地址无效'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('嵌入服务地址无效：仅支持 HTTPS 或本机 HTTP，不能包含凭据、查询参数或片段');
  if (!value.model?.trim() || value.model.length > 200 || !Number.isInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > 8192 || !Number.isFinite(value.inputPrice) || value.inputPrice < 0 || !value.unit?.trim() || value.unit.length > 16 || value.unitsPerYuan !== null && (!Number.isFinite(value.unitsPerYuan) || value.unitsPerYuan <= 0) || typeof value.enabled !== 'boolean') throw new Error('嵌入模型配置无效');
  return { enabled:value.enabled, endpoint:endpoint.href.replace(/\/$/, ''), model:value.model.trim(), dimensions:value.dimensions, inputPrice:value.inputPrice, unit:value.unit.trim(), unitsPerYuan:value.unitsPerYuan };
}
export function embeddingRouteKey(config: EmbeddingSettings): string {
  const c = validConfig(config);
  const request = embeddingRequest(c);
  if (request.multimodal) return hash(JSON.stringify([request.url, c.model, c.dimensions, 'ark-multimodal-v1']));
  return hash(JSON.stringify([c.endpoint, c.model, c.dimensions]));
}
type Secret = { apiKey: string; checked?: string };
type VectorStore = Store & {
  pendingVectors(routeKey: string, limit?: number): Memory[];
  saveVector(memoryId: string, version: number, routeKey: string, vector: number[], revision: number): boolean;
  vectorCounts(routeKey: string): { indexed: number; total: number; pending: number };
  reserve(jobId: string, amount: number, background: boolean, details?: CostDetails): string;
  settle(ticket: string, actual: number | null, details?: Partial<CostDetails>): void;
};
export class Embeddings {
  private store: VectorStore;
  private secretPath: string;
  constructor(store: Store, root: string, private fetchImpl: typeof fetch = fetch) { this.store=store as VectorStore; this.secretPath=join(root,'embedding-secret.json'); }
  private secret(): Secret | null { try { const data=JSON.parse(readFileSync(this.secretPath,'utf8')); return typeof data.apiKey==='string' && data.apiKey ? data : null; } catch { return null; } }
  private writeSecret(secret: Secret) {
    mkdirSync(join(this.secretPath,'..'), {recursive:true,mode:0o700});
    const path=this.secretPath+'.'+randomUUID()+'.tmp';
    try { writeFileSync(path, JSON.stringify(secret), {mode:0o600,flag:'wx'}); renameSync(path,this.secretPath); chmodSync(this.secretPath,0o600); }
    finally { try { unlinkSync(path); } catch {} }
  }
  private fingerprint(c: EmbeddingSettings, key: string) { return hash(JSON.stringify([validConfig(c), key])); }
  private config(): EmbeddingSettings | null { const c=this.store.settings().embedding; return c ? validConfig(c) : null; }
  private rate(c: EmbeddingSettings): number {
    const settings=this.store.settings();
    if(c.unit===settings.unit) return 1;
    if(c.unitsPerYuan===null || settings.pointsPerYuan===null || !Number.isFinite(settings.pointsPerYuan) || settings.pointsPerYuan<=0) throw new Error('嵌入服务费用单位无法换算，请配置换算关系');
    return settings.pointsPerYuan/c.unitsPerYuan;
  }
  status(): EmbeddingStatus {
    try {
      const c=this.config(), key=this.secret();
      if(!c) return {configured:false,checked:false,reason:'尚未配置语义回想',routeKey:null,indexed:0,total:0,pending:0};
      const routeKey=embeddingRouteKey(c), counts=this.store.vectorCounts(routeKey);
      let checked=c.enabled && !!key && key.checked===this.fingerprint(c,key.apiKey);
      let reason=!c.enabled?'语义回想已关闭':!key?'需要设置密钥':!checked?'需要检查连接':'';
      try { this.rate(c); } catch { checked=false; reason='费用单位无法换算'; }
      return {configured:true,checked,reason,routeKey,...counts};
    } catch { return {configured:false,checked:false,reason:'嵌入服务配置无效',routeKey:null,indexed:0,total:0,pending:0}; }
  }
  configure(config: EmbeddingSettings | null, apiKey?: string, clearKey=false): EmbeddingStatus {
    const c=config ? validConfig(config) : null;
    if(apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length>8192 || /[\r\n]/.test(apiKey))) throw new Error('密钥格式无效');
    const previous=this.secret();
    const old=this.config();
    const originChanged=!!old && !!c && new URL(old.endpoint).origin!==new URL(c.endpoint).origin;
    if(clearKey || !c || originChanged && !(apiKey?.trim())) { if(existsSync(this.secretPath)) unlinkSync(this.secretPath); }
    else if(apiKey !== undefined && apiKey.trim()) this.writeSecret({apiKey:apiKey.trim()});
    else if(previous && (!c || previous.checked!==this.fingerprint(c,previous.apiKey))) this.writeSecret({apiKey:previous.apiKey});
    this.store.patchSettings({embedding:c});
    return this.status();
  }
  private async perform(texts: string[], c: EmbeddingSettings, key: string, opts: {signal?:AbortSignal;jobId:string;background:boolean}): Promise<number[][]> {
    opts.signal?.throwIfAborted();
    const conversionRate=this.rate(c), tokensBound=texts.reduce((sum,t)=>sum+Buffer.byteLength(t,'utf8'),0)+256*texts.length;
    const rawReserved=tokensBound*c.inputPrice/1e6;
    const details:CostDetails={provider:'embedding',model:c.model,rawUnit:c.unit,conversionRate,priceVerified:true,rawReserved};
    const ticket=this.store.reserve(opts.jobId,rawReserved*conversionRate,opts.background,details);
    const request = embeddingRequest(c);
    // Ark combines all input objects into one vector. Keep different memories
    // in separate requests, but reserve and settle this job once in the ledger.
    const batches = request.multimodal ? texts.map(text => [text]) : [texts];
    let dispatched=false, usage:number|null=0, failure:Error|undefined;
    const vectors:number[][]=[];
    let signal:AbortSignal|undefined;
    try {
      signal=opts.signal ? AbortSignal.any([opts.signal,AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
      for (const batch of batches) {
        signal.throwIfAborted();
        const previousUsage:number|null = usage;
        usage = null; // A dispatched request with no verified usage makes the job uncertain.
        dispatched=true;
        const response=await this.fetchImpl(request.url,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify({model:c.model,input:request.multimodal?batch.map(text=>({type:'text',text})):batch,dimensions:c.dimensions,...request.multimodal?{encoding_format:'float'}:{}})});
        if(!response.ok) {
          const hints:Record<number,string>={400:'请求参数或模型与接口不匹配',401:'请检查 API 密钥',403:'请检查模型开通状态和访问权限',404:'请检查完整接口地址和模型名称',429:'请求过于频繁或额度不足'};
          throw new EmbeddingFailure(`嵌入服务请求失败（HTTP ${response.status}）：${hints[response.status] || '请稍后重试'}`);
        }
        let body:any;
        try { body=await response.json(); } catch { throw new EmbeddingFailure('嵌入服务返回格式无效：响应不是 JSON'); }
        const prompt=body?.usage?.prompt_tokens, total=body?.usage?.total_tokens;
        const valid=(n:unknown):n is number=>Number.isSafeInteger(n) && (n as number)>=0;
        if(prompt!==undefined && !valid(prompt) || total!==undefined && !valid(total) || prompt!==undefined && total!==undefined && prompt!==total) throw new EmbeddingFailure('嵌入服务返回格式无效：用量字段不一致');
        const currentUsage=valid(prompt)?prompt:valid(total)?total:null;
        if(currentUsage===null) throw new EmbeddingFailure('嵌入服务未返回可核实用量，已暂停本次操作');
        if(previousUsage===null || !Number.isSafeInteger(previousUsage+currentUsage)) throw new EmbeddingFailure('嵌入服务返回格式无效：累计用量无效');
        usage=previousUsage+currentUsage;
        const data=request.multimodal && body?.data && !Array.isArray(body.data) ? [{index:0,embedding:body.data.embedding}] : request.multimodal ? null : body?.data;
        if(!Array.isArray(data) || data.length!==batch.length) throw new EmbeddingFailure('嵌入服务返回格式无效：向量结果数量不符');
        const ordered=Array<number[]>(batch.length), seen=new Set<number>();
        for(const item of data) {
          if(!Number.isInteger(item?.index)||item.index<0||item.index>=batch.length||seen.has(item.index)||!Array.isArray(item.embedding)||!item.embedding.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))||!item.embedding.some((n:number)=>n!==0)) throw new EmbeddingFailure('嵌入服务返回格式无效：向量数据无效');
          if(item.embedding.length!==c.dimensions) throw new EmbeddingFailure(`嵌入服务返回格式无效：配置为 ${c.dimensions} 维，实际返回 ${item.embedding.length} 维`);
          seen.add(item.index);ordered[item.index]=item.embedding;
        }
        opts.signal?.throwIfAborted();
        signal.throwIfAborted();
        vectors.push(...ordered);
      }
    } catch(e) { failure=e instanceof EmbeddingFailure?e:new EmbeddingFailure(opts.signal?.aborted?'嵌入请求已中断':signal?.aborted?'嵌入请求超时，请稍后重试':'嵌入服务暂时不可用或返回格式无效'); }
    const rawActual=!dispatched?0:usage===null?null:usage*c.inputPrice/1e6;
    this.store.settle(ticket,rawActual===null?null:rawActual*conversionRate,{rawActual,...usage===null?{}:{inputTokens:usage}});
    if(failure) throw failure;
    if(usage===null) throw new Error('嵌入服务未返回可核实用量，已暂停本次操作');
    return vectors;
  }
  async check(signal?:AbortSignal): Promise<EmbeddingStatus> {
    const c=this.config(), secret=this.secret();
    if(!c || !secret || !c.enabled) throw new Error('请先启用并配置嵌入服务和密钥');
    const fingerprint=this.fingerprint(c,secret.apiKey);
    await this.perform(['连接检查'],c,secret.apiKey,{signal,jobId:'embedding-check:'+randomUUID(),background:false});
    const now=this.config(), current=this.secret();
    if(!now || !current || this.fingerprint(now,current.apiKey)!==fingerprint) throw new Error('配置已变化，请重新检查');
    this.writeSecret({apiKey:current.apiKey,checked:fingerprint});
    return this.status();
  }
  private ready() {
    const c=this.config(), secret=this.secret();
    if(!c || !c.enabled || !secret || secret.checked!==this.fingerprint(c,secret.apiKey)) throw new Error('嵌入服务尚未通过连接检查');
    this.rate(c); return {c,key:secret.apiKey,routeKey:embeddingRouteKey(c)};
  }
  async query(text:string, opts:{signal?:AbortSignal;jobId:string;background:boolean}):Promise<{vector:number[];routeKey:string}> {
    if(!text.trim()||text.length>20000) throw new Error('语义查询内容无效');
    const {c,key,routeKey}=this.ready();
    const [vector]=await this.perform([text],c,key,opts);
    if(this.status().routeKey!==routeKey || !this.status().checked) throw new Error('嵌入配置已变化');
    return {vector,routeKey};
  }
  async indexBatch(opts:{signal?:AbortSignal;jobId:string;rows?:Memory[]}):Promise<number> {
    const {c,key,routeKey}=this.ready(), revision=this.store.revision();
    const rows=opts.rows ?? this.store.pendingVectors(routeKey,8);
    if(rows.length>8) throw new Error('单次索引最多处理八条记忆');
    if(!rows.length)return 0;
    const vectors=await this.perform(rows.map(row=>row.text),c,key,{...opts,background:true});
    opts.signal?.throwIfAborted();
    if(this.status().routeKey!==routeKey || !this.status().checked) throw new Error('嵌入配置已变化');
    let saved=0;
    rows.forEach((row,i)=>{if(this.store.saveVector(row.id,row.version??1,routeKey,vectors[i],revision))saved++;});
    return saved;
  }
}
