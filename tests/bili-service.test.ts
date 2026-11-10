import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Model } from '../src/model.js';
import { BiliService, segmentMaterial } from '../src/bili/service.js';
import type { BiliMaterial, BiliProvider, BiliRecord, BiliVideo } from '../src/bili/types.js';
import type { HostContext } from '../src/types.js';

const route={provider:'test',model:'vision'};
const video:BiliVideo={bvid:'BV1xx411c7mD',aid:123,cid:456,title:'游戏操作教学',owner:'UP 主',ownerId:'1234',duration:100,url:'https://www.bilibili.com/video/BV1xx411c7mD'};
const material=():BiliMaterial=>({video:{...video},subtitles:[{from:0,to:5,text:'教学从掩体出发'}, {from:40,to:45,text:'选择合适时机'}],frames:[{at:2,data:Buffer.from('synthetic-frame-a'),mediaType:'image/jpeg'},{at:50,data:Buffer.from('synthetic-frame-b'),mediaType:'image/jpeg'}],subtitleLanguage:'zh',coverage:'全片字幕，抽取两帧',limitations:['抽样不等于逐秒观看']});
const prior=(id:string):Omit<BiliRecord,'version'>=>({id,video:{...video,bvid:'BV1xx411c7mE',title:'先前的视频'},origin:'autonomous',createdAt:Date.now(),summary:'内容',opinion:'看法',topics:['游戏'],coverage:'字幕和画面',limitations:['抽样画面'],excerpts:[{from:0,to:3,text:'以前的字幕'}],frameTimes:[1],liked:false,favorited:false,actionReason:'',shareText:'我看到一条有趣的内容。',shareStatus:'pending'});
const waitFor=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('task did not settle');};
function setup(){
 const root=mkdtempSync(join(tmpdir(),'whale-bili-service-')),store=new Store(root),calls:any[]=[],providerCalls:string[]=[];
 let canBrowse=true,canDeliver=true,networkFailure=false,noUsage=false,truncateCalls=0,hold:Promise<void>|null=null,content=material(), accountLoggedIn=true,engage=false,segmentResponses:unknown[]=[],reflectionResponses:unknown[]=[],lowerBudgetAfterSegment=false;
 const llm={resolveModelInfo:async()=>({inputModalities:['text','image'],context:{contextWindow:1000000}}),imageRequestPricing:()=>({priceImages:(images:any[])=>images.map(()=>({visualTokens:256,text:''}))}),
  async *stream(options:any){calls.push(options);if(hold)await hold;
   const segment=options.system.includes('一个片段');
   const response=options.system.includes('挑选自己')?{bvid:video.bvid,reason:'对内容好奇'}:segment?(segmentResponses.length?segmentResponses.shift():{notes:'字幕描述操作，画面展示场景',limitations:['画面为抽样']}):(reflectionResponses.length?reflectionResponses.shift():{summary:'视频介绍了游戏操作。',opinion:'步骤具体，但效果仍需实测。',topics:['游戏'],limitations:['抽样不等于完整视觉'],share:true,shareText:'我看到一个操作讲解，步骤还挺具体。',like:engage,favorite:engage,actionReason:engage?'内容值得对照练习':''});
   if(segment&&lowerBudgetAfterSegment){lowerBudgetAfterSegment=false;store.patchSettings({dailyLimit:.05});}
   yield {type:'text-delta',text:JSON.stringify(response)};
   if(!noUsage)yield {type:'usage',usage:{inputTokens:200,outputTokens:80,cacheReadTokens:100,cacheWriteTokens:0}};
   const truncated=truncateCalls>0;if(truncated)truncateCalls--;yield {type:'finish',reason:{kind:truncated?'max-tokens':'stop'}};
  }};
 const provider:BiliProvider={setExpectedMid:()=>{},available:()=>true,
  account:async()=>{providerCalls.push('account');return {loggedIn:accountLoggedIn,name:'伙伴账号',mid:accountLoggedIn?'1234':null};},
  login:async()=>{},logout:async()=>{},resolve:async()=>{providerCalls.push('resolve');return video.bvid;},
  candidates:async()=>{providerCalls.push('candidates');return [{...video}];},
  material:async(_bv,_signal,stage)=>{providerCalls.push('material');stage('正在读取');if(networkFailure)throw Error('synthetic failure');return content;},
  like:async()=>{providerCalls.push('like');},favorite:async()=>{providerCalls.push('favorite');},dispose:async()=>{}};
 const ctx={get:(name:string)=>name==='llm'?llm:name==='attachments'?{saveImages:async(images:any[])=>images.map(()=>({attachmentId:'synthetic'}))}:undefined,on:()=>()=>{},inject:()=>{}} as HostContext;
 store.patchSettings({model:route,priceRoute:route,prices:{input:30,cached:.6,output:120},dailyLimit:100});
 const engine=new BiliService(root,store,new Model(ctx,store),ctx,{canBrowse:()=>canBrowse,canDeliver:()=>canDeliver,system:()=> '独立伙伴设定'},provider);
 const ready=async()=>{await engine.action({action:'bili.account.check'});await waitFor(()=>!engine.busy());await engine.action({action:'bili.account.confirm',mid:'1234'});await engine.check();};
 return {root,store,engine,ctx,provider,calls,providerCalls,ready,setBrowse:(v:boolean)=>canBrowse=v,setDeliver:(v:boolean)=>canDeliver=v,setNetworkFailure:(v:boolean)=>networkFailure=v,setUsage:(v:boolean)=>noUsage=!v,setTruncate:(n:number)=>truncateCalls=n,setHold:(p:Promise<void>|null)=>hold=p,setMaterial:(v:BiliMaterial)=>content=v,setLoggedIn:(v:boolean)=>accountLoggedIn=v,setEngage:(v:boolean)=>engage=v,setSegmentResponses:(v:unknown[])=>segmentResponses=[...v],setReflectionResponses:(v:unknown[])=>reflectionResponses=[...v],lowerBudgetAfterSegment:()=>lowerBudgetAfterSegment=true,close:async()=>{await engine.dispose();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('not enabled or unconfirmed never begins browsing',async()=>{const x=setup();try{
 await x.engine.tick();assert.deepEqual(x.providerCalls,[]);assert.equal(x.calls.length,0);
 await assert.rejects(x.engine.action({action:'bili.settings',patch:{enabled:true}}),/能力检查/);
 await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 assert.equal(x.providerCalls.length,0);assert.equal(x.calls.length,0);assert.equal(x.engine.data.attempts().length,0);
 }finally{await x.close();}});

test('daily limit or a Bilibili unknown charge prevents provider and model work',async()=>{
 for(const scenario of ['limit','unknown']){const x=setup();try{
  await x.ready();await x.engine.action({action:'bili.settings',patch:{enabled:true}});x.providerCalls.length=0;
  if(scenario==='limit')x.store.patchSettings({dailyLimit:0});else{const t=x.store.reserve('bili-old-unknown',.1,true,undefined,'bilibili');x.store.settle(t,null);}
  await x.engine.tick();assert.deepEqual(x.providerCalls,[]);assert.equal(x.calls.length,0);assert.equal(x.engine.data.attempts().length,0);
 }finally{await x.close();}}
});

test('complete subtitle and picture understanding saves one experience and costs, not user messages or memories',async()=>{const x=setup();try{
 await x.ready();await x.engine.action({action:'bili.settings',patch:{enabled:true}});await x.engine.tick();
 assert.equal(x.engine.data.stats().attempted,1);assert.equal(x.engine.data.stats().succeeded,1);assert.equal(x.engine.data.records().length,1);
 assert.equal(x.calls.length,3);assert.ok(x.store.ledger().filter(l=>l.budgetScope==='bilibili').length===3);
 const r=x.engine.data.records()[0];assert.equal(r.origin,'autonomous');assert.equal(r.video.bvid,video.bvid);assert.equal(r.coverage,'全片字幕，抽取两帧');assert.ok(r.excerpts.length&&r.frameTimes.length);
 assert.equal(x.store.memories().length,0);assert.equal(x.store.sources().length,0);assert.equal(x.store.messages().length,0);
 }finally{await x.close();}});

test('segment notes may be a list of text items and are passed through to the final reflection',async()=>{const x=setup();try{
 await x.ready();x.setSegmentResponses([{notes:['字幕描述操作','画面展示场景'],limitations:['画面为抽样']}]);
 await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 assert.equal(x.engine.data.attempts()[0].status,'succeeded');assert.equal(x.engine.data.records().length,1);
 assert.equal(x.calls.length,2);const reflection=JSON.stringify(x.calls[1].messages);
 assert.match(reflection,/字幕描述操作/);assert.match(reflection,/画面展示场景/);
 const ledger=x.store.ledger().filter(l=>l.budgetScope==='bilibili');assert.equal(ledger.length,2);assert.ok(ledger.every(l=>l.status==='settled'&&l.actual!>0));
 }finally{await x.close();}});

test('valid JSON missing segment notes gets one field-specific repair without enlarging output budget',async()=>{const x=setup();try{
 await x.ready();x.setSegmentResponses([{limitations:['画面为抽样']},{notes:'字幕描述操作，画面展示场景',limitations:['画面为抽样']}]);
 await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 assert.equal(x.engine.data.attempts()[0].status,'succeeded');assert.equal(x.engine.data.records().length,1);
 assert.equal(x.calls.length,3);assert.equal(x.calls[0].maxTokens,x.calls[1].maxTokens);assert.match(x.calls[1].system,/notes/);
 const ledger=x.store.ledger().filter(l=>l.budgetScope==='bilibili');assert.equal(ledger.length,3);assert.ok(ledger.every(l=>l.status==='settled'&&l.actual!>0));
 assert.equal(x.store.messages().length,0);
 }finally{await x.close();}});

test('repeated missing or non-text segment notes fail after one repair without saving or sharing',async()=>{
 for(const invalid of [{}, {notes:''}, {notes:[]}, {notes:{text:'不应转换成事实'}}, {notes:['字幕描述',42]}]){const x=setup();try{
  await x.ready();x.setSegmentResponses([invalid,invalid]);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
  assert.equal(x.engine.data.attempts()[0].status,'failed');assert.equal(x.engine.data.records().length,0);
  assert.equal(x.calls.length,2);assert.equal(x.calls[0].maxTokens,x.calls[1].maxTokens);assert.match(x.calls[1].system,/notes/);
  const ledger=x.store.ledger().filter(l=>l.budgetScope==='bilibili');assert.equal(ledger.length,2);assert.ok(ledger.every(l=>l.status==='settled'&&l.actual!>0));
  x.engine.deliver();assert.equal(x.store.messages().length,0);assert.equal(x.providerCalls.includes('like'),false);assert.equal(x.providerCalls.includes('favorite'),false);
 }finally{await x.close();}}
});

test('missing final opinion gets one field-specific repair before saving the experience',async()=>{const x=setup();try{
 await x.ready();x.setReflectionResponses([{summary:'视频介绍了游戏操作。'},{summary:'视频介绍了游戏操作。',opinion:'步骤具体，但效果仍需实测。'}]);
 await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 assert.equal(x.engine.data.attempts()[0].status,'succeeded');assert.equal(x.engine.data.records().length,1);
 assert.equal(x.calls.length,3);assert.equal(x.calls[1].maxTokens,x.calls[2].maxTokens);assert.match(x.calls[2].system,/opinion/);
 const ledger=x.store.ledger().filter(l=>l.budgetScope==='bilibili');assert.equal(ledger.length,3);assert.ok(ledger.every(l=>l.status==='settled'&&l.actual!>0));
 }finally{await x.close();}});

test('segment format repair does not call the model when the remaining budget is insufficient',async()=>{const x=setup();try{
 await x.ready();x.setSegmentResponses([{}]);x.lowerBudgetAfterSegment();
 await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 assert.equal(x.engine.data.attempts()[0].status,'failed');assert.equal(x.engine.data.records().length,0);
 assert.equal(x.calls.length,1);const ledger=x.store.ledger().filter(l=>l.budgetScope==='bilibili');assert.equal(ledger.length,1);assert.ok(ledger[0].actual!>0);
 assert.ok(x.store.usage(true).spent<=.05);assert.equal(x.store.messages().length,0);
 }finally{await x.close();}});

test('failed content reads remain a failed attempt and never become watched records',async()=>{const x=setup();try{
 await x.ready();await x.engine.action({action:'bili.settings',patch:{enabled:true}});x.setNetworkFailure(true);await x.engine.tick();
 const a=x.engine.data.attempts()[0];assert.equal(a.status,'failed');assert.match(a.stage,/正在读取/);assert.equal(x.engine.data.records().length,0);assert.equal(x.calls.length,1);
 }finally{await x.close();}});

test('recommendation works when autonomous is off, after capability check',async()=>{const x=setup();try{
 await x.ready();assert.equal(x.engine.data.settings().enabled,false);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 const r=x.engine.data.records()[0];assert.equal(r.origin,'recommended');assert.equal(x.calls.length,2);assert.equal(x.engine.data.recommendations()[0].status,'done');
 }finally{await x.close();}});

test('typing delays share, quiet mode expires it and creates no user message',async()=>{const x=setup();try{
 const r=x.engine.data.saveRecord(prior('old'),x.engine.data.version())!;x.setDeliver(false);x.engine.deliver();assert.equal(x.engine.data.record(r.id)?.shareStatus,'pending');
 x.setDeliver(true);x.engine.deliver();assert.equal(x.store.messages().length,1);assert.equal(x.store.messages()[0].role,'assistant');assert.equal(x.store.messages()[0].origin,'proactive');
 const next=x.engine.data.saveRecord(prior('next'),x.engine.data.version())!;x.store.patchSettings({quiet:true});x.engine.deliver();assert.equal(x.engine.data.record(next.id)?.shareStatus,'expired');
 x.store.patchSettings({quiet:false});x.engine.deliver();assert.equal(x.store.messages().length,1);assert.equal(x.store.messages().some(m=>m.role==='user'),false);
 }finally{await x.close();}});

test('delete or stop during in-flight model work cannot resurrect a deleted record or save new completion',async()=>{
 for(const mode of ['delete','stop']){const x=setup();let release=()=>{};try{
  await x.ready();x.engine.data.saveRecord(prior('old'),x.engine.data.version());await x.engine.action({action:'bili.recommend',input:video.bvid});
  x.setHold(new Promise<void>(resolve=>release=resolve));const running=x.engine.tick();await waitFor(()=>x.calls.length===1);
  if(mode==='delete')await x.engine.action({action:'bili.delete',ids:['old']});else await x.engine.action({action:'bili.stop'});
  release();await running;assert.equal(x.engine.data.record('old')===null,mode==='delete');assert.equal(x.engine.data.records().length,mode==='delete'?0:1);
  assert.equal(x.engine.data.attempts()[0].status,'interrupted');assert.equal(x.providerCalls.includes('like'),false);assert.equal(x.providerCalls.includes('favorite'),false);
 }finally{release();await x.close();}}
});

test('account loss and incomplete video material cannot produce a watched record',async()=>{
 for(const fault of ['account','frames','subtitles']){const x=setup();try{
  await x.ready();await x.engine.action({action:'bili.recommend',input:video.bvid});
  if(fault==='account')x.setLoggedIn(false);else {const m=material();if(fault==='frames')m.frames=[];else m.subtitles=[];x.setMaterial(m);}
  await x.engine.tick();assert.equal(x.engine.data.records().length,0);assert.equal(x.engine.data.attempts()[0].status,'failed');
  assert.equal(x.calls.length,0);assert.equal(x.providerCalls.includes('like'),false);assert.equal(x.providerCalls.includes('favorite'),false);
 }finally{await x.close();}}
});

test('like and favorite require both the companion decision and user settings',async()=>{
 for(const allowed of [false,true]){const x=setup();try{
  await x.ready();await x.engine.action({action:'bili.settings',patch:{allowLike:allowed,allowFavorite:allowed}});x.setEngage(true);
  await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
  const r=x.engine.data.records()[0];assert.ok(r);assert.equal(r.liked,allowed);assert.equal(r.favorited,allowed);
  assert.equal(x.providerCalls.includes('like'),allowed);assert.equal(x.providerCalls.includes('favorite'),allowed);
 }finally{await x.close();}}
});

test('truncation retries once within budget; unknown usage stops retry',async()=>{
 for(const unknown of [false,true]){const x=setup();try{
  await x.ready();await x.engine.action({action:'bili.recommend',input:video.bvid});x.setTruncate(unknown?1:2);x.setUsage(!unknown);await x.engine.tick();
  assert.equal(x.calls.length,unknown?1:2);assert.equal(x.engine.data.records().length,0);assert.equal(x.engine.data.attempts()[0].status,'failed');
  assert.equal(x.store.usage(true).uncertain,unknown);
 }finally{await x.close();}}
});

test('truncation retry does not exceed the remaining Bilibili budget',async()=>{const x=setup();try{
 await x.ready();x.store.patchSettings({dailyLimit:.7});await x.engine.action({action:'bili.recommend',input:video.bvid});x.setTruncate(1);await x.engine.tick();
 assert.equal(x.calls.length,1,'the larger retry must be admitted before any model request');
 assert.equal(x.engine.data.records().length,0);assert.equal(x.engine.data.attempts()[0].status,'failed');
 assert.equal(x.store.ledger().filter(l=>l.budgetScope==='bilibili').length,1);
 assert.ok(x.store.usage(true).spent<=.7);
 }finally{await x.close();}});

test('long video subtitle chunks are bounded and retain every subtitle with all frame indices',()=>{
 const m=material();m.video.duration=1600;m.subtitles=Array.from({length:30},(_,i)=>({from:i*50,to:i*50+3,text:'字幕'+i}));m.frames=Array.from({length:9},(_,i)=>({at:i*150,data:Buffer.from('x'),mediaType:'image/jpeg' as const}));
 const groups=segmentMaterial(m);assert.ok(groups.length>1);assert.equal(groups.flatMap(x=>x.subtitles).length,30);assert.equal(groups.flatMap(x=>x.frameIndexes).length,9);assert.ok(groups.every(x=>x.frameIndexes.length<=3));
});

test('on restart an already enabled and confirmed account is rechecked without a model call or reviving old jobs',async()=>{
 const x=setup();let resumed:BiliService|undefined;try{
  await x.ready();await x.engine.action({action:'bili.settings',patch:{enabled:true}});
  const pending=x.engine.data.recommend(video.bvid,video.bvid);const t=Date.now();
  x.engine.data.putAttempt({id:'unfinished',origin:'recommended',status:'running',stage:'正在了解',reason:'',createdAt:t,updatedAt:t});
  x.engine.data.saveRecord(prior('old-pending'),x.engine.data.version());
  await x.engine.dispose();x.providerCalls.length=0;
  resumed=new BiliService(x.root,x.store,new Model(x.ctx,x.store),x.ctx,{canBrowse:()=>false,canDeliver:()=>true,system:()=>''},x.provider);
  assert.equal(resumed.data.recommendations().find(r=>r.id===pending.id)?.status,'failed');
  assert.equal(resumed.data.attempts().find(a=>a.id==='unfinished')?.status,'interrupted');
  assert.equal(resumed.data.record('old-pending')?.shareStatus,'expired');
  resumed.start();await waitFor(()=>!resumed!.busy());assert.equal(resumed.snapshot().checked,true);
  assert.deepEqual(x.providerCalls,['account']);assert.equal(x.calls.length,0);assert.equal(x.store.ledger().length,0);
  resumed.deliver();assert.equal(x.store.messages().length,0);
 }finally{if(resumed)await resumed.dispose();await x.close();}
});

test('startup with disabled or unconfirmed account does not open a provider or run a model',async()=>{
 for(const condition of ['disabled','unconfirmed']){const x=setup();try{
  if(condition==='disabled')x.engine.data.confirmAccount('1234');else x.engine.data.patchSettings({enabled:true});
  x.engine.start();assert.equal(x.engine.busy(),false);assert.deepEqual(x.providerCalls,[]);assert.equal(x.calls.length,0);
 }finally{await x.close();}}
});

test('turning shares off immediately expires pending shares; turning them on does not replay',async()=>{const x=setup();try{
 const one=x.engine.data.saveRecord(prior('first'),x.engine.data.version())!;
 const two=x.engine.data.saveRecord(prior('second'),x.engine.data.version())!;
 await x.engine.action({action:'bili.settings',patch:{shareEnabled:false}});
 assert.equal(x.engine.data.record(one.id)?.shareStatus,'expired');assert.equal(x.engine.data.record(two.id)?.shareStatus,'expired');
 await x.engine.action({action:'bili.settings',patch:{shareEnabled:true}});x.engine.deliver();assert.equal(x.store.messages().length,0);
 const three=x.engine.data.saveRecord(prior('third'),x.engine.data.version())!;
 x.engine.suppressShares();assert.equal(x.engine.data.record(three.id)?.shareStatus,'expired');x.engine.deliver();assert.equal(x.store.messages().length,0);
 }finally{await x.close();}});

test('disabling sharing expires every pending entry, including entries past the first page',async()=>{const x=setup();try{
 for(let n=0;n<501;n++)assert.ok(x.engine.data.saveRecord(prior('entry-'+n),x.engine.data.version()));
 await x.engine.action({action:'bili.settings',patch:{shareEnabled:false}});
 assert.equal(x.engine.data.pendingShares().length,0);
 await x.engine.action({action:'bili.settings',patch:{shareEnabled:true}});x.engine.deliver();assert.equal(x.store.messages().length,0);
 }finally{await x.close();}});

test('consuming a previous video after the selection changes preserves the new selection',async()=>{const x=setup();try{
 const one=x.engine.data.saveRecord(prior('first'),x.engine.data.version())!;
 const two=x.engine.data.saveRecord(prior('second'),x.engine.data.version())!;
 x.engine.data.selectContext(one.id);const used=x.engine.data.selectedContext();x.engine.data.selectContext(two.id);
 x.engine.consumedContext(used);assert.ok(x.engine.data.record(one.id)?.discussedAt);assert.equal(x.engine.data.selectedContext(),two.id);
 x.engine.consumedContext(two.id);assert.ok(x.engine.data.record(two.id)?.discussedAt);assert.equal(x.engine.data.selectedContext(),null);
 }finally{await x.close();}});

test('ordinary chat text does not enqueue historical work; only a newly shared video link creates a recommendation',async()=>{const x=setup();try{
 x.engine.fromChat('今天我想聊聊别的');assert.equal(x.engine.data.recommendations().length,0);
 await x.engine.tick();assert.equal(x.calls.length,0);assert.equal(x.engine.data.attempts().length,0);
 x.engine.fromChat('这条给你 https://www.bilibili.com/video/'+video.bvid);assert.equal(x.engine.data.recommendations().length,1);
 assert.equal(x.engine.data.recommendations()[0].status,'pending');assert.equal(x.engine.data.settings().enabled,false);
 }finally{await x.close();}});

test('segment batches obey host image count and byte limits without losing subtitles or frames',()=>{
 const m=material();m.frames=Array.from({length:5},(_,i)=>({at:2+i,data:Buffer.alloc(6),mediaType:'image/jpeg' as const}));
 for(const [count,bytes] of [[1,100],[3,10],[2,12]]){const chunks=segmentMaterial(m,count,bytes);assert.equal(chunks.flatMap(c=>c.subtitles).length,m.subtitles.length);assert.deepEqual(chunks.flatMap(c=>c.frameIndexes),[0,1,2,3,4]);assert.ok(chunks.every(c=>c.frameIndexes.length<=count&&c.frameIndexes.reduce((n,i)=>n+m.frames[i].data.length,0)<=bytes));}
 assert.throws(()=>segmentMaterial(m,3,5),/图片大小限制/);
});
