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
const prior=(id:string):Omit<BiliRecord,'version'>=>({id,video:{...video,bvid:'BV1xx411c7mE',title:'先前的视频'},origin:'autonomous',createdAt:Date.now(),summary:'内容',opinion:'看法',topics:['游戏'],coverage:'字幕和画面',limitations:['抽样画面'],excerpts:[{from:0,to:3,text:'以前的字幕'}],frameTimes:[1],liked:false,favorited:false,actionReason:'',shareText:'',shareStatus:'pending'});
const waitFor=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('task did not settle');};
const putMessage=(store:Store,id:string,role:'user'|'assistant',createdAt:number,origin:'chat'|'proactive'='chat',text='一条真实的交流')=>store.putMessage({id,chatId:store.companion().id,role,text,images:[],status:'complete',createdAt,origin,requestId:id});
function setup(){
 const root=mkdtempSync(join(tmpdir(),'whale-bili-service-')),store=new Store(root),calls:any[]=[],providerCalls:string[]=[];
 let canBrowse=true,canDeliver=true,networkFailure=false,noUsage=false,truncateCalls=0,hold:Promise<void>|null=null,holdShare:Promise<void>|null=null,content=material(), accountLoggedIn=true,engage=false,segmentResponses:unknown[]=[],reflectionResponses:unknown[]=[],shareResponses:unknown[]=[],lowerBudgetAfterSegment=false,wantShare=false,shareFailure=false;
 const llm={resolveModelInfo:async()=>({inputModalities:['text','image'],context:{contextWindow:1000000}}),imageRequestPricing:()=>({priceImages:(images:any[])=>images.map(()=>({visualTokens:256,text:''}))}),
  async *stream(options:any){calls.push(options);if(hold)await hold;
   const segment=options.system.includes('一个片段');
   const sharing=options.system.includes('【此刻是否想分享】');
   if(sharing&&holdShare)await holdShare;
   const share={share:true,shareKind:'reaction',shareReason:'操作时机引发了一个值得聊的具体想法',shareText:'这个时机的选择让我想起一件事：犹豫有时比操作失误更难补救。'};
   const response=options.system.includes('挑选自己')?{bvid:video.bvid,reason:'对内容好奇'}:segment?(segmentResponses.length?segmentResponses.shift():{notes:'字幕描述操作，画面展示场景',limitations:['画面为抽样']}):sharing?(shareResponses.length?shareResponses.shift():share):(reflectionResponses.length?reflectionResponses.shift():{summary:'视频介绍了游戏操作。',opinion:'步骤具体，但效果仍需实测。',topics:['游戏'],limitations:['抽样不等于完整视觉'],...share,share:wantShare,like:engage,favorite:engage,actionReason:engage?'内容值得对照练习':''});
   if(segment&&lowerBudgetAfterSegment){lowerBudgetAfterSegment=false;store.patchSettings({dailyLimit:.05});}
   if(!sharing||!shareFailure)yield {type:'text-delta',text:JSON.stringify(response)};
   if(!noUsage)yield {type:'usage',usage:{inputTokens:200,outputTokens:80,cacheReadTokens:100,cacheWriteTokens:0}};
   const truncated=truncateCalls>0;if(truncated)truncateCalls--;yield {type:'finish',reason:{kind:sharing&&shareFailure?'error':truncated?'max-tokens':'stop'}};
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
 let disposed=false;const disposeEngine=async()=>{if(!disposed){disposed=true;await engine.dispose();}};
 return {root,store,engine,ctx,provider,calls,providerCalls,ready,disposeEngine,setBrowse:(v:boolean)=>canBrowse=v,setDeliver:(v:boolean)=>canDeliver=v,setNetworkFailure:(v:boolean)=>networkFailure=v,setUsage:(v:boolean)=>noUsage=!v,setTruncate:(n:number)=>truncateCalls=n,setHold:(p:Promise<void>|null)=>hold=p,setHoldShare:(p:Promise<void>|null)=>holdShare=p,setMaterial:(v:BiliMaterial)=>content=v,setLoggedIn:(v:boolean)=>accountLoggedIn=v,setEngage:(v:boolean)=>engage=v,setSegmentResponses:(v:unknown[])=>segmentResponses=[...v],setReflectionResponses:(v:unknown[])=>reflectionResponses=[...v],setShareResponses:(v:unknown[])=>shareResponses=[...v],setWantShare:(v:boolean)=>wantShare=v,setShareFailure:(v:boolean)=>shareFailure=v,lowerBudgetAfterSegment:()=>lowerBudgetAfterSegment=true,close:async()=>{await disposeEngine();store.close();rmSync(root,{recursive:true,force:true});}};
}
const addDraft=(x:ReturnType<typeof setup>,id:string,contextId:string|null=null)=>{
 (x.engine as any).shareDrafts.set(id,{text:'这个角度让我想到了以前的一次练习。',kind:'reaction',reason:'这条内容引发了一个具体想法',contextId,revision:x.store.revision()});
};

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
 const r=x.engine.data.saveRecord(prior('old'),x.engine.data.version())!;addDraft(x,r.id);x.setDeliver(false);x.engine.deliver();assert.equal(x.engine.data.record(r.id)?.shareStatus,'pending');
 x.setDeliver(true);x.engine.deliver();assert.equal(x.store.messages().length,1);assert.equal(x.store.messages()[0].role,'assistant');assert.equal(x.store.messages()[0].origin,'proactive');
 const next=x.engine.data.saveRecord(prior('next'),x.engine.data.version())!;x.store.patchSettings({quiet:true});x.engine.deliver();assert.equal(x.engine.data.record(next.id)?.shareStatus,'expired');
 x.store.patchSettings({quiet:false});x.engine.deliver();assert.equal(x.store.messages().length,1);assert.equal(x.store.messages().some(m=>m.role==='user'),false);
 }finally{await x.close();}});

