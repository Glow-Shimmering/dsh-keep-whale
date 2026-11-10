import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Appearance, APPEARANCE_FILES, MOOD_APPEARANCE_FILES } from '../src/appearance.js';
import { createHandler } from '../src/server.js';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,1]);
const gif=Buffer.from('GIF89aSynthetic','ascii');
const sourceSkin='/keep-whale/media/12345678-1234-1234-1234-123456789abc';
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'kw-art-')),dir=join(root,'appearance');mkdirSync(dir);
 let manifest:any={schemaVersion:1,version:'test-v1',sourceSkin,files:Object.fromEntries(APPEARANCE_FILES.map(name=>[name,name])),durations:{pet:2600,feed:3200}};
 for(const file of APPEARANCE_FILES)writeFileSync(join(dir,file),file.endsWith('.png')?png:gif);
 const save=()=>writeFileSync(join(dir,'manifest.json'),JSON.stringify(manifest));save();
 return {root,dir,manifest,save,appearance:new Appearance(root),close:()=>rmSync(root,{recursive:true,force:true})};
}
async function request(handler:ReturnType<typeof createHandler>,method:string,url:string,headers:Record<string,string>={}) {
 const req=Readable.from([]) as any;req.method=method;req.url=url;req.headers={host:'127.0.0.1:3000',...headers};
 const res:any={headersSent:false,status:0,headers:{},data:Buffer.alloc(0),writeHead(status:number,h:Record<string,string>){this.status=status;this.headers=h;this.headersSent=true;},end(data:unknown){this.data=Buffer.isBuffer(data)?data:Buffer.from(String(data??''));}};
 await handler(req,res);return res;
}

test('valid local pack returns only status and only for its currently bound skin',()=>{
 const f=fixture();try {
  assert.deepEqual(f.appearance.status(sourceSkin),{available:true,version:'test-v1',durations:{pet:2600,feed:3200}});
  assert.deepEqual(f.appearance.status(null),{available:false,version:null});
  assert.deepEqual(f.appearance.status('/keep-whale/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),{available:false,version:null});
  assert.deepEqual(f.appearance.bytes('happy.png',sourceSkin),{bytes:png,mediaType:'image/png'});
  assert.deepEqual(f.appearance.bytes('feed.gif',sourceSkin),{bytes:gif,mediaType:'image/gif'});
  assert.equal(f.appearance.bytes('feed.gif',null),null);
  assert.equal(JSON.stringify(f.appearance.status(sourceSkin)).includes(f.root),false);
 }finally{f.close();}
});

test('pack-specific bounded timings are returned without changing old pack behavior',()=>{
 const f=fixture();try {
  f.manifest.durations={pet:1800,feed:2200};f.save();
  assert.deepEqual(f.appearance.status(sourceSkin),{available:true,version:'test-v1',durations:{pet:1800,feed:2200}});
  f.manifest.durations={pet:600,feed:6000};f.save();assert.equal(f.appearance.status(sourceSkin).available,true);
 }finally{f.close();}
});

test('current-skin binding also works for a pack explicitly created for the default skin',()=>{
 const f=fixture();try{f.manifest.sourceSkin=null;f.save();assert.equal(f.appearance.status(null).available,true);assert.equal(f.appearance.status(sourceSkin).available,false);}finally{f.close();}
});

test('invalid manifests, partial packs and invalid image signatures fail closed',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.manifest.schemaVersion=2;f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.version='../bad';f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.files['happy.png']='../manifest.json';f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.files['private.txt']='private.txt';f.save();},
  (f:ReturnType<typeof fixture>)=>{delete f.manifest.files['happy.png'];f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.durations.pet=599;f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.durations.feed=6001;f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.durations.pet=1800.5;f.save();},
  (f:ReturnType<typeof fixture>)=>{delete f.manifest.durations;f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.sourceSkin='/keep-whale/media/../../private';f.save();},
  (f:ReturnType<typeof fixture>)=>unlinkSync(join(f.dir,'sad.png')),
  (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.dir,'happy.png'),'not an image'),
  (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.dir,'pet.gif'),png),
  (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.dir,'feed.gif'),Buffer.alloc(8*1024*1024+1)),
  (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.dir,'manifest.json'),'{"schemaVersion":'),
 ]) {
  const f=fixture();try{mutate(f);assert.deepEqual(f.appearance.status(sourceSkin),{available:false,version:null});assert.equal(f.appearance.bytes('happy.png',sourceSkin),null);}finally{f.close();}
 }
});

test('pack, manifest and image symlinks are never followed',()=>{
 for(const target of ['dir','manifest','file']) {
  const f=fixture();try {
   if(target==='dir'){const real=join(f.root,'elsewhere');renameSync(f.dir,real);symlinkSync(real,f.dir,'dir');}
   else {const path=join(f.dir,target==='manifest'?'manifest.json':'pet.gif');unlinkSync(path);symlinkSync('/etc/passwd',path);}
   assert.deepEqual(f.appearance.status(sourceSkin),{available:false,version:null});assert.equal(f.appearance.bytes('pet.gif',sourceSkin),null);
  }finally{f.close();}
 }
});

