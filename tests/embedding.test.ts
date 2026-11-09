import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embeddings, embeddingRouteKey } from '../src/embedding.js';
import { Store } from '../src/core/store.js';
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

test('automatic indexing ignores zero Bilibili cap and old unknown costs while preserving their records',async()=>{
 const root=mkdtempSync(join(tmpdir(),'kw-index-unlimited-')),store=new Store(root);let calls=0;
 const instance=new Embeddings(store,root,async()=>{calls++;return response();});
 try{
  store.patchSettings({model:{provider:'test',model:'text'},priceRoute:{provider:'test',model:'text'},prices:{input:30,cached:.6,output:120},pointsPerYuan:30,dailyLimit:0});
  const old=store.reserve('legacy-memory',.7197,true);store.settle(old,null);const original=store.ledger()[0];
  store.addSource({id:'s',kind:'user_fact',text:'我喜欢茶',occasion:'s',createdAt:Date.now(),processed:false,revoked:false});
  const memory=store.saveMemory({kind:'user_fact',text:'用户喜欢茶',sourceIds:['s'],evidence:[{sourceId:'s',quote:'喜欢茶'}]})!;assert.ok(memory);
  instance.configure(config,'test-only-fake-key');await instance.check();
  assert.equal(await instance.indexBatch({jobId:'unlimited-index',rows:[memory]}),1);assert.equal(calls,2);
  assert.deepEqual(store.ledger().find(row=>row.id===old),original);assert.equal(store.usage(true).spent,0);assert.equal(store.budgetBlockers().length,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

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

const arkConfig:EmbeddingSettings={...config,endpoint:'https://ark.cn-beijing.volces.com/api/v3',model:'doubao-embedding-vision-251215'};
const arkResponse=(embedding=[0.1,0.2],tokens=10)=>new Response(JSON.stringify({data:{object:'embedding',embedding},usage:{prompt_tokens:tokens,total_tokens:tokens,prompt_tokens_details:{text_tokens:tokens,image_tokens:0}}}));

test('Ark vision supports base URLs, standard endpoints, full endpoints and the Beijing origin',async()=>{
 for(const endpoint of ['https://ark.cn-beijing.volces.com','https://ark.cn-beijing.volces.com/api/v3/','https://ark.cn-beijing.volces.com/api/v3/embeddings','https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal/']) {
  const calls:any[]=[];const f=fixture(async(url,options)=>{calls.push({url,options});return arkResponse();});
  try{f.instance.configure({...arkConfig,endpoint},'secret-key');await f.instance.check();assert.equal(f.instance.status().checked,true);assert.equal(calls[0].url,'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal');assert.deepEqual(JSON.parse(calls[0].options.body),{model:arkConfig.model,input:[{type:'text',text:'连接检查'}],dimensions:2,encoding_format:'float'});assert.equal(calls[0].options.redirect,'error');}finally{f.cleanup();}
 }
});

test('an explicit multimodal endpoint selects Ark format for opaque deployment IDs',async()=>{
 const f=fixture(async(_url,options)=>{assert.deepEqual(JSON.parse(String(options?.body)).input,[{type:'text',text:'连接检查'}]);return arkResponse();});
 try{f.instance.configure({...config,endpoint:'https://proxy.example.test/embeddings/multimodal',model:'ep-example'},'key');await f.instance.check();assert.equal(f.instance.status().checked,true);}finally{f.cleanup();}
});

test('the reported 2048-dimensional Ark model passes check and semantic query',async()=>{
 const f=fixture(async(_url,options)=>{assert.equal(JSON.parse(String(options?.body)).dimensions,2048);return arkResponse(Array(2048).fill(0.01));});
 try{f.instance.configure({...arkConfig,dimensions:2048},'key');await f.instance.check();const result=await f.instance.query('寻找相关记忆',{jobId:'ark-query',background:false});assert.equal(result.vector.length,2048);assert.equal(f.instance.status().checked,true);}finally{f.cleanup();}
});

test('OpenAI-compatible indexing retains one batched request and reorders returned vectors',async()=>{
 let calls=0;const f=fixture(async(_url,options)=>{const body=JSON.parse(String(options?.body));calls++;assert(!body.encoding_format);if(body.input.length===1)return response();assert.deepEqual(body.input,['a','b']);return new Response(JSON.stringify({data:[{index:1,embedding:[3,4]},{index:0,embedding:[1,2]}],usage:{prompt_tokens:20}}));});
 try{f.instance.configure(config,'key');await f.instance.check();assert.equal(await f.instance.indexBatch({jobId:'openai-batch',rows:[{id:'a',text:'a',version:1},{id:'b',text:'b',version:1}] as any}),2);assert.equal(calls,2);assert.deepEqual(f.saved.map(row=>row[3]),[[1,2],[3,4]]);}finally{f.cleanup();}
});

test('Ark route identity canonicalizes equivalent endpoints and remains distinct from text protocol',()=>{
 assert.equal(embeddingRouteKey(arkConfig),embeddingRouteKey({...arkConfig,endpoint:arkConfig.endpoint+'/embeddings/multimodal'}));
 assert.notEqual(embeddingRouteKey({...config,model:'ep-example'}),embeddingRouteKey({...config,model:'ep-example',endpoint:config.endpoint+'/embeddings/multimodal'}));
});

test('Ark indexing sends one request per memory and settles aggregate usage exactly once',async()=>{
 const texts:string[]=[];const f=fixture(async(_url,options)=>{const body=JSON.parse(String(options?.body));assert.equal(body.input.length,1);texts.push(body.input[0].text);return arkResponse([texts.length,1],texts.length);});
 try{
  f.instance.configure(arkConfig,'key');await f.instance.check();
  const rows:any[]=[{id:'a',text:'第一条记忆',version:1},{id:'b',text:'第二条记忆',version:2}];
  assert.equal(await f.instance.indexBatch({jobId:'two',rows}),2);
  assert.deepEqual(texts,['连接检查','第一条记忆','第二条记忆']);assert.equal(f.ledger.length,2);
  assert.equal(f.ledger[1].settled.inputTokens,5);assert.equal(f.ledger[1].actual,5*config.inputPrice/1e6);
  assert.deepEqual(f.saved.map(row=>row[3]),[[2,1],[3,1]]);
 }finally{f.cleanup();}
});

test('Ark batch aggregate billing works with the real Store job-id deduplication',async()=>{
 const root=mkdtempSync(join(tmpdir(),'kw-ark-ledger-'));const store=new Store(root);let calls=0;
 const instance=new Embeddings(store,root,async()=>arkResponse([++calls,1],10));
 try{
  instance.configure(arkConfig,'key');await instance.check();
  const rows=Array.from({length:2},(_,i)=>{const id=`source-${i}`;store.addSource({id,kind:'user_fact',text:`记忆${i}`,occasion:id,createdAt:Date.now(),processed:false,revoked:false});return store.saveMemory({kind:'user_fact',text:`记忆${i}`,sourceIds:[id]})!;});
  assert.equal(await instance.indexBatch({jobId:'ark-real-batch',rows}),2);
  const ledger=store.ledger().filter(row=>row.jobId==='ark-real-batch');assert.equal(ledger.length,1);assert.equal(ledger[0].details?.inputTokens,20);assert.equal(ledger[0].actual,20*config.inputPrice/1e6);assert.equal(instance.status().indexed,2);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('Ark failures after a successful request preserve uncertain billing and do not save a partial batch',async()=>{
 let calls=0;const f=fixture(async()=>++calls===3?new Response('private provider message secret-key',{status:401}):arkResponse());
 try{
  f.instance.configure(arkConfig,'secret-key');await f.instance.check();
  const rows:any[]=[{id:'a',text:'a',version:1},{id:'b',text:'b',version:1},{id:'c',text:'c',version:1}];
  await assert.rejects(f.instance.indexBatch({jobId:'fail',rows}),e=>e instanceof Error&&e.message.includes('HTTP 401')&&!e.message.includes('secret-key'));
  assert.equal(calls,3);assert.equal(f.ledger.length,2);assert.equal(f.ledger[1].actual,null);assert.equal(f.saved.length,0);
 }finally{f.cleanup();}
});

test('missing usage stops later Ark requests rather than continuing unverified spending',async()=>{
 let calls=0;const f=fixture(async()=>++calls===1?arkResponse():new Response(JSON.stringify({data:{embedding:[1,2]}})));
 try{
  f.instance.configure(arkConfig,'key');await f.instance.check();
  await assert.rejects(f.instance.indexBatch({jobId:'usage',rows:[{id:'a',text:'a'},{id:'b',text:'b'}] as any}),/未返回可核实用量/);
  assert.equal(calls,2);assert.equal(f.ledger[1].actual,null);assert.equal(f.saved.length,0);
 }finally{f.cleanup();}
});

test('Ark batch cancellation stops remaining requests and discards vectors',async()=>{
 const controller=new AbortController();let calls=0;
 const f=fixture(async()=>{if(++calls===2)controller.abort();return arkResponse();});
 try{
  f.instance.configure(arkConfig,'key');await f.instance.check();
  await assert.rejects(f.instance.indexBatch({jobId:'abort',signal:controller.signal,rows:[{id:'a',text:'a'},{id:'b',text:'b'}] as any}),/中断/);
  assert.equal(calls,2);assert.equal(f.ledger[1].actual,10*config.inputPrice/1e6);assert.equal(f.saved.length,0);
 }finally{f.cleanup();}
});

test('a malformed later Ark vector keeps verified aggregate costs but writes no partial vectors',async()=>{
 let calls=0;const f=fixture(async()=>arkResponse(++calls===3?[0,0]:[1,2],10));
 try{f.instance.configure(arkConfig,'key');await f.instance.check();await assert.rejects(f.instance.indexBatch({jobId:'bad-vector',rows:[{id:'a',text:'a'},{id:'b',text:'b'},{id:'c',text:'c'}] as any}),/向量数据无效/);assert.equal(calls,3);assert.equal(f.ledger[1].settled.inputTokens,20);assert.equal(f.ledger[1].actual,20*config.inputPrice/1e6);assert.equal(f.saved.length,0);}finally{f.cleanup();}
});

test('a pre-aborted Ark request creates no reservation and makes no network call',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return arkResponse();});const controller=new AbortController();controller.abort();
 try{f.instance.configure(arkConfig,'key');await assert.rejects(f.instance.check(controller.signal),e=>e instanceof Error&&e.name==='AbortError');assert.equal(calls,0);assert.equal(f.ledger.length,0);}finally{f.cleanup();}
});

test('safe HTTP and vector diagnostics never expose response bodies or keys',async()=>{
 for(const status of [400,401,403,404,429,500]) {
  const f=fixture(async()=>new Response('secret-key https://private.example/secret',{status}));try{
   f.instance.configure(config,'secret-key');await assert.rejects(f.instance.check(),e=>e instanceof Error&&e.message.includes(`HTTP ${status}`)&&!e.message.includes('secret-key')&&!e.message.includes('private.example'));assert.equal(f.ledger[0].actual,null);
  }finally{f.cleanup();}
 }
 const f=fixture(async()=>arkResponse([1,2,3]));try{
  f.instance.configure(arkConfig,'key');await assert.rejects(f.instance.check(),/配置为 2 维，实际返回 3 维/);assert.equal(f.instance.status().checked,false);
 }finally{f.cleanup();}
});