test('a missing share reason or repeated summary is not sent, but the video experience is retained',async()=>{
 const summary='片段讲述了游戏里的操作时机。';
 for(const response of [
  {summary,opinion:'时机很关键。',share:true,shareKind:'reaction',shareText:'我想聊聊什么时候该尝试。'},
  {summary,opinion:'时机很关键。',share:true,shareKind:'invented-kind',shareReason:'有了一个想法',shareText:'我想聊聊什么时候该尝试。'},
  {summary,opinion:'时机很关键。',share:true,shareKind:'reaction',shareReason:'有了一个想法',shareText:''},
  {summary,opinion:'时机很关键。',share:true,shareKind:'discovery',shareReason:'值得看看',shareText:summary},
 ]){const x=setup();try{
  await x.ready();x.setReflectionResponses([response]);if(response.shareText===summary)x.setShareResponses([response]);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
  const record=x.engine.data.records()[0];assert.ok(record);assert.equal(record.shareStatus,'skipped');
  x.engine.deliver();assert.equal(x.store.messages().length,0);assert.ok(x.calls.length<=3);if(response.shareText!==summary)assert.equal(x.calls.length,2);
 }finally{await x.close();}}
});

test('a new message after a share was prepared makes its context stale instead of sending it later',async()=>{const x=setup();try{
 const r=x.engine.data.saveRecord(prior('prepared'),x.engine.data.version())!;addDraft(x,r.id);
 putMessage(x.store,'new-topic','user',Date.now()-3000,'chat','换个话题');
 putMessage(x.store,'new-reply','assistant',Date.now()-2000,'chat','好，我们聊聊别的。');
 x.engine.deliver();assert.notEqual(x.engine.data.record(r.id)?.shareStatus,'pending');
 assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,0);
 }finally{await x.close();}});

