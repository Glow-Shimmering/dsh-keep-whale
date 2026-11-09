import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.js';
import { BiliStore } from '../src/bili/store.js';
import type { BiliRecord, BiliAttempt } from '../src/bili/types.js';

function setup(){
 const root=mkdtempSync(join(tmpdir(),'keep-whale-bili-'));let time=Date.parse('2026-11-08T12:00:00Z');
 const core=new Store(root,()=>time),store=new BiliStore(root,()=>time);
 return {root,core,store,now:()=>time,advance:(ms:number)=>time+=ms,cleanup:()=>{store.close();core.close();rmSync(root,{recursive:true,force:true});}};
}
function record(id:string,createdAt:number,patch:Partial<Omit<BiliRecord,'version'>>={}):Omit<BiliRecord,'version'>{
 return {id,createdAt,video:{bvid:'BV1xx411c7mD',aid:123,cid:456,title:'一条真实视频',owner:'UP主',ownerId:'1234',duration:600,url:'https://www.bilibili.com/video/BV1xx411c7mD'},origin:'autonomous',summary:'一条内容摘要',opinion:'我的看法',topics:['游戏'],coverage:'字幕和两帧抽样',limitations:['抽样不等于逐秒观看'],excerpts:[{from:0,to:3,text:'开场文字'}],frameTimes:[1,120],liked:false,favorited:false,actionReason:'',shareText:'想聊聊',shareStatus:'pending',...patch};
}
function attempt(id:string,createdAt:number):BiliAttempt{return {id,createdAt,updatedAt:createdAt,origin:'autonomous',status:'running',stage:'准备',reason:''};}

test('new tables share SQLite backup boundary without changing schema version or companion data',()=>{
 const e=setup();try{
  const companion=e.core.companion(),version=new DatabaseSync(join(e.root,'keep-whale.sqlite'),{readOnly:true});
  try {assert.equal(version.prepare('PRAGMA user_version').get()?.user_version,2);}finally{version.close();}
  assert.equal(e.store.settings().enabled,false);assert.equal(e.store.settings().maxVideoMinutes,0);
  const saved=e.store.saveRecord(record('rec-1',e.now()),e.store.version());assert.ok(saved);
  assert.deepEqual(e.core.companion(),companion);
  assert.equal(e.core.sources().length,0);assert.equal(e.core.memories().length,0);
  e.store.close();const reopened=new BiliStore(e.root,e.now);try{assert.equal(reopened.record('rec-1')?.opinion,'我的看法');}finally{reopened.close();}
 }finally{e.cleanup();}
});

test('deletion removes context and interest evidence, stops stale writes but allows a later new source',()=>{
 const e=setup();try{
  const first=e.store.saveRecord(record('r1',e.now()),e.store.version());assert.ok(first);
  const r2=record('r2',e.now()+1);r2.video.bvid='BV1xx411c7mE';e.store.saveRecord(r2,e.store.version());e.advance(86400000);
  const r3=record('r3',e.now());r3.video.bvid='BV1xx411c7mF';e.store.saveRecord(r3,e.store.version());assert.deepEqual(e.store.interests()[0].recordIds,['r3','r2','r1']);
  e.store.selectContext('r1');assert.match(e.store.context('游戏'),/伙伴个人浏览经历/);assert.match(e.store.context('游戏'),/r1/);
  const old=e.store.version();assert.throws(()=>e.store.deleteRecords(['r1','r2']));assert.equal(e.store.deleteRecords(['r1']),1);
  assert.equal(e.store.selectedContext(),null);assert.doesNotMatch(e.store.context('游戏'),/r1/);assert.deepEqual(e.store.interests(),[]);
  assert.equal(e.store.saveRecord(record('r4',e.now()),old),null);assert.equal(e.store.updateRecord('r2',{shareStatus:'sent'},old),null);
  assert.equal(e.store.saveRecord(record('r1',e.now()),e.store.version()),null);
  assert.ok(e.store.saveRecord(record('r4',e.now()),e.store.version()));
  assert.throws(()=>e.store.clearRecords(false));assert.equal(e.store.clearRecords(true),3);assert.equal(e.store.records().length,0);
 }finally{e.cleanup();}
});

