import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('acknowledged unknown costs are estimates and never presented as verified actual charges', async()=>{
 const {summarizeJobCosts,budgetConfirmation}=await import('../src/client/cost.js');
 const entry={id:'a',day:'2026-11-09',jobId:'j',background:true,reserved:.7197,actual:null,status:'uncertain' as const,createdAt:1,unit:'积分',budgetAcknowledgedAt:2};
 const group=summarizeJobCosts([entry])[0];
 assert.equal(group.actual,0);assert.equal(group.hasActual,false);assert.equal(group.estimated,.7197);assert.equal(group.hasEstimated,true);assert.equal(group.hasUncertain,false);
 const prompt=budgetConfirmation(entry);
 assert.match(prompt,/0\.7197 积分/);assert.match(prompt,/实际费用仍未核实/);assert.match(prompt,/可能高于暂记金额/);assert.match(prompt,/不会修改供应商账单/);assert.match(prompt,/产生新费用/);assert.match(prompt,/不能保证供应商实际总扣费不超过预算/);
 assert.match(budgetConfirmation({...entry,actual:1}),/已知的 1 积分/);
});

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

test('budget recovery UI supports cancel, failure, retry and refresh without duplicate submissions',async()=>{
  const bundle=readFileSync('dist/client.js','utf8');
  let module:any, main:any, current:any, index=0, accept=false, prompts=0;
  let resolvePost:((value:any)=>void)|undefined;
  const hooks=new Map<any,any[]>(), effects:Array<()=>void>=[], posts:any[]=[];
  const entry={id:'fee-1',day:'2026-11-09',jobId:'old',background:true,reserved:.7197,actual:null,status:'uncertain',createdAt:1,unit:'积分'};
  const state:any={token:'test-only',companion:{name:'测试',mood:'平静'},settings:{quiet:false},ledger:[entry],budgetBlockers:[entry],interactions:[],messages:[],unread:0,jobs:[{id:'old',kind:'memory',status:'interrupted',stage:'已中断',updatedAt:1}],usage:{spent:0,estimated:0,reserved:.7197,uncertain:true,chatSpent:0,unit:'积分',limit:1}};
  const react:any={createElement:(type:any,props:any,...children:any[])=>({type,props:props||{},children}),Fragment:'fragment',
    useState:(initial:any)=>{const values=hooks.get(current)!;const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],(v:any)=>{values[i]=typeof v==='function'?v(values[i]):v;}];},
    useEffect:(fn:()=>void)=>{effects.push(fn);},useRef:(value:any)=>react.useState({current:value})[0]};
  const render=(fn:any,props:any)=>{current=fn;index=0;if(!hooks.has(fn))hooks.set(fn,[]);return fn(props);};
  const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.children)]:[];
  const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.children):node==null||typeof node==='boolean'?'':String(node);
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  runInNewContext(bundle,{window:{__ModuleLoader__:{load:(v:any)=>{module=v;}},confirm:()=>{prompts++;return accept;}},Date,Math,Set,AbortSignal,setTimeout:()=>0,clearTimeout:()=>{},fetch:async(_url:string,options:any)=>{
    if(options.method==='POST'){posts.push(JSON.parse(options.body));return new Promise(resolve=>{resolvePost=resolve;});}
    return {ok:true,json:async()=>state};
  }});
  module.factory(()=>react).apply({slots:{inject:(_name:string,fn:()=>void)=>fn(),register:(meta:any,fn:any)=>{if(meta.name==='main')main=fn;}}});
  const page=main();render(page.type,page.props);effects.shift()!();await flush();
  const pageTree=render(page.type,page.props);
  nodes(pageTree).find(n=>n.type==='button'&&text(n)==='近况').props.onClick();
  const activity=()=>nodes(render(page.type,page.props)).find(n=>typeof n.type==='function'&&n.type.name==='Activity');
  const activityTree=()=>{const element=activity();return render(element.type,element.props);};
  const button=()=>nodes(activityTree()).find(n=>n.type==='button'&&text(n)==='确认按预留暂记预算');
  assert.equal(nodes(activityTree()).find(n=>n.type==='button'&&text(n)==='重试整理').props.disabled,undefined);
  button().props.onClick();await flush();assert.equal(posts.length,0);assert.equal(prompts,1);
  accept=true;const click=button().props.onClick;click();click();await flush();
  assert.equal(posts.length,1);assert.equal(prompts,2);
  assert.equal(nodes(activityTree()).find(n=>n.type==='button'&&text(n)==='正在记录…').props.disabled,true);
  assert.deepEqual(posts[0],{action:'billing.acknowledge',id:'fee-1',day:'2026-11-09',unit:'积分',amount:.7197,confirm:true});
  resolvePost!({ok:false,json:async()=>({error:'测试网络中断'})});await flush();
  assert.match(text(render(page.type,page.props)),/测试网络中断/);assert.equal(button().props.disabled,false);
  button().props.onClick();await flush();assert.equal(posts.length,2);
  state.budgetBlockers=[];state.ledger=[{...entry,budgetAcknowledgedAt:2}];state.usage={...state.usage,estimated:.7197,reserved:0,uncertain:false};
  resolvePost!({ok:true,json:async()=>state.usage});await flush();
  assert.doesNotMatch(text(activityTree()),/费用确认与恢复/);
  assert.match(text(activityTree()),/暂记，实际费用未核实/);
  assert.equal(nodes(activityTree()).find(n=>n.type==='button'&&text(n)==='重试整理').props.disabled,undefined);
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
