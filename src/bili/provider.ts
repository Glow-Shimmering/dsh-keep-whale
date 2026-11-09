import { existsSync, mkdirSync, renameSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ModelFailure } from '../model.js';
import type { BiliAccount, BiliFrame, BiliMaterial, BiliProvider, BiliSubtitle, BiliVideo } from './types.js';

// Only this provider's dedicated profile is ever launched; no existing browser
// profile, exported cookie string, or browser debugging port is used.
const api = 'https://api.bilibili.com';
const bvPattern = /^BV[0-9A-Za-z]{10}$/;
const hostMatches = (host:string, domain:string) => host === domain || host.endsWith('.'+domain);
const pageDomains = ['bilibili.com','biliapi.net','biliapi.com','bilivideo.com','bilivideo.cn','bilivideo.net','hdslb.com','b23.tv','geetest.com','geevisit.com'];
const timeout = 15000;

export function allowedBiliURL(raw:string): boolean {
  try {
    const url = new URL(raw);
    if (['data:','blob:','about:'].includes(url.protocol)) return true;
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && pageDomains.some(d=>hostMatches(url.hostname,d));
  } catch { return false; }
}
export function subtitleURL(raw:string): string {
  let url:URL;try { url = new URL(raw.startsWith('//') ? 'https:'+raw : raw); } catch { throw new ModelFailure('SUBTITLE','字幕来源无法核实'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['bilibili.com','hdslb.com'].some(d=>hostMatches(url.hostname,d))) throw new ModelFailure('SUBTITLE','字幕来源无法核实');
  return url.href;
}
export function videoId(input:string): string {
  const value = input.trim();
  if (bvPattern.test(value)) return value;
  let url:URL;try { url = new URL(value); } catch { throw new ModelFailure('UNSUPPORTED','请填写 B 站视频链接或 BV 号'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !hostMatches(url.hostname,'bilibili.com')) throw new ModelFailure('UNSUPPORTED','请填写 B 站视频链接或 BV 号');
  const pages=url.searchParams.getAll('p');
  if (pages.length>1 || pages.length===1 && pages[0]!=='1') throw new ModelFailure('UNSUPPORTED','暂不支持分 P 视频');
  const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/);
  if (!match) throw new ModelFailure('UNSUPPORTED','请填写 B 站普通视频链接或 BV 号');
  return match[1];
}
export function validateVideo(data:any): BiliVideo {
  if (!data || !bvPattern.test(data.bvid) || !Number.isSafeInteger(data.aid) || data.aid<1 || !Number.isSafeInteger(data.cid) || data.cid<1 || !Number.isFinite(data.duration) || data.duration<1) throw new ModelFailure('READ','暂时无法读取视频信息');
  if (data.videos!==1 || !Array.isArray(data.pages) || data.pages.length!==1 || data.rights?.pay || data.is_chargeable_season || data.is_upower_exclusive || data.ugc_season?.is_pay_season || data.redirect_url) throw new ModelFailure('UNSUPPORTED','目前只支持免费普通单 P 视频');
  const ownerId=String(data.owner?.mid||'');if(!/^\d{1,20}$/.test(ownerId)) throw new ModelFailure('READ','视频 UP 主信息不完整');
  return { bvid:data.bvid, aid:data.aid, cid:data.cid, title:String(data.title||'').slice(0,200), owner:String(data.owner?.name||'').slice(0,80), ownerId, duration:data.duration, url:`https://www.bilibili.com/video/${data.bvid}/`, description:String(data.desc||'').slice(0,1000) };
}
export function normalizeSubtitles(body:any, duration:number): BiliSubtitle[] {
  if (!Array.isArray(body) || !body.length || body.length>100000) throw new ModelFailure('SUBTITLE','没有可用字幕或转写，暂时不能了解这条视频');
  const lines:BiliSubtitle[] = body.map((x:any)=>({from:Number(x.from),to:Number(x.to),text:typeof x.content==='string'?x.content.trim():''}))
    .filter((x:BiliSubtitle)=>Number.isFinite(x.from)&&Number.isFinite(x.to)&&x.from>=0&&x.to>x.from&&x.from<duration&&x.to<=duration+5&&!!x.text).sort((a:BiliSubtitle,b:BiliSubtitle)=>a.from-b.from);
  if (!lines.length || lines.reduce((n,x)=>n+x.text.length,0)>2_000_000) throw new ModelFailure('SUBTITLE','字幕缺失或超过本次可处理的范围');
  return lines;
}
function chromePath(): string | null {
  const list = process.platform==='darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform==='win32' ? [join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),join(process.env.LOCALAPPDATA||join(homedir(),'AppData/Local'),'Google/Chrome/Application/chrome.exe')]
    : ['/usr/bin/google-chrome-stable','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
  return list.find(existsSync)||null;
}
function checkSignal(signal:AbortSignal) { signal.throwIfAborted(); }
function safeMessage(error:unknown):string {
  if(error instanceof Error && error.name==='AbortError')return '本次读取已停止';
  return 'B 站暂时无法连接，或账号需要验证';
}
export class BrowserBiliProvider implements BiliProvider {
  private readonly profile:string;
  private readonly base:string;
  private readonly executable:string|null;
  private readonly loadDriver:()=>Promise<any>;
  private readonly testDriver:boolean;
  private context:any=null;
  private launch:Promise<any>|null=null;
  private visible=false;
  private closed=false;
  private expectedMid:string|null=null;
  private lastBvid:string|null=null;
  private recommendationRound=0;
  constructor(root:string, companionId:string, driver?:{ chromium:any; executablePath?:string }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companionId)) throw new ModelFailure('ACCOUNT','伙伴编号无效');
    this.base=join(root,'bili-browser');this.profile=join(this.base,companionId);
    this.testDriver=!!driver;
    this.executable=driver ? driver.executablePath || 'test-browser' : chromePath();
    this.loadDriver=driver ? async()=>driver : async()=>{const name='playwright-core';return import(name);};
  }
  available():boolean {
    if(!this.executable)return false;
    if(this.testDriver)return true;
    try { const require=createRequire(import.meta.url);require.resolve('playwright-core');return true; } catch { return false; }
  }
  setExpectedMid(mid:string|null):void {
    if(mid!==null&&!/^\d{1,20}$/.test(mid))throw new ModelFailure('ACCOUNT','绑定账号编号无效');
    this.expectedMid=mid;
  }
  private ensureProfileDirectory():void {
    if(existsSync(this.base)) {
      const base=lstatSync(this.base);
      if(!base.isDirectory()||base.isSymbolicLink())throw new ModelFailure('READ','独立浏览目录无效');
    } else mkdirSync(this.base,{recursive:true,mode:0o700});
    if(existsSync(this.profile)) {
      const profile=lstatSync(this.profile);
      if(!profile.isDirectory()||profile.isSymbolicLink())throw new ModelFailure('READ','独立浏览目录无效');
    }
  }
  private async open(visible=false):Promise<any> {
    if(this.closed)throw new ModelFailure('READ','浏览服务已停止');
    if(this.launch)await this.launch;
    if(this.context && (!visible || this.visible))return this.context;
    if(this.context)await this.close();
    if(!this.executable)throw new ModelFailure('READ','未找到可用的 Chrome 浏览器');
    this.launch=(async()=>{
      let chromium:any;try { ({chromium}=await this.loadDriver()); } catch { throw new ModelFailure('READ','独立浏览组件未安装'); }
      this.ensureProfileDirectory();
      mkdirSync(this.profile,{recursive:true,mode:0o700});
      let context:any;
      try { context=await chromium.launchPersistentContext(this.profile,{executablePath:this.executable,headless:!visible,viewport:{width:1120,height:800},locale:'zh-CN',timezoneId:'Asia/Shanghai',acceptDownloads:false,timeout:20000,args:['--mute-audio','--disable-background-networking','--disable-extensions','--disable-features=MediaRouter']}); }
      catch { throw new ModelFailure('READ','无法启动独立浏览器，请检查 Chrome 是否可用'); }
      if(this.closed){await context.close();throw new ModelFailure('READ','浏览服务已停止');}
      this.context=context;this.visible=visible;
      context.on('close',()=>{if(this.context===context){this.context=null;this.visible=false;}});
      context.setDefaultTimeout(timeout);
      try {
        await context.route('**/*',(route:any)=>allowedBiliURL(route.request().url())?route.continue():route.abort());
        await context.addInitScript(()=>{
          const mute=()=>document.querySelectorAll('video,audio').forEach((v:any)=>{v.muted=true;v.volume=0;});
          new MutationObserver(mute).observe(document,{childList:true,subtree:true});
        });
      } catch {await this.close();throw new ModelFailure('READ','无法初始化独立浏览器');}
      return context;
    })();
    try{return await this.launch;}finally{this.launch=null;}
  }
  private async close():Promise<void> {
    const context=this.context;this.context=null;this.visible=false;
    if(context)await context.close().catch(()=>{});
  }
  private async request(context:any,path:string,signal:AbortSignal,form?:Record<string,string>):Promise<any> {
    checkSignal(signal);
    const url=api+path;
    const cancel=()=>{void context.close().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
    try {
      const options={timeout,maxRedirects:0,headers:{Referer:'https://www.bilibili.com/'}};
      const res=form?await context.request.post(url,{...options,form}):await context.request.get(url,options);
      checkSignal(signal);
      const length=Number(res.headers()['content-length']||0);
      if(!res.ok() || length>2_000_000)throw new Error('bad response');
      const text:string=await res.text();if(Buffer.byteLength(text)>2_000_000)throw new Error('oversize');
      const json=JSON.parse(text);if(json.code===-101)throw new ModelFailure('LOGIN','小号登录已失效，请重新登录');
      if(json.code!==0)throw new Error('bad api code');
      return json.data;
    } catch(error) { checkSignal(signal);if(error instanceof ModelFailure)throw error;throw new ModelFailure('NETWORK',safeMessage(error)); }
    finally { signal.removeEventListener('abort',cancel); }
  }
  private async currentAccount(context:any,signal:AbortSignal):Promise<BiliAccount> {
    let data:any;try { data=await this.request(context,'/x/web-interface/nav',signal); }
    catch(error) { if(error instanceof ModelFailure && error.code==='LOGIN')return {loggedIn:false,name:'',mid:null,reason:'请先登录独立小号'};throw error; }
    if(!data?.isLogin||!/^\d{1,20}$/.test(String(data.mid)))return {loggedIn:false,name:'',mid:null,reason:'请先登录独立小号'};
    return {loggedIn:true,mid:String(data.mid),name:String(data.uname||'').slice(0,80)};
  }
  private async session(signal:AbortSignal):Promise<any> {
    checkSignal(signal);if(!this.expectedMid)throw new ModelFailure('LOGIN','请先确认独立小号');
    const context=await this.open();
    const account=await this.currentAccount(context,signal);
    if(!account.loggedIn)throw new ModelFailure('LOGIN','小号登录失效，请重新登录');
    if(account.mid!==this.expectedMid)throw new ModelFailure('ACCOUNT','账号身份变化，请重新确认');
    checkSignal(signal);return context;
  }
  async login():Promise<void> {
    const context=await this.open(true);
    try { const page=context.pages()[0]||await context.newPage();await page.goto('https://www.bilibili.com/',{waitUntil:'domcontentloaded',timeout:25000}); }
    catch { await this.close();throw new ModelFailure('LOGIN','暂时无法打开独立登录窗口'); }
  }
  async account(signal:AbortSignal):Promise<BiliAccount> {
    const context=await this.open();const wasVisible=this.visible;
    const result=await this.currentAccount(context,signal);
    if(result.loggedIn&&wasVisible)await this.close();
    return result;
  }
  async logout():Promise<void> {
    if(this.launch)await this.launch.catch(()=>{});
    if(existsSync(this.profile)) {
      const context=await this.open();
      try { await context.clearCookies(); } catch { throw new ModelFailure('ACCOUNT','清除独立小号登录状态失败，请稍后重试'); }
      await this.close();
      this.ensureProfileDirectory();
      const archived=this.profile+'.logged-out-'+randomUUID();
      renameSync(this.profile,archived);
    }
    this.expectedMid=null;
  }
  async resolve(input:string, signal:AbortSignal):Promise<string> {
    checkSignal(signal);try{return videoId(input);}catch{}
    let short:URL;try{short=new URL(input.trim());}catch{throw new ModelFailure('UNSUPPORTED','请填写 B 站视频链接或 BV 号');}
    if(short.protocol!=='https:'||short.hostname!=='b23.tv'||short.port||short.username||short.password||!/^\/[A-Za-z0-9]+\/?$/.test(short.pathname))throw new ModelFailure('UNSUPPORTED','请填写 B 站视频链接或 BV 号');
    const context=await this.open();let current=short.href;
    for(let i=0;i<3;i++) {
      checkSignal(signal);let res:any;
      try {res=await context.request.get(current,{timeout,maxRedirects:0});}catch(error){checkSignal(signal);throw new ModelFailure('NETWORK',safeMessage(error));}
      checkSignal(signal);const location=res.headers().location;
      if(!location)throw new ModelFailure('UNSUPPORTED','短链接无法解析到普通视频');
      let target:URL;try{target=new URL(location,current);}catch{throw new ModelFailure('UNSUPPORTED','短链接目标无效');}
      if(target.protocol!=='https:'||target.port||target.username||target.password||!(target.hostname==='b23.tv'||hostMatches(target.hostname,'bilibili.com')))throw new ModelFailure('UNSUPPORTED','短链接目标不是 B 站');
      try{return videoId(target.href);}catch{}
      if(target.hostname!=='b23.tv')throw new ModelFailure('UNSUPPORTED','短链接目标不是普通视频');
      current=target.href;
    }
    throw new ModelFailure('UNSUPPORTED','短链接重定向过多');
  }
  private async metadata(context:any,bvid:string,signal:AbortSignal):Promise<BiliVideo> {
    const data=await this.request(context,'/x/web-interface/view?bvid='+encodeURIComponent(videoId(bvid)),signal);
    return validateVideo(data);
  }
  async candidates(signal:AbortSignal):Promise<BiliVideo[]> {
    const context=await this.session(signal);let page:any;
    const cancel=()=>{void this.close();};signal.addEventListener('abort',cancel,{once:true});
    try {
      page=await context.newPage();const related=this.lastBvid && (++this.recommendationRound%2===0);
      await page.goto(related?`https://www.bilibili.com/video/${this.lastBvid}/`:'https://www.bilibili.com/',{waitUntil:'domcontentloaded',timeout:25000});
      await page.locator('a[href*="/video/BV"]').first().waitFor({timeout});
      const links:string[]=await page.locator('a[href*="/video/BV"]').evaluateAll((nodes:any[])=>nodes.map(a=>a.href));
      const ids:string[]=[];for(const value of links){try{const id=videoId(value);if(!ids.includes(id))ids.push(id);}catch{}if(ids.length>=12)break;}
      const result:BiliVideo[]=[];for(const id of ids){checkSignal(signal);try{result.push(await this.metadata(context,id,signal));}catch{checkSignal(signal);}}
      return result;
    } catch(error){checkSignal(signal);throw new ModelFailure('NETWORK',safeMessage(error));}finally{signal.removeEventListener('abort',cancel);await page?.close().catch(()=>{});}
  }
  async material(bvid:string,signal:AbortSignal,stage:(label:string)=>void,maxDurationSeconds?:number,acceptVideo?:(video:BiliVideo)=>boolean):Promise<BiliMaterial> {
    const context=await this.session(signal);const video=await this.metadata(context,bvid,signal);
    if(maxDurationSeconds && video.duration>maxDurationSeconds)throw new ModelFailure('UNSUPPORTED','视频超过设置的最长时长，未开始读取');
    if(acceptVideo&&!acceptVideo(video))throw new ModelFailure('SKIP','该视频或 UP 主已被屏蔽');
    checkSignal(signal);
    let page:any;
    const cancel=()=>{void this.close();};signal.addEventListener('abort',cancel,{once:true});
    try {
      stage('读取视频字幕');page=await context.newPage();const observed:{subtitles:any[]|null}={subtitles:null};
      page.on('response',async(response:any)=>{try{const u=new URL(response.url());if(u.hostname==='api.bilibili.com'&&/^\/x\/player\/(?:wbi\/)?v2$/.test(u.pathname)&&String(u.searchParams.get('cid'))===String(video.cid)){if(Number(response.headers()['content-length']||0)>2_000_000)return;const text=await response.text();if(Buffer.byteLength(text)>2_000_000)return;const j=JSON.parse(text);if(j.code===0)observed.subtitles=j.data?.subtitle?.subtitles||null;}}catch{}});
      await page.goto(video.url,{waitUntil:'domcontentloaded',timeout:25000});
      const locator=page.locator('video').first();await locator.waitFor({timeout:20000});
      await locator.evaluate((v:HTMLVideoElement)=>{v.muted=true;v.volume=0;return v.play();});
      await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=2&&v.duration>0;},null,{timeout:20000});
      checkSignal(signal);
      if(!observed.subtitles?.length){const data=await this.request(context,`/x/player/v2?aid=${video.aid}&cid=${video.cid}`,signal);observed.subtitles=data?.subtitle?.subtitles||null;}
      const track:any=observed.subtitles?.find((x:any)=>/zh|cn/i.test(x.lan))||observed.subtitles?.[0];
      if(!track?.subtitle_url)throw new ModelFailure('SUBTITLE','没有可用字幕或转写，不能凭标题冒充看过');
      const res=await context.request.get(subtitleURL(String(track.subtitle_url)),{timeout,maxRedirects:0});
      if(!res.ok() || Number(res.headers()['content-length']||0)>2_000_000)throw new ModelFailure('SUBTITLE','字幕暂时无法读取');
      const raw:string=await res.text();if(Buffer.byteLength(raw)>2_000_000)throw new ModelFailure('SUBTITLE','字幕过大');
      const lines=normalizeSubtitles(JSON.parse(raw).body,video.duration);
      stage('读取抽样画面');const count=Math.min(24,Math.max(3,Math.ceil(video.duration/30)+1));
      const times=Array.from({length:count},(_,i)=>Math.max(0,Math.round((video.duration-1)*i/(count-1))));
      const frames:BiliFrame[]=[];
      for(const at of times){
        checkSignal(signal);
        await locator.evaluate(async(v:HTMLVideoElement,time:number)=>{v.muted=true;v.pause();await new Promise<void>((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);v.removeEventListener('seeked',done);};const done=()=>{cleanup();resolve();};const timer=setTimeout(()=>{cleanup();reject(new Error('画面定位超时'));},12000);if(Math.abs(v.currentTime-time)<0.2&&v.readyState>=2)return done();v.addEventListener('seeked',done,{once:true});v.currentTime=time;});if(v.readyState<2||Math.abs(v.currentTime-time)>2)throw new Error('没有取得对应时刻画面');v.style.cssText+=';width:480px!important;height:270px!important;object-fit:contain!important;';},at);
        const data:Buffer=await locator.screenshot({type:'jpeg',quality:65,timeout:12000});
        if(data.length>2_000_000)throw new ModelFailure('READ','抽样画面过大');frames.push({at,data,mediaType:'image/jpeg'});
      }
      checkSignal(signal);this.lastBvid=video.bvid;
      return {video,subtitles:lines,frames,subtitleLanguage:String(track.lan_doc||track.lan||'').slice(0,40),coverage:`读取 ${lines.length} 条可用字幕及 ${frames.length} 张全片分布的抽样画面，字幕时间 ${lines[0].from.toFixed(1)}–${lines.at(-1)!.to.toFixed(1)} 秒。`,limitations:['不是逐秒观看；没有读取音轨，字幕可能缺漏或识别有误。']};
    } catch(error){if(signal.aborted)checkSignal(signal);if(error instanceof ModelFailure)throw error;throw new ModelFailure('READ','视频画面或字幕暂时无法读取');}
    finally{signal.removeEventListener('abort',cancel);await page?.close().catch(()=>{});}
  }
  private async engage(video:BiliVideo,signal:AbortSignal,kind:'like'|'favorite'):Promise<void> {
    const context=await this.session(signal);const bvid=videoId(video.bvid);
    // Revalidate metadata so a fabricated client value cannot choose a different aid.
    const verified=await this.metadata(context,bvid,signal);
    if(verified.aid!==video.aid)throw new ModelFailure('READ','视频信息已变化，请重新读取');
    const relation=await this.request(context,'/x/web-interface/archive/relation?bvid='+bvid,signal);
    if((kind==='like'&&relation?.like)||(kind==='favorite'&&relation?.favorite))return;
    let folderId:string|undefined;
    if(kind==='favorite') {
      // Choose an existing folder owned by this account, without assuming
      // undocumented flag bits identify the default or guessing sentinel 0.
      const data=await this.request(context,`/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(this.expectedMid!)}&rid=${verified.aid}&type=2`,signal);
      const folders=Array.isArray(data?.list)?data.list:[];
      const folder=folders.find((v:any)=>Number.isSafeInteger(v?.id)&&v.id>0&&String(v.mid)===this.expectedMid);
      if(!folder)throw new ModelFailure('ACCOUNT','未找到小号自己的收藏夹，未执行收藏');
      folderId=String(folder.id);
    }
    const cookies=await context.cookies('https://www.bilibili.com/');
    const csrf=cookies.find((c:any)=>c.name==='bili_jct')?.value;
    if(typeof csrf!=='string'||!csrf)throw new ModelFailure('LOGIN','小号登录失效，请重新登录');
    checkSignal(signal);
    if(kind==='like')await this.request(context,'/x/web-interface/archive/like',signal,{aid:String(verified.aid),like:'1',csrf});
    else await this.request(context,'/x/v3/fav/resource/deal',signal,{rid:String(verified.aid),type:'2',add_media_ids:folderId!,platform:'web',csrf});
    const after=await this.request(context,'/x/web-interface/archive/relation?bvid='+bvid,signal);
    if(kind==='like'?!after?.like:!after?.favorite)throw new ModelFailure('NETWORK','B 站互动结果尚未确认');
  }
  async like(video:BiliVideo,signal:AbortSignal):Promise<void>{return this.engage(video,signal,'like');}
  async favorite(video:BiliVideo,signal:AbortSignal):Promise<void>{return this.engage(video,signal,'favorite');}
  async dispose():Promise<void>{this.closed=true;if(this.launch)await this.launch.catch(()=>{});await this.close();}
}
