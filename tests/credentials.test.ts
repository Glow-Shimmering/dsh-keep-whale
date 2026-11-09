import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embeddings, embeddingCredentialReference } from '../src/embedding.js';
import { Store } from '../src/core/store.js';
import { memoryCredentials } from './helpers/credentials.js';
import type { Credentials } from '../src/credentials.js';
import type { EmbeddingSettings } from '../src/types.js';
const config:EmbeddingSettings={enabled:true,endpoint:'https://example.test/v1',model:'synthetic',dimensions:2,inputPrice:1,unit:'积分',unitsPerYuan:30};
const key='synthetic-test-key';
const fingerprint=createHash('sha256').update(JSON.stringify([config,key])).digest('hex');
const reply=()=>new Response(JSON.stringify({data:[{index:0,embedding:[1,2]}],usage:{prompt_tokens:2}}));
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'kw-credentials-')),store=new Store(root),host=memoryCredentials();
 store.patchSettings({embedding:config});
 let provider:Credentials|undefined=host,calls=0;
 const create=(fetcher:typeof fetch=async()=>{calls++;return reply();})=>new Embeddings(store,root,fetcher,()=>provider);
 const instance=create(),legacy=join(root,'embedding-secret.json');
 return {root,store,host,instance,legacy,create,calls:()=>calls,setProvider:(p:Credentials|undefined)=>{provider=p;},writeLegacy:(checked=fingerprint)=>writeFileSync(legacy,JSON.stringify({apiKey:key,checked}),{mode:0o600}),close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}

test('migration verifies host readback before removing plaintext and preserves a matching check',async()=>{
 const f=fixture();try{
  f.writeLegacy();let verified=false;
  f.setProvider({...f.host,async resolve(ref){const saved=await f.host.resolve(ref);if(saved){assert(existsSync(f.legacy));verified=true;}return saved;}});
  await f.instance.refresh();assert(verified);assert.equal(existsSync(f.legacy),false);assert.equal(f.host.values.get(embeddingCredentialReference(config)),key);assert(f.instance.status().checked);assert.equal(f.calls(),0);
  const metadata=join(f.root,'embedding-credential-state.json');assert.equal(statSync(metadata).mode&0o777,0o600);assert(!readFileSync(metadata,'utf8').includes(key));assert(!JSON.stringify(f.instance.status()).includes(key));
  f.setProvider(f.host);const restarted=f.create();await restarted.refresh();assert(restarted.status().checked);assert.equal(f.host.values.size,1);assert.equal(f.calls(),0);
 }finally{f.close();}
});

test('unavailable host preserves legacy without using it for a remote request, then recovers',async()=>{
 const f=fixture();try{f.writeLegacy();f.setProvider(undefined);await f.instance.refresh();assert.match(f.instance.status().reason,/凭据服务不可用/);await assert.rejects(f.instance.check(),/凭据服务不可用/);assert(existsSync(f.legacy));assert.equal(f.calls(),0);f.setProvider(f.host);await f.instance.refresh();assert(f.instance.status().checked);assert(!existsSync(f.legacy));}finally{f.close();}
});

test('host write failures and failed readback preserve the legacy key and redact host errors',async()=>{
 for(const failWrite of [true,false]) {
  const f=fixture();try{
   f.writeLegacy();f.setProvider({...f.host,async set(ref,value){if(failWrite)throw Error('private '+value);await f.host.set(ref,value);},async resolve(){return undefined;}});
   await f.instance.refresh();assert(!f.instance.status().checked);assert(existsSync(f.legacy));assert(!JSON.stringify(f.instance.status()).includes(key));assert.equal(f.calls(),0);
   f.setProvider(f.host);await f.instance.refresh();assert(f.instance.status().checked);assert(!existsSync(f.legacy));
  }finally{f.close();}
 }
});

test('migration never overwrites a different host key or deletes the old copy',async()=>{
 const f=fixture();try{f.writeLegacy();await f.host.set(embeddingCredentialReference(config),'different-synthetic-key');await f.instance.refresh();assert.match(f.instance.status().reason,/不一致/);assert(existsSync(f.legacy));assert.equal(f.host.values.get(embeddingCredentialReference(config)),'different-synthetic-key');await f.instance.configure(config,'replacement-key');assert(!existsSync(f.legacy));assert.equal(f.host.values.get(embeddingCredentialReference(config)),'replacement-key');assert(!f.instance.status().checked);}finally{f.close();}
});

test('interrupted migration with an identical host value can finish idempotently',async()=>{
 const f=fixture();try{f.writeLegacy();await f.host.set(embeddingCredentialReference(config),key);f.setProvider({...f.host,async set(){throw Error('should not write again');}});await f.instance.refresh();assert(f.instance.status().checked);assert(!existsSync(f.legacy));}finally{f.close();}
});

test('invalid legacy data and stale capability checks do not become a validated credential',async()=>{
 const f=fixture();try{writeFileSync(f.legacy,'{"apiKey":123}');await f.instance.refresh();assert(existsSync(f.legacy));assert(!f.instance.status().checked);f.writeLegacy('stale');await f.instance.refresh();assert(!existsSync(f.legacy));assert(!f.instance.status().checked);await f.instance.check();assert(f.instance.status().checked);}finally{f.close();}
});

