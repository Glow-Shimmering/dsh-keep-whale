import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Service } from './service.js';
import { ModelFailure, userError } from './model.js';
export function allowedRequest(req:IncomingMessage) {
  const host=req.headers.host;if(!host||/[\s/@\\?#,]/.test(host)||req.headers['sec-fetch-site']==='cross-site')return false;
  const origin=req.headers.origin;if(!origin||origin==='dsh-app://app')return true;
  try { const u=new URL(origin);return ['http:','https:'].includes(u.protocol)&&u.origin===origin&&u.host===host; }catch{return false;}
}
export function createHandler(service:Service,assetUrl:URL) {
  const token=randomBytes(32).toString('hex');
  return async(req:IncomingMessage,res:ServerResponse)=>{
    const send=(body:any,status=200)=>{if(res.headersSent)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
    try {
      if(!allowedRequest(req))return send({error:'请求来源不匹配'},403);
      const path=new URL(req.url||'','http://localhost').pathname.replace(/^\/keep-whale/,'');
      if(req.method==='GET'&&path==='/messages'){const before=new URL(req.url||'','http://localhost').searchParams.get('before')||undefined;const messages=service.store.messagePage(before);return send({messages,hasMore:messages.length===100});}
      if(req.method==='GET'&&path==='/state')return send({...service.snapshot(),token});
      if(req.method==='GET'&&path==='/whale.svg'){res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'public, max-age=3600','x-content-type-options':'nosniff'});return res.end(readFileSync(assetUrl));}
      if(req.method==='GET'&&path.startsWith('/media/')){const m=service.media.bytes(path.slice(7));res.writeHead(200,{'content-type':m.ref.mediaType,'cache-control':'private, max-age=3600','x-content-type-options':'nosniff'});return res.end(m.bytes);}
      if(req.method!=='POST')return send({error:'没有这个入口'},404);
      if(req.headers['x-keep-whale-token']!==token)return send({error:'连接已更新，请刷新后重试'},403);
      let bytes=0;const chunks:Buffer[]=[];const limit=path==='/upload'?12*1024*1024:100000;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)return send({error:'请求过大'},413);chunks.push(Buffer.from(chunk));}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      if(!body||typeof body!=='object'||Array.isArray(body))return send({error:'请求格式无效'},400);
      if(path==='/upload'){const ref=await service.media.upload(body);if(body.kind==='skin')service.store.patchSettings({skin:ref.url});return send(ref);}
      if(path==='/action')return send(await service.action(body));
      return send({error:'没有这个入口'},404);
    }catch(e){return send({error:e instanceof SyntaxError?'请求格式无效':e instanceof ModelFailure?userError(e): e instanceof Error && !/sqlite|SQLITE|ENOENT|EACCES|\/Users\/|api.?key|token/i.test(e.message)?e.message:'操作未完成，请检查设置后重试'},400);}
  };
}