test('only the newest share is eligible even when more than one page of pending shares exists',async()=>{const x=setup();try{
 const now=Date.now();
 for(let i=0;i<501;i++){
  const row={...prior('backlog-'+i),createdAt:now-(501-i)*1000};
  assert.ok(x.engine.data.saveRecord(row,x.engine.data.version()));addDraft(x,row.id);
 }
 x.engine.deliver();
 assert.equal(x.engine.data.pendingShares().length,0);
 assert.equal(x.engine.data.record('backlog-500')?.shareStatus,'sent');
 assert.equal(x.engine.data.record('backlog-0')?.shareStatus,'skipped');
 assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,1);
 }finally{await x.close();}});

test('recent generic proactive contact blocks a Bilibili share without queueing it',async()=>{const x=setup();try{
 putMessage(x.store,'general-contact','assistant',Date.now()-2*60_000,'proactive');
 await x.ready();x.setWantShare(true);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 const r=x.engine.data.records()[0];assert.ok(r);assert.equal(r.shareStatus,'skipped');
 x.engine.deliver();assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,1);
 }finally{await x.close();}});

test('a new viewing experience cannot repeat an earlier proactive share word for word',async()=>{const x=setup();try{
 const now=Date.now(),old='那个选择时机让我想到，犹豫有时比一次失误更难补救。';
 putMessage(x.store,'old-share','assistant',now-4*60*60_000,'proactive',old+'\n\n[这条视频]('+video.url+')');
 putMessage(x.store,'reply-to-old','user',now-3*60*60_000-20*60_000,'chat','确实有点道理。');
 putMessage(x.store,'reply-finished','assistant',now-3*60*60_000-19*60_000,'chat','嗯，遇到时很容易反应不过来。');
 await x.ready();x.setReflectionResponses([{summary:'一条不同的游戏视频。',opinion:'它提醒我操作节奏很重要。',share:true,shareKind:'reaction',shareReason:'操作时机让人想起旧观点',shareText:old}]);x.setShareResponses([{share:true,shareKind:'reaction',shareReason:'操作时机让人想起旧观点',shareText:old}]);
 await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 const r=x.engine.data.records()[0];assert.ok(r);assert.equal(r.shareStatus,'skipped');x.engine.deliver();
 assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,1);
 }finally{await x.close();}});

test('unanswered proactive contact can receive new content after three hours, without old shares piling up',async()=>{const x=setup();try{
 putMessage(x.store,'older-contact','assistant',Date.now()-3*60*60_000-5000,'proactive');
 const item=prior('fresh-after-wait');
 const r=x.engine.data.saveRecord(item,x.engine.data.version())!;addDraft(x,r.id,'older-contact');x.engine.deliver();
 assert.equal(x.engine.data.record(r.id)?.shareStatus,'sent');assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,2);
 }finally{await x.close();}});

test('a reply to proactive contact does not cancel the minimum share interval',async()=>{const x=setup();try{
 putMessage(x.store,'earlier-contact','assistant',Date.now()-15*60_000,'proactive');
 putMessage(x.store,'user-reply','user',Date.now()-14*60_000,'chat');
 putMessage(x.store,'assistant-reply','assistant',Date.now()-13*60_000,'chat');
 await x.ready();x.setWantShare(true);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 const r=x.engine.data.records()[0];assert.ok(r);assert.equal(r.shareStatus,'skipped');
 x.engine.deliver();assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,1);
 }finally{await x.close();}});

test('there is no fixed daily share quota when the contact interval and conversation permit it',async()=>{const x=setup();try{
 const now=Date.now();
 for(let i=0;i<4;i++){
  const at=now-(4-i)*46*60_000;
  putMessage(x.store,'earlier-'+i,'assistant',at,'proactive','过去的一条不同的消息 '+i);
  putMessage(x.store,'user-'+i,'user',at+60_000,'chat','我看到啦 '+i);
  putMessage(x.store,'answer-'+i,'assistant',at+120_000,'chat','嗯嗯 '+i);
 }
 await x.ready();x.setWantShare(true);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 const r=x.engine.data.records()[0];assert.ok(r);assert.equal(r.shareStatus,'pending');x.engine.deliver();
 assert.equal(x.engine.data.record(r.id)?.shareStatus,'sent');assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,5);
 }finally{await x.close();}});

