import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { Service, quietIntent } from '../src/service.js';
import { Model, ModelFailure } from '../src/model.js';
import type { HostContext } from '../src/types.js';
const route={provider:'test',model:'text'};
function setup() {
 const root=mkdtempSync(join(tmpdir(),'keep-whale-test-')),store=new Store(root);
 const calls:any[]=[];let answer='我是你的伙伴，我们可以慢慢认识。',reason='stop',reportUsage=true;
 const llm={listProviders:()=>[{id:'test'}],listModels:async()=>[{id:'text',name:'Text',inputModalities:['text']},{id:'vision',name:'Vision',inputModalities:['text','image']}],resolveModelInfo:async(_p:string,m:string)=>({inputModalities:m==='vision'?['text','image']:['text'],context:{contextWindow:1000000}}),async*stream(options:any){calls.push(options);yield {type:'text-delta',text:answer.slice(0,5)};yield {type:'text-delta',text:answer.slice(5)};if(reportUsage)yield {type:'usage',usage:{inputTokens:200,outputTokens:80,cacheReadTokens:100,cacheWriteTokens:0}};yield {type:'finish',reason:{kind:reason}};}};
 const ctx={get:(name:string)=>name==='llm'?llm:name==='attachments'?{saveImages:async()=>[{attachmentId:'test-image'}]}:undefined,on:()=>()=>{},inject:()=>{}} as HostContext;
 store.patchSettings({model:route,priceRoute:route,prices:{input:30,cached:.6,output:120},dailyLimit:100});
 const service=new Service(store,ctx,root);
 return {root,store,service,ctx,calls,llm,setAnswer:(s:string)=>{answer=s;},setReason:(s:string)=>{reason=s;},withoutUsage:()=>{reportUsage=false;},close:async()=>{await service.dispose();store.close();rmSync(root,{recursive:true,force:true});}};
}
const waitFor=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('task did not settle');};
test('private chat streams through llm without native session and feed is known with no model call',async()=>{const x=setup();try{
 await x.service.action({action:'interaction',type:'feed',requestId:'feed-1'});assert.equal(x.calls.length,0);assert.equal(x.store.memories().length,0);
 await x.service.action({action:'chat',requestId:'req-1',text:'你知道我刚才做什么了吗？',imageIds:[]});await waitFor(()=>!x.service.snapshot().busy);
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].sessionId,undefined);assert.match(x.calls[0].system,/用户喂食/);assert.equal(x.store.messages().length,2);assert.equal(x.store.messages()[1].status,'complete');
 await x.service.action({action:'chat',requestId:'req-1',text:'重复网络请求',imageIds:[]});assert.equal(x.calls.length,1);
 assert.equal(x.store.sources().length,3);assert.equal(x.store.sources().filter(s=>s.provenance==='behavior').length,1);
 }finally{await x.close();}});
test('truncated replies do not become learning evidence; retry keeps original user message and bills separate attempt',async()=>{const x=setup();try{
 x.setReason('max-tokens');await x.service.action({action:'chat',requestId:'r',text:'你好',imageIds:[]});await waitFor(()=>!x.service.snapshot().busy);
 const a=x.store.messages().find(m=>m.role==='assistant')!;assert.equal(a.status,'failed');assert.equal(x.store.sources().length,1);assert.equal(x.store.sources()[0].kind,'user_fact');assert.equal(x.store.sources().some(s=>s.provenance==='behavior'),false);
 x.setReason('stop');await x.service.action({action:'retry',messageId:a.id,requestId:'retry'});await waitFor(()=>!x.service.snapshot().busy);
 assert.equal(x.store.messages().length,2);assert.equal(x.calls[1].maxTokens,8192);assert.equal(x.store.ledger().length,2);assert.equal(x.store.sources().length,3);assert.equal(x.store.sources().filter(s=>s.provenance==='behavior').length,1);
 }finally{await x.close();}});
