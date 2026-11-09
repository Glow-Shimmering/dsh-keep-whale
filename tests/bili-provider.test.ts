import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserBiliProvider, allowedBiliURL, subtitleURL, videoId, validateVideo, normalizeSubtitles } from '../src/bili/provider.js';
import { ModelFailure } from '../src/model.js';

const bv='BV1xx411c7mD';
const video={bvid:bv,aid:1,cid:2,title:'合成视频',owner:'合成 UP',ownerId:'10',duration:90,url:`https://www.bilibili.com/video/${bv}/`};
const info={bvid:bv,aid:1,cid:2,title:video.title,duration:90,videos:1,pages:[{cid:2}],owner:{mid:10,name:'合成 UP'},rights:{}};
const signal=()=>new AbortController().signal;
const response=(data:any,options:{status?:number;location?:string}={})=>({ok:()=>!options.status||options.status<400,headers:()=>options.location?{location:options.location}:{},text:async()=>JSON.stringify(data),status:()=>options.status||200});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'whale-bili-provider-'));
  const state={mid:'10',logged:true,failNav:false,subtitle:true,like:false,favorite:false,folder:true,posts:[] as string[],forms:[] as any[],pages:0,loginVisible:false,cleared:false,location:`https://www.bilibili.com/video/${bv}/`};
  const makePage=()=>{state.pages++;const locator={first:()=>locator,waitFor:async()=>{},evaluateAll:async()=>[`https://www.bilibili.com/video/${bv}/`],evaluate:async()=>{},screenshot:async()=>Buffer.from('synthetic-jpeg')};return {locator:()=>locator,goto:async()=>{},waitForFunction:async()=>{},on:()=>{},close:async()=>{}};};
  let handler=()=>{};
  const context={
    on:(_name:string,fn:()=>void)=>{handler=fn;},setDefaultTimeout:()=>{},route:async()=>{},addInitScript:async()=>{},pages:()=>[],newPage:async()=>makePage(),close:async()=>handler(),
    clearCookies:async()=>{state.cleared=true;state.logged=false;},cookies:async()=>[{name:'bili_jct',value:'synthetic-test-csrf'}],
    request:{get:async(url:string)=>{
      if(url.startsWith('https://b23.tv/'))return response({}, {status:302,location:state.location});
      if(url.includes('/x/web-interface/nav')){if(state.failNav)throw new Error('sensitive-query-token-from-network');return response({code:0,data:{isLogin:state.logged,mid:state.mid,uname:'合成小号'}});}
      if(url.includes('/x/web-interface/view?'))return response({code:0,data:info});
      if(url.includes('/x/player/v2?'))return response({code:0,data:{subtitle:{subtitles:state.subtitle?[{lan:'zh-CN',lan_doc:'中文',subtitle_url:'https://i0.hdslb.com/subtitle.json'}]:[]}}});
      if(url.includes('/x/web-interface/archive/relation'))return response({code:0,data:{like:state.like,favorite:state.favorite}});
      if(url.includes('/x/v3/fav/folder/created/list-all?'))return response({code:0,data:{list:state.folder?[{id:12345,mid:10,attr:0,title:'合成默认收藏夹'}]:[]}});
      if(url==='https://i0.hdslb.com/subtitle.json')return response({body:[{from:0,to:3,content:'测试字幕'}]});
      throw Error('unexpected synthetic request');
    },post:async(url:string,options:any)=>{state.posts.push(url);state.forms.push(options.form);if(url.endsWith('/like'))state.like=true;if(url.endsWith('/deal'))state.favorite=true;return response({code:0,data:{}});}}
  };
  const chromium={launchPersistentContext:async(_path:string,opts:any)=>{state.loginVisible=!opts.headless;return context;}};
  const provider=new BrowserBiliProvider(root,'00000000-0000-4000-8000-000000000000',{chromium});
  return {root,state,provider,cleanup:async()=>{await provider.dispose();rmSync(root,{recursive:true,force:true});}};
}

test('video and subtitle parsing reject forged origins, extra pages, and unsuitable sources',()=>{
  assert.equal(videoId(bv),bv);assert.equal(videoId(video.url+'?p=1'),bv);
  for(const s of [`https://bilibili.com.evil.invalid/video/${bv}`,`https://user@bilibili.com/video/${bv}`,`https://bilibili.com/video/${bv}?p=2`,`https://bilibili.com/video/${bv}?p=1&p=2`,`http://bilibili.com/video/${bv}`])assert.throws(()=>videoId(s));
  assert.equal(allowedBiliURL('https://i0.hdslb.com/path'),true);assert.equal(allowedBiliURL('https://hdslb.com.evil.invalid'),false);assert.equal(allowedBiliURL('http://www.bilibili.com'),false);
  assert.throws(()=>subtitleURL('https://127.0.0.1/sub.json'));assert.equal(subtitleURL('//i0.hdslb.com/sub.json'),'https://i0.hdslb.com/sub.json');
  assert.equal(validateVideo(info).bvid,bv);for(const change of [{videos:2},{rights:{pay:1}},{redirect_url:'https://example.invalid'}])assert.throws(()=>validateVideo({...info,...change}));
  assert.deepEqual(normalizeSubtitles([{from:0,to:1,content:' 字幕 '},{from:4,to:3,content:'bad'}],90),[{from:0,to:1,text:'字幕'}]);
  assert.throws(()=>normalizeSubtitles([],90));
});