test('video reflection omits conversation and the optional share call redacts withdrawn evidence',async()=>{const x=setup();try{
 const now=Date.now(),secret='不要发送的秘密代号';
 putMessage(x.store,'secret','user',now-80000,'chat',secret);
 x.store.addSource({id:'chat:secret',kind:'user_fact',text:secret,occasion:'secret',createdAt:now-80000,processed:false,revoked:false});
 const memory=x.store.saveMemory({kind:'user_fact',text:secret,sourceIds:['chat:secret']})!;x.store.deleteMemories([memory.id]);
 putMessage(x.store,'last-reply','assistant',now-70000,'chat','收到，我们继续聊。');
 await x.ready();x.setWantShare(true);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 const reflection=x.calls.find(c=>c.system.includes('你刚自行了解了一条视频'));assert.ok(reflection);
 const input=JSON.stringify(reflection.messages);assert.doesNotMatch(input,new RegExp(secret));assert.doesNotMatch(input,/recentConversation|收到，我们继续聊/);
 const sharing=x.calls.find(c=>c.system.includes('【此刻是否想分享】'));assert.ok(sharing);
 const shareInput=JSON.stringify(sharing.messages);assert.doesNotMatch(shareInput,new RegExp(secret));assert.match(shareInput,/相关记忆已删除/);
 const record=x.engine.data.records()[0];assert.equal(record.shareText,'');assert.doesNotMatch(JSON.stringify(record),/操作时机引发了一个值得聊的具体想法|犹豫有时比操作失误更难补救/);
 const ledger=x.store.ledger().filter(l=>l.budgetScope==='bilibili');assert.equal(ledger.length,3);assert.ok(ledger.every(l=>l.status==='settled'&&l.actual!>0));
 }finally{await x.close();}});

test('optional share model failure leaves the completed viewing experience intact',async()=>{const x=setup();try{
 await x.ready();x.setWantShare(true);x.setShareFailure(true);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 assert.equal(x.engine.data.attempts()[0].status,'succeeded');const record=x.engine.data.records()[0];assert.ok(record);
 assert.equal(record.shareText,'');assert.notEqual(record.shareStatus,'pending');x.engine.deliver();assert.equal(x.store.messages().length,0);
 assert.equal(x.calls.filter(c=>c.system.includes('【此刻是否想分享】')).length,1,'optional sharing is not retried');
 const ledger=x.store.ledger().filter(l=>l.budgetScope==='bilibili');assert.equal(ledger.length,3);assert.ok(ledger.every(l=>l.status==='settled'&&l.actual!>0));
 }finally{await x.close();}});

test('revoking evidence during the optional share call drops its draft but preserves the completed video',async()=>{const x=setup();let release=()=>{};try{
 const now=Date.now();putMessage(x.store,'source-user','user',now-80000,'chat','一件暂时分享的事');
 x.store.addSource({id:'chat:source-user',kind:'user_fact',text:'一件暂时分享的事',occasion:'source-user',createdAt:now-80000,processed:false,revoked:false});
 const memory=x.store.saveMemory({kind:'user_fact',text:'一件暂时分享的事',sourceIds:['chat:source-user']})!;
 putMessage(x.store,'last-answer','assistant',now-70000,'chat','我记下了。');
 await x.ready();x.setWantShare(true);x.setHoldShare(new Promise<void>(resolve=>release=resolve));
 await x.engine.action({action:'bili.recommend',input:video.bvid});const running=x.engine.tick();
 await waitFor(()=>x.calls.some(c=>c.system.includes('【此刻是否想分享】')));
 assert.equal(x.engine.data.records().length,1,'the viewing experience is stored before optional sharing');
 x.store.deleteMemories([memory.id]);release();await running;
 const record=x.engine.data.records()[0];assert.ok(record);assert.equal(x.engine.data.attempts()[0].status,'succeeded');
 assert.equal(record.shareText,'');assert.notEqual(record.shareStatus,'pending');x.engine.deliver();
 assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,0);
 }finally{release();await x.close();}});