test('explicit quiet boundary applies before model work, quoted or hypothetical statements do not',async()=>{const x=setup();try{
 assert.equal(quietIntent('今天别主动提醒我，我想安静一会儿'),true);assert.equal(quietIntent('不主动提醒我'),true);assert.equal(quietIntent('我不希望你只会附和'),null);assert.equal(quietIntent('她说“不要主动提醒我”'),null);
 await x.service.action({action:'chat',requestId:'quiet',text:'今天别主动提醒我，我想安静一会儿',imageIds:[]});assert.equal(x.store.settings().quiet,true);await waitFor(()=>!x.service.snapshot().busy);assert.match(x.calls[0].system,/用户开启了安静陪伴/);
 }finally{await x.close();}});
test('only fresh ordinary visible user text is observed, tool/reasoning/subagent/history and excluded sessions are ignored',async()=>{const x=setup();try{
 x.store.patchSettings({observeEnabled:true,excludedSessions:['old-companion'],excludedWorkspaces:['/private-work']});
 const event=(text:string,seq:number)=>({type:'user/message',seq,time:Date.now(),data:{source:{kind:'user'},content:[{type:'text',text},{type:'reasoning',text:'secret reasoning'}]}});
 for(const session of [{id:'old-companion',header:{cwd:'/work'}},{id:'sub',header:{origin:'subagent',cwd:'/work'}},{id:'excluded',header:{cwd:'/private-work/child'}}]){x.service.observe(session,event('私有',1));x.service.observe(session,{type:'turn/end',time:Date.now()});}
 const normal={id:'ordinary',header:{cwd:'/work'}};x.service.observe(normal,{type:'turn/start',time:Date.now()});x.service.observe(normal,event('我喜欢下雨天',2));
 x.service.observe(normal,{type:'assistant/message',time:Date.now(),data:{message:{content:[{type:'text',text:'你讨厌雨'}]}}});
 assert.equal(x.store.sources().length,0);x.service.observe(normal,{type:'turn/end',time:Date.now()});
 assert.equal(x.store.sources().length,1);assert.equal(x.store.sources()[0].kind,'observed_dialogue');assert.equal(x.store.sources()[0].text,'我喜欢下雨天');assert.equal(x.store.sources()[0].context,'你讨厌雨');
 }finally{await x.close();}});
test('presence is monotonic, stale window blocks proactive, explicit close removes it',async()=>{const x=setup();try{
 const now=Date.now();x.service.presence({windowId:'a',seq:1,visible:true,typing:false,lastInputAt:now-4000});assert.equal(x.service.canDeliver(now),true);
 x.service.presence({windowId:'b',seq:2,visible:true,typing:true,lastInputAt:now});x.service.presence({windowId:'b',seq:1,visible:true,typing:false,lastInputAt:now-4000});assert.equal(x.service.canDeliver(now),false);
 x.service.presence({windowId:'a',seq:2,visible:true,typing:false,lastInputAt:now-4000});assert.equal(x.service.canDeliver(now+21000),false);
 x.service.presence({windowId:'b',seq:3,closed:true});x.service.presence({windowId:'b',seq:2,visible:true,typing:true,lastInputAt:now});assert.equal(x.service.canDeliver(now),true);
 }finally{await x.close();}});
test('model capability follows exact selected route and unknown user-chat cost is visible',async()=>{const x=setup();try{
 await x.service.refreshModels();assert.equal(x.service.snapshot().capability.images,false);x.store.patchSettings({model:{provider:'test',model:'vision'}});assert.equal(x.service.snapshot().capability.images,true);
 x.store.patchSettings({model:null});assert.equal(x.service.snapshot().capability.chat,false);
 x.store.patchSettings({model:route});x.withoutUsage();await x.service.action({action:'chat',requestId:'unknown',text:'你好',imageIds:[]});await waitFor(()=>!x.service.snapshot().busy);
 assert.equal(x.store.usage().chatUncertain,true);assert.equal(x.store.usage().uncertain,false);
 }finally{await x.close();}});