test('dedicated login does not authorize browsing until an expected account is bound',async()=>{
  const f=fixture();try{
    await f.provider.login();assert.equal(f.state.loginVisible,true);
    const account=await f.provider.account(signal());assert.deepEqual(account,{loggedIn:true,mid:'10',name:'合成小号'});
    await assert.rejects(f.provider.candidates(signal()),(e:any)=>e instanceof ModelFailure&&e.code==='LOGIN');
    f.provider.setExpectedMid('11');await assert.rejects(f.provider.candidates(signal()),(e:any)=>e instanceof ModelFailure&&e.code==='ACCOUNT');
    f.provider.setExpectedMid('10');assert.equal((await f.provider.candidates(signal()))[0].bvid,bv);
    await f.provider.logout();assert.equal(f.state.cleared,true);assert.ok(readdirSync(join(f.root,'bili-browser')).some(n=>n.includes('.logged-out-')));
  }finally{await f.cleanup();}
});

test('profile directory cannot redirect into another browser and network errors are sanitized',async()=>{
  const f=fixture();try {
    symlinkSync(tmpdir(),join(f.root,'bili-browser'));
    await assert.rejects(f.provider.login(),(e:any)=>e instanceof ModelFailure&&e.code==='READ');
  }finally{await f.cleanup();}
  const g=fixture();try {
    g.state.failNav=true;
    await assert.rejects(g.provider.account(signal()),(e:any)=>e instanceof ModelFailure&&e.code==='NETWORK'&&!e.message.includes('sensitive-query-token'));
  }finally{await g.cleanup();}
});

test('short links require safe destinations and never follow untrusted redirects',async()=>{
  const f=fixture();try{
    assert.equal(await f.provider.resolve('https://b23.tv/abc',signal()),bv);
    f.state.location='http://127.0.0.1/private';await assert.rejects(f.provider.resolve('https://b23.tv/abc',signal()),(e:any)=>e instanceof ModelFailure&&e.code==='UNSUPPORTED');
    f.state.location=`https://www.bilibili.com/video/${bv}/?p=1&p=2`;await assert.rejects(f.provider.resolve('https://b23.tv/abc',signal()));
    await assert.rejects(f.provider.resolve('https://b23.tv.evil.invalid/abc',signal()));
  }finally{await f.cleanup();}
});

test('material has evidence from subtitle and sampled frames; missing subtitles or excessive duration stops',async()=>{
  const f=fixture();try{
    f.provider.setExpectedMid('10');const stages:string[]=[];
    await assert.rejects(f.provider.material(bv,signal(),s=>stages.push(s),60),(e:any)=>e instanceof ModelFailure&&e.code==='UNSUPPORTED');
    assert.equal(f.state.pages,0);
    await assert.rejects(f.provider.material(bv,signal(),s=>stages.push(s),120,()=>false),(e:any)=>e instanceof ModelFailure&&e.code==='SKIP');
    assert.equal(f.state.pages,0,'blocked owner or video is rejected before video navigation');
    const material=await f.provider.material(bv,signal(),s=>stages.push(s),120);
    assert.equal(material.video.bvid,bv);assert.equal(material.subtitles.length,1);assert.equal(material.frames.length,4);assert.match(material.coverage,/抽样画面/);assert.match(material.limitations[0],/不是逐秒观看/);
    assert.deepEqual(stages,['读取视频字幕','读取抽样画面']);
    f.state.subtitle=false;await assert.rejects(f.provider.material(bv,signal(),()=>{}),(e:any)=>e instanceof ModelFailure&&e.code==='SUBTITLE');
  }finally{await f.cleanup();}
});

test('like and favorite validate account, video identity, cancellation and write result',async()=>{
  const f=fixture();try{
    f.provider.setExpectedMid('11');await assert.rejects(f.provider.like(video,signal()));assert.equal(f.state.posts.length,0);
    f.provider.setExpectedMid('10');await assert.rejects(f.provider.like({...video,aid:999},signal()));assert.equal(f.state.posts.length,0);
    const controller=new AbortController();controller.abort();await assert.rejects(f.provider.like(video,controller.signal));assert.equal(f.state.posts.length,0);
    await f.provider.like(video,signal());await f.provider.like(video,signal());await f.provider.favorite(video,signal());
    assert.equal(f.state.posts.length,2);assert.ok(f.state.like&&f.state.favorite);assert.equal(f.state.forms[1].add_media_ids,'12345');
    f.state.favorite=false;f.state.folder=false;
    await assert.rejects(f.provider.favorite(video,signal()),(e:any)=>e instanceof ModelFailure&&e.code==='ACCOUNT');
    assert.equal(f.state.posts.length,2,'missing owned folder never creates or guesses a folder');
  }finally{await f.cleanup();}
});
