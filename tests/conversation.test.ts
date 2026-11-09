import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Service } from '../src/service.js';
import type { HostContext, Message } from '../src/types.js';

function fixture(t: any) {
  const root=mkdtempSync(join(tmpdir(),'whale-conversation-'));
  let clockOffset=0;
  const store=new Store(root,()=>Date.now()+clockOffset);
  const route={provider:'test',model:'text'};
  store.patchSettings({model:route,priceRoute:route,prices:{input:30,cached:.6,output:120}});
  const calls:any[]=[];
  let answer=JSON.stringify({send:true,text:'同一件事里，理解一个人的处境和认可他的做法确实可以分开。'});
  let hold:Promise<void>=Promise.resolve();
  const llm={resolveModelInfo:async()=>({context:{contextWindow:1000000}}),async*stream(options:any){
    calls.push(options);await hold;
    yield {type:'text-delta',text:answer};
    yield {type:'usage',usage:{inputTokens:100,outputTokens:100}};
    yield {type:'finish',reason:{kind:'stop'}};
  }};
  const ctx:HostContext={get:(name:string)=>name==='llm'?llm:undefined,on:()=>()=>{},inject:()=>{}};
  const service=new Service(store,ctx,root);
  let seq=0;
  const presence=(typing=false)=>service.presence({windowId:'window',seq:++seq,typing,visible:true,lastInputAt:Date.now()-4000});
  presence();
  const message=(id:string,role:Message['role'],text:string,at:number,patch:Partial<Message>={})=>{
    store.putMessage({id,chatId:store.companion().id,role,text,images:[],status:'complete',createdAt:at,origin:'chat',requestId:id,...patch});
  };
  const source=(id:string,occasion=id,at=Date.now()-65000)=>{
    store.addSource({id,kind:'user_fact',provenance:'user_statement',text:'我觉得理解与赞同不是一回事',occasion,createdAt:at,processed:false,revoked:false});
    store.markProcessed([id]);
  };
  t.after(async()=>{await service.dispose();store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,service,calls,presence,message,source,setClockOffset:(offset:number)=>{clockOffset=offset;},setAnswer:(text:string)=>{answer=text;},hold:(promise:Promise<void>)=>{hold=promise;}};
}

async function until(check:()=>boolean) {
  for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('model task did not settle');
}

test('variable length replies remain complete single turns without fabricated continuation messages',async t=>{
  const f=fixture(t);
  const answers=['嗯，我也这么想。','我比较在意的是你说的那个区别。理解一个人的处境，未必就得认可他的选择。\n\n有些行为可以理解缘由，但责任仍然是另一回事。'];
  for(const [i,answer] of answers.entries()){
    f.setAnswer(answer);
    await f.service.action({action:'chat',requestId:'turn'+i,text:'我们接着聊这个区别',imageIds:[]});
    await until(()=>!f.service.snapshot().busy);
    assert.equal(f.store.findRequest('turn'+i,'assistant')?.text,answer);
    assert.equal(f.store.findRequest('turn'+i,'assistant')?.status,'complete');
  }
  assert.equal(f.calls.length,2);
  assert.equal(f.store.messages().length,4);
  assert.equal(f.store.messages().some(m=>m.origin==='proactive'),false);
  assert.equal(f.calls.some(call=>call.sessionId),false);
});

test('voluntary follow-up gives the user the floor across sources and a service restart',async t=>{
  const f=fixture(t);
  f.source('one');f.source('two');
  await f.service.tick();await f.service.tick();
  assert.equal(f.calls.length,1);
  assert.equal(f.store.messages().length,1);
  assert.equal(f.store.messages()[0].origin,'proactive');
  const restarted=new Service(f.store,{get:()=>undefined,on:()=>()=>{},inject:()=>{}},f.root);
  restarted.presence({windowId:'new',seq:1,typing:false,lastInputAt:Date.now()-4000});
  const jobsBefore=f.store.jobs().length;
  await restarted.tick();assert.equal(f.store.jobs().length,jobsBefore);
  await restarted.dispose();
  f.message('user-back','user','这个角度确实有意思',Date.now()+1);
  assert.equal(f.service.canDeliver(),false,'a new user turn should get its normal reply first');
  f.message('reply','assistant','对，解释缘由与承担责任可以同时成立。',Date.now()+2,{requestId:'user-back'});
  assert.equal(f.service.canDeliver(),true);
});

test('continuation includes complete dated turns, excludes partial output and respects withdrawn evidence',async t=>{
  const f=fixture(t),now=Date.now();
  f.message('secret','user','我的秘密代号是海蓝石',now-80000);
  f.store.addSource({id:'chat:secret',kind:'user_fact',text:'我的秘密代号是海蓝石',occasion:'secret',createdAt:now-80000,processed:false,revoked:false});
  const memory=f.store.saveMemory({kind:'user_fact',text:'用户代号是海蓝石',sourceIds:['chat:secret']})!;
  f.store.deleteMemories([memory.id]);
  for(const [i,status] of (['failed','cancelled','streaming'] as const).entries())f.message('partial'+i,'assistant','不应送给接话模型的半句话'+i,now-79000+i,{status});
  f.message('current','user','说回刚才的小说',now-70000);
  f.message('finished','assistant','同意这个人有自己的难处。',now-69000,{requestId:'current'});
  f.source('chat:current','current',now-70000);
  await f.service.tick();
  const request=JSON.parse(f.calls[0].messages[0].content[0].text);
  assert.ok(Number.isFinite(Date.parse(request.now)));
  assert.deepEqual(request.recent.map((m:any)=>m.id),['secret','current','finished']);
  assert.ok(request.recent.every((m:any)=>Number.isFinite(Date.parse(m.at))&&m.origin==='chat'));
  assert.doesNotMatch(JSON.stringify(request),/海蓝石|半句话/);
});

test('older private turns cannot become a follow-up after the conversation has moved on',async t=>{
  const f=fixture(t),now=Date.now();
  f.message('old','user','刚才在讨论小说',now-120000);
  f.message('old-reply','assistant','是啊。',now-119000,{requestId:'old'});
  f.source('chat:old','old',now-120000);f.source('episode:old','old',now-120000);
  f.message('new','user','我想聊聊今天的晚饭',now-70000);
  f.message('new-reply','assistant','我有点好奇你做了什么。',now-69000,{requestId:'new'});
  await f.service.tick();assert.equal(f.calls.length,0);
  f.source('chat:new','new',now-70000);
  await f.service.tick();assert.equal(f.calls.length,1);
  assert.equal(JSON.parse(f.calls[0].messages[0].content[0].text).trigger.id,'chat:new');
});

for(const interrupt of ['typing','quiet','new-turn'] as const)test(`in-flight follow-up is discarded after ${interrupt}`,async t=>{
  const f=fixture(t);f.source('pending');
  let release!:()=>void;f.hold(new Promise<void>(resolve=>{release=resolve;}));
  const running=f.service.tick();
  try {
    await until(()=>f.calls.length===1);
    if(interrupt==='typing')f.presence(true);
    if(interrupt==='quiet')await f.service.action({action:'settings',patch:{quiet:true}});
    if(interrupt==='new-turn'){
      // Simulates a fresh complete exchange written while the old draft is in flight.
      // Presence alone is eligible again, but the prior conversational context is stale.
      f.message('new-user','user','换个话题吧',Date.now());
      f.message('new-answer','assistant','好，说说你现在想聊的。',Date.now()+1,{requestId:'new-user'});
      assert.equal(f.service.canDeliver(),true);
    }
  } finally {release();await running;}
  assert.equal(f.store.messages().some(m=>m.origin==='proactive'),false);
  assert.equal(f.store.jobs().find(j=>j.kind==='proactive')?.stage,'未发送');
});

test('choosing silence is final for the occasion and never becomes a user message',async t=>{
  const f=fixture(t);f.source('quiet-choice');f.setAnswer(JSON.stringify({send:false,text:''}));
  await f.service.tick();await f.service.tick();
  assert.equal(f.calls.length,1);assert.equal(f.store.messages().length,0);
  assert.equal(f.store.jobs().find(j=>j.kind==='proactive')?.status,'skipped');
});

test('failed or cancelled direct replies are not resumed by unsolicited contact',async t=>{
  const f=fixture(t);f.source('available');
  f.message('user','user','我们讨论一下这个人物',Date.now()-70000);
  f.message('unfinished','assistant','我觉得',Date.now()-69000,{status:'failed',requestId:'user'});
  await f.service.tick();assert.equal(f.calls.length,0);
  f.store.updateMessage('unfinished',{status:'cancelled'});
  await f.service.tick();assert.equal(f.calls.length,0);
});

test('a genuinely new allowed observation can warrant contact, but old observations cannot pile up',async t=>{
  const f=fixture(t),now=Date.now();
  f.setClockOffset(-180000);f.store.patchSettings({observeEnabled:true});f.setClockOffset(0);
  f.message('previous-contact','assistant','刚才那个区别让我想到人物动机。',now-120000,{origin:'proactive'});
  for(const [id,at] of [['old-observation',now-150000],['new-observation',now-65000]] as const){
    f.store.addSource({id,kind:'observed_dialogue',provenance:'observation',text:'用户在普通对话中分享了一个新的阅读发现',occasion:id,createdAt:at,sessionId:'ordinary',workspace:'/allowed',processed:false,revoked:false});
    f.store.markProcessed([id]);
  }
  await f.service.tick();await f.service.tick();
  assert.equal(f.calls.length,1);
  assert.equal(JSON.parse(f.calls[0].messages[0].content[0].text).trigger.id,'new-observation');
  assert.equal(f.store.messages().filter(m=>m.origin==='proactive').length,2);
});

for(const patch of [{observeEnabled:false},{excludedSessions:['excluded']},{excludedWorkspaces:['/excluded'] }])test('updated observation scope excludes processed sources from proactive contact '+JSON.stringify(patch),async t=>{
  const f=fixture(t),now=Date.now();
  f.setClockOffset(-180000);f.store.patchSettings({observeEnabled:true});f.setClockOffset(0);
  f.store.addSource({id:'observation',kind:'observed_dialogue',text:'我发现了一个新观点',occasion:'observation',createdAt:now-65000,sessionId:'excluded',workspace:'/excluded',processed:false,revoked:false});
  f.store.markProcessed(['observation']);f.store.patchSettings(patch);
  await f.service.tick();assert.equal(f.calls.length,0);assert.equal(f.store.messages().length,0);
});
