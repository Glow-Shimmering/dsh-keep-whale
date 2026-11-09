import test from 'node:test';
import assert from 'node:assert/strict';
import { moodPortrait, interactionPortrait, clampOverlay, toggleOverlayPosition, overlaySize } from '../src/client/appearance.js';

test('eight supported moods select their own local image without changing the stored mood',()=>{
 const appearance={available:true,version:'v1'}, original={mood:'担心'};
 const moods={平静:'calm',开心:'happy',期待:'expectant',担心:'worried',沮丧:'sad',不满:'annoyed',害羞:'shy',释然:'relieved'};
 for(const [mood,asset] of Object.entries(moods))assert.equal(moodPortrait(mood,'/custom',appearance),`/keep-whale/art/${asset}.png?v=v1`);
 assert.equal(moodPortrait(original.mood,'/custom',appearance),'/keep-whale/art/worried.png?v=v1');
 assert.equal(original.mood,'担心');
 assert.equal(moodPortrait('无法识别','/custom',appearance),'/keep-whale/art/calm.png?v=v1');
});

test('missing or unavailable local appearance keeps the user skin and never uses another character',()=>{
 for(const appearance of [undefined,null,{available:false,version:null}]) {
  assert.equal(moodPortrait('开心','/keep-whale/media/custom',appearance),'/keep-whale/media/custom');
  assert.equal(moodPortrait('开心',null,appearance),'/keep-whale/portrait.png');
  assert.equal(interactionPortrait('担心','/keep-whale/media/custom',appearance,'pet',false,true,'1'),'/keep-whale/media/custom');
 }
});

test('GIF playback has a fresh cache identity and yields to stills when motion is reduced or window hidden',()=>{
 const pack={available:true,version:'generation 2'};
 const pet=(id:string,reduced=false,visible=true)=>interactionPortrait('担心','/skin',pack,'pet',reduced,visible,id);
 assert.match(pet('1'),/\/pet\.gif\?v=generation%202&play=1$/);
 assert.notEqual(pet('1'),pet('2'));
 assert.equal(pet('1',true),'/keep-whale/art/pet.png?v=generation%202');
 assert.equal(pet('1',false,false),'/keep-whale/art/pet.png?v=generation%202');
 assert.equal(interactionPortrait('担心','/skin',pack,null,false,true,'1'),'/keep-whale/art/worried.png?v=generation%202');
 assert.match(interactionPortrait('担心','/skin',pack,'feed',false,true,'1'),/\/feed\.gif\?/);
});

test('collapsed thumbnail is square, preserves the bottom-right anchor and stays within the viewport',()=>{
 assert.deepEqual(overlaySize(true,1000,800),{width:56,height:56});
 const expanded={x:810,y:572}, collapsed=toggleOverlayPosition(expanded,false,1000,800);
 assert.deepEqual(collapsed,{x:910,y:726});
 assert.deepEqual(toggleOverlayPosition(collapsed,true,1000,800),expanded);
 assert.deepEqual(clampOverlay({x:900,y:760},true,300,200),{x:244,y:144});
 assert.deepEqual(overlaySize(true,20,40),{width:20,height:40});
 assert.deepEqual(clampOverlay({x:-1,y:-5},true,20,40),{x:0,y:0});
});