test('new configuration stores only in the host, clearing uses unset and leaves other namespaces intact',async()=>{
 const f=fixture();try{f.host.values.set('FISH_BRAIN_EMBEDDING_TEST','old-plugin-key');f.host.values.set('DEEPSEEK_API_KEY','host-model-key');await f.instance.configure(config,key);await f.instance.check();assert(!existsSync(f.legacy));await f.instance.configure(config,undefined,true);assert(!f.instance.status().checked);assert(!f.host.values.has(embeddingCredentialReference(config)));assert.equal(f.host.values.size,2);assert(!JSON.stringify(f.store.settings()).includes(key));assert(!JSON.stringify(f.store.ledger()).includes(key));for(const file of readdirSync(f.root).filter(x=>x.endsWith('.json')))assert(!readFileSync(join(f.root,file),'utf8').includes(key));}finally{f.close();}
});

test('key rotation through the host invalidates the capability check before any remote call',async()=>{
 const f=fixture();try{await f.instance.configure(config,key);await f.instance.check();const calls=f.calls();await f.host.set(embeddingCredentialReference(config),'rotated-synthetic');await assert.rejects(f.instance.query('test',{jobId:'rotated',background:false}),/连接检查/);assert.equal(f.calls(),calls);assert(!f.instance.status().checked);}finally{f.close();}
});

test('a check completing after a key rotation cannot validate the new key',async()=>{
 const f=fixture();try{await f.instance.configure(config,key);const instance=f.create(async()=>{await f.host.set(embeddingCredentialReference(config),'rotated-synthetic');return reply();});await assert.rejects(instance.check(),/配置已变化/);assert(!instance.status().checked);}finally{f.close();}
});

test('an in-flight index is discarded after a credential change even when the vector route is unchanged',async()=>{
 const f=fixture();try{
  await f.instance.configure(config,key);await f.instance.check();f.store.addSource({id:'source',kind:'user_fact',text:'合成资料',occasion:'one',createdAt:Date.now(),processed:false,revoked:false});const memory=f.store.saveMemory({kind:'user_fact',text:'合成资料',sourceIds:['source']})!;
  const instance=f.create(async()=>{await f.host.set(embeddingCredentialReference(config),'rotated-synthetic');return reply();});await assert.rejects(instance.indexBatch({jobId:'stale',rows:[memory]}),/配置已变化/);assert.equal(f.instance.status().indexed,0);
 }finally{f.close();}
});

test('credential operations serialize settings and keep equivalent Ark endpoints on the same reference',async()=>{
 const f=fixture();try{const c={...config,model:'doubao-embedding-vision-test',endpoint:'https://ark.cn-beijing.volces.com/api/v3'};assert.equal(embeddingCredentialReference(c),embeddingCredentialReference({...c,endpoint:c.endpoint+'/embeddings/multimodal'}));await Promise.all([f.instance.configure(config,'first-key'),f.instance.configure({...config,endpoint:'https://other.example.test/v1'},'second-key')]);assert.equal(f.host.values.size,2);assert.equal(f.host.values.get(embeddingCredentialReference({...config,endpoint:'https://other.example.test/v1'})),'second-key');assert.equal(f.store.settings().embedding?.endpoint,'https://other.example.test/v1');}finally{f.close();}
});

test('removing stored credentials detects inherited fallbacks instead of falsely claiming deletion',async()=>{
 const f=fixture();try{await f.instance.configure(config,key);f.setProvider({...f.host,async resolve(ref){return (await f.host.resolve(ref))??{value:key,source:'env'};}});await assert.rejects(f.instance.configure(config,undefined,true),/同名环境凭据/);}finally{f.close();}
});


test('migration writes an identical environment fallback into durable host storage before deletion',async()=>{
 const f=fixture();try{f.writeLegacy();f.setProvider({...f.host,async resolve(ref){return (await f.host.resolve(ref))??{value:key,source:'env'};}});await f.instance.refresh();assert.equal(f.host.values.get(embeddingCredentialReference(config)),key);assert(!existsSync(f.legacy));assert(f.instance.status().checked);}finally{f.close();}
});

test('a failed configuration commit retains both old and newly saved endpoint credentials',async()=>{
 const f=fixture();try{await f.instance.configure(config,key);f.store.patchSettings=()=>{throw Error('synthetic db error');};const c={...config,endpoint:'https://other.example.test/v1'};await assert.rejects(f.instance.configure(c,'new-key'));assert.equal(f.host.values.get(embeddingCredentialReference(config)),key);assert.equal(f.host.values.get(embeddingCredentialReference(c)),'new-key');assert.equal(f.store.settings().embedding?.endpoint,config.endpoint);}finally{f.close();}
});

test('failed clearing caused by environment fallback restores the existing durable value',async()=>{
 const f=fixture();try{await f.instance.configure(config,key);f.setProvider({...f.host,async resolve(ref){return (await f.host.resolve(ref))??{value:'different-env-key',source:'env'};}});await assert.rejects(f.instance.configure(config,undefined,true),/同名环境凭据/);assert.equal(f.host.values.get(embeddingCredentialReference(config)),key);}finally{f.close();}
});


test('switching back to a same-origin path never overwrites its own existing credential',async()=>{
 const f=fixture();try{await f.instance.configure(config,key);const target={...config,endpoint:'https://example.test/v2'};await f.host.set(embeddingCredentialReference(target),'target-existing-key');await f.instance.configure(target);assert.equal(f.host.values.get(embeddingCredentialReference(target)),'target-existing-key');assert.equal(f.host.values.get(embeddingCredentialReference(config)),key);assert(!f.instance.status().checked);}finally{f.close();}
});