test('art HTTP route is private, whitelisted, origin-checked and stops immediately when the skin changes',async()=>{
 const f=fixture();try{
  let skin:string|null=sourceSkin;
  const service:any={appearance:f.appearance,store:{settings:()=>({skin})},snapshot:()=>({appearance:f.appearance.status(skin)})};
  const handler=createHandler(service,new URL('../public/whale-girl.png',import.meta.url));
  let result=await request(handler,'GET','/keep-whale/art/pet.gif?v=test-v1&play=1');
  assert.equal(result.status,200);assert.equal(result.headers['content-type'],'image/gif');assert.equal(result.headers['cache-control'],'private, no-store');assert.equal(result.headers['x-content-type-options'],'nosniff');assert.deepEqual(result.data,gif);
  result=await request(handler,'GET','/keep-whale/art/happy.png');assert.equal(result.status,200);assert.equal(result.headers['content-type'],'image/png');
  for(const path of ['/keep-whale/art/manifest.json','/keep-whale/art/%2e%2e%2fmanifest.json','/keep-whale/art/unknown.png','/keep-whale/art/%2fetc%2fpasswd'])assert.equal((await request(handler,'GET',path)).status,404);
  assert.equal((await request(handler,'GET','/keep-whale/art/pet.gif',{origin:'https://example.com'})).status,403);
  skin=null;assert.equal((await request(handler,'GET','/keep-whale/art/pet.gif')).status,404);
  const state=await request(handler,'GET','/keep-whale/state');assert.deepEqual(JSON.parse(state.data.toString()).appearance,{available:false,version:null});assert(!state.data.toString().includes(f.root));
 }finally{f.close();}
});


test('v2 exposes only complete per-mood media for the exact bound skin',async()=>{
 const f=fixture();try {
  f.manifest.schemaVersion=2;f.manifest.version='mood-v2';f.manifest.durations={pet:1800,feed:2200};
  f.manifest.files=Object.fromEntries(MOOD_APPEARANCE_FILES.map(name=>[name,name]));
  for(const file of MOOD_APPEARANCE_FILES)writeFileSync(join(f.dir,file),file.endsWith('.png')?png:gif);f.save();
  assert.equal(MOOD_APPEARANCE_FILES.length,40);
  assert.deepEqual(f.appearance.status(sourceSkin),{available:true,version:'mood-v2',durations:{pet:1800,feed:2200},moodInteractions:true});
  for(const mood of ['calm','happy','expectant','worried','sad','annoyed','shy','relieved'])for(const action of ['pet','feed']) {
   assert.deepEqual(f.appearance.bytes(`${action}-${mood}.gif`,sourceSkin),{bytes:gif,mediaType:'image/gif'});
   assert.deepEqual(f.appearance.bytes(`${action}-${mood}.png`,sourceSkin),{bytes:png,mediaType:'image/png'});
  }
  assert.equal(f.appearance.bytes('pet.gif',sourceSkin),null,'v1 leftover must not leak into v2');
  assert.equal(f.appearance.bytes('pet-worried.gif',null),null);
  const handler=createHandler({appearance:f.appearance,store:{settings:()=>({skin:sourceSkin})}} as any,new URL('../public/whale-girl.png',import.meta.url));
  assert.equal((await request(handler,'GET','/keep-whale/art/pet-sad.gif?play=1')).status,200);
  for(const path of ['/keep-whale/art/pet-happy/../../manifest.json','/keep-whale/art/pet-nefarious.gif','/keep-whale/art/pet.gif'])assert.equal((await request(handler,'GET',path)).status,404);
  unlinkSync(join(f.dir,'pet-sad.gif'));symlinkSync('/etc/passwd',join(f.dir,'pet-sad.gif'));
  assert.equal(f.appearance.status(sourceSkin).available,false);assert.equal(f.appearance.bytes('sad.png',sourceSkin),null);
 }finally{f.close();}
});

test('v2 rejects missing, extra, substituted and corrupt mood interaction assets',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{delete f.manifest.files['feed-sad.gif'];f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.files['feed-sad.gif']='../manifest.json';f.save();},
  (f:ReturnType<typeof fixture>)=>{f.manifest.files['feed-invalid.gif']='feed-invalid.gif';f.save();},
  (f:ReturnType<typeof fixture>)=>unlinkSync(join(f.dir,'feed-shy.gif')),
  (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.dir,'pet-sad.gif'),png),
 ]) {const f=fixture();try{
  f.manifest.schemaVersion=2;f.manifest.files=Object.fromEntries(MOOD_APPEARANCE_FILES.map(name=>[name,name]));
  for(const file of MOOD_APPEARANCE_FILES)writeFileSync(join(f.dir,file),file.endsWith('.png')?png:gif);f.save();
  mutate(f);assert.deepEqual(f.appearance.status(sourceSkin),{available:false,version:null});assert.equal(f.appearance.bytes('happy.png',sourceSkin),null);
 }finally{f.close();}}
});
