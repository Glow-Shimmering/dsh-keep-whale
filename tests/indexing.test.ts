import {test, type TestContext} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Service} from '../src/service.js';
import type {Job,Memory} from '../src/types.js';

function fixture(t:TestContext) {
 const root=mkdtempSync(join(tmpdir(),'whale-index-test-')),services:Service[]=[];
 t.after(async()=>{await Promise.all(services.map(s=>s.dispose()));rmSync(root,{recursive:true,force:true});});
 const memories=Array.from({length:18},(_,i)=>({id:`m${i}`,version:1,text:`记忆${i}`,sourceIds:[`s${i}`]} as Memory));
 const jobs=new Map<string,Job>(),indexed=new Set<string>();let failure=false, zero=false;const calls:string[][]=[];
 const store:any={companion:()=>({id:'00000000-0000-4000-8000-000000000001'}),settings:()=>({backgroundEnabled:true}),memories:()=>memories,embeddingJobs:()=>[...jobs.values()],pendingVectors:(_r:string,n:number,excluded:string[])=>memories.filter(m=>!indexed.has(m.id)&&!excluded.includes(m.id)).slice(0,n),putJob:(j:Job)=>{if(jobs.has(j.id))return false;jobs.set(j.id,{...j});return true;},updateJob:(id:string,p:any)=>{const j=jobs.get(id);if(j)Object.assign(j,p);},jobById:(id:string)=>jobs.get(id)};
 const create=()=>{const s=new Service(store,{get:()=>undefined} as any,root);services.push(s);(s as any).embeddings={status:()=>({checked:true,routeKey:'route',pending:memories.length-indexed.size}),indexBatch:async({rows}:any)=>{calls.push(rows.map((x:Memory)=>x.id));if(failure)throw Error('failed');if(zero)return 0;for(const m of rows)indexed.add(m.id);return rows.length;}};return s as any;};
 return {memories,jobs,indexed,calls,create,fail:(v:boolean)=>failure=v,zero:(v:boolean)=>zero=v};
}

test('failed batch is remembered across restart while later batches proceed; explicit retry targets it',async(t)=>{
 const f=fixture(t),first=f.create();f.fail(true);await first.runIndex();const failed=[...f.jobs.values()][0];assert.equal(failed.status,'failed');assert.equal(f.calls[0].length,8);
 f.fail(false);const restarted=f.create();await restarted.runIndex();await restarted.runIndex();assert.equal(f.calls.length,3);assert.equal(f.indexed.size,10);assert(!f.calls[1].includes(f.calls[0][0]));
 await restarted.runIndex(failed);assert.deepEqual(f.calls[3],f.calls[0]);assert.equal(f.indexed.size,18);await restarted.runIndex();assert.equal(f.calls.length,4);
});

test('zero saved is interrupted and later nodes still proceed',async(t)=>{
 const f=fixture(t),s=f.create();f.zero(true);await s.runIndex();assert.equal([...f.jobs.values()][0].status,'interrupted');f.zero(false);await s.runIndex();assert.equal(f.indexed.size,8);assert(!f.calls[1].includes(f.calls[0][0]));
});

test('changed memory version does not inherit old failed attempt',async(t)=>{
 const f=fixture(t),s=f.create();f.fail(true);await s.runIndex();f.fail(false);f.memories[0].version=2;await s.runIndex();assert(f.calls[1].includes('m0'));assert.equal(f.indexed.has('m0'),true);
});

test('interrupted batch stays blocked on restart and leaves later entries available',async(t)=>{
 const f=fixture(t),s=f.create();let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 s.embeddings.indexBatch=({signal,rows}:any)=>{f.calls.push(rows.map((m:Memory)=>m.id));started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));};
 const running=s.runIndex();await ready;s.stopRelatedWork();await running;assert.equal([...f.jobs.values()][0].status,'interrupted');
 const restarted=f.create();await restarted.runIndex();assert.equal(f.indexed.size,8);assert(!f.calls[1].includes(f.calls[0][0]));
});