test('failed memory task does not block a later source or invent unsupported facts',async()=>{const x=setup();try{
 const first={id:'first',kind:'user_fact' as const,text:'我喜欢茶',occasion:'one',createdAt:Date.now(),processed:false,revoked:false};x.store.addSource(first);
 x.store.putJob({id:'memory:first',kind:'memory',status:'failed',stage:'未完成',reason:'network',sourceIds:['first'],createdAt:Date.now(),updatedAt:Date.now()});
 x.store.addSource({...first,id:'second',text:'我喜欢下雨天',occasion:'two'});x.setAnswer(JSON.stringify({memories:[{kind:'user_fact',text:'用户喜欢下雨天',sourceIds:['second'],quote:'喜欢下雨天'},{kind:'user_fact',text:'用户住在火星',sourceIds:['nonexistent'],quote:'火星'}]}));
 await x.service.tick();assert.equal(x.calls.length,1);assert.equal(x.store.memories().length,1);assert.equal(x.store.memories()[0].text,'用户喜欢下雨天');
 }finally{await x.close();}});
test('background missing usage pauses and does not turn a failed response into successful memory',async()=>{const x=setup();try{
 x.withoutUsage();x.setReason('max-tokens');x.store.addSource({id:'first',kind:'user_fact',text:'我喜欢茶',occasion:'one',createdAt:Date.now(),processed:false,revoked:false});
 await x.service.tick();assert.equal(x.store.usage().uncertain,true);assert.equal(x.calls.length,1);assert.equal(x.store.memories().length,0);assert.equal(x.store.jobs()[0].status,'failed');
 }finally{await x.close();}});

test('proactive delivery writes only one assistant message per occasion and never invents a user turn',async()=>{const x=setup();try{
 const now=Date.now();const common={text:'我喜欢从不同角度理解小说人物',occasion:'same-occasion',createdAt:now-61000,processed:false,revoked:false};
 x.store.addSource({...common,id:'user-source',kind:'user_fact'});x.store.addSource({...common,id:'episode-source',kind:'shared_episode'});x.store.markProcessed(['user-source','episode-source']);
 x.service.presence({windowId:'window',seq:1,typing:false,visible:true,lastInputAt:now-4000});x.setAnswer(JSON.stringify({send:true,text:'刚才说的理解与赞同，我还想到一个区别。'}));
 await x.service.tick();await x.service.tick();assert.equal(x.calls.length,1);assert.equal(x.store.messages().length,1);assert.equal(x.store.messages()[0].role,'assistant');assert.equal(x.store.messages()[0].origin,'proactive');assert.equal(x.store.sources().length,2);
 }finally{await x.close();}});
test('only local imported media can be selected as a skin',async()=>{const x=setup();try{
 assert.throws(()=>x.store.patchSettings({skin:'https://example.com/tracking.png'}));assert.throws(()=>x.store.patchSettings({skin:'file:///private/test.png'}));
 x.store.patchSettings({skin:'/keep-whale/media/11111111-1111-1111-1111-111111111111'});assert.match(x.store.settings().skin!,/^\/keep-whale/);
 }finally{await x.close();}});

test('topic recall finds an old grounded event instead of unrelated latest memories',async()=>{const x=setup();try{
 const add=(id:string,text:string,when:number)=>{x.store.addSource({id,kind:'user_fact',text,occasion:id,createdAt:when,processed:false,revoked:false});return x.store.saveMemory({kind:'user_fact',text,sourceIds:[id],evidence:[{sourceId:id,quote:text}]})!;};
 const old=add('exam','我参加过海洋大学面试，面试官问了并发编程',Date.now()-180*86400000);
 for(let i=0;i<45;i++)add('recent'+i,'今日早餐是面包和牛奶，第'+i+'条',Date.now()+i);
 await x.service.action({action:'chat',requestId:'recall-old',text:'海洋大学面试问了什么？',imageIds:[]});await waitFor(()=>!x.service.snapshot().busy);
 assert.ok(x.calls[0].system.includes(old.text));assert.ok(!x.calls[0].system.includes('第44条'));assert.equal(x.store.ledger().length,1);
 }finally{await x.close();}});