test('overlay renders a square collapsed avatar and plays then restores mood without writing a chat message',async()=>{
 const {build}=await import('esbuild');const {runInNewContext}=await import('node:vm');
 const result=await build({entryPoints:['src/client/index.tsx'],bundle:true,write:false,platform:'browser',format:'iife',jsx:'transform',tsconfigRaw:{compilerOptions:{jsx:'react'}},target:'es2022',external:['react','react/jsx-runtime'],loader:{'.css':'text'},logLevel:'silent'});
 let module:any, overlay:any, current:any, index=0;
 const hooks=new Map<any,any[]>(), effects:Array<()=>unknown>=[], timers=new Map<number,{fn:()=>void;ms:number}>(), posts:any[]=[];let nextTimer=0;
 const values=new Map<string,string>([['dsh-keep-whale:position',JSON.stringify({x:500,y:300})]]);
 const media:any={matches:false,callback:null,addEventListener:(_name:string,fn:()=>void)=>{media.callback=fn;},removeEventListener:()=>{}};
 const doc:any={visibilityState:'visible',addEventListener:()=>{},removeEventListener:()=>{}};
 const state:any={token:'synthetic',companion:{name:'测试伙伴',mood:'担心'},settings:{skin:'/keep-whale/media/custom',quiet:false},appearance:{available:true,version:'test'},ledger:[],interactions:[],messages:[],unread:2,jobs:[],usage:{},models:[],busy:false,revision:1};
 const react:any={createElement:(type:any,props:any,...children:any[])=>({type,props:props||{},children}),Fragment:'fragment',
  useState:(initial:any)=>{const all=hooks.get(current)!;const i=index++;if(!(i in all))all[i]=typeof initial==='function'?initial():initial;return [all[i],(v:any)=>{all[i]=typeof v==='function'?v(all[i]):v;}];},
  useEffect:(fn:()=>unknown)=>{effects.push(fn);},useLayoutEffect:()=>{},useRef:(value:any)=>react.useState({current:value})[0],useCallback:(fn:any)=>fn};
 const win:any={__ModuleLoader__:{load:(v:any)=>{module=v;}},matchMedia:()=>media,addEventListener:()=>{},removeEventListener:()=>{},dispatchEvent:()=>{}};
 const setTimer=(fn:()=>void,ms:number)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;};
 runInNewContext(result.outputFiles[0].text,{window:win,document:doc,localStorage:{getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>values.set(k,v)},innerWidth:800,innerHeight:600,Element:class {},Date,Math,Set,AbortSignal,CustomEvent:class {},setTimeout:setTimer,clearTimeout:(id:number)=>timers.delete(id),setInterval:()=>0,clearInterval:()=>{},fetch:async(_url:string,options:any={})=>{
   if(options.method==='POST'){const body=JSON.parse(options.body);posts.push(body);return {ok:true,json:async()=>body.action==='interaction'?{text:'我在。'}:{ok:true}};}
   return {ok:true,json:async()=>state};
 }});
 module.factory(()=>react).apply({slots:{inject:(_name:string,fn:()=>void)=>fn(),register:(meta:any,fn:any)=>{if(meta.name==='shell.overlay')overlay=fn;}}});
 const element=overlay({layout:{selectPanel:()=>{}}});
 const render=()=>{current=element.type;index=0;if(!hooks.has(current))hooks.set(current,[]);return element.type(element.props);};
 const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.children)]:[];
 const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.children):value==null||typeof value==='boolean'?'':String(value);
 const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 render();for(const effect of effects.splice(0))effect();await flush();
 let tree=render(), pet=nodes(tree).find(n=>n.type==='button'&&String(n.props.className).startsWith('kw-pet'));
 assert.equal(nodes(pet).find(n=>n.type==='img').props.src,'/keep-whale/art/worried.png?v=test');
 nodes(tree).find(n=>n.type==='button'&&n.props['aria-label']==='收起伙伴').props.onClick();tree=render();
 pet=nodes(tree).find(n=>n.type==='button'&&String(n.props.className).startsWith('kw-pet'));
 assert.match(tree.props.className,/kw-collapsed/);assert.deepEqual({x:tree.props.style.left,y:tree.props.style.top},{x:600,y:454});
 assert.equal(nodes(pet).find(n=>n.type==='img').props.src,'/keep-whale/art/worried.png?v=test');assert.doesNotMatch(text(pet),/测试伙伴/);assert.match(pet.props['aria-label'],/2 条未读消息/);
 pet.props.onClick();tree=render();assert.deepEqual({x:tree.props.style.left,y:tree.props.style.top},{x:500,y:300});
 pet=nodes(tree).find(n=>n.type==='button'&&String(n.props.className).startsWith('kw-pet'));pet.props.onClick();tree=render();
 nodes(tree).find(n=>n.type==='button'&&text(n)==='摸摸').props.onClick();await flush();tree=render();
 pet=nodes(tree).find(n=>n.type==='button'&&String(n.props.className).startsWith('kw-pet'));
 assert.match(nodes(pet).find(n=>n.type==='img').props.src,/\/pet\.gif\?v=test&play=/);
 assert.equal(posts.filter(p=>p.action==='interaction').length,1);assert.equal(posts.some(p=>p.action==='chat'),false);
 media.matches=true;media.callback();tree=render();pet=nodes(tree).find(n=>n.type==='button'&&String(n.props.className).startsWith('kw-pet'));
 assert.equal(nodes(pet).find(n=>n.type==='img').props.src,'/keep-whale/art/pet.png?v=test');
 const end=[...timers.values()].find(t=>t.ms===2600);assert.ok(end);end.fn();tree=render();pet=nodes(tree).find(n=>n.type==='button'&&String(n.props.className).startsWith('kw-pet'));
 assert.equal(nodes(pet).find(n=>n.type==='img').props.src,'/keep-whale/art/worried.png?v=test');assert.equal(state.companion.mood,'担心');
});

