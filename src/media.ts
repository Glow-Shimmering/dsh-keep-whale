import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HostContext, ImageRef } from './types.js';
import { ModelFailure } from './model.js';
export class Media {
  private root: string;
  constructor(root:string,private ctx:HostContext) { this.root=join(root,'media');mkdirSync(this.root,{recursive:true,mode:0o700}); }
  async upload(body:any):Promise<ImageRef> {
    const {mediaType,data}=body;
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(mediaType)||typeof data!=='string'||data.length>12*1024*1024) throw new ModelFailure('IMAGE','请上传不超过 8 MB 的 PNG、JPEG、WebP 或 GIF 图片');
    const bytes=Buffer.from(data,'base64');
    if(!bytes.length||bytes.length>8*1024*1024||bytes.toString('base64')!==data) throw new ModelFailure('IMAGE','图片数据无效或过大');
    const attachments=this.ctx.get('attachments');
    if(!attachments?.saveImages) throw new ModelFailure('IMAGE','宿主图片接口暂不可用');
    const [attachment]=await attachments.saveImages([{data:bytes,mediaType,name:String(body.name||'image').slice(0,120)}]);
    const id=randomUUID();const ref={id,url:'/keep-whale/media/'+id,mediaType,name:String(body.name||'image').slice(0,120)};
    writeFileSync(join(this.root,id),bytes,{mode:0o600});writeFileSync(join(this.root,id+'.json'),JSON.stringify({ref,attachment}),{mode:0o600});return ref;
  }
  get(id:string):{ref:ImageRef;attachment:any} {
    if(!/^[0-9a-f-]{36}$/.test(id)) throw new ModelFailure('IMAGE','图片不存在');
    try{return JSON.parse(readFileSync(join(this.root,id+'.json'),'utf8'));}catch{throw new ModelFailure('IMAGE','图片不存在或已失效');}
  }
  bytes(id:string) { const {ref}=this.get(id);return {ref,bytes:readFileSync(join(this.root,id))}; }
}
