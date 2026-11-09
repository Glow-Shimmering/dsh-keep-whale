import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, beijingDay } from '../src/core/store.js';

function setup() {
  const root=mkdtempSync(join(tmpdir(),'keep-whale-budget-'));
  let now=Date.parse('2026-11-09T07:00:00Z');
  const clock=()=>now, store=new Store(root,clock);
  store.patchSettings({model:{provider:'test',model:'text'},priceRoute:{provider:'test',model:'text'},prices:{input:30,cached:.6,output:120},dailyLimit:1});
  const db=new DatabaseSync(join(root,'keep-whale.sqlite'),{readOnly:true});
  return {store,root,clock,db,advance:(ms:number)=>{now+=ms;},
    ack:(id:string,amount:number)=>store.acknowledgeBudget(id,beijingDay(now),'积分',amount),
    row:(id:string)=>db.prepare('SELECT * FROM ledger WHERE id=?').get(id),
    close:()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('ordinary calls ignore Bilibili limit and unknown charges without changing historical ledger',()=>{
  const e=setup();try {
    const old=e.store.reserve('legacy-memory',.7197,true);e.store.settle(old,null);const original=e.row(old);
    e.store.patchSettings({dailyLimit:0});
    for(const kind of ['memory','embedding','proactive']) {
      const ticket=e.store.reserve(kind,120,true);e.store.settle(ticket,150);
      assert.equal(e.store.ledger().find(row=>row.id===ticket)?.status,'settled');
    }
    const chat=e.store.reserve('chat',120,false);e.store.settle(chat,150);
    assert.equal(e.store.usage().spent,450);assert.equal(e.store.usage().chatSpent,150);
    assert.equal(e.store.usage().uncertain,true);assert.equal(e.store.budgetBlockers().length,0);
    assert.deepEqual([e.store.usage(true).spent,e.store.usage(true).reserved,e.store.usage(true).uncertain],[0,0,false]);
    assert.throws(()=>e.store.reserve('future-bilibili',.1,true,undefined,'bilibili'),/B 站预算不足/);
    assert.throws(()=>e.ack(old,.7197),/已变化/);assert.deepEqual(e.row(old),original);
    assert.equal(e.db.prepare("SELECT 1 FROM meta WHERE key=?").get('budget-ack:'+old),undefined);
  }finally{e.close();}
});

test('only Bilibili charges share the preserved cap, and scope cannot change on a repeated job ID',()=>{
  const e=setup();try {
    const normal=e.store.reserve('normal',50,true);e.store.settle(normal,null);
    const a=e.store.reserve('bilibili-a',.8,true,undefined,'bilibili');
    assert.equal(e.store.reserve('bilibili-a',.8,true,undefined,'bilibili'),a);
    assert.throws(()=>e.store.reserve('bilibili-a',.8,true),/用途已变化/);
    assert.throws(()=>e.store.reserve('normal',50,true,undefined,'bilibili'),/用途已变化/);
    assert.throws(()=>e.store.reserve('bilibili-b',.21,true,undefined,'bilibili'),/预算不足/);
    e.store.settle(a,null);
    assert.throws(()=>e.store.reserve('bilibili-c',.1,true,undefined,'bilibili'),/未核实/);
    assert.doesNotThrow(()=>e.store.reserve('memory-still-works',50,true));
    assert.deepEqual(e.store.budgetBlockers().map(row=>row.id),[a]);
    e.ack(a,.8);assert.equal(e.store.usage(true).estimated,.8);
    const b=e.store.reserve('bilibili-b',.2,true,undefined,'bilibili');e.store.settle(b,.1);
    assert.equal(e.store.usage(true).spent,.1);assert.equal(e.store.usage().uncertain,true);
  }finally{e.close();}
});

test('acknowledging interrupted cost preserves raw ledger and separately counts budget estimate across restart',()=>{
  const e=setup();try {
    const id=e.store.reserve('interrupted',.7197,true,undefined,'bilibili');
    e.store.recover();
    const original=e.row(id);
    assert.equal(e.store.usage().uncertain,true);
    const usage=e.ack(id,.7197);
    assert.deepEqual([usage.spent,usage.estimated,usage.reserved,usage.uncertain],[0,.7197,0,false]);
    assert.deepEqual(e.row(id),original);
    const ackAt=e.store.ledger()[0].budgetAcknowledgedAt;
    e.advance(1000);e.ack(id,.7197);
    assert.equal(e.store.ledger()[0].budgetAcknowledgedAt,ackAt);
    assert.equal(e.store.budgetBlockers().length,0);
    assert.throws(()=>e.store.reserve('too-much',.2804,true,undefined,'bilibili'),/预算不足/);
    const second=e.store.reserve('fits',.2803,true,undefined,'bilibili');e.store.settle(second,.1);
    e.store.close();
    const reopened=new Store(e.root,e.clock);try {
      reopened.recover();
      assert.equal(reopened.usage().estimated,.7197);
      assert.equal(reopened.usage().spent,.1);
      assert.equal(reopened.usage().uncertain,false);
      assert.deepEqual(e.row(id),original);
    }finally{reopened.close();}
  }finally{e.close();}
});

test('one acknowledgment cannot release another unknown charge',()=>{
  const e=setup();try {
    const a=e.store.reserve('a',.2,true,undefined,'bilibili'), b=e.store.reserve('b',.3,true,undefined,'bilibili');
    e.store.settle(a,null);e.store.settle(b,null);
    e.ack(a,.2);
    assert.equal(e.store.usage().uncertain,true);
    assert.equal(e.store.usage().estimated,.2);
    assert.deepEqual(e.store.budgetBlockers().map(row=>row.id),[b]);
    assert.throws(()=>e.store.reserve('blocked',.1,true,undefined,'bilibili'),/未核实/);
    e.ack(b,.3);
    assert.equal(e.store.usage().uncertain,false);
    assert.equal(e.store.usage().estimated,.5);
  }finally{e.close();}
});

test('known overrun stays actual and cannot bypass daily budget after acknowledgment',()=>{
  const e=setup();try {
    e.store.patchSettings({dailyLimit:.6});
    const id=e.store.reserve('overrun',.2,true,undefined,'bilibili');e.store.settle(id,.5);
    const original=e.row(id);e.ack(id,.5);
    assert.deepEqual(e.row(id),original);
    assert.deepEqual([e.store.usage().spent,e.store.usage().estimated,e.store.usage().uncertain],[.5,0,false]);
    assert.throws(()=>e.store.reserve('next',.11,true,undefined,'bilibili'),/预算不足/);
  }finally{e.close();}
});

test('stale, invalid, non-background and unfinished acknowledgments fail without changing metadata',()=>{
  const e=setup();try {
    const pending=e.store.reserve('pending',.1,true,undefined,'bilibili'), settled=e.store.reserve('settled',.1,true,undefined,'bilibili'), id=e.store.reserve('unknown',.1,true,undefined,'bilibili'), manual=e.store.reserve('manual',.1,false);
    e.store.settle(settled,.1);e.store.settle(id,null);e.store.settle(manual,null);
    const day=beijingDay(e.clock());
    for(const args of [[id,day,'积分',.2],[id,day,'CNY',.1],[id,'2026-11-08','积分',.1],[id,day,'积分',NaN],[id,day,'积分',-.1],['missing',day,'积分',.1],[pending,day,'积分',.1],[settled,day,'积分',.1],[manual,day,'积分',.1]] as Array<[string,string,string,number]>) {
      assert.throws(()=>e.store.acknowledgeBudget(...args));
    }
    e.store.putJob({id:'unknown',kind:'memory',status:'running',stage:'整理',reason:'',sourceIds:[],createdAt:e.clock(),updatedAt:e.clock()});
    assert.throws(()=>e.ack(id,.1),/仍在运行/);
    assert.equal(e.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'budget-ack:%'").get()?.n,0);
    assert.equal(e.store.usage().uncertain,true);
  }finally{e.close();}
});

test('recovery blockers remain reachable beyond the 500-entry history display',()=>{
  const e=setup();try {
    const id=e.store.reserve('old-background',.1,true,undefined,'bilibili');e.store.settle(id,null);e.advance(1000);
    for(let i=0;i<501;i++){const ticket=e.store.reserve('new-manual-'+i,0,false);e.store.settle(ticket,0);}
    assert.equal(e.store.ledger().length,500);
    assert.equal(e.store.ledger().some(row=>row.id===id),false);
    assert.deepEqual(e.store.budgetBlockers().map(row=>row.id),[id]);
    e.ack(id,.1);assert.equal(e.store.usage().uncertain,false);
  }finally{e.close();}
});

test('day or budget-unit changes invalidate a stale confirmation',()=>{
  const e=setup();try {
    const id=e.store.reserve('old',.1,true,undefined,'bilibili');e.store.settle(id,null);
    assert.throws(()=>e.store.patchSettings({unit:'CNY'}),/不能修改计费单位/);
    assert.throws(()=>e.store.acknowledgeBudget(id,beijingDay(e.clock()),'CNY',.1));
    e.advance(86400000);e.store.patchSettings({unit:'CNY'});
    assert.throws(()=>e.store.acknowledgeBudget(id,'2026-11-09','积分',.1));
    assert.equal(e.store.usage().uncertain,false);
    assert.equal(e.store.budgetBlockers().length,0);
    assert.equal(e.row(id)?.status,'uncertain');assert.equal(e.row(id)?.actual,null);
  }finally{e.close();}
});
