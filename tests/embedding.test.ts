import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embeddings, embeddingRouteKey } from '../src/embedding.js';
import type { EmbeddingSettings } from '../src/types.js';

const config:EmbeddingSettings={enabled:true,endpoint:'https://example.test/v1',model:'embed',dimensions:2,inputPrice:30,unit:'积分',unitsPerYuan:30};
function fixture(fetcher:typeof fetch) {
 const root=mkdtempSync(join(tmpdir(),'kw-embed-'));
 const ledger:any[]=[]; const saved:any[]=[];
 const settings:any={embedding:null,unit:'积分',pointsPerYuan:30};
 const store:any={settings:()=>settings,patchSettings:(p:any)=>Object.assign(settings,p),vectorCounts:()=>({indexed:0,total:1,pending:1}),revision:()=>4,pendingVectors:()=>[{id:'one',text:'真实内容',version:1}],saveVector:(...a:any[])=>{saved.push(a);return true;},reserve:(job:string,amount:number,background:boolean,details:any)=>{ledger.push({job,amount,background,details});return String(ledger.length-1);},settle:(id:string,amount:number|null,details:any)=>Object.assign(ledger[+id],{actual:amount,settled:details})};
 const instance=new Embeddings(store,root,fetcher);
 return {root,store,settings,ledger,saved,instance,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const response=(usage:any={prompt_tokens:10})=>new Response(JSON.stringify({data:[{index:0,embedding:[0.1,0.2]}],usage}),{status:200});

test('checked configuration, cost, incremental indexing and protected secret',async()=>{
 const calls:any[]=[];const f=fixture(async (url,options)=>{calls.push({url,options});return response();});
 try {f.instance.configure(config,'secret-key');assert.equal(f.instance.status().checked,false); await f.instance.check();assert.equal(f.ledger[0].background,false);assert.equal(f.instance.status().checked,true);assert.equal(await f.instance.indexBatch({jobId:'batch'}),1);assert.equal(f.ledger[1].background,true);assert.equal(f.ledger[1].actual,10*30/1e6);assert.equal(f.saved[0][4],4);assert.equal(statSync(join(f.root,'embedding-secret.json')).mode&0o777,0o600);assert(!JSON.stringify(f.instance.status()).includes('secret-key'));assert(!JSON.stringify(f.ledger).includes('secret-key'));assert.equal(calls[0].url,'https://example.test/v1/embeddings');assert.equal(calls[0].options.redirect,'error');assert.match(readFileSync(join(f.root,'embedding-secret.json'),'utf8'),/secret-key/);}
 finally {f.cleanup();}
});

test('unavailable usage produces uncertain charge and never validates capability',async()=>{
 const f=fixture(async()=>response({}));try{f.instance.configure(config,'key');await assert.rejects(f.instance.check(),/未返回可核实用量/);assert.equal(f.ledger[0].actual,null);assert.equal(f.instance.status().checked,false);}finally{f.cleanup();}
});

test('provider errors are redacted and failed calls are charged as uncertain',async()=>{
 const f=fixture(async()=>{throw Error('key is secret-key')});try{f.instance.configure(config,'secret-key');await assert.rejects(f.instance.check(),e=>e instanceof Error&&!e.message.includes('secret-key'));assert.equal(f.ledger[0].actual,null);}finally{f.cleanup();}
});

test('configuration and key changes invalidate the check and endpoint rejects credentials',async()=>{
 const f=fixture(async()=>response());try{f.instance.configure(config,'key');await f.instance.check();f.instance.configure({...config,inputPrice:31});assert.equal(f.instance.status().checked,false);await assert.rejects(f.instance.query('hi',{jobId:'x',background:false}));assert.throws(()=>f.instance.configure({...config,endpoint:'https://user:password@example.test'}));assert.equal(embeddingRouteKey(config),embeddingRouteKey({...config,inputPrice:42}));}finally{f.cleanup();}
});

test('different billing unit conversion and invalid vectors',async()=>{
 const f=fixture(async()=>response());try{f.settings.unit='人民币';f.settings.pointsPerYuan=1;f.instance.configure(config,'key');await f.instance.check();assert(Math.abs(f.ledger[0].actual-10/1e6)<1e-14);f.instance.configure({...config,dimensions:3});await assert.rejects(f.instance.check(),/返回格式无效/);assert(Math.abs(f.ledger[1].actual-10/1e6)<1e-14);assert.equal(f.instance.status().checked,false);}finally{f.cleanup();}
});

test('different origin removes old key, same origin rechecks without losing key',async()=>{
 const f=fixture(async()=>response());try {
  f.instance.configure(config,'old-secret'); await f.instance.check();
  f.instance.configure({...config,endpoint:'https://example.test/other'});assert.equal(f.instance.status().checked,false);await f.instance.check();
  f.instance.configure({...config,endpoint:'https://other.test/v1'});assert.equal(f.instance.status().checked,false);assert(!f.instance.status().checked);assert.throws(()=>readFileSync(join(f.root,'embedding-secret.json')));await assert.rejects(f.instance.check(),/密钥/);
 }finally{f.cleanup();}
});

test('disabled and nonconvertible configuration cannot show checked',async()=>{
 const f=fixture(async()=>response());try{
  f.instance.configure(config,'key');await f.instance.check();
  f.settings.embedding={...config,enabled:false};assert.equal(f.instance.status().checked,false);
  f.settings.embedding=config;f.settings.unit='其他单位';f.settings.pointsPerYuan=null;assert.equal(f.instance.status().checked,false);assert.match(f.instance.status().reason,/换算/);
 }finally{f.cleanup();}
});

test('total tokens accepted and conflicting token fields produce uncertain usage',async()=>{
 let usage:any={total_tokens:11};const f=fixture(async()=>response(usage));try{
  f.instance.configure(config,'key');await f.instance.check();assert.equal(f.ledger[0].settled.inputTokens,11);
  usage={prompt_tokens:11,total_tokens:12};await assert.rejects(f.instance.query('你好',{jobId:'bad',background:true}));assert.equal(f.ledger[1].actual,null);
 }finally{f.cleanup();}
});

test('zero vector rejected and abort ignored by remote implementation does not succeed',async()=>{
 let zero=false;let controller:AbortController|undefined;const f=fixture(async()=>{if(controller)controller.abort();return new Response(JSON.stringify({data:[{index:0,embedding:zero?[0,0]:[1,2]}],usage:{prompt_tokens:5}}));});try{
  f.instance.configure(config,'key');await f.instance.check();zero=true;await assert.rejects(f.instance.query('hi',{jobId:'zero',background:true}),/返回格式无效/);zero=false;controller=new AbortController();await assert.rejects(f.instance.query('hi',{jobId:'abort',background:true,signal:controller.signal}),/中断/);assert.equal(f.ledger[2].actual,5*30/1e6);
 }finally{f.cleanup();}
});