test('settings preview opens on demand and replays locally without changing mood or creating interactions',async()=>{
 const {build}=await import('esbuild');const {runInNewContext}=await import('node:vm');
 const result=await build({entryPoints:['src/client/index.tsx'],bundle:true,write:false,platform:'browser',format:'iife',jsx:'transform',tsconfigRaw:{compilerOptions:{jsx:'react'}},target:'es2022',external:['react','react/jsx-runtime'],loader:{'.css':'text'},logLevel:'silent'});
 let module:any, main:any, current:any,index=0,nextTimer=0;
 const hooks=new Map<any,any[]>(),effects:Array<()=>unknown>=[],timers=new Map<number,{fn:()=>void;ms:number}>(),posts:any[]=[];
 const media:any={matches:false,callback:null,addEventListener:(_name:string,fn:()=>void)=>{media.callback=fn;},removeEventListener:()=>{}};
 const doc:any={visibilityState:'visible',addEventListener:()=>{},removeEventListener:()=>{}};
 const state:any={token:'synthetic',companion:{name:'测试伙伴',mood:'担心'},settings:{skin:'/keep-whale/media/custom',quiet:false,model:null,unit:'积分',dailyLimit:100,prices:null,pointsPerYuan:null,excludedSessions:[],excludedWorkspaces:[]},appearance:{available:true,version:'preview'},ledger:[],interactions:[],messages:[],unread:0,jobs:[],usage:{},models:[],busy:false,revision:1};
 const react:any={createElement:(type:any,props:any,...children:any[])=>({type,props:props||{},children}),Fragment:'fragment',
  useState:(initial:any)=>{const all=hooks.get(current)!;const i=index++;if(!(i in all))all[i]=typeof initial==='function'?initial():initial;return [all[i],(v:any)=>{all[i]=typeof v==='function'?v(all[i]):v;}];},
  useEffect:(fn:()=>unknown)=>{effects.push(fn);},useLayoutEffect:()=>{},useRef:(value:any)=>react.useState({current:value})[0],useCallback:(fn:any)=>fn};
 const win:any={__ModuleLoader__:{load:(v:any)=>{module=v;}},matchMedia:()=>media,addEventListener:()=>{},removeEventListener:()=>{},dispatchEvent:()=>{}};
 runInNewContext(result.outputFiles[0].text,{window:win,document:doc,localStorage:{getItem:()=>null,setItem:()=>{}},innerWidth:800,innerHeight:600,Element:class {},Date,Math,Set,AbortSignal,CustomEvent:class {},setTimeout:(fn:()=>void,ms:number)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:(id:number)=>timers.delete(id),setInterval:()=>0,clearInterval:()=>{},fetch:async(_url:string,options:any={})=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));return {ok:true,json:async()=>({ok:true})};}return {ok:true,json:async()=>state};}});
 module.factory(()=>react).apply({slots:{inject:(_name:string,fn:()=>void)=>fn(),register:(meta:any,fn:any)=>{if(meta.name==='main')main=fn;}}});
 const render=(element:any)=>{current=element.type;index=0;if(!hooks.has(current))hooks.set(current,[]);return current(element.props);};
 const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.children)]:[];
 const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.children):value==null||typeof value==='boolean'?'':String(value);
 const page=main({layout:{selectPanel:()=>{}}});render(page);for(const effect of effects.splice(0))effect();for(let i=0;i<20;i++)await Promise.resolve();
 let tree=render(page);nodes(tree).find(n=>n.type==='button'&&text(n)==='设置').props.onClick();tree=render(page);
 const settings=nodes(tree).find(n=>typeof n.type==='function'&&n.type.name==='SettingsPage');assert.ok(settings);
 let settingsTree=render(settings);assert.match(text(settingsTree),/当前形象已关联表情与动作素材/);
 const preview=nodes(settingsTree).find(n=>typeof n.type==='function'&&n.type.name==='AppearancePreview');assert.ok(preview);
 effects.length=0;let previewTree=render(preview);for(const effect of effects.splice(0))effect();
 assert.equal(nodes(previewTree).filter(n=>n.type==='img').length,0,'closed preview does not load images');
 nodes(previewTree).find(n=>n.type==='details').props.onToggle({currentTarget:{open:true}});previewTree=render(preview);
 const figures=nodes(previewTree).filter(n=>n.type==='figure');assert.equal(figures.length,8);assert.deepEqual(figures.map(f=>text(f)),['平静','开心','期待','担心','沮丧','不满','害羞','释然']);
 const play=(title:string)=>nodes(previewTree).find(n=>n.type==='button'&&text(n)===title).props.onClick();
 play('预览摸摸');previewTree=render(preview);let image=nodes(previewTree).find(n=>n.type==='img'&&n.props.alt==='摸摸动作预览');assert.match(image.props.src,/\/pet\.gif\?v=preview&play=/);const first=image.props.src;
 play('预览摸摸');previewTree=render(preview);image=nodes(previewTree).find(n=>n.type==='img'&&n.props.alt==='摸摸动作预览');assert.notEqual(image.props.src,first);
 media.matches=true;media.callback();previewTree=render(preview);image=nodes(previewTree).find(n=>n.type==='img'&&n.props.alt==='摸摸动作预览');assert.equal(image.props.src,'/keep-whale/art/pet.png?v=preview');
 play('预览喂食');previewTree=render(preview);image=nodes(previewTree).find(n=>n.type==='img'&&n.props.alt==='喂食动作预览');assert.equal(image.props.src,'/keep-whale/art/feed.png?v=preview');
 const end=[...timers.values()].find(t=>t.ms===3200);assert.ok(end);end.fn();previewTree=render(preview);image=nodes(previewTree).find(n=>n.type==='img'&&n.props.alt==='当前心情预览');assert.equal(image.props.src,'/keep-whale/art/worried.png?v=preview');
 assert.equal(posts.length,0);assert.equal(state.interactions.length,0);assert.equal(state.companion.mood,'担心');
 state.appearance={available:false,version:null};settingsTree=render(settings);assert.match(text(settingsTree),/当前形象未关联表情与动作素材/);assert.equal(nodes(settingsTree).some(n=>typeof n.type==='function'&&n.type.name==='AppearancePreview'),false);
});
