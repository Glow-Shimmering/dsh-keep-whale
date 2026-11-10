import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MOOD_NAMES, validInteractionDuration, type AppearanceDurations } from './appearance-timing.js';

/** Private appearance packs are local to one exact skin, never public assets. */
export const APPEARANCE_FILES = ['calm.png','happy.png','expectant.png','worried.png','sad.png','annoyed.png','shy.png','relieved.png','pet.png','feed.png','pet.gif','feed.gif'] as const;
export const MOOD_APPEARANCE_FILES = [...MOOD_NAMES.map(mood=>`${mood}.png`),...MOOD_NAMES.flatMap(mood=>['pet','feed'].flatMap(action=>[`${action}-${mood}.png`,`${action}-${mood}.gif`]))];
export type AppearanceStatus = { available: boolean; version: string | null; durations?: AppearanceDurations; moodInteractions?: boolean };
const allowed = new Set<string>([...APPEARANCE_FILES,...MOOD_APPEARANCE_FILES]);
const unavailable: AppearanceStatus = { available:false, version:null };
const limit = 8 * 1024 * 1024;
const pngSignature = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const validSignature=(name:string, data:Buffer) => name.endsWith('.png')
  ? data.length>=pngSignature.length && data.subarray(0,8).equals(pngSignature)
  : data.length>=6 && ['GIF87a','GIF89a'].includes(data.subarray(0,6).toString('ascii'));

/** Reject symlink leaves; bound allocation even if a concurrent writer grows a file. */
function readFile(path:string,maxBytes:number,headerOnly=false):Buffer {
  const before=lstatSync(path);
  if(!before.isFile() || before.isSymbolicLink() || before.size<=0 || before.size>maxBytes) throw new Error('invalid file');
  const fd=openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info=fstatSync(fd);
    if(!info.isFile() || info.size<=0 || info.size>maxBytes || info.dev!==before.dev || info.ino!==before.ino) throw new Error('invalid file');
    const data=Buffer.alloc(headerOnly ? Math.min(info.size,8) : info.size);
    let offset=0;
    while(offset<data.length) {const n=readSync(fd,data,offset,data.length-offset,offset);if(n===0)throw new Error('incomplete file');offset+=n;}
    const after=fstatSync(fd);
    if(after.size!==info.size || after.mtimeMs!==info.mtimeMs || after.ino!==info.ino)throw new Error('changed file');
    return data;
  } finally {closeSync(fd);}
}
export class Appearance {
  private readonly dir:string;
  constructor(private readonly root:string) { this.dir=join(root,'appearance'); }
  private directory():void {
    const info=lstatSync(this.dir);
    if(!info.isDirectory() || info.isSymbolicLink() || realpathSync(this.dir)!==join(realpathSync(this.root),'appearance'))throw new Error('invalid directory');
  }
  private validate(skin:string|null):{version:string;durations:AppearanceDurations;files:readonly string[];moodInteractions:boolean} {
    this.directory();
    const manifest=JSON.parse(readFile(join(this.dir,'manifest.json'),64*1024).toString('utf8'));
    if(!manifest || typeof manifest!=='object' || Array.isArray(manifest) || ![1,2].includes(manifest.schemaVersion) || typeof manifest.version!=='string' || !/^[A-Za-z0-9._-]{1,128}$/.test(manifest.version))throw new Error('invalid manifest');
    if(manifest.sourceSkin!==null && (typeof manifest.sourceSkin!=='string' || !/^\/keep-whale\/media\/[0-9a-f-]{36}$/.test(manifest.sourceSkin)))throw new Error('invalid skin');
    if(manifest.sourceSkin!==skin || !manifest.files || typeof manifest.files!=='object' || Array.isArray(manifest.files))throw new Error('wrong skin');
    const keys=Object.keys(manifest.files);
    const files:readonly string[]=manifest.schemaVersion===2?MOOD_APPEARANCE_FILES:APPEARANCE_FILES;
    if(keys.length!==files.length || keys.some(key=>!files.includes(key)) || files.some(name=>manifest.files[name]!==name))throw new Error('invalid files');
    if(!validInteractionDuration(manifest.durations?.pet) || !validInteractionDuration(manifest.durations?.feed))throw new Error('invalid durations');
    for(const name of files) if(!validSignature(name,readFile(join(this.dir,name),limit,true)))throw new Error('invalid image');
    this.directory();
    return {version:manifest.version,durations:{pet:manifest.durations.pet,feed:manifest.durations.feed},files,moodInteractions:manifest.schemaVersion===2};
  }
  status(skin:string|null):AppearanceStatus {
    try { const {version,durations,moodInteractions}=this.validate(skin);return {available:true,version,durations,...(moodInteractions?{moodInteractions:true}:{})}; }
    catch { return {...unavailable}; }
  }
  bytes(name:string,skin:string|null):{bytes:Buffer;mediaType:'image/png'|'image/gif'}|null {
    if(!allowed.has(name))return null;
    try {
      const {files}=this.validate(skin);
      if(!files.includes(name))return null;
      const bytes=readFile(join(this.dir,name),limit);
      if(!validSignature(name,bytes))return null;
      this.directory();
      return {bytes,mediaType:name.endsWith('.png')?'image/png':'image/gif'};
    } catch { return null; }
  }
}
