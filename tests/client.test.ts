import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('client bundle registers the DSH panels without a global CommonJS require', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], {stdio: 'pipe'});
  const bundle = readFileSync('dist/client.js', 'utf8');
  let module: {id:string;factory:(require:(name:string)=>unknown)=>{inject:string[];apply:(ctx:unknown)=>void}} | undefined;
  runInNewContext(bundle, { window: { __ModuleLoader__: { load(value: typeof module) { module=value; } } }, Date, Math, Set });
  assert.equal(module?.id, 'dsh-keep-whale');
  const react = { createElement: () => null };
  const plugin = module!.factory((name: string) => { assert.equal(name,'react'); return react; });
  assert.ok(plugin.inject.includes('layout'), 'floating actions require the host layout service, not only the layout module dependency');
  const registrations: Array<{name:string;id?:string;key?:string}> = [];
  plugin.apply({ slots: {
    inject(name:string, callback:()=>void) { callback(); },
    register(meta: {name:string;id?:string;key?:string}) { registrations.push(meta); },
  }});
  assert.deepEqual(registrations.map(x=>[x.name,x.id || x.key]), [
    ['main','dsh-keep-whale'], ['sidebar.panellist','dsh-keep-whale'], ['shell.overlay','dsh-keep-whale'],
  ]);
});

test('manual embedding costs are shown separately from automatic background work', async () => {
  const { manualEmbeddingCalls } = await import('../src/client/cost.js');
  const base = { id:'a',day:'2026-11-09',jobId:'search:1',background:false,reserved:1,actual:.5,status:'settled' as const,createdAt:1,unit:'积分' };
  const details={provider:'example',model:'embedding',rawUnit:'CNY',conversionRate:30,priceVerified:true};
  const manualSearch={...base,details};
  const manualCheck={...base,id:'b',jobId:'embedding-check:2',details};
  const automatic={...base,id:'c',background:true,details};
  const chat={...base,id:'d',jobId:'chat:1'};
  assert.deepEqual(manualEmbeddingCalls([manualSearch,automatic,chat,manualCheck]),[manualSearch,manualCheck]);
});

test('known cost above a reservation is shown as actual and not mislabeled unknown', async () => {
  const { summarizeJobCosts } = await import('../src/client/cost.js');
  const base = {id:'1',day:'2026-11-09',jobId:'j',background:true,unit:'积分',createdAt:1};
  const result = summarizeJobCosts([
    {...base,reserved:1,actual:1.5,status:'uncertain'},
    {...base,id:'2',reserved:.25,actual:null,status:'uncertain'},
    {...base,id:'3',unit:'CNY',reserved:1,actual:.1,status:'settled'},
  ]);
  assert.equal(result[0].actual,1.5); assert.equal(result[0].uncertain,.25); assert.equal(result[0].exceeded,true);
  assert.equal(result[1].unit,'CNY'); assert.equal(result[1].actual,.1); assert.equal(result[1].hasUncertain,false);
});

test('chat task cost includes its recall without matching other jobs', async () => {
  const { jobLedgerEntries, manualEmbeddingLabel } = await import('../src/client/cost.js');
  const base = {id:'1',day:'2026-11-09',jobId:'chat-a',background:false,reserved:1,actual:.5,status:'settled' as const,createdAt:1};
  const chat=base, recall={...base,id:'2',jobId:'chat-a:recall'}, retry={...base,id:'3',jobId:'chat-a:attempt:1'};
  const other={...base,id:'4',jobId:'chat-ab:recall'}, prefix={...base,id:'5',jobId:'chat-a:recall-other'};
  assert.deepEqual(jobLedgerEntries('chat-a',[chat,recall,retry,other,prefix]),[chat,recall,retry]);
  assert.equal(manualEmbeddingLabel('chat-a:recall'),'对话回想');
  assert.equal(manualEmbeddingLabel('embedding-check:1'),'连接检查');
  assert.equal(manualEmbeddingLabel('search:1'),'语义搜索');
});
