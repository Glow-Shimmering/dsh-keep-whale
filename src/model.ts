import { randomUUID } from 'node:crypto';
import type { HostContext, ModelInfo, Route } from './types.js';
import type { Store } from './core/store.js';

export class ModelFailure extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ModelFailure'; }
}
export const userError = (error: unknown) => error instanceof ModelFailure ? error.message : (error instanceof Error && error.name === 'AbortError') ? '本次任务已中断' : '任务未完成，请检查模型连接或配置后重试';

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if(signal.aborted){void promise.catch(()=>{});return Promise.reject(signal.reason);}
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
export interface CallInput { system: string; messages: any[]; maxTokens: number; signal: AbortSignal; jobId: string; background: boolean; onText?: (text: string)=>void }
export class Model {
  constructor(private ctx: HostContext, private store: Store) {}
  available() { return !!this.ctx.get('llm'); }
  imagesAvailable() { return !!this.ctx.get('attachments')?.saveImages; }
  async catalog(): Promise<ModelInfo[]> {
    const llm = this.ctx.get('llm'); if (!llm) return [];
    const groups = await Promise.allSettled(llm.listProviders().map(async (p: any) => (await Promise.race([llm.listModels(p.id),new Promise<any[]>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('模型目录暂不可用')),12000);timer.unref?.();})])).map((m: any) => ({ provider: p.id, model: m.id, name: `${p.name || p.id} · ${m.name || m.id}`, vision: m.inputModalities?.includes('image') === true }))));
    return groups.flatMap((g: any) => g.status === 'fulfilled' ? g.value : []);
  }
  async call(input: CallInput): Promise<string> {
    const { model: route, priceRoute, prices } = this.store.settings();
    const llm = this.ctx.get('llm');
    if (!llm || !route) throw new ModelFailure('CONFIG', '请先在设置中选择可用模型');
    input.signal.throwIfAborted();
    const resolveSignal=AbortSignal.any([input.signal,AbortSignal.timeout(15000)]);
    const info:any = await abortable(llm.resolveModelInfo(route.provider, route.model, resolveSignal),resolveSignal);
    const images = input.messages.flatMap(m => m.content.filter((c: any)=>c.type==='image'));
    if (images.length && !info.inputModalities?.includes('image')) throw new ModelFailure('VISION', '当前模型未声明图像能力，请选择支持图片的模型');
    const textBound = Buffer.byteLength(input.system + JSON.stringify(input.messages.map(m=>({...m,content:m.content.filter((c:any)=>c.type!=='image')})))) + 4096;
    let imageBound = 0;
    if (images.length) {
      const price = llm.imageRequestPricing?.(route.provider, route.model);
      const estimates = price?.priceImages(images);
      if (estimates?.length === images.length && estimates.every((p:any)=>Number.isFinite(p.visualTokens)&&p.visualTokens>=0)) imageBound = estimates.reduce((n:number,p:any)=>n+p.visualTokens+Buffer.byteLength(p.text||''),0);
      else if (input.background) throw new ModelFailure('VISION_COST', '无法核算图像用量，已暂停后台任务');
      else imageBound = images.length * 16384; // conservative admission only; user chat is settled by actual usage
    }
    const bound = textBound + imageBound;
    if (!Number.isFinite(info.context?.contextWindow) || bound + input.maxTokens > info.context.contextWindow) throw new ModelFailure('CONTEXT', '内容超出可核实的上下文容量，请缩短本次消息或减少图片');
    const priced = prices && priceRoute?.provider===route.provider && priceRoute.model===route.model;
    if (input.background && !priced) throw new ModelFailure('PRICE', '当前模型缺少已确认的计费信息，后台任务已暂停');
    const reserveAmount = priced ? (bound*Math.max(prices.input,prices.cached)+input.maxTokens*prices.output)/1e6 : 0;
    let ticket: string;
    try { ticket = this.store.reserve(input.jobId,reserveAmount,input.background,priced?{provider:route.provider,model:route.model,rawUnit:this.store.settings().unit,conversionRate:1,priceVerified:true,rawReserved:reserveAmount}:undefined); } catch (e) { throw new ModelFailure('BUDGET', e instanceof Error ? e.message : '后台预算暂不可用'); }
    let text='', usage:any, finish:any, closed=false, dispatched=false, caught:unknown;
    try {
      input.signal.throwIfAborted();
      const options:any = { ...route, system:input.system, messages:input.messages, maxTokens:input.maxTokens, signal:input.signal };
      const off = info.reasoning?.efforts?.find((e:any)=>['off','none'].includes(e.id)); if(off) options.reasoningEffort=off.id;
      dispatched=true;
      const iterator=llm.stream(options)[Symbol.asyncIterator]();
      try { while(true) {
        const next:any=await abortable(iterator.next(),input.signal);if(next.done){closed=true;break;}const part=next.value;
        if(part.type==='text-delta') { text+=part.text; input.onText?.(text); if(text.length>150000) throw new ModelFailure('OUTPUT','输出异常过长，已停止本次任务'); }
        if(part.type==='usage') usage=part.usage;
        if(part.type==='finish') finish=typeof part.reason==='string'?part.reason:{...part.reason}.kind;
      }
      } finally { if(iterator.return)void Promise.resolve(iterator.return()).catch(()=>{}); }
      if(input.signal.aborted || finish==='aborted') throw new ModelFailure('CANCELLED','本次任务已中断');
      if(finish==='max-tokens') throw new ModelFailure('TRUNCATED','这次回复达到输出长度上限，内容尚未完成；可以重试');
      if(finish!=='stop' || !text.trim()) throw new ModelFailure('MODEL','模型未完整返回内容，请检查连接后重试');
    } catch(e) { caught=e; }
    const nums=usage&&[usage.inputTokens,usage.outputTokens,usage.cacheReadTokens??0,usage.cacheWriteTokens??0];
    const valid=nums?.every((v:any)=>Number.isSafeInteger(v)&&v>=0);
    // DSH normalizes inputTokens to uncached input; cache read/write are separate fields.
    const actual=!dispatched ? 0 : priced&&valid&&closed&&finish ? ((nums[0]+nums[3])*prices.input+nums[2]*prices.cached+nums[1]*prices.output)/1e6 : null;
    this.store.settle(ticket,actual,{rawActual:actual,...valid?{inputTokens:nums[0]+nums[3],outputTokens:nums[1],cachedTokens:nums[2]}:{}});
    if(caught) throw caught;
    return text;
  }
}
export function requestMessage(text: string) { return { id:randomUUID(),role:'user',source:{kind:'keep-whale-background'},content:[{type:'text',text}] }; }
export function jsonResult(text:string):any { try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')); } catch { throw new ModelFailure('FORMAT','模型返回格式不完整，未保存为记忆'); } }
