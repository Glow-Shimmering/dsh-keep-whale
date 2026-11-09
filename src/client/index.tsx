import type { DeletePreview, EmbeddingSettings, EmbeddingStatus, ImageRef, Ledger, Memory, MemoryDetail, MemoryPage as MemoryPageResult, Message, ModelInfo, PersonalityProfile, Settings, Snapshot } from '../types.js';
import css from './style.css';
import chatCss from './chat.css';
import { createMessageText } from './markdown.js';
import { budgetConfirmation, jobLedgerEntries, manualEmbeddingCalls, manualEmbeddingLabel, summarizeJobCosts } from './cost.js';
import { moodPortrait, interactionPortrait, overlaySize as sizeForViewport, clampOverlay, toggleOverlayPosition, INTERACTION_MS } from './appearance.js';

declare global {
  interface Window { __ModuleLoader__: { load(options: { id: string; factory: (require: (name: string) => any) => object }): void } }
}

window.__ModuleLoader__.load({
  id: 'dsh-keep-whale',
  factory(require) {
    const React = require('react') as typeof import('react');
    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;
    const MessageText=createMessageText(React);
    const PANEL = 'dsh-keep-whale';
    const PREFIX = '/keep-whale';
    const KEY_POSITION = 'dsh-keep-whale:position';
    const KEY_COLLAPSED = 'dsh-keep-whale:collapsed';
    const KEY_NOTICE = 'dsh-keep-whale:last-notice';
    const maxImageBytes = 8 * 1024 * 1024;
    const createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const read = <T,>(key: string, fallback: T): T => { try { const text = localStorage.getItem(key); return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };
    const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be disabled. */ } };
    const date = (n: number) => Number.isFinite(n) ? new Date(n).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const routeKey = (v: {provider:string;model:string} | null) => v ? JSON.stringify([v.provider, v.model]) : '';
    const labels: Record<string, string> = { user_fact:'用户事实', shared_episode:'共同经历', observed_dialogue:'普通对话观察', understanding:'暂定理解', tendency:'逐渐形成的倾向', embedding:'语义索引', active:'生效中', uncertain:'待确认', dormant:'暂未唤起', superseded:'已更新', related:'关联', same_event:'同一事件', supports:'支持', contradicts:'相反证据', updates:'更新', derived_from:'来源', interaction:'互动', chat:'聊天', memory:'记忆整理', proactive:'主动联系', running:'进行中', succeeded:'完成', failed:'未完成', interrupted:'已中断', skipped:'已跳过' };
    const label = (value: string) => labels[value] || value;

    let snapshot: Snapshot | null = null;
    let token = '';
    let connectionError: string | null = null;
    let subscribers = new Set<() => void>();
    let users = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let nextTab: Tab = 'chat';
    let panelIsOpen = false;
    let lastInputAt = Date.now();
    let composing = false;
    // Each rendered document owns an independent presence, including cloned windows.
    const windowId = createId();
    let presenceSeq = 0;
    const emit = () => subscribers.forEach(fn => fn());
    async function refresh() {
      if (polling) return;
      polling = true;
      try {
        const r = await fetch(`${PREFIX}/state`, { credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(9000) });
        const value = await r.json();
        if (!r.ok) throw new Error(value.error || '暂时无法连接');
        snapshot = value as Snapshot;
        token = typeof value.token === 'string' ? value.token : '';
        connectionError = null;
      } catch { connectionError = '暂时无法连接，请确认插件已启动。'; }
      finally { polling = false; emit(); }
    }
    function schedule() {
      clearTimeout(pollTimer);
      if (!users) return;
      pollTimer = setTimeout(async () => { await refresh(); schedule(); }, snapshot?.busy ? 800 : 4000);
    }
    function acquire(fn: () => void) {
      subscribers.add(fn); users++;
      if (users === 1) void refresh().finally(schedule);
      return () => { subscribers.delete(fn); users--; if (!users) clearTimeout(pollTimer); };
    }
    async function send(path: string, body: object): Promise<any> {
      if (!token) await refresh();
      if (!token) throw new Error('暂时无法连接，请确认插件已启动。');
      const r = await fetch(`${PREFIX}/${path}`, {
        method:'POST', credentials:'same-origin', cache:'no-store',
        headers:{'content-type':'application/json','x-keep-whale-token':token},
        body:JSON.stringify(body), signal:AbortSignal.timeout(path === 'upload' ? 45000 : 12000),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '操作暂未完成');
      return data;
    }
    async function act(action: string, extra: object = {}) {
      const result = await send('action', { action, ...extra });
      await refresh(); schedule();
      return result;
    }
    async function upload(file: File, kind: 'image' | 'skin'): Promise<ImageRef> {
      if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
      if (file.size <= 0 || file.size > maxImageBytes) throw new Error('每张图片需小于 8 MB。');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1] || '') : reject(new Error('无法读取图片'));
        reader.onerror = () => reject(new Error('无法读取图片'));
        reader.readAsDataURL(file);
      });
      const result = await send('upload', {kind, name:file.name, mediaType:file.type, data});
      const image = (result.image || result) as ImageRef;
      if (!image?.id || !image.url) throw new Error('图片没有上传成功。');
      return image;
    }
    function useData() {
      const [, redraw] = useState(0);
      useEffect(() => acquire(() => redraw(n => n + 1)), []);
      return {data:snapshot, connectionError};
    }
    type Tab = 'chat' | 'memory' | 'activity' | 'settings';
    function selectPanel(ctx:any,id:string|null) {
      if(typeof ctx.layout?.selectPanel!=='function')throw new Error('伙伴面板暂时无法打开，请重新加载插件。');
      ctx.layout.selectPanel(id);
    }
    function openPanel(ctx: any, tab: Tab = 'chat') {
      nextTab = tab;
      try { selectPanel(ctx,PANEL); }
      catch { return false; }
      window.dispatchEvent(new CustomEvent('dsh-keep-whale:tab', {detail:tab}));
      return true;
    }
    function isEditable(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
      if (target instanceof HTMLInputElement) return !target.readOnly && !target.disabled && !['button','checkbox','radio','file','submit','reset','range','color'].includes(target.type);
      return !!target.closest('[contenteditable="true"],[role="textbox"]');
    }
    function usePresence() {
      useEffect(() => {
        let mounted = true;
        let lastReport=0;
        const presence = () => {
          if (!mounted || !token) return;
          const now = Date.now(); lastReport=now;
          void send('action', {action:'presence',windowId,seq:++presenceSeq,visible:document.visibilityState === 'visible',typing:composing || now-lastInputAt < 3000,lastInputAt,panelOpen:panelIsOpen}).catch(() => {});
        };
        const activity=(force=false)=>{const now=Date.now();const wasTyping=composing||now-lastInputAt<3000;lastInputAt=now;if(force||!wasTyping||now-lastReport>=250)presence();};
        const input = (event: Event) => { if (isEditable(event.target)) activity(); };
        const startComposition = (event: Event) => { if (isEditable(event.target)) { composing = true; activity(true); } };
        const endComposition = () => { composing = false; activity(); };
        const closed=()=>{if(token)void fetch(`${PREFIX}/action`,{method:'POST',credentials:'same-origin',keepalive:true,headers:{'content-type':'application/json','x-keep-whale-token':token},body:JSON.stringify({action:'presence',windowId,seq:++presenceSeq,closed:true})}).catch(()=>{});};
        document.addEventListener('input',input,true); document.addEventListener('keydown',input,true);
        document.addEventListener('compositionstart',startComposition,true); document.addEventListener('compositionend',endComposition,true);
        const timer = setInterval(presence, 2000);
        const changed = () => presence();
        document.addEventListener('visibilitychange',changed); window.addEventListener('pagehide',closed);
        presence();
        return () => { closed(); mounted=false; clearInterval(timer); document.removeEventListener('input',input,true); document.removeEventListener('keydown',input,true); document.removeEventListener('compositionstart',startComposition,true); document.removeEventListener('compositionend',endComposition,true); document.removeEventListener('visibilitychange',changed); window.removeEventListener('pagehide',closed); };
      }, []);
    }
    function formatError(e: unknown) { return e instanceof Error ? e.message : '操作暂未完成'; }
    function fallbackPortrait(event: React.SyntheticEvent<HTMLImageElement>, skin?:string|null) {
      const image=event.currentTarget;
      if(!image.dataset.fallback && skin) {image.dataset.fallback='1';image.src=skin;}
      else if(image.dataset.fallback!=='2'){image.dataset.fallback='2';image.src=`${PREFIX}/portrait.png`;}
    }
    function downloadJSON(value: unknown) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type:'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = 'keep-whale-memories.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    type ChatIconName = 'plus'|'send'|'stop'|'copy'|'retry'|'down'|'more'|'close'|'back';
    function ChatIcon({name}: {name:ChatIconName}) {
      const paths:Record<ChatIconName,string>={plus:'M12 5v14M5 12h14',send:'m6 11 6-6 6 6M12 5v14',stop:'M6 6h12v12H6z',copy:'M9 5V3h11v13h-2M4 7h11v14H4z',retry:'M4 10a8 8 0 1 1 1 8M4 4v6h6',down:'m6 9 6 6 6-6',more:'M5 12h.01M12 12h.01M19 12h.01',close:'m6 6 12 12M18 6 6 18',back:'m14 6-6 6 6 6'};
      return <svg className="kw-chat-icon" viewBox="0 0 24 24" fill={name==='stop'?'currentColor':'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
    }
    function Chat({data, report, active, openSettings}: {data:Snapshot; report:(s:string)=>void; active:boolean; openSettings:()=>void}) {
      const [text,setText] = useState('');
      const [images,setImages] = useState<ImageRef[]>([]);
      const [uploading,setUploading] = useState(false);
      const [pending,setPending] = useState(false);
      const [older,setOlder] = useState<Message[]>([]);
      const [hasMore,setHasMore] = useState(data.messages.length >= 200);
      const [loadingHistory,setLoadingHistory] = useState(false);
      const [atBottom,setAtBottom] = useState(true);
      const [copied,setCopied] = useState<string|null>(null);
      const previousSnapshot = useRef({revision:data.revision,messages:data.messages});
      const viewport = useRef<HTMLDivElement>(null), editor = useRef<HTMLTextAreaElement>(null);
      const follow = useRef(true), restoreScroll = useRef<{height:number;top:number}|null>(null);
      const copyTimer = useRef<ReturnType<typeof setTimeout>|null>(null);
      const request = useRef<string | null>(null);
      const requestPending = useRef(false);
      const latestIds = new Set(data.messages.map(message => message.id));
      const list = [...older.filter(message => !latestIds.has(message.id)), ...data.messages];
      const modelName=data.models.find(m=>routeKey(m)===routeKey(data.settings.model))?.name || data.settings.model?.model || '选择模型';
      const portrait=moodPortrait(data.companion.mood,data.settings.skin,data.appearance);
      useEffect(()=>()=>{if(copyTimer.current)clearTimeout(copyTimer.current);},[]);
      useEffect(() => {
        const previous=previousSnapshot.current;
        if(previous.revision!==data.revision) { setOlder([]); setHasMore(data.messages.length>=200); }
        else if(data.messages.length===200) {
          const currentIds=new Set(data.messages.map(message=>message.id));
          const dropped=previous.messages.filter(message=>!currentIds.has(message.id)&&message.createdAt<=data.messages[0].createdAt);
          if(dropped.length) setOlder(current=>{const seen=new Set(current.map(message=>message.id));return [...current,...dropped.filter(message=>!seen.has(message.id))];});
        }
        previousSnapshot.current={revision:data.revision,messages:data.messages};
      }, [data.revision,data.messages]);
      useEffect(() => { if (active && document.visibilityState === 'visible' && data.unread) void act('read').catch(() => {}); }, [active,data.unread]);
      const jumpToLatest=()=>{follow.current=true;setAtBottom(true);const v=viewport.current;if(v)v.scrollTop=v.scrollHeight;};
      useLayoutEffect(()=>{
        if(!active)return;
        const v=viewport.current;if(!v)return;
        if(restoreScroll.current){v.scrollTop=restoreScroll.current.top+v.scrollHeight-restoreScroll.current.height;restoreScroll.current=null;}
        else if(follow.current)v.scrollTop=v.scrollHeight;
      },[active,list.length,list.at(-1)?.text,list.at(-1)?.status,loadingHistory]);
      useLayoutEffect(()=>{const field=editor.current;if(!field||!active)return;field.style.height='auto';field.style.height=`${Math.min(field.scrollHeight,180)}px`;},[text,active]);
      const loadHistory=async()=>{
        const before=list[0]?.id; if(!before||loadingHistory)return; setLoadingHistory(true); report('');
        try {
          const response=await fetch(`${PREFIX}/messages?before=${encodeURIComponent(before)}`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(9000)});
          const result=await response.json(); if(!response.ok)throw new Error(result.error||'暂时无法读取更早的聊天');
          if(!Array.isArray(result.messages)||typeof result.hasMore!=='boolean')throw new Error('聊天历史格式无效');
          const v=viewport.current;if(v)restoreScroll.current={height:v.scrollHeight,top:v.scrollTop};
          follow.current=false;
          setOlder(current=>{const seen=new Set(current.map(x=>x.id));return [...result.messages.filter((x:Message)=>!seen.has(x.id)),...current];});
          setHasMore(result.hasMore);
        }catch(e){report(formatError(e));}finally{setLoadingHistory(false);}
      };
      const addFiles = async (files: File[]) => {
        if (!files.length || uploading || requestPending.current) return;
        if (!data.capability.images) { report('当前模型没有确认图片能力，请在设置中选择支持图片的模型。'); return; }
        if (files.length + images.length > 4) { report('每次最多发送 4 张图片。'); return; }
        setUploading(true); report('');
        try {
          const added: ImageRef[] = [];
          for (const file of files) added.push(await upload(file,'image'));
          setImages(old => [...old,...added]);request.current=null;
        } catch (e) { report(formatError(e)); }
        finally { setUploading(false); }
      };
      const submit = async () => {
        if (requestPending.current || data.busy || uploading || (!text.trim() && !images.length)) return;
        requestPending.current=true;setPending(true); report('');
        const requestId = request.current || createId(); request.current = requestId;
        try { await act('chat', {requestId,text:text.trim(),imageIds:images.map(image=>image.id)}); setText(''); setImages([]); request.current=null;jumpToLatest();editor.current?.focus(); }
        catch (e) { report(formatError(e)); }
        finally { requestPending.current=false;setPending(false); }
      };
      const retryMessage=async(message:Message)=>{
        if(requestPending.current||data.busy)return;
        requestPending.current=true;setPending(true);report('');follow.current=true;
        try {await act('retry',{messageId:message.id});}
        catch(e){report(formatError(e));}
        finally {requestPending.current=false;setPending(false);}
      };
      const copyMessage=async(message:Message)=>{
        try {await navigator.clipboard.writeText(message.text);setCopied(message.id);if(copyTimer.current)clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>setCopied(null),1800);}
        catch {report('暂时无法复制，请选中文字复制。');}
      };
      const clearVisible=()=>{
        if(data.busy)return;
        if(window.confirm('删除已加载的问答及对应回复？相关记忆依据也会撤回。'))void act('messages.delete',{ids:list.map(x=>x.id),confirm:true}).then(()=>{setOlder([]);setHasMore(true);}).catch(e=>report(formatError(e)));
      };
      return <div className="kw-chat-view" hidden={!active}>
        <div className="kw-chat-history" ref={viewport} aria-label="聊天消息" onScroll={()=>{const v=viewport.current;if(!v)return;const near=v.scrollHeight-v.scrollTop-v.clientHeight<96;follow.current=near;setAtBottom(near);}} onLoad={()=>{if(follow.current)jumpToLatest();}}>
          <div className="kw-chat-transcript">
            <div className="kw-history-tools">
              {hasMore&&list.length>0&&<button className="kw-text-button" type="button" disabled={loadingHistory} onClick={()=>void loadHistory()}>{loadingHistory?'正在读取…':'加载更早的聊天'}</button>}
              {!!list.length&&<details className="kw-chat-menu"><summary aria-label="聊天管理" title="聊天管理"><ChatIcon name="more"/></summary><div><button type="button" className="kw-danger" disabled={data.busy} onClick={clearVisible}>删除已加载的聊天</button></div></details>}
            </div>
            {list.length===0 && <div className="kw-chat-welcome"><img key={portrait} src={portrait} onError={e=>fallbackPortrait(e,data.settings.skin)} alt=""/><h2>{data.companion.name}在这里</h2><p>今天想聊些什么？</p></div>}
            {list.map(m => <article key={m.id} className={`kw-chat-message kw-chat-${m.role}`} aria-label={`${m.role==='user'?'你':data.companion.name}的消息`}>
              {m.role==='assistant'&&<img className="kw-message-avatar" key={portrait} src={portrait} onError={e=>fallbackPortrait(e,data.settings.skin)} alt={data.companion.name}/>}
              <div className="kw-message-main">
                {m.role==='assistant'&&<div className="kw-reply-heading"><strong>{data.companion.name}</strong>{m.origin==='proactive'&&<span>主动分享</span>}{m.status==='streaming'&&<span className="kw-stream-status" role="status">正在回复<span className="kw-typing-dots" aria-hidden="true"><i/><i/><i/></span></span>}</div>}
                <div className="kw-message-content">{m.text&&<MessageText text={m.text} role={m.role}/>}{!m.text&&m.status==='streaming'&&<span className="kw-thinking">让我想一想…</span>}
                  {!!m.images.length && <div className="kw-chat-images">{m.images.map(img => <a key={img.id} href={img.url} target="_blank" rel="noreferrer"><img src={img.url} alt={img.name}/></a>)}</div>}
                </div>
                {m.error && <p className="kw-message-error" role="status">{m.error}</p>}
                <footer className="kw-message-footer"><time dateTime={new Date(m.createdAt).toISOString()} title={date(m.createdAt)}>{new Date(m.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>
                  {m.status==='failed'?<span>回复未完成</span>:m.status==='cancelled'?<span>已停止</span>:null}
                  {m.text&&<button className="kw-icon-button" type="button" aria-label={copied===m.id?'已复制':'复制消息'} title={copied===m.id?'已复制':'复制'} onClick={()=>void copyMessage(m)}><ChatIcon name="copy"/>{copied===m.id&&<span>已复制</span>}</button>}
                  {(m.status==='failed' || m.status==='cancelled') && <button className="kw-text-button" type="button" disabled={pending||data.busy} onClick={() => void retryMessage(m)}><ChatIcon name="retry"/>重试</button>}
                </footer>
              </div>
            </article>)}
          </div>
        </div>
        <div className="kw-composer-dock">
          {!atBottom&&<button className="kw-jump-latest" type="button" onClick={jumpToLatest}><ChatIcon name="down"/>回到最新</button>}
          <form className="kw-chat-composer" onSubmit={event => {event.preventDefault(); void submit();}}>
            {images.length > 0 && <div className="kw-attachment-tray">{images.map(image=><div className="kw-attachment" key={image.id}><img src={image.url} alt={image.name}/><span>{image.name}</span><button type="button" className="kw-icon-button" aria-label={`移除${image.name}`} disabled={pending} onClick={()=>{setImages(old=>old.filter(x=>x.id!==image.id));request.current=null;}}><ChatIcon name="close"/></button></div>)}</div>}
            <textarea ref={editor} aria-label="聊天内容" placeholder={`给${data.companion.name}发消息…`} rows={2} value={text} disabled={pending} onChange={e=>{setText(e.target.value);request.current=null;}} onPaste={e=>{const files=Array.from(e.clipboardData.files).filter(f=>f.type.startsWith('image/')); if(files.length){e.preventDefault();const pasted=e.clipboardData.getData('text/plain');if(pasted){const field=e.currentTarget;setText(text.slice(0,field.selectionStart)+pasted+text.slice(field.selectionEnd));request.current=null;}void addFiles(files);}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submit();}}}/>
            <div className="kw-composer-toolbar"><div className="kw-composer-left"><label className={`kw-add-image ${uploading||!data.capability.images?'is-disabled':''}`} title={data.capability.images?'添加图片':'当前模型未确认图片能力'}><ChatIcon name="plus"/><input type="file" aria-label="添加图片" accept="image/png,image/jpeg,image/webp" multiple disabled={pending||uploading || images.length>=4 || !data.capability.images} onChange={e=>{void addFiles(Array.from(e.target.files || []));e.target.value='';}}/></label><span>{uploading?'正在上传…':'独立陪伴'}</span></div>
              <div className="kw-composer-right"><button type="button" className="kw-model-button" title="模型与预算设置" onClick={openSettings}><span>{modelName}</span><ChatIcon name="down"/></button>{data.busy?<button className="kw-send-button is-stop" type="button" title="停止回复" aria-label="停止回复" onClick={()=>{void act('cancel').catch(e=>report(formatError(e)));}}><ChatIcon name="stop"/></button>:<button className="kw-send-button" type="submit" title="发送消息" aria-label="发送消息" disabled={pending||uploading||(!text.trim()&&!images.length)||!data.capability.chat}><ChatIcon name="send"/></button>}</div>
            </div>
          </form>
          <div className="kw-composer-help">{!data.capability.chat?<button className="kw-text-button" type="button" onClick={openSettings}>选择模型后开始聊天</button>:<span>Enter 发送 · Shift + Enter 换行</span>}</div>
        </div>
      </div>;
    }

    function MemoryPage({data,report,notice}: {data:Snapshot;report:(s:string)=>void;notice:(s:string)=>void}) {
      const [query,setQuery]=useState(''),[kind,setKind]=useState(''),[state,setState]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[semantic,setSemantic]=useState(false);
      const [filter,setFilter]=useState<Record<string,unknown>>({}),[offset,setOffset]=useState(0),[page,setPage]=useState<MemoryPageResult|null>(null);
      const [view,setView]=useState<'records'|'profile'>('records'),[profile,setProfile]=useState<PersonalityProfile|null>(null);
      const [selected,setSelected]=useState<string[]>([]),[detail,setDetail]=useState<MemoryDetail|null>(null),[edit,setEdit]=useState(''),[editing,setEditing]=useState<'edit'|'correct'|null>(null);
      const [preview,setPreview]=useState<{requested:string[];value:DeletePreview;all:boolean}|null>(null),[loading,setLoading]=useState(false),[deleting,setDeleting]=useState(false);
      const [reload,setReload]=useState(0); const sequence=useRef(0),detailSequence=useRef(0),lastRevision=useRef(data.revision);
      const limit=20;
      useEffect(()=>{let alive=true;const current=++sequence.current;setLoading(true);
        void send('action',{action:'memory.list',...filter,offset,limit}).then((result:MemoryPageResult)=>{if(alive&&current===sequence.current){setPage(result);setLoading(false);}}).catch(e=>{if(alive&&current===sequence.current){setLoading(false);setPage(null);report(formatError(e));}});
        return()=>{alive=false;};
      },[filter,offset,reload]);
      // Do not silently repeat a user-paid semantic query when background memory changes.
      useEffect(()=>{if(lastRevision.current!==data.revision){lastRevision.current=data.revision;if(!filter.semantic)setReload(n=>n+1);}},[data.revision,filter]);
      useEffect(()=>{if(view!=='profile')return;let alive=true;void send('action',{action:'memory.profile'}).then((result:PersonalityProfile)=>{if(alive)setProfile(result);}).catch(e=>{if(alive)report(formatError(e));});return()=>{alive=false;};},[view,reload,data.revision]);
      const applyFilters=(e:React.FormEvent)=>{e.preventDefault();if(from&&to&&from>to){report('开始日期不能晚于结束日期。');return;}report('');setOffset(0);setSelected([]);setFilter({...(query.trim()?{query:query.trim()}:{}),...(kind?{kind}:{}),...(state?{state}:{}),...(from?{from:Date.parse(from+'T00:00:00+08:00')}:{}),...(to?{to:Date.parse(to+'T23:59:59.999+08:00')}:{}),...(query.trim()&&semantic?{semantic:true}:{})});};
      const openDetail=async(id:string)=>{const current=++detailSequence.current;setEditing(null);setDetail(null);report('');try{const result:MemoryDetail|null=await send('action',{action:'memory.detail',id});if(current===detailSequence.current){if(!result)throw Error('这条记忆已不存在。');setDetail(result);}}catch(e){if(current===detailSequence.current)report(formatError(e));}};
      const previewDelete=async(ids:string[],all=false)=>{if(!all&&!ids.length)return;report('');try{const result:DeletePreview=await send('action',{action:'memory.preview',...(all?{all:true}:{ids})});setPreview({requested:all?result.ids:ids,value:result,all});}catch(e){report(formatError(e));}};
      const deleteConfirmed=async()=>{if(!preview||deleting)return;setDeleting(true);report('');try{await act('memory.delete',{...(preview.all?{all:true}:{ids:preview.requested}),confirm:true,revision:preview.value.revision});setPreview(null);setSelected([]);setDetail(null);setOffset(0);setSemantic(false);setFilter(old=>{const {semantic:ignored,...local}=old;void ignored;return local;});setReload(n=>n+1);notice('已删除选中的记忆并撤回关联依据。');}catch(e){setPreview(null);report(formatError(e)+'；请重新预览删除影响。');}finally{setDeleting(false);}};
      const submitEdit=async()=>{if(!detail||!editing||!edit.trim())return;try{await act(editing==='edit'?'memory.edit':'memory.correct',{id:detail.memory.id,text:edit.trim()});setEditing(null);setDetail(null);setSemantic(false);setFilter(old=>{const {semantic:ignored,...local}=old;void ignored;return local;});setReload(n=>n+1);notice(editing==='edit'?'记忆已更新。':'已记录你的纠正，后续会结合证据重新理解。');}catch(e){report(formatError(e));}};
      const doExport=async()=>{try{downloadJSON(await act('memory.export'));notice('已导出记忆和来源。');}catch(e){report(formatError(e));}};
      const factOrCorrection=(memory:Memory)=>memory.kind==='user_fact'||memory.kind==='understanding'||memory.kind==='tendency';
      const memoryCards=(items:Memory[],selectable:boolean)=>items.map(memory=><article className="kw-card kw-memory" key={memory.id}>
        <div className="kw-row kw-between"><div className="kw-row">{selectable&&<input type="checkbox" checked={selected.includes(memory.id)} aria-label={`选择记忆 ${memory.text.slice(0,20)}`} onChange={e=>setSelected(old=>e.target.checked?[...old,memory.id]:old.filter(id=>id!==memory.id))}/>}<span className="kw-badge">{label(memory.kind)}</span><span className="kw-badge">{label(memory.recallState||memory.status||'active')}</span></div><small>{date(memory.updatedAt)}</small></div>
        <p>{memory.text}</p><div className="kw-row"><button type="button" onClick={()=>void openDetail(memory.id)}>详情与依据</button><button className="kw-danger" type="button" onClick={()=>void previewDelete([memory.id])}>删除</button></div>
      </article>);
      return <div className="kw-stack"><div className="kw-heading"><div><h2>记忆</h2><small>记录有来源；暂定理解和倾向可以被新证据修正。</small></div><button type="button" onClick={()=>void doExport()}>导出记忆</button></div>
        <div className="kw-row" role="tablist" aria-label="记忆视图"><button type="button" role="tab" aria-selected={view==='records'} onClick={()=>setView('records')}>记忆记录</button><button type="button" role="tab" aria-selected={view==='profile'} onClick={()=>setView('profile')}>人格档案</button></div>
        {view==='records'?<><form className="kw-card kw-form" onSubmit={applyFilters}>
          <label>搜索记忆<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="关键词或自然语言" aria-label="搜索记忆"/></label>
          <div className="kw-form-grid"><label>类型<select value={kind} onChange={e=>setKind(e.target.value)}><option value="">全部类型</option>{['user_fact','shared_episode','observed_dialogue','understanding','tendency'].map(x=><option value={x} key={x}>{label(x)}</option>)}</select></label><label>状态<select value={state} onChange={e=>setState(e.target.value)}><option value="">全部状态</option>{['active','uncertain','dormant','superseded'].map(x=><option value={x} key={x}>{label(x)}</option>)}</select></label><label>开始日期（北京时间）<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>结束日期（北京时间）<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div>
          <label className="kw-checkbox"><input type="checkbox" checked={semantic} onChange={e=>setSemantic(e.target.checked)}/><span>语义搜索<small> · 需配置并检查语义索引；仅点击搜索时调用，手动费用单独计费。</small></span></label><div className="kw-row"><button type="submit" className="kw-primary">搜索 / 筛选</button><button type="button" onClick={()=>{setQuery('');setKind('');setState('');setFrom('');setTo('');setSemantic(false);setFilter({});setOffset(0);setSelected([]);}}>重置</button></div>
        </form>
        <div className="kw-row kw-between"><small>{loading?'正在读取…':`共 ${page?.total??0} 条${page?.mode==='hybrid'?' · 混合检索':' · 本地检索'}`}{page?.reason?` · ${page.reason}`:''}</small><div className="kw-row"><button type="button" disabled={!selected.length} onClick={()=>void previewDelete(selected)}>删除所选（{selected.length}）</button><button type="button" disabled={!page?.total && !Object.keys(filter).length} onClick={()=>void previewDelete([],true)}>清空全部记忆</button></div></div>
        {!loading&&page?.items.length===0&&<div className="kw-empty">没有符合条件的记忆。</div>}{memoryCards(page?.items||[],true)}
        <div className="kw-row kw-between"><button type="button" disabled={loading||offset===0} onClick={()=>setOffset(Math.max(0,offset-limit))}>上一页</button><small>{page?.total?`${offset+1}–${Math.min(offset+limit,page.total)} / ${page.total}`:'0 条'}</small><button type="button" disabled={loading||!page||offset+limit>=page.total} onClick={()=>setOffset(offset+limit)}>下一页</button></div></>:<div className="kw-stack"><section className="kw-card"><h3>初始倾向</h3><small>这是角色设定，不是过去经历。</small>{profile?.initial.map((text,index)=><p key={index}>{text}</p>)||<p>正在读取…</p>}</section><section className="kw-card"><h3>暂定理解</h3><small>尚待更多相处证据，可以修正。</small></section>{memoryCards(profile?.tentative||[],false)}<section className="kw-card"><h3>逐渐形成的倾向</h3><small>可查看支持和相反的证据，也可能改变。</small></section>{memoryCards(profile?.tendencies||[],false)}</div>}
        {detail&&<section className="kw-card kw-detail" role="dialog" aria-modal="true" aria-label="记忆详情"><div className="kw-heading"><h3>记忆详情</h3><button type="button" onClick={()=>{detailSequence.current++;setDetail(null);setEditing(null);}}>关闭</button></div><div className="kw-row"><span className="kw-badge">{label(detail.memory.kind)}</span><span className="kw-badge">{label(detail.memory.recallState||detail.memory.status||'active')}</span><small>更新于 {date(detail.memory.updatedAt)}</small></div><p>{detail.memory.text}</p>
          {editing&&<div className="kw-stack"><label>{editing==='edit'?'修改用户事实':'提供你的纠正'}<textarea value={edit} onChange={e=>setEdit(e.target.value)} rows={3}/></label><small>{editing==='edit'?'原依据及其派生内容会被撤回。':'纠正会作为独立来源保存，不会直接改写性格或发送聊天。'}</small><div className="kw-row"><button type="button" className="kw-primary" disabled={!edit.trim()} onClick={()=>void submitEdit()}>保存</button><button type="button" onClick={()=>setEditing(null)}>取消</button></div></div>}
          {factOrCorrection(detail.memory)&&!editing&&<button type="button" onClick={()=>{setEditing(detail.memory.kind==='user_fact'?'edit':'correct');setEdit(detail.memory.kind==='user_fact'?detail.memory.text:'');}}>{detail.memory.kind==='user_fact'?'修改用户事实':'提供纠正'}</button>}
          <h4>原文与证据</h4>{detail.sources.length===0&&<small>没有可显示的来源。</small>}{detail.sources.map(source=><div className="kw-source" key={source.id}><strong>{label(source.kind)} · {date(source.createdAt)}</strong><div>{source.text}</div>{(detail.memory.evidence||[]).filter(e=>e.sourceId===source.id).map((e,i)=><div key={i}>支持：{e.quote}</div>)}{(detail.memory.counterEvidence||[]).filter(e=>e.sourceId===source.id).map((e,i)=><div key={i}>相反证据：{e.quote}</div>)}{source.context&&<div>上下文（助手回复仅供理解）：{source.context}</div>}</div>)}
          <h4>关联记忆</h4>{detail.relations.length===0&&<small>暂无关联。</small>}{detail.relations.map(relation=>{const otherId=relation.fromId===detail.memory.id?relation.toId:relation.fromId;const other=detail.related.find(m=>m.id===otherId);return <div className="kw-source" key={relation.id}>{label(relation.kind)}：{other?<button type="button" onClick={()=>void openDetail(other.id)}>{other.text}</button>:otherId}{relation.evidence.map((e,i)=><div key={i}>依据：{e.quote}</div>)}</div>;})}
          <h4>变化历史</h4>{detail.history.length===0&&<small>暂无历史版本。</small>}{detail.history.map(old=><div className="kw-source" key={old.id}>{date(old.updatedAt)} · {label(old.status||'active')} · {old.text}</div>)}
          <div className="kw-row"><button className="kw-danger" type="button" onClick={()=>void previewDelete([detail.memory.id])}>删除这条记忆</button></div>
        </section>}
        {preview&&<section className="kw-card kw-detail" role="alertdialog" aria-modal="true" aria-label="确认删除记忆"><h3>确认删除</h3><p>选中 {preview.requested.length} 条，将影响 {preview.value.memories.length} 条记忆与 {preview.value.sourceIds.length} 条来源。</p><small>包含关联内容和派生理解；真实聊天消息不会因此删除。请检查影响后确认。</small><div className="kw-delete-list">{preview.value.memories.slice(0,50).map(memory=><p key={memory.id}><span className="kw-badge">{label(memory.kind)}</span> {memory.text}</p>)}{preview.value.memories.length>50&&<p>另外还有 {preview.value.memories.length-50} 条受影响记忆。</p>}</div><div className="kw-row"><button type="button" className="kw-danger" disabled={deleting} onClick={()=>void deleteConfirmed()}>{deleting?'正在删除…':'确认删除'}</button><button type="button" disabled={deleting} onClick={()=>setPreview(null)}>取消</button></div></section>}
      </div>;
    }

    function JobCost({jobId,entries}: {jobId:string;entries:Array<Ledger & {unit?:string}>}) {
      const matching=jobLedgerEntries(jobId,entries);
      if(!matching.length)return <p><small>费用：暂无记录</small></p>;
      const totals=summarizeJobCosts(matching);
      const format=(n:number)=>n>0&&n<0.000001?'<0.000001':String(Number(n.toFixed(6)));
      return <div><p><small>费用：{totals.map(total=>[total.exceeded?'实际费用超出原预估':'',total.hasActual?`已计 ${format(total.actual)} ${total.unit}`:'',total.hasReserved?`预留 ${format(total.reserved)} ${total.unit}`:'',total.hasEstimated?`预算暂记 ${format(total.estimated)} ${total.unit}（实际费用未核实）`:'',total.hasUncertain?`未核实（保留 ${format(total.uncertain)} ${total.unit}）`:''].filter(Boolean).join(' · ')).join('；')}</small></p>{matching.some(entry=>entry.details)&&<details><summary>供应商原始费用与折算</summary>{matching.filter(entry=>entry.details).map(entry=>{const d=entry.details!;return <div className="kw-source" key={entry.id}>{d.provider} · {d.model}<br/>{d.rawActual!=null?`原始实际费用 ${format(d.rawActual)} ${d.rawUnit}`:entry.status==='uncertain'?`原始费用未核实${d.rawReserved!=null?`，预留 ${format(d.rawReserved)} ${d.rawUnit}`:''}`:`原始预留 ${d.rawReserved==null?'未记录':`${format(d.rawReserved)} ${d.rawUnit}`}`}<br/>原费用 × {format(d.conversionRate)} = 预算单位费用 · {d.priceVerified?'单价已核实':'单价未核实'}{d.inputTokens!=null&&` · 输入 ${d.inputTokens} tokens`}<br/><small>原始供应商费用和伙伴预算折算独立于 tju 实际账户余额。</small></div>;})}</details>}</div>;
    }
    function Activity({data,report}: {data:Snapshot;report:(s:string)=>void}) {
      const {jobs,usage,interactions}=data;
      const [acknowledging,setAcknowledging]=useState<string|null>(null);
      const acknowledgePending=useRef(false);
      const acknowledge=async(entry:Ledger)=>{
        if(acknowledgePending.current||!window.confirm(budgetConfirmation(entry)))return;
        acknowledgePending.current=true;
        setAcknowledging(entry.id);report('');
        try { await act('billing.acknowledge',{id:entry.id,day:entry.day,unit:entry.unit,amount:entry.actual??entry.reserved,confirm:true}); }
        catch(e){report(formatError(e));}finally{acknowledgePending.current=false;setAcknowledging(null);}
      };
      const ledger=(data as Snapshot & {ledger?:Array<Ledger & {unit?:string}>}).ledger || [];
      const chatUncertain=(usage as typeof usage & {chatUncertain?:boolean}).chatUncertain===true;
      const manualEmbedding=manualEmbeddingCalls(ledger);
      const succeeded=jobs.filter(j=>j.status==='succeeded').length;
      const failed=jobs.filter(j=>j.status==='failed'||j.status==='interrupted').length;
      return <div className="kw-stack"><div className="kw-heading"><div><h2>近况</h2><small>心情与正在进行的活动分别记录。</small></div><span className="kw-badge">心情：{data.companion.mood}</span></div>
        <div className="kw-row"><div className="kw-card kw-metric"><small>后台今日已计 / 未结算预估</small><strong>{usage.spent.toFixed(4)} / {usage.reserved.toFixed(4)}</strong><small>{usage.unit} · 聊天、记忆整理与主动联系不限预算</small>{!!usage.estimated&&<small>另有 {usage.estimated.toFixed(6)} {usage.unit} 暂记，实际费用未核实</small>}</div><div className="kw-card kw-metric"><small>任务记录</small><strong>{jobs.length} 次尝试</strong><small>{succeeded} 次完成 · {failed} 次未完成或中断</small></div><div className="kw-card kw-metric"><small>手动调用（聊天、搜索与连接检查）</small><strong>{chatUncertain?'未核实':usage.chatSpent.toFixed(4)}</strong><small>{chatUncertain?'至少一笔手动调用费用未知':usage.unit}</small></div></div>
        {usage.uncertain && <p className="kw-error" role="status">有历史或后台调用费用未核实或超出原预估，记录会保留；不影响聊天、记忆整理、索引或主动联系。</p>}
        {!!data.budgetBlockers?.length&&<section className="kw-card kw-stack"><h3>B 站费用确认与恢复</h3><small>中断调用可能已经收费。请优先核对供应商账单；也可明确接受按预留金额暂记本地预算。原始账目保留，未知费用不会被当作实际扣费。仅 B 站预算受这些记录影响，聊天、记忆整理与主动联系不受影响。</small>{data.budgetBlockers.map(entry=><article className="kw-source" key={entry.id}><strong>{date(entry.createdAt)} · {entry.details?.provider||'原调用'} · {entry.details?.model||'模型未记录'}</strong><p>{entry.actual===null?`实际费用未核实，拟暂记 ${entry.reserved} ${entry.unit}`:`实际费用 ${entry.actual} ${entry.unit} 超出预留 ${entry.reserved} ${entry.unit}`}</p><button type="button" disabled={!!acknowledging} onClick={()=>void acknowledge(entry)}>{acknowledging===entry.id?'正在记录…':entry.actual===null?'确认按预留暂记预算':'确认已知超额费用'}</button></article>)}</section>}
        <div className="kw-heading"><h2>最近活动</h2></div>
        {!jobs.length && !interactions.length && <div className="kw-empty">暂时没有活动记录。</div>}
        {jobs.map(job=><article className="kw-card" key={job.id}><div className="kw-row kw-between"><strong>{label(job.kind)} · {label(job.status)}</strong><small>{date(job.updatedAt)}</small></div><p>{job.stage || '等待处理'}</p>{job.reason && <small>{job.reason}</small>}<JobCost jobId={job.id} entries={ledger}/>{(job.kind==='memory'||job.kind==='embedding')&&job.status!=='running'&&job.status!=='succeeded'&&<div className="kw-row"><button type="button" onClick={()=>void act('job.retry',{id:job.id}).catch(e=>report(formatError(e)))}>重试整理</button></div>}</article>)}
        {!!manualEmbedding.length && <section className="kw-card"><h3>手动语义调用</h3><small>对话回想、搜索和连接检查单独计费，不受 B 站预算限制。这里是明细，不会重复收费。供应商费用与 tju 实际账户余额分开。</small>{manualEmbedding.map(entry=><article className="kw-source" key={entry.id}><strong>{manualEmbeddingLabel(entry.jobId)} · {date(entry.createdAt)}</strong><JobCost jobId={entry.jobId} entries={[entry]}/></article>)}</section>}
        {!!interactions.length && <div className="kw-card"><strong>最近互动</strong>{interactions.map(i=><p key={i.id}><small>{date(i.createdAt)} · {i.type==='pet'?'摸摸':'喂食'}</small><br/>{i.text}</p>)}</div>}
      </div>;
    }
    function EmbeddingPanel({data,report,notice}: {data:Snapshot;report:(s:string)=>void;notice:(s:string)=>void}) {
      const initial=data.settings.embedding;
      const [enabled,setEnabled]=useState(initial?.enabled??false),[endpoint,setEndpoint]=useState(initial?.endpoint||''),[model,setModel]=useState(initial?.model||'');
      const [dimensions,setDimensions]=useState(initial?String(initial.dimensions):''),[price,setPrice]=useState(initial?String(initial.inputPrice):''),[unit,setUnit]=useState(initial?.unit||'CNY'),[ratio,setRatio]=useState(initial?.unitsPerYuan==null?'':String(initial.unitsPerYuan));
      const [secret,setSecret]=useState(''),[clearKey,setClearKey]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState<EmbeddingStatus|null>(data.embedding||null);
      useEffect(()=>{if(data.embedding)setStatus(data.embedding);},[data.embedding]);
      const save=async()=>{if(busy)return;report('');
        if(!endpoint.trim()||!model.trim()||!unit.trim()||!Number.isSafeInteger(Number(dimensions))||Number(dimensions)<=0||!price.trim()||!Number.isFinite(Number(price))||Number(price)<0||(ratio.trim()&&(!Number.isFinite(Number(ratio))||Number(ratio)<=0))){report('请填写接口地址、模型、正整数维度、非负单价和费用单位；换算率如填写须大于零。');return;}
        if(secret&&clearKey){report('请只选择更新密钥或删除密钥。');return;}
        const config:EmbeddingSettings={enabled,endpoint:endpoint.trim(),model:model.trim(),dimensions:Number(dimensions),inputPrice:Number(price),unit:unit.trim(),unitsPerYuan:ratio.trim()?Number(ratio):null};
        setBusy(true);try{const result:EmbeddingStatus=await act('embedding.configure',{config,...(secret?{apiKey:secret}:{}),...(clearKey?{clearKey:true}:{})});setStatus(result);setSecret('');setClearKey(false);notice('语义索引配置已保存。能力检查需手动执行。');}catch(e){report(formatError(e));}finally{setBusy(false);}
      };
      const check=async()=>{if(busy)return;setBusy(true);report('');try{const result:EmbeddingStatus=await act('embedding.check');setStatus(result);notice('能力检查已完成，请查看状态。');}catch(e){report(formatError(e));}finally{setBusy(false);}};
      const remove=async()=>{if(busy||!window.confirm('移除语义索引配置和已保存的密钥？已有记忆保留，搜索会使用本地方式。'))return;setBusy(true);try{const result:EmbeddingStatus=await act('embedding.configure',{config:null,clearKey:true});setStatus(result);setEnabled(false);setEndpoint('');setModel('');setDimensions('');setPrice('');setRatio('');setSecret('');setClearKey(false);notice('语义索引配置和密钥已移除。');}catch(e){report(formatError(e));}finally{setBusy(false);}};
      return <section className="kw-card kw-stack"><h3>语义索引（可选）</h3><small>默认关闭。本地关键词检索始终可用；配置后才会使用远程 embedding。可使用百炼等兼容服务，请以供应商当前文档为准填写接口与模型。</small>
        <p className="kw-notice" role="status">{status?.reason || (status?.checked?'语义索引已就绪。':status?.configured?'等待能力检查，当前使用本地检索。':'尚未配置，当前使用本地检索。')}{status&&` · 已索引 ${status.indexed}/${status.total} · 待处理 ${status.pending}`}</p>
        <label className="kw-checkbox"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/><span>启用远程语义索引</span></label>
        <div className="kw-form-grid"><label>Embedding 接口地址<input type="url" value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="填写供应商提供的当前接口地址" autoComplete="off"/></label><label>模型名称<input value={model} onChange={e=>setModel(e.target.value)} placeholder="填写供应商的模型名称" autoComplete="off"/></label><label>向量维度<input type="number" min="1" step="1" value={dimensions} onChange={e=>setDimensions(e.target.value)}/></label><label>输入单价（每百万 tokens）<input type="number" min="0" step="any" value={price} onChange={e=>setPrice(e.target.value)}/></label><label>供应商费用单位<input value={unit} onChange={e=>setUnit(e.target.value)} maxLength={16}/></label><label>每元对应供应商单位数（可选）<input type="number" min="0.000001" step="any" value={ratio} onChange={e=>setRatio(e.target.value)} placeholder="例如人民币填 1"/></label></div>
        <label>API 密钥（留空通常保留已有密钥）<input type="password" value={secret} onChange={e=>setSecret(e.target.value)} autoComplete="new-password"/></label><label className="kw-checkbox"><input type="checkbox" checked={clearKey} onChange={e=>setClearKey(e.target.checked)}/><span>删除已保存的密钥</span></label><small>密钥交由 DSH 凭据服务保存，不回显；这不等于系统钥匙串加密。更换服务域名需重新填写密钥。手动能力检查和语义搜索单独计费；自动建立索引与记忆整理不设预算上限。费用按配置换算，并与 tju 实际账户余额分开。需先保存并启用配置。</small>
        <div className="kw-row"><button type="button" className="kw-primary" disabled={busy} onClick={()=>void save()}>保存语义配置</button><button type="button" disabled={busy||!status?.configured||!data.settings.embedding?.enabled} onClick={()=>void check()}>执行能力检查</button><button type="button" disabled={busy||!status?.configured} onClick={()=>void remove()}>移除配置与密钥</button></div>
      </section>;
    }
    function AppearancePreview({data}: {data:Snapshot}) {
      const [open,setOpen]=useState(false);
      const [preview,setPreview]=useState<'pet'|'feed'|null>(null);
      const [playbackId,setPlaybackId]=useState('');
      const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
      const {reduced,visible}=useMotionPreferences();
      const stop=()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;setPreview(null);};
      useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
      useEffect(()=>{if(!visible)stop();},[visible]);
      const play=(type:'pet'|'feed')=>{
        if(timer.current)clearTimeout(timer.current);
        setPlaybackId(createId());setPreview(type);
        timer.current=setTimeout(()=>{timer.current=null;setPreview(null);},INTERACTION_MS[type]);
      };
      const moods=['平静','开心','期待','担心','沮丧','不满','害羞','释然'];
      const src=interactionPortrait(data.companion.mood,data.settings.skin,data.appearance,preview,reduced,visible,playbackId);
      return <details className="kw-appearance-preview" onToggle={event=>{const next=event.currentTarget.open;setOpen(next);if(!next)stop();}}>
        <summary>预览表情与动作</summary>
        {open&&<div className="kw-stack">
          <small>仅预览画面，不记录互动，也不会改变心情。</small>
          <div className="kw-mood-grid">{moods.map(mood=><figure key={mood}><img src={moodPortrait(mood,data.settings.skin,data.appearance)} onError={event=>fallbackPortrait(event,data.settings.skin)} alt=""/><figcaption>{mood}</figcaption></figure>)}</div>
          <div className="kw-preview-action"><img key={src} src={src} onError={event=>fallbackPortrait(event,data.settings.skin)} alt={preview==='pet'?'摸摸动作预览':preview==='feed'?'喂食动作预览':'当前心情预览'}/><div className="kw-row"><button type="button" onClick={()=>play('pet')}>预览摸摸</button><button type="button" onClick={()=>play('feed')}>预览喂食</button></div></div>
        </div>}
      </details>;
    }
    function SettingsPage({data,report,notice}: {data:Snapshot;report:(s:string)=>void;notice:(s:string)=>void}) {
      const initial=data.settings;
      const [name,setName]=useState(data.companion.name);
      const [model,setModel]=useState(routeKey(initial.model));
      const [unit,setUnit]=useState(initial.unit);
      const [limit,setLimit]=useState(String(initial.dailyLimit));
      const [rateInput,setRateInput]=useState(initial.prices ? String(initial.prices.input) : '');
      const [rateCached,setRateCached]=useState(initial.prices ? String(initial.prices.cached) : '');
      const [rateOutput,setRateOutput]=useState(initial.prices ? String(initial.prices.output) : '');
      const [ratio,setRatio]=useState(initial.pointsPerYuan == null ? '' : String(initial.pointsPerYuan));
      const [observe,setObserve]=useState(initial.observeEnabled);
      const [sessions,setSessions]=useState(initial.excludedSessions.join('\n'));
      const [workspaces,setWorkspaces]=useState(initial.excludedWorkspaces.join('\n'));
      const [background,setBackground]=useState(initial.backgroundEnabled);
      const [proactive,setProactive]=useState(initial.proactiveEnabled);
      const [saving,setSaving]=useState(false);
      const [skinUploading,setSkinUploading]=useState(false);
      const modelList=data.models;
      const chosen=modelList.find(m=>routeKey(m)===model);
      const handleSave=async(e:React.FormEvent)=>{
        e.preventDefault(); if(saving)return;
        const number=(s:string)=>Number(s);
        const daily=number(limit); if(!unit.trim() || !Number.isFinite(daily) || daily<=0){report('请填写大于零的 B 站预留预算和费用单位。');return;}
        const specified=[rateInput,rateCached,rateOutput].map(s=>s.trim());
        const hasAny=specified.some(Boolean);
        if(hasAny && (!specified.every(Boolean) || specified.some(s=>!Number.isFinite(number(s))||number(s)<0))){report('计费单价需要同时填写输入、缓存和输出三个非负数字。');return;}
        if(ratio.trim() && (!Number.isFinite(number(ratio))||number(ratio)<=0)){report('每元积分换算需要填写大于零的数字。');return;}
        if(!name.trim()){report('请给伙伴取一个名字。');return;}
        if(name.trim().length>32){report('伙伴名字不能超过 32 个字符。');return;}
        setSaving(true);report('');
        try {
          const route=chosen?{provider:chosen.provider,model:chosen.model}:null;
          const patch:Partial<Settings>={model:route,priceRoute:hasAny?route:null,prices:hasAny?{input:number(rateInput),cached:number(rateCached),output:number(rateOutput)}:null,unit:unit.trim(),dailyLimit:daily,pointsPerYuan:ratio.trim()?number(ratio):null,observeEnabled:observe,excludedSessions:sessions.split('\n').map(s=>s.trim()).filter(Boolean),excludedWorkspaces:workspaces.split('\n').map(s=>s.trim()).filter(Boolean),backgroundEnabled:background,proactiveEnabled:proactive};
          if(hasAny&&!route)throw new Error('请为这组价格选择对应的模型线路。');
          if(data.companion.name!==name.trim())await act('rename',{name:name.trim()});
          await act('settings',{patch});notice('设置已保存。');
        }catch(error){report(formatError(error));}finally{setSaving(false);}
      };
      const skinChange=async(file:File|undefined)=>{if(!file)return;setSkinUploading(true);report('');try{const image=await upload(file,'skin');await act('settings',{patch:{skin:image.url}});notice('自定义皮肤已保存到本机。');}catch(e){report(formatError(e));}finally{setSkinUploading(false);}};
      return <form className="kw-form" onSubmit={e=>void handleSave(e)}>
        <div className="kw-heading"><div><h2>设置</h2><small>你设置使用边界；伙伴的回应和选择不由滑块控制。</small></div><button className="kw-primary" type="submit" disabled={saving}>{saving?'正在保存…':'保存设置'}</button></div>
        <section className="kw-card kw-stack"><h3>伙伴与形象</h3><label>伙伴名字<input value={name} maxLength={32} onChange={e=>setName(e.target.value)} placeholder="给伙伴起个名字"/></label><small>改名不会改变伙伴 ID 或清空记忆。</small><div className="kw-row"><img src={data.settings.skin || `${PREFIX}/portrait.png`} alt="当前伙伴形象" width="100" height="100" style={{objectFit:'contain'}}/><label className="kw-file">{skinUploading?'正在导入…':'导入本地皮肤'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={skinUploading} onChange={e=>{void skinChange(e.target.files?.[0]);e.target.value='';}}/></label><button type="button" onClick={()=>void act('skin.reset').then(()=>notice('已恢复默认形象。')).catch(e=>report(formatError(e)))}>恢复默认</button></div><small>图片保存在本机，不会上传到公开仓库。支持 PNG、JPEG、WebP。</small><small role="status">{data.appearance?.available?'当前形象已关联表情与动作素材。':'当前形象未关联表情与动作素材。'}</small>{data.appearance?.available&&<AppearancePreview data={data}/>}</section>
        <section className="kw-card kw-stack"><h3>模型与预算</h3><label>聊天及后台使用的模型<select value={model} onChange={e=>{setModel(e.target.value);if(e.target.value!==routeKey(initial.priceRoute)){setRateInput('');setRateCached('');setRateOutput('');}}}><option value="">请选择已有模型</option>{modelList.map((m:ModelInfo)=><option key={routeKey(m)} value={routeKey(m)}>{m.name}{m.vision?' · 支持图片':''}</option>)}</select></label><div className="kw-row"><button type="button" onClick={()=>void act('models.refresh').then(()=>notice('模型列表已刷新。')).catch(e=>report(formatError(e)))}>刷新模型列表</button></div><small>图片能力：{chosen?.vision?'已声明支持':'未确认'}。聊天、记忆整理、自动索引和主动联系只记录费用，不设预算上限。下方预算仅为刷 B 站保留；当前版本尚未实现 B 站功能，设置尚不约束任何现有调用。</small>
          <div className="kw-form-grid"><label>费用单位<input value={unit} onChange={e=>setUnit(e.target.value)} maxLength={16}/></label><label>刷 B 站每日预算（预留）<input type="number" min="0.000001" step="any" value={limit} onChange={e=>setLimit(e.target.value)}/></label><label>每元对应积分（可选）<input type="number" min="0.000001" step="any" value={ratio} onChange={e=>setRatio(e.target.value)} placeholder="例如 30"/></label></div>
          <strong>所选线路单价（每百万 tokens）</strong><div className="kw-form-grid"><label>输入<input type="number" min="0" step="any" value={rateInput} onChange={e=>setRateInput(e.target.value)} placeholder="未设置"/></label><label>缓存命中<input type="number" min="0" step="any" value={rateCached} onChange={e=>setRateCached(e.target.value)} placeholder="未设置"/></label><label>输出<input type="number" min="0" step="any" value={rateOutput} onChange={e=>setRateOutput(e.target.value)} placeholder="未设置"/></label></div><small>单价必须与你选择的模型线路匹配。后台调用仍需配置可靠单价；缺失用量会如实记录，但不阻止后续普通任务。</small>
        </section>
        <EmbeddingPanel data={data} report={report} notice={notice}/>
        <section className="kw-card kw-stack"><h3>相处与观察</h3>
          <label className="kw-checkbox"><input type="checkbox" checked={data.settings.quiet} onChange={e=>{void act('settings',{patch:{quiet:e.target.checked}}).catch(err=>report(formatError(err)));}}/><span>安静陪伴<br/><small>不主动发送消息和提示；不影响记忆整理。</small></span></label>
          <label className="kw-checkbox"><input type="checkbox" checked={proactive} onChange={e=>setProactive(e.target.checked)}/><span>允许主动联系<br/><small>有想分享的内容时，发到伙伴聊天，等你停止输入后轻声提示。</small></span></label>
          <label className="kw-checkbox"><input type="checkbox" checked={background} onChange={e=>setBackground(e.target.checked)}/><span>启用后台整理<br/><small>有新的可用信息时整理记忆，不为凑次数重复调用模型。</small></span></label>
          <label className="kw-checkbox"><input type="checkbox" checked={observe} onChange={e=>setObserve(e.target.checked)}/><span>观察之后新的普通 DSH 对话<br/><small>帮助伙伴了解你，不接管 DeepSeek 的身份；不会回填启用前的历史。</small></span></label>
          <div className="kw-form-grid"><label>不观察的会话 ID，每行一个<textarea value={sessions} onChange={e=>setSessions(e.target.value)} rows={3} placeholder="留空表示不额外排除"/></label><label>不观察的工作区，每行一个<textarea value={workspaces} onChange={e=>setWorkspaces(e.target.value)} rows={3} placeholder="填写工作区路径"/></label></div><small>调整观察范围后只影响新的或尚未处理的内容；已保存的记忆可在“记忆”里查看或删除。</small>
        </section>
        <div className="kw-row"><button className="kw-primary" type="submit" disabled={saving}>{saving?'正在保存…':'保存设置'}</button></div>
      </form>;
    }
    function Page({ctx}: {ctx:any}) {
      const {data,connectionError:offline}=useData();
      const [tab,setTab]=useState<Tab>(nextTab);
      const [error,setError]=useState('');
      const [notice,setNotice]=useState('');
      useEffect(()=>{
        panelIsOpen=true;
        const change=(e:Event)=>{const value=(e as CustomEvent<Tab>).detail;if(value)setTab(value);};
        window.addEventListener('dsh-keep-whale:tab',change);
        return()=>{panelIsOpen=false;window.removeEventListener('dsh-keep-whale:tab',change);};
      },[]);
      useEffect(()=>{setError('');setNotice('');},[tab]);
      const chooseTab=(value:Tab)=>{nextTab=value;setTab(value);};
      const tabs:Array<[Tab,string]>=[['chat','对话'],['memory','记忆'],['activity','近况'],['settings','设置']];
      return <div className="kw-root kw-main"><style>{css+chatCss}</style><div className="kw-shell">
        <header className="kw-header"><div className="kw-title"><img key={moodPortrait(data?.companion.mood,data?.settings.skin,data?.appearance)} src={moodPortrait(data?.companion.mood,data?.settings.skin,data?.appearance)} onError={e=>fallbackPortrait(e,data?.settings.skin)} alt=""/><h1>{data?.companion.name || '陪伴伙伴'}</h1>{data&&<span className="kw-title-mood"><span className="kw-dot"/>{data.settings.quiet?'安静陪伴':data.companion.mood}</span>}</div><button className="kw-back" type="button" onClick={()=>{try{selectPanel(ctx,null);}catch(e){setError(formatError(e));}}}><ChatIcon name="back"/>返回 DSH</button></header>
        <nav className="kw-tabs" role="tablist" aria-label="伙伴面板">{tabs.map(([id,title])=><button key={id} type="button" role="tab" aria-selected={tab===id} onClick={()=>chooseTab(id)}>{title}{id==='chat'&&!!data?.unread?` · ${data.unread}`:''}</button>)}</nav>
        <div className="kw-page-notices">{offline && <p className="kw-error" role="status">{offline} {data && '下方是上次成功连接时的信息。'}</p>}{(error||data?.error) && <p className="kw-error" role="alert">{error||data?.error}</p>}{notice && <p className="kw-notice" role="status">{notice}</p>}</div>
        {data ? <><Chat data={data} report={setError} active={tab==='chat'} openSettings={()=>chooseTab('settings')}/>{tab!=='chat'&&<div className="kw-page-body">{tab==='memory'?<MemoryPage data={data} report={setError} notice={setNotice}/>:tab==='activity'?<Activity data={data} report={setError}/>:<SettingsPage data={data} report={setError} notice={setNotice}/>}</div>}</> : <div className="kw-page-body"><div className="kw-empty">正在连接伙伴服务…</div></div>}
      </div></div>;
    }

    type Pos = {x:number;y:number};
    // The measured frame sizes must track .kw-overlay and .kw-collapsed.
    const overlaySize=(collapsed=false)=>sizeForViewport(collapsed,innerWidth,innerHeight);
    const clamp=(p:Pos,collapsed=false):Pos=>clampOverlay(p,collapsed,innerWidth,innerHeight);
    const defaultPosition=(collapsed=false):Pos=>{const size=overlaySize(collapsed);return clamp({x:innerWidth-size.width-18,y:innerHeight-size.height-18},collapsed);};
    function useMotionPreferences() {
      const [reduced,setReduced]=useState(()=>typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const [visible,setVisible]=useState(()=>document.visibilityState==='visible');
      useEffect(()=>{
        const media=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
        const motion=()=>setReduced(!!media?.matches), visibility=()=>setVisible(document.visibilityState==='visible');
        media?.addEventListener?.('change',motion);document.addEventListener('visibilitychange',visibility);
        motion();visibility();
        return()=>{media?.removeEventListener?.('change',motion);document.removeEventListener('visibilitychange',visibility);};
      },[]);
      return {reduced,visible};
    }
    function Overlay({ctx}: {ctx:any}) {
      const {data,connectionError:offline}=useData(); usePresence();
      const [pos,setPos]=useState<Pos>(()=>{const isCollapsed=read(KEY_COLLAPSED,false);return clamp(read(KEY_POSITION,defaultPosition(isCollapsed)),isCollapsed);});
      const [collapsed,setCollapsed]=useState(()=>read(KEY_COLLAPSED,false));
      const [menu,setMenu]=useState(false), [bubble,setBubble]=useState('');
      const [anim,setAnim]=useState<'pet'|'feed'|null>(null), [interacting,setInteracting]=useState(false);
      const [playbackId,setPlaybackId]=useState('');const {reduced,visible}=useMotionPreferences();
      const actionPending=useRef(false), animationTimer=useRef<ReturnType<typeof setTimeout>|null>(null), mounted=useRef(true);
      const drag=useRef<{x:number;y:number;origin:Pos;moved:boolean;pointerId:number}|null>(null);
      const suppressClick=useRef(false), previousUnread=useRef<number|null>(null), dismiss=useRef<ReturnType<typeof setTimeout>|null>(null);
      const positionRef=useRef(pos); positionRef.current=pos;
      useEffect(()=>{const resize=()=>setPos(p=>{const adjusted=clamp(p,collapsed);write(KEY_POSITION,adjusted);return adjusted;});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[collapsed]);
      useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(dismiss.current)clearTimeout(dismiss.current);if(animationTimer.current)clearTimeout(animationTimer.current);};},[]);
      useEffect(()=>{if(!visible && animationTimer.current){clearTimeout(animationTimer.current);animationTimer.current=null;setAnim(null);}},[visible]);
      useEffect(()=>{
        if(!data)return;
        const before=previousUnread.current; previousUnread.current=data.unread;
        if(before===null || data.unread<=before || panelIsOpen || data.settings.quiet || document.visibilityState!=='visible')return;
        const latest=data.messages.findLast(m=>m.role==='assistant'&&m.origin==='proactive');
        if(!latest || read(KEY_NOTICE,'')===latest.id)return;
        write(KEY_NOTICE,latest.id);setMenu(false);setBubble('有一条新消息，想听听吗？');
        if(dismiss.current)clearTimeout(dismiss.current);dismiss.current=setTimeout(()=>setBubble(''),10000);
      },[data?.unread,data?.settings.quiet,data?.messages]);
      const toggle=()=>{const next=!collapsed;setCollapsed(next);write(KEY_COLLAPSED,next);setMenu(false);setBubble('');setPos(p=>{const nextPos=toggleOverlayPosition(p,collapsed,innerWidth,innerHeight);write(KEY_POSITION,nextPos);return nextPos;});};
      const showPanel=(tab:Tab)=>{setMenu(false);setBubble(openPanel(ctx,tab)?'':'伙伴面板暂时无法打开，请从侧边栏「陪伴伙伴」进入。');};
      const interact=async(type:'pet'|'feed')=>{
        if(actionPending.current||animationTimer.current)return;
        actionPending.current=true;setInteracting(true);setMenu(false);setBubble('');setPlaybackId(createId());setAnim(type);
        if(dismiss.current)clearTimeout(dismiss.current);
        // Start on the click, not after the next state poll. No model is involved.
        animationTimer.current=setTimeout(()=>{animationTimer.current=null;if(mounted.current)setAnim(null);},INTERACTION_MS[type]);
        try {
          const result=await send('action',{action:'interaction',type,requestId:createId()});
          if(!mounted.current)return;
          setBubble(typeof result.text==='string'?result.text:type==='pet'?'嗯，我在。':'谢谢，我收下啦。');
          dismiss.current=setTimeout(()=>setBubble(''),4500);
          void refresh().finally(schedule);
        }catch(e){
          if(!mounted.current)return;
          if(animationTimer.current)clearTimeout(animationTimer.current);animationTimer.current=null;setAnim(null);setBubble(formatError(e));
        }finally{actionPending.current=false;if(mounted.current)setInteracting(false);}
      };
      const down=(e:React.PointerEvent<HTMLDivElement>)=>{if(e.button!==0 || (e.target instanceof Element && e.target.closest('.kw-overlay-menu,.kw-bubble,.kw-collapse')))return;drag.current={x:e.clientX,y:e.clientY,origin:pos,moved:false,pointerId:e.pointerId};const pet=e.target instanceof Element?e.target.closest('.kw-pet'):null;if(pet instanceof HTMLElement)pet.setPointerCapture(e.pointerId);};
      const move=(e:React.PointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d||d.pointerId!==e.pointerId)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;if(Math.abs(dx)+Math.abs(dy)>5)d.moved=true;if(d.moved){setMenu(false);setBubble('');setPos(clamp({x:d.origin.x+dx,y:d.origin.y+dy},collapsed));}};
      const up=(e:React.PointerEvent<HTMLDivElement>)=>{const d=drag.current;if(!d||d.pointerId!==e.pointerId)return;drag.current=null;if(d.moved){suppressClick.current=true;write(KEY_POSITION,positionRef.current);setTimeout(()=>{suppressClick.current=false;},0);} };
      const menuStyle:React.CSSProperties=pos.x<100?{left:0,right:'auto'}:{};
      if(pos.y<250){menuStyle.bottom='auto';menuStyle.top='100%';menuStyle.marginTop=8;}
      const mood=data?.companion.mood||'平静', skin=data?.settings.skin;
      const name=data?.companion.name||'伙伴';
      const state=offline?'离线':data?.settings.quiet?'安静陪伴':mood;
      const artwork=data?.appearance;
      const portrait=interactionPortrait(mood,skin,artwork,collapsed?null:anim,reduced,visible,playbackId);
      const fallback=moodPortrait(mood,skin);
      const description=`${name} · ${state}${data?.unread?` · ${data.unread} 条未读消息`:''}`;
      return <div className={`kw-root kw-overlay ${collapsed?'kw-collapsed':''} ${offline?'kw-offline':''} ${skin&&!artwork?.available?'kw-custom-skin':''} ${artwork?.available?'kw-art-skin':''}`} style={{left:pos.x,top:pos.y}} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <style>{css}</style>
        <button type="button" className={`kw-pet ${!artwork?.available&&anim?`is-${anim}`:''}`} aria-label={collapsed?`${description}，展开伙伴`:`${description}，互动菜单`} title={collapsed?`${description} · 点击展开`:description} aria-expanded={collapsed?undefined:menu} onClick={()=>{if(suppressClick.current)return;if(collapsed){toggle();return;}setMenu(old=>!old);setBubble('');}}>
          <span className="kw-portrait-stage">
            <img key={portrait} src={portrait} alt="" draggable={false} onError={e=>{const image=e.currentTarget;if(!image.dataset.fallback){image.dataset.fallback='1';image.src=fallback===portrait?`${PREFIX}/portrait.png`:fallback;}else if(image.dataset.fallback==='1'){image.dataset.fallback='2';image.src=`${PREFIX}/portrait.png`;}}}/>
            {!collapsed&&!artwork?.available&&anim==='pet'&&<span className="kw-interaction-art kw-pat" aria-hidden="true">
              <svg className="kw-pat-hand" viewBox="0 0 64 48"><path d="M57 15 36 7c-4-2-7 3-3 5l8 4-23-5c-5-1-6 5-2 6l18 5-24-3c-5 0-5 6-1 7l25 3-20 1c-5 1-4 6 0 6l24 1-8 3c-4 2-2 7 2 6l17-6c7-3 9-9 10-15Z" fill="#ffe6cf" stroke="#796073" strokeWidth="2.2" strokeLinejoin="round"/><path d="m54 12 6 2-1 15-7-2" fill="#b5e2f6" stroke="#796073" strokeWidth="2.2"/></svg>
            </span>}
            {!collapsed&&!artwork?.available&&anim==='feed'&&<span className="kw-interaction-art kw-feed" aria-hidden="true">
              <svg className="kw-snack" viewBox="0 0 48 48"><circle cx="24" cy="24" r="19" fill="#eec18a" stroke="#966b43" strokeWidth="2.5"/><path d="M14 16h3m11-4h3m2 18h3m-20 3h3m5-12h3" stroke="#916243" strokeWidth="4" strokeLinecap="round"/><circle cx="31" cy="23" r="2" fill="#fff1d4"/></svg>
            </span>}
          </span>
          {!collapsed&&<span className="kw-pet-caption"><span className="kw-dot"/>{name} · {state}</span>}
          {collapsed&&offline&&<span className="kw-thumb-offline" aria-hidden="true"/>}
          {collapsed&&!!data?.unread&&<span className="kw-thumb-unread" aria-hidden="true">{data.unread>99?'99+':data.unread}</span>}
        </button>
        {!collapsed&&<button className="kw-collapse" type="button" title="收起" aria-label="收起伙伴" onClick={toggle}>−</button>}
        {menu&&!collapsed&&<div className="kw-overlay-menu" style={menuStyle} aria-label="伙伴互动"><strong>{data?.companion.name||'伙伴'}</strong><div className="kw-row"><button type="button" disabled={!data||!!offline||interacting||!!anim} onClick={()=>void interact('pet')}>摸摸</button><button type="button" disabled={!data||!!offline||interacting||!!anim} onClick={()=>void interact('feed')}>喂食</button><button type="button" onClick={()=>{showPanel('chat');}}>聊聊</button><button type="button" disabled={!data||!!offline} onClick={()=>{if(data)void act('settings',{patch:{quiet:!data.settings.quiet}}).then(()=>setBubble(data.settings.quiet?'已恢复主动联系。':'已开启安静陪伴。')).catch(e=>setBubble(formatError(e)));}}>{data?.settings.quiet?'恢复关心':'安静陪我'}</button><button type="button" onClick={()=>{showPanel('settings');}}>设置</button><button type="button" onClick={()=>{const p=defaultPosition();setPos(p);write(KEY_POSITION,p);}}>重置位置</button></div></div>}
        {bubble&&<div className="kw-bubble" role="status" aria-live="polite" style={menuStyle}><span>{bubble}</span>{data?.unread? <button type="button" onClick={()=>{showPanel('chat');}}>聊聊</button>:null}<button type="button" aria-label="关闭提示" onClick={()=>setBubble('')}>×</button></div>}
      </div>;
    }
    function Icon(){return <svg className="kw-sidebar-icon" viewBox="0 0 24 24" aria-label="伙伴"><path d="M4 13c0-4 3-7 8-7s8 3 8 7c0 3-3 6-8 6s-8-2-8-6Z"/><path d="M20 11c1-2 2-2 2-2m-2 5 2 1M8 12h.01M15 12h.01M10 15c1 1 3 1 4 0M12 6c0-2-1-3-2-3m2 3c0-2 1-3 2-3" strokeLinecap="round"/></svg>;}
    return {inject:['slots','layout'], apply(ctx:any) {
      ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL,registrant:'dsh-keep-whale'},()=>React.createElement(Page,{ctx})));
      ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL,order:40,label:()=> '陪伴伙伴',registrant:'dsh-keep-whale'},Icon));
      ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:PANEL,order:40,registrant:'dsh-keep-whale'},()=>React.createElement(Overlay,{ctx})));
    }};
  },
});