test('blocking, account confirmation and settings invalidate an in-flight read',()=>{
 const e=setup();try{
  const initial=e.store.version();e.store.confirmAccount('1234');assert.notEqual(e.store.version(),initial);assert.equal(e.store.accountMid(),'1234');
  assert.throws(()=>e.store.confirmAccount('not-mid'));assert.throws(()=>e.store.patchSettings({maxVideoMinutes:-1}));
  e.store.patchSettings({enabled:true,shareEnabled:false});assert.equal(e.store.settings().enabled,true);
  const before=e.store.version();e.store.block('owner','1234','UP主');assert.equal(e.store.saveRecord(record('blocked',e.now()),before),null);
  assert.equal(e.store.saveRecord(record('blocked',e.now()),e.store.version()),null);assert.equal(e.store.blocks().length,1);
  assert.equal(e.store.unblock('owner','1234'),true);assert.ok(e.store.saveRecord(record('ok',e.now()),e.store.version()));
  assert.throws(()=>e.store.patchSettings({enabled:'yes'} as any));assert.throws(()=>e.store.patchSettings({unknown:true} as any));
 }finally{e.cleanup();}
});

test('attempt counters describe attempts and successes separately and restart expires pending work',()=>{
 const e=setup();try{
  e.store.putAttempt(attempt('a1',e.now()));e.store.updateAttempt('a1',{status:'failed',stage:'抽帧失败',reason:'暂时无法读取'});
  e.store.putAttempt(attempt('a2',e.now()));e.store.updateAttempt('a2',{status:'succeeded',stage:'已完成'});
  e.store.putAttempt(attempt('a3',e.now()));e.store.saveRecord(record('r1',e.now()),e.store.version());
  const recommendation=e.store.recommend('https://www.bilibili.com/video/BV1xx411c7mD?tracking=secret#here','BV1xx411c7mD');
  assert.doesNotMatch(recommendation.input,/tracking|secret|#/);
  assert.deepEqual(e.store.stats(),{attempted:3,succeeded:1,failed:1,interrupted:0,skipped:0});e.store.recover();
  assert.equal(e.store.attempts().find(a=>a.id==='a3')?.status,'interrupted');assert.equal(e.store.record('r1')?.shareStatus,'expired');
  assert.equal(e.store.recommendations().find(r=>r.id===recommendation.id)?.status,'failed');
  e.advance(86400000);assert.equal(e.store.stats().attempted,0);
 }finally{e.cleanup();}
});

test('record cannot claim viewing without both subtitle text and sampled frames',()=>{
 const e=setup();try{
  assert.throws(()=>e.store.saveRecord(record('a',e.now(),{excerpts:[]}),e.store.version()));
  assert.throws(()=>e.store.saveRecord(record('a',e.now(),{frameTimes:[]}),e.store.version()));
  assert.throws(()=>e.store.recommend('https://evil.example/video/BV1xx411c7mD',null));
  assert.throws(()=>e.store.recommend('https://www.bilibili.com@evil.example/video/BV1xx411c7mD',null));
  assert.equal(e.store.records().length,0);
 }finally{e.cleanup();}
});

test('interest counts distinct videos, pages include total and pending shares are not limited to recent 50',()=>{
 const e=setup();try{
  e.store.saveRecord(record('r0',e.now(),{opinion:'特别的旧记录'}),e.store.version());e.advance(86400000);
  for(let n=1;n<=505;n++)e.store.saveRecord(record('r'+n,e.now()+n),e.store.version());
  assert.deepEqual(e.store.interests(),[],'rewatching the same video does not count as 3 independent videos');
  const page=e.store.recordPage('',1,2,['r0','r1','r2']);assert.equal(page.total,3);assert.equal(page.items.length,2);
  assert.equal(e.store.pendingShares(1)[0].id,'r0');
  const context=JSON.parse(e.store.context('一条真实视频','r0'));assert.equal(context.records[0].id,'r0');
  const old=e.store.record('r0')!;assert.ok(old);const title={...old.video,bvid:'BV1xx411c7mG',title:'远古特定视频'};
  // Search is across the entire stored history, not a recent fixed-size slice.
  e.store.saveRecord(record('unique-old',e.now()-86400000,{video:title}),e.store.version());
  assert.match(e.store.context('远古特定视频',null),/unique-old/);
  assert.equal(e.store.hasVideo('BV1xx411c7mG'),true);assert.equal(e.store.hasVideo('BV1xx411c7mH'),false);
 }finally{e.cleanup();}
});

test('direct and short links reject non-first or duplicated P before stripping tracking parameters',()=>{
 const e=setup();try{
  const base='https://www.bilibili.com/video/BV1xx411c7mD';
  assert.equal(e.store.recommend(base+'?p=1&from=test',null).input,base);
  for(const tail of ['?p=2','?p=1&p=1','?p=1&p=2','?p=','?%70=2'])assert.throws(()=>e.store.recommend(base+tail,null),/不支持分 P/);
  assert.throws(()=>e.store.recommend('https://b23.tv/test?p=3',null),/不支持分 P/);
  assert.equal(e.store.recommend(base+'?from=test',null).input,base);
 }finally{e.cleanup();}
});

test('blocking a video or UP immediately discards only their pending shares and unblocking cannot revive them',()=>{
 const e=setup();try{
  const one=record('one',e.now()),two=record('two',e.now()+1),three=record('three',e.now()+2);
  two.video.bvid='BV1xx411c7mE';two.video.ownerId='5678';three.video.bvid='BV1xx411c7mF';
  for(const r of [one,two,three])assert.ok(e.store.saveRecord(r,e.store.version()));
  const before=e.store.version();e.store.block('video',one.video.bvid,'one');assert.ok(e.store.version()>before);
  assert.equal(e.store.record('one')?.shareStatus,'skipped');assert.equal(e.store.record('two')?.shareStatus,'pending');assert.equal(e.store.record('three')?.shareStatus,'pending');
  e.store.unblock('video',one.video.bvid);assert.equal(e.store.record('one')?.shareStatus,'skipped');
  assert.throws(()=>e.store.updateRecord('one',{shareStatus:'pending'}),/不能重新排队/);
  e.store.block('owner','1234','UP');assert.equal(e.store.record('three')?.shareStatus,'skipped');assert.equal(e.store.record('two')?.shareStatus,'pending');
  e.store.unblock('owner','1234');assert.equal(e.store.record('three')?.shareStatus,'skipped');assert.equal(e.store.records().length,3);
 }finally{e.cleanup();}
});

test('selected context expires at 30 minutes and timestamp-less legacy selection cannot revive',()=>{
 const e=setup();try{
  e.store.saveRecord(record('r1',e.now()),e.store.version());e.store.selectContext('r1');assert.equal(e.store.selectedContext(),'r1');
  e.advance(30*60_000-1);assert.equal(e.store.selectedContext(),'r1');e.advance(1);assert.equal(e.store.selectedContext(),null);
  e.advance(-60_000);assert.equal(e.store.selectedContext(),null,'a clock change cannot revive a cleared selection');
  const db=new DatabaseSync(join(e.root,'keep-whale.sqlite'));try{db.prepare("UPDATE bili_meta SET data=? WHERE key='selected'").run(JSON.stringify('r1'));}finally{db.close();}
  assert.equal(e.store.selectedContext(),null);assert.equal(e.store.context('无关话题'),'', 'legacy metadata has no reliable selection time');
  e.store.selectContext('r1');assert.equal(e.store.selectedContext(),'r1');e.store.deleteRecords(['r1']);assert.equal(e.store.selectedContext(),null);
 }finally{e.cleanup();}
});