test('viewing attempt and recommendation are complete before optional sharing, and stay complete if sharing is aborted',async()=>{const x=setup();let release=()=>{};try{
 await x.ready();x.setWantShare(true);x.setHoldShare(new Promise<void>(resolve=>release=resolve));
 await x.engine.action({action:'bili.recommend',input:video.bvid});const running=x.engine.tick();
 await waitFor(()=>x.calls.some(c=>c.system.includes('【此刻是否想分享】')));
 const attempt=x.engine.data.attempts()[0],record=x.engine.data.records()[0];assert.ok(record);
 assert.equal(attempt.status,'succeeded');assert.equal(x.store.jobs().find(j=>j.id===attempt.id)?.status,'succeeded');
 assert.equal(x.engine.data.recommendations()[0].status,'done');
 x.engine.suppressShares();release();await running;
 assert.equal(x.engine.data.attempts()[0].status,'succeeded');assert.equal(x.store.jobs().find(j=>j.id===attempt.id)?.status,'succeeded');
 assert.equal(x.engine.data.recommendations()[0].status,'done');assert.ok(x.engine.data.record(record.id));
 assert.notEqual(x.engine.data.record(record.id)?.shareStatus,'pending');assert.equal(x.store.messages().length,0);
 }finally{release();await x.close();}});

test('an in-memory share draft is not restored or sent after restarting the Bilibili service',async()=>{const x=setup();let resumed:BiliService|undefined;try{
 await x.ready();x.setWantShare(true);await x.engine.action({action:'bili.recommend',input:video.bvid});await x.engine.tick();
 const record=x.engine.data.records()[0];assert.equal(record.shareStatus,'pending');assert.equal(record.shareText,'');
 await x.disposeEngine();
 resumed=new BiliService(x.root,x.store,new Model(x.ctx,x.store),x.ctx,{canBrowse:()=>true,canDeliver:()=>true,system:()=>''},x.provider);
 assert.equal(resumed.data.record(record.id)?.shareStatus,'expired');resumed.deliver();assert.equal(x.store.messages().length,0);
 }finally{if(resumed)await resumed.dispose();await x.close();}});

test('deleting evidence after preparing a share discards that stale draft',async()=>{const x=setup();try{
 const now=Date.now();putMessage(x.store,'source-user','user',now-80000,'chat','一件暂时分享的事');
 x.store.addSource({id:'chat:source-user',kind:'user_fact',text:'一件暂时分享的事',occasion:'source-user',createdAt:now-80000,processed:false,revoked:false});
 const memory=x.store.saveMemory({kind:'user_fact',text:'一件暂时分享的事',sourceIds:['chat:source-user']})!;
 putMessage(x.store,'last-answer','assistant',now-70000,'chat','我记下了。');
 const r=x.engine.data.saveRecord(prior('stale-memory'),x.engine.data.version())!;addDraft(x,r.id,'last-answer');
 x.store.deleteMemories([memory.id]);x.engine.deliver();
 assert.notEqual(x.engine.data.record(r.id)?.shareStatus,'pending');
 assert.equal(x.store.messages().filter(m=>m.origin==='proactive').length,0);
 }finally{await x.close();}});

test('deleting a video with a pending private share clears its in-memory draft immediately',async()=>{const x=setup();try{
 const record=x.engine.data.saveRecord(prior('video-to-delete'),x.engine.data.version())!;addDraft(x,record.id);
 assert.equal((x.engine as any).shareDrafts.has(record.id),true);
 await x.engine.action({action:'bili.delete',ids:[record.id]});
 assert.equal(x.engine.data.record(record.id),null);assert.equal((x.engine as any).shareDrafts.has(record.id),false);
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
  await x.disposeEngine();x.providerCalls.length=0;
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