test('management search, evidence details and personality correction never write chat messages',async()=>{const x=setup();try{
 const src={id:'fact',kind:'user_fact' as const,text:'那次我更希望你解释理由',occasion:'one',createdAt:Date.now(),processed:false,revoked:false};x.store.addSource(src);
 const m=x.store.saveMemory({kind:'understanding',text:'用户可能更重视解释理由',sourceIds:[src.id],evidence:[{sourceId:src.id,quote:src.text}],status:'uncertain'})!;
 const page=await x.service.action({action:'memory.list',query:'解释理由',limit:10});assert.equal(page.total,1);
 const detail=await x.service.action({action:'memory.detail',id:m.id});assert.equal(detail.sources[0].text,src.text);
 await assert.rejects(x.service.action({action:'memory.edit',id:m.id,text:'立刻变成指定人格'}));
 await x.service.action({action:'memory.correct',id:m.id,text:'这是针对那道题的要求，不是对所有聊天的期待'});
 assert.equal(x.store.messages().length,0);assert.equal(x.calls.length,0);
 const profile=await x.service.action({action:'memory.profile'});assert.equal(profile.tendencies.length,0);assert.ok(profile.tentative.length>=1);
 }finally{await x.close();}});

test('deleted evidence is absent from the next model context while original chat stays visible',async()=>{const x=setup();try{
 await x.service.action({action:'chat',requestId:'private-fact',text:'我的秘密代号是海蓝石',imageIds:[]});await waitFor(()=>!x.service.snapshot().busy);
 const s=x.store.sources().find(s=>s.kind==='user_fact')!;
 const m=x.store.saveMemory({kind:'user_fact',text:'用户秘密代号是海蓝石',sourceIds:[s.id],evidence:[{sourceId:s.id,quote:s.text}]})!;
 const preview=await x.service.action({action:'memory.preview',ids:[m.id]});await x.service.action({action:'memory.delete',ids:preview.ids,revision:preview.revision,confirm:true});
 assert.ok(x.store.messages().some(m=>m.text.includes('海蓝石')));
 await x.service.action({action:'chat',requestId:'after-delete',text:'我们来聊聊春天',imageIds:[]});await waitFor(()=>!x.service.snapshot().busy);
 assert.doesNotMatch(JSON.stringify({system:x.calls[1].system,messages:x.calls[1].messages}),/海蓝石/);
 }finally{await x.close();}});

test('memory truncation retries only a smaller batch and leaves other sources eligible',async()=>{const x=setup();try{
 for(let i=0;i<8;i++)x.store.addSource({id:'batch'+i,kind:'user_fact',text:'独立信息'+i,occasion:'occasion'+i,createdAt:Date.now()+i,processed:false,revoked:false});
 let n=0;x.llm.stream=async function*(options:any){x.calls.push(options);n++;yield {type:'text-delta',text:JSON.stringify({memories:[]})};yield {type:'usage',usage:{inputTokens:200,outputTokens:80,cacheReadTokens:0,cacheWriteTokens:0}};yield {type:'finish',reason:{kind:n===1?'max-tokens':'stop'}};};
 await x.service.tick();assert.equal(x.calls.length,2);
 assert.equal(JSON.parse(x.calls[0].messages[0].content[0].text).newSources.length,8);assert.equal(JSON.parse(x.calls[1].messages[0].content[0].text).newSources.length,4);
 assert.equal(x.store.pendingSources().length,4);
 await x.service.tick();assert.equal(x.calls.length,3);assert.equal(x.store.pendingSources().length,0);
 }finally{await x.close();}});
