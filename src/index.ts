import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from './core/store.js';
import { Service } from './service.js';
import { createHandler } from './server.js';
import type { HostContext } from './types.js';
export const name='keep-whale';
export const inject=['llm','sessions'];
export function acquireLock(root:string):()=>void {
  mkdirSync(root,{recursive:true,mode:0o700});const file=join(root,'host.lock'),nonce=randomUUID();
  for(let n=0;n<2;n++) {
    try{writeFileSync(file,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});return ()=>{try{if(JSON.parse(readFileSync(file,'utf8')).nonce===nonce)unlinkSync(file);}catch{}};}
    catch(e:any){if(e.code!=='EEXIST')throw e;let pid:number;try{pid=JSON.parse(readFileSync(file,'utf8')).pid;}catch{throw new Error('伙伴锁文件无法读取，请先检查另一个 DSH 是否正在运行');}if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('伙伴锁文件无效');try{process.kill(pid,0);throw new Error('另一处 DSH 已在管理这个伙伴');}catch(err:any){if(err.code!=='ESRCH')throw err;}unlinkSync(file);}
  }
  throw new Error('无法取得伙伴运行锁');
}
export async function apply(ctx:HostContext) {
  const root=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'dsh-keep-whale');
  const release=acquireLock(root);let store:Store;
  try{store=new Store(root);}catch(e){release();throw e;}
  try {
    store.recover();
    const bootstrap=join(root,'bootstrap.json');
    if(existsSync(bootstrap)) {
      const b=JSON.parse(readFileSync(bootstrap,'utf8'));
      if(store.messages(1).length===0&&store.memories().length===0){if(b.name)store.rename(b.name);if(b.settings)store.patchSettings(b.settings);}
      renameSync(bootstrap,join(root,'bootstrap.applied.json'));
    }
    const service=new Service(store,ctx,root);
    const off=ctx.on('session/event',(session:any,event:any)=>service.observe(session,event));
    const offModels=ctx.on('llm/adapters-updated',()=>void service.refreshModels());
    ctx.inject(['webServer'],(web:any)=>web.effect(()=>web.webServer.register({kind:'prefix',path:'/keep-whale',handler:createHandler(service,new URL('../public/whale.svg',import.meta.url))})));
    ctx.on('dispose',()=>{off();offModels();void service.dispose().finally(()=>{store.close();release();});});
    await service.start();
  }catch(e){store.close();release();throw e;}
}
