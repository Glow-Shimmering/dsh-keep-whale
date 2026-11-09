import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.js';
import { searchTerms, cosine, recencyWeight } from '../src/core/memory.js';
import type { Source, Memory } from '../src/types.js';

const setup = () => {
  const root=mkdtempSync(join(tmpdir(),'keep-whale-network-')); let time=Date.parse('2026-11-08T02:00:00Z');
  const store=new Store(root,()=>time); return {root,store,now:()=>time,advance:(ms:number)=>{time+=ms;},close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
};
const src=(id:string,text:string,time:number,extra:Partial<Source>={}):Source=>({id,kind:'user_fact',text,occasion:id,createdAt:time,processed:false,revoked:false,provenance:'user_statement',...extra});
const add=(s:Store,id:string,text:string,t:number)=>{s.addSource(src(id,text,t));return s.saveMemory({kind:'user_fact',text,sourceIds:[id],evidence:[{sourceId:id,quote:text}]})!;};

test('legacy migration creates recoverable pre-migration SQLite snapshot including WAL and never invents quotes',()=>{
  const root=mkdtempSync(join(tmpdir(),'keep-whale-migrate-')),path=join(root,'keep-whale.sqlite');
  const old=new DatabaseSync(path);old.exec('PRAGMA journal_mode=WAL; CREATE TABLE sources(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,processed INTEGER NOT NULL,revoked INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE memories(id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,data TEXT NOT NULL);');
  const source=src('legacy-source','旧事实',100);const memory:Memory={id:'legacy',kind:'user_fact',text:'旧事实',sourceIds:['legacy-source'],createdAt:100,updatedAt:100};
  old.prepare('INSERT INTO sources VALUES(?,?,1,0,?)').run(source.id,100,JSON.stringify(source));old.prepare('INSERT INTO memories VALUES(?,?,?)').run(memory.id,100,JSON.stringify(memory));
  const store=new Store(root,()=>1000);
  try {
    assert.equal(store.memoryDetail('legacy')?.memory.text,'旧事实');
    assert.equal(store.memoryDetail('legacy')?.memory.evidence,undefined);
    const files=readdirSync(root).filter(x=>x.startsWith('keep-whale.before-memory-network-')&&x.endsWith('.sqlite'));assert.equal(files.length,1);
    const backup=new DatabaseSync(join(root,files[0]),{readOnly:true});
    try {assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n,1);assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');} finally {backup.close();}
    store.close();const reopened=new Store(root,()=>1000);try {assert.equal(reopened.memories().length,1);assert.equal(readdirSync(root).filter(x=>x.startsWith('keep-whale.before-memory-network-')).length,1);} finally {reopened.close();}
  } finally {store.close();old.close();rmSync(root,{recursive:true,force:true});}
});

test('lexical, local semantic and two-hop relations find relevant memories without generic stopword flood',()=>{
  const e=setup();try {
    const a=add(e.store,'a','用户喜欢青花瓷',e.now()); const b=add(e.store,'b','雨夜散步',e.now()); const c=add(e.store,'c','靠窗听雨',e.now()); const d=add(e.store,'d','远方绿茶',e.now());
    e.store.linkMemories({fromId:a.id,toId:b.id,kind:'related',evidence:[]});e.store.linkMemories({fromId:b.id,toId:c.id,kind:'related',evidence:[]});
    const lexical=e.store.recall('还记得青花瓷吗');assert.ok(lexical.hits.some(x=>x.memory.id===a.id));assert.ok(lexical.hits.some(x=>x.memory.id===c.id));assert.ok(!lexical.hits.some(x=>x.memory.id===d.id));
    const rev=e.store.revision();assert.equal(e.store.saveVector(d.id,d.version!, 'r1',[0,1],rev),true);
    const hybrid=e.store.recall('茶话题',{vector:[0,1],routeKey:'r1'});assert.equal(hybrid.mode,'hybrid');assert.ok(hybrid.hits.some(x=>x.memory.id===d.id));
    assert.equal(e.store.recall('茶话题',{vector:[0,1],routeKey:'wrong'}).mode,'local');
    assert.equal(cosine([1,0],[0,1]),0);assert.ok(recencyWeight(e.now()-365*86400000,e.now())>0);
    assert.deepEqual(searchTerms('你我吗呢的了'),[]);assert.ok(searchTerms('小余').includes('小余'));assert.ok(searchTerms('猫').includes('猫'));
  }finally{e.close();}
});

test('verified evidence merges exact duplicates once and never reinforces repeated same evidence',()=>{
  const e=setup();try {
    e.store.addSource(src('s1','我喜欢茶，也喜欢棋',e.now()));
    const input={kind:'user_fact' as const,text:'用户喜欢茶',sourceIds:['s1'],evidence:[{sourceId:'s1',quote:'喜欢茶'}]};
    const first=e.store.saveMemory(input)!;assert.equal(e.store.saveMemory({...input,evidence:[{sourceId:'s1',quote:'假引用'}]}),null);
    e.advance(86400000);const duplicate=e.store.saveMemory(input)!;assert.equal(duplicate.id,first.id);assert.equal(duplicate.version,first.version);assert.equal(duplicate.reinforcedAt,first.reinforcedAt);
    e.store.addSource(src('s2','我确实喜欢茶',e.now()));const more=e.store.saveMemory({...input,sourceIds:['s2'],evidence:[{sourceId:'s2',quote:'喜欢茶'}]})!;
    assert.equal(more.id,first.id);assert.equal(more.version,2);assert.deepEqual(new Set(more.sourceIds),new Set(['s1','s2']));assert.equal(e.store.memories().length,1);
  }finally{e.close();}
});

test('preview keeps roots distinct; deletion masks exact evidence and cascades only dependencies',()=>{
  const e=setup();try {
    e.store.addSource(src('chat:u','我喜欢红茶，也喜欢围棋',e.now()));
    const a=e.store.saveMemory({kind:'user_fact',text:'用户喜欢红茶',sourceIds:['chat:u'],evidence:[{sourceId:'chat:u',quote:'喜欢红茶'}]})!;
    const b=e.store.saveMemory({kind:'user_fact',text:'用户喜欢围棋',sourceIds:['chat:u'],evidence:[{sourceId:'chat:u',quote:'喜欢围棋'}]})!;
    e.store.addSource(src('independent','用户喜欢围棋',e.now()));const c=e.store.saveMemory({kind:'user_fact',text:'另一个围棋事实',sourceIds:['independent'],evidence:[{sourceId:'independent',quote:'喜欢围棋'}],parentMemoryIds:[a.id]})!;
    const preview=e.store.deletePreview([a.id]);assert.deepEqual(preview.ids,[a.id]);assert.deepEqual(new Set(preview.memories.map(m=>m.id)),new Set([a.id,c.id]));
    e.store.deleteMemories(preview.ids,preview.revision);assert.ok(e.store.memoryDetail(b.id));assert.equal(e.store.memoryDetail(c.id),null);
    assert.match(e.store.sources().find(s=>s.id==='chat:u')!.text,/█/);
    assert.equal(e.store.saveMemory({kind:'user_fact',text:'用户喜欢红茶',sourceIds:['chat:u'],evidence:[{sourceId:'chat:u',quote:'喜欢红茶'}]}),null);
    assert.ok(e.store.memoryDetail(b.id));
  }finally{e.close();}
});

test('delete preview revisions catch later graph changes; late vectors cannot resurrect deleted memories',()=>{
  const e=setup();try {
    const a=add(e.store,'a','旧时爱喝红茶',e.now());const rev=e.store.revision();assert.equal(e.store.saveVector(a.id,1,'r',[1,0],rev),true);
    const preview=e.store.deletePreview([a.id]);add(e.store,'new','新发生的来源',e.now());assert.throws(()=>e.store.deleteMemories(preview.ids,preview.revision),/重新预览/);
    e.store.deleteMemories([a.id]);assert.equal(e.store.saveVector(a.id,1,'r',[1,0],rev),false);assert.equal(e.store.vectorCounts('r').indexed,0);
  }finally{e.close();}
});

test('growth requires grounded independent evidence; self declarations and expectations cannot prove growth; counter evidence cannot promote',()=>{
  const e=setup();try {
    const facts=['我觉得你上次分析有理','你这次的解释有自己的理由','那次你没有附和我'];
    for(let i=0;i<3;i++){if(i===2)e.advance(86400000);e.store.addSource(src('p'+i,facts[i],e.now(),{occasion:'o'+i}));}
    const evidence=facts.map((quote,i)=>({sourceId:'p'+i,quote}));
    const valid=e.store.saveMemory({kind:'tendency',text:'有自己的判断',sourceIds:['p0','p1','p2'],evidence});assert.ok(valid);assert.equal(valid.status,'active');
    e.store.addSource(src('counter','你那次完全附和',e.now()));
    const changed=e.store.saveMemory({kind:'tendency',text:'有自己的判断',sourceIds:['p0','p1','p2','counter'],evidence,counterEvidence:[{sourceId:'counter',quote:'你那次完全附和'}]})!;assert.equal(changed.status,'uncertain');
    e.store.addSource(src('self','我已经变得更有主见',e.now(),{kind:'shared_episode',provenance:'behavior'}));
    assert.equal(e.store.saveMemory({kind:'tendency',text:'变得更有主见',sourceIds:['p0','p1','self'],evidence:[...evidence.slice(0,2),{sourceId:'self',quote:'我已经变得更有主见'}]}),null);
    assert.equal(e.store.saveMemory({kind:'shared_episode',text:'自我评价不作事实',sourceIds:['self'],evidence:[{sourceId:'self',quote:'我已经变得更有主见'}]}),null);
  }finally{e.close();}
});

test('observation restrictions prevent new derived memories and vector transmission but keep old memory locally readable',()=>{
  const e=setup();try {
    e.store.patchSettings({observeEnabled:true});const obs=src('obs','我喜欢黄昏',e.now(),{kind:'observed_dialogue',sessionId:'session',workspace:'/a'});e.store.addSource(obs);
    const m=e.store.saveMemory({kind:'observed_dialogue',text:'旁观得知用户喜欢黄昏',sourceIds:['obs'],evidence:[{sourceId:'obs',quote:'喜欢黄昏'}]})!;e.store.markProcessed(['obs']);
    e.store.patchSettings({observeEnabled:false});assert.equal(e.store.pendingVectors('r').length,0);assert.equal(e.store.saveVector(m.id,1,'r',[1,0],e.store.revision()),false);
    assert.equal(e.store.saveMemory({kind:'observed_dialogue',text:'不可派生',sourceIds:['obs'],evidence:[{sourceId:'obs',quote:'喜欢黄昏'}]}),null);
    assert.ok(e.store.recall('黄昏').hits.some(x=>x.memory.id===m.id));
  }finally{e.close();}
});

test('manager search paginates beyond 100 results and dormant state is inspectable',()=>{
  const e=setup();try {
    for(let i=0;i<115;i++)add(e.store,'s'+i,`用户喜欢白猫第${i}条`,e.now());
    const page=e.store.memoryPage({query:'白猫',offset:100,limit:20});assert.equal(page.total,115);assert.equal(page.items.length,15);
    const blocked=e.store.pendingVectors('route',100).map(m=>m.id);const later=e.store.pendingVectors('route',8,blocked);assert.equal(later.length,8);assert.ok(later.every(m=>!blocked.includes(m.id)));
    e.advance(91*86400000);assert.equal(e.store.memoryPage({state:'dormant',limit:1}).total,115);
    assert.equal(e.store.recall('白猫',{limit:115,maxChars:Number.MAX_SAFE_INTEGER}).hits.length,115);
  }finally{e.close();}
});

test('old failed sources never starve later work and historical jobs remain searchable',()=>{
  const e=setup();try {
    for(let i=0;i<105;i++){
      const id='old'+i;e.store.addSource(src(id,'历史信息'+i,e.now()));
      e.store.putJob({id:'job'+i,kind:'memory',status:'failed',stage:'失败',reason:'网络',sourceIds:[id],createdAt:e.now(),updatedAt:e.now()});
    }
    for(let i=0;i<510;i++)e.store.putJob({id:'irrelevant'+i,kind:'chat',status:'succeeded',stage:'完成',reason:'',sourceIds:[],createdAt:e.now()+i+1,updatedAt:e.now()+i+1});
    e.store.addSource(src('fresh','最新信息',e.now()+1000));
    assert.equal(e.store.jobById('job0')?.status,'failed');assert.equal(e.store.hasSourceJob('memory',['old0']),true);
    assert.deepEqual(e.store.pendingSources(8,{unattempted:true}).map(s=>s.id),['fresh']);
  }finally{e.close();}
});

test('embedding accounting requires verified conversion, keeps raw audit details and shares budget',()=>{
  const e=setup();try {
    const details={provider:'embedding',model:'embed',rawUnit:'积分',conversionRate:1/30,priceVerified:true,rawReserved:3};
    assert.throws(()=>e.store.reserve('bad',0.2,true,details),/换算/);
    const ticket=e.store.reserve('embedding',0.1,true,details);assert.equal(e.store.usage().reserved,0.1);
    e.store.settle(ticket,0.05,{rawActual:1.5,inputTokens:1000});
    assert.equal(e.store.usage().spent,0.05);assert.equal(e.store.ledger()[0].details?.inputTokens,1000);
    assert.equal(e.store.ledger()[0].details?.rawActual,1.5);
  }finally{e.close();}
});

test('memory changes and relation changes invalidate deletion preview without invalidating batch knowledge revision',()=>{
  const e=setup();try {
    const a=add(e.store,'a','来源甲',e.now());const rev=e.store.revision(),preview=e.store.deletePreview([a.id]);
    const b=add(e.store,'b','来源乙',e.now());assert.equal(e.store.revision(),rev);
    e.store.linkMemories({fromId:b.id,toId:a.id,kind:'derived_from',evidence:[]},rev);
    assert.equal(e.store.revision(),rev);assert.throws(()=>e.store.deleteMemories(preview.ids,preview.revision),/重新预览/);
  }finally{e.close();}
});

test('removing the claim that superseded a fact restores its previous state and retains history',()=>{
  const e=setup();try {
    const old=add(e.store,'old','以前喜欢红茶',e.now());e.advance(86400000);
    const current=add(e.store,'new','现在喜欢绿茶',e.now());
    assert.ok(e.store.linkMemories({fromId:current.id,toId:old.id,kind:'updates',evidence:[{sourceId:'new',quote:'现在喜欢绿茶'}]}));
    assert.equal(e.store.memoryDetail(old.id)?.memory.status,'superseded');
    e.store.deleteMemories([current.id]);
    assert.equal(e.store.memoryDetail(old.id)?.memory.status,'active');
    assert.ok(e.store.memoryDetail(old.id)!.history.length>0);
  }finally{e.close();}
});

test('clear-all preview and deletion cover more than 5000 memories without truncation',()=>{
  const e=setup();try {
    const db=new DatabaseSync(join(e.root,'keep-whale.sqlite'));
    try {
      db.exec('BEGIN');const insert=db.prepare('INSERT INTO memories(id,updated_at,data) VALUES(?,?,?)');
      for(let i=0;i<5001;i++) {const m:Memory={id:'bulk'+i,kind:'user_fact',text:'合成记忆'+i,sourceIds:['synthetic'+i],createdAt:i,updatedAt:i};insert.run(m.id,i,JSON.stringify(m));}
      db.exec('COMMIT');
    } finally {db.close();}
    const ids=e.store.memories().map(m=>m.id);assert.equal(ids.length,5001);
    const preview=e.store.deletePreview(ids);assert.equal(preview.ids.length,5001);assert.equal(preview.memories.length,5001);
    e.store.deleteMemories(preview.ids,preview.revision);assert.equal(e.store.memories().length,0);
  }finally{e.close();}
});

test('actual occasions and exact subject-topic keys create bounded local retrieval links',()=>{
  const e=setup();try {
    const put=(id:string,text:string,occasion:string,topicKey:string)=>{
      e.store.addSource(src(id,text,e.now(),{occasion}));
      return e.store.saveMemory({kind:'user_fact',text,sourceIds:[id],evidence:[{sourceId:id,quote:text}],topicKey})!;
    };
    const first=put('sealion','用户看到海狮','event1','用户:海洋');
    const second=put('parrot','用户喜欢鹦鹉','event1','用户:鸟类');
    const third=put('eagle','用户观察苍鹰','event2','用户:鸟类');
    const other=put('other','小李观察孔雀','event3','小李:鸟类');
    const firstLinks=e.store.memoryDetail(first.id)!.relations;
    assert.ok(firstLinks.some(r=>r.kind==='same_event'&&r.fromId===second.id&&r.toId===first.id&&r.evidence.length===2));
    assert.ok(e.store.memoryDetail(second.id)!.relations.some(r=>r.kind==='related'&&r.fromId===third.id&&r.toId===second.id&&r.evidence.length===0));
    assert.ok(!e.store.memoryDetail(other.id)!.relations.some(r=>r.kind==='related'));
    const recalled=e.store.recall('海狮');assert.ok(recalled.hits.some(h=>h.memory.id===third.id&&h.reasons.includes('关联 2 跳')));
    assert.ok(!recalled.hits.some(h=>h.memory.id===other.id));
  }finally{e.close();}
});
