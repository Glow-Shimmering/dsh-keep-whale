import type { ImageRef, Ledger, Memory, Message, ModelInfo, Settings, Snapshot } from '../types.js';
import css from './style.css';

declare global {
  interface Window { __ModuleLoader__: { load(options: { id: string; factory: (require: (name: string) => any) => object }): void } }
}

window.__ModuleLoader__.load({
  id: 'dsh-keep-whale',
  factory(require) {
    const React = require('react') as typeof import('react');
    const { useState, useEffect, useRef, useCallback } = React;
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
    const labels: Record<string, string> = { user_fact:'用户事实', shared_episode:'共同经历', observed_dialogue:'普通对话观察', tendency:'逐渐形成的倾向', interaction:'互动', chat:'聊天', memory:'记忆整理', proactive:'主动联系', running:'进行中', succeeded:'完成', failed:'未完成', interrupted:'已中断', skipped:'已跳过' };
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
    function downloadJSON(value: unknown) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type:'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = 'keep-whale-memories.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function Chat({data, report}: {data:Snapshot; report:(s:string)=>void}) {
      const [text,setText] = useState('');
      const [images,setImages] = useState<ImageRef[]>([]);
      const [uploading,setUploading] = useState(false);
      const [pending,setPending] = useState(false);
      const [older,setOlder] = useState<Message[]>([]);
      const [hasMore,setHasMore] = useState(data.messages.length >= 200);
      const [loadingHistory,setLoadingHistory] = useState(false);
      const previousSnapshot = useRef({revision:data.revision,messages:data.messages});
      const anchor = useRef<HTMLDivElement>(null);
      const request = useRef<string | null>(null);
      const selectedImageIds = images.map(image => image.id);
      const latestIds = new Set(data.messages.map(message => message.id));
      const list = [...older.filter(message => !latestIds.has(message.id)), ...data.messages];
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
      useEffect(() => { if (document.visibilityState === 'visible' && panelIsOpen && data.unread) void act('read').catch(() => {}); }, [data.unread]);
      useEffect(() => { anchor.current?.scrollIntoView({block:'end'}); }, [data.messages.length, data.messages.at(-1)?.id, data.messages.at(-1)?.text]);
      const loadHistory=async()=>{
        const before=list[0]?.id; if(!before||loadingHistory)return; setLoadingHistory(true); report('');
        try {
          const response=await fetch(`${PREFIX}/messages?before=${encodeURIComponent(before)}`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(9000)});
          const result=await response.json(); if(!response.ok)throw new Error(result.error||'暂时无法读取更早的聊天');
          if(!Array.isArray(result.messages)||typeof result.hasMore!=='boolean')throw new Error('聊天历史格式无效');
          setOlder(current=>{const seen=new Set(current.map(x=>x.id));return [...result.messages.filter((x:Message)=>!seen.has(x.id)),...current];});
          setHasMore(result.hasMore);
        }catch(e){report(formatError(e));}finally{setLoadingHistory(false);}
      };
      const addFiles = async (files: File[]) => {
        if (!files.length || uploading) return;
        if (!data.capability.images) { report('当前模型没有确认图片能力，请在设置中选择支持图片的模型。'); return; }
        if (files.length + images.length > 4) { report('每次最多发送 4 张图片。'); return; }
        setUploading(true); report('');
        try {
          const added: ImageRef[] = [];
          for (const file of files) added.push(await upload(file,'image'));
          setImages(old => [...old,...added]);
        } catch (e) { report(formatError(e)); }
        finally { setUploading(false); }
      };
      const submit = async () => {
        if (pending || data.busy || uploading || (!text.trim() && !images.length)) return;
        setPending(true); report('');
        const requestId = request.current || createId(); request.current = requestId;
        try { await act('chat', {requestId,text:text.trim(),imageIds:selectedImageIds}); setText(''); setImages([]); request.current=null; }
        catch (e) { report(formatError(e)); }
        finally { setPending(false); }
      };
      return <div className="kw-stack">
        <div className="kw-heading"><div><h2>和 {data.companion.name} 聊聊</h2><small>这是一间独立的陪伴聊天，普通 DSH 对话仍由 DeepSeek 回答。</small></div><button type="button" disabled={!list.length} onClick={() => { if (window.confirm('删除当前显示的问答及其对应回复？相关的记忆依据也会撤回。')) void act('messages.delete',{ids:list.map(x=>x.id),confirm:true}).then(()=>{setOlder([]);setHasMore(true);}).catch(e=>report(formatError(e))); }}>删除当前显示的聊天</button></div>
        <div className="kw-scroll" aria-label="聊天消息">
          {hasMore&&list.length>0&&<div className="kw-row"><button type="button" disabled={loadingHistory} onClick={()=>void loadHistory()}>{loadingHistory?'正在读取…':'加载更早的聊天'}</button></div>}
          {list.length===0 && <div className="kw-empty">这里还没有聊天记录。<br/><small>不用发送角色设定，自然地开始吧。</small></div>}
          {list.map(m => <article key={m.id} className={`kw-message ${m.role==='user'?'kw-user':''}`}>
            <p>{m.text || (m.status === 'streaming' ? '正在想…' : '')}</p>
            {!!m.images.length && <div className="kw-images">{m.images.map(img => <a key={img.id} href={img.url} target="_blank" rel="noreferrer"><img src={img.url} alt={img.name}/></a>)}</div>}
            <small>{m.role==='user'?'你':data.companion.name} · {date(m.createdAt)}{m.origin==='proactive'?' · 主动分享':''}{m.status==='streaming'?' · 正在回复…':m.status==='failed'?' · 回复未完成':m.status==='cancelled'?' · 已停止':''}</small>
            {m.error && <small className="kw-danger">{m.error}</small>}
            {(m.status==='failed' || m.status==='cancelled') && <button type="button" disabled={data.busy} onClick={() => { void act('retry',{messageId:m.id,requestId:createId()}).catch(e=>report(formatError(e))); }}>重试</button>}
          </article>)}<div ref={anchor}/>
        </div>
        <form className="kw-compose" onSubmit={event => {event.preventDefault(); void submit();}}>
          <textarea aria-label="聊天内容" placeholder={`对${data.companion.name}说些什么…`} value={text} onChange={e=>{setText(e.target.value);request.current=null;}} onPaste={e=>{const files=Array.from(e.clipboardData.files).filter(f=>f.type.startsWith('image/')); if(files.length){e.preventDefault();void addFiles(files);}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submit();}}}/>
          {images.length > 0 && <div className="kw-row">{images.map(image=><span className="kw-chip" key={image.id}>{image.name}<button type="button" aria-label={`移除${image.name}`} onClick={()=>{setImages(old=>old.filter(x=>x.id!==image.id));request.current=null;}}>×</button></span>)}</div>}
          <div className="kw-row kw-between"><label className="kw-file">{uploading?'正在上传…':'添加图片'}<input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={uploading || images.length>=4 || !data.capability.images} onChange={e=>{void addFiles(Array.from(e.target.files || []));e.target.value='';}}/></label><small>Enter 发送 · Shift + Enter 换行</small><div className="kw-row">{data.busy && <button type="button" onClick={()=>{void act('cancel').catch(e=>report(formatError(e)));}}>停止回复</button>}<button className="kw-primary" type="submit" disabled={pending||data.busy||uploading||(!text.trim()&&!images.length)||!data.capability.chat}>发送</button></div></div>
          {!data.capability.chat && <small>请先到设置中选择 DSH 已配置的模型。</small>}
        </form>
      </div>;
    }

    function MemoryPage({data,report,notice}: {data:Snapshot;report:(s:string)=>void;notice:(s:string)=>void}) {
      const [query,setQuery]=useState(''), [selected,setSelected]=useState<string[]>([]), [editing,setEditing]=useState<string|null>(null), [edit,setEdit]=useState('');
      const records = data.memories.filter(x => (x.text+' '+label(x.kind)).toLowerCase().includes(query.trim().toLowerCase()));
      const deleteIds = async (ids:string[]) => {
        if(!ids.length || !window.confirm(`删除 ${ids.length} 条记忆？关联的摘要和成长依据也会撤回，聊天消息保留。`)) return;
        try { await act('memory.delete',{ids,confirm:true}); setSelected([]); notice('记忆已删除，关联依据已撤回。'); } catch(e) {report(formatError(e));}
      };
      const editMemory = async () => { if (!editing || !edit.trim()) return; try { await act('memory.edit',{id:editing,text:edit.trim()}); setEditing(null); notice('记忆已更新。'); } catch(e) {report(formatError(e));} };
      const doExport=async()=>{try{downloadJSON(await act('memory.export'));notice('已导出记忆和来源。');}catch(e){report(formatError(e));}};
      return <div className="kw-stack"><div className="kw-heading"><div><h2>记忆</h2><small>区分你说过的事、实际相处和对普通对话的观察。</small></div><button type="button" onClick={()=>void doExport()}>导出记忆</button></div>
        <input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索记忆或类型" aria-label="搜索记忆"/>
        <div className="kw-row"><button type="button" disabled={!selected.length} onClick={()=>void deleteIds(selected)}>删除所选（{selected.length}）</button><button type="button" disabled={!data.memories.length} onClick={()=>void deleteIds(data.memories.map(x=>x.id))}>清空记忆</button></div>
        {!records.length && <div className="kw-empty">{query?'没有符合条件的记忆。':'还没有保存的记忆。相处中的真实信息会逐渐整理到这里。'}</div>}
        {records.map((memory:Memory)=><article className="kw-card kw-memory" key={memory.id}>
          <div className="kw-row kw-between"><div className="kw-row"><input type="checkbox" checked={selected.includes(memory.id)} aria-label={`选择记忆 ${memory.text.slice(0,20)}`} onChange={e=>setSelected(old=>e.target.checked?[...old,memory.id]:old.filter(id=>id!==memory.id))}/><span className="kw-badge">{label(memory.kind)}</span></div><small>{date(memory.updatedAt)}</small></div>
          {editing===memory.id ? <div className="kw-stack"><textarea value={edit} onChange={e=>setEdit(e.target.value)} aria-label="修改记忆"/><div className="kw-row"><button type="button" className="kw-primary" onClick={()=>void editMemory()}>保存</button><button type="button" onClick={()=>setEditing(null)}>取消</button></div></div> : <p>{memory.text}</p>}
          <details><summary>查看依据（{memory.sourceIds.length}）</summary>{memory.sourceIds.map(id=>{const source=data.sources.find(x=>x.id===id);return <div className="kw-source" key={id}>{source ? <><strong>{label(source.kind)} · {date(source.createdAt)}</strong><div>{source.text}</div>{source.context && <div>上下文：{source.context}</div>}</> : '来源已撤回'}</div>;})}</details>
          <div className="kw-row"><button type="button" onClick={()=>{setEditing(memory.id);setEdit(memory.text);}}>修改</button><button className="kw-danger" type="button" onClick={()=>void deleteIds([memory.id])}>删除</button></div>
        </article>)}
      </div>;
    }

    function JobCost({jobId,entries}: {jobId:string;entries:Array<Ledger & {unit?:string}>}) {
      const matching=entries.filter(entry=>entry.jobId===jobId || entry.jobId.startsWith(jobId+':attempt:'));
      if(!matching.length)return <p><small>费用：暂无记录</small></p>;
      const totals=new Map<string,{actual:number;reserved:number;uncertain:number;hasActual:boolean;hasReserved:boolean;hasUncertain:boolean}>();
      for(const entry of matching){
        const unit=entry.unit || '单位未记录';
        const total=totals.get(unit) || {actual:0,reserved:0,uncertain:0,hasActual:false,hasReserved:false,hasUncertain:false};
        if(entry.status==='settled' && entry.actual!==null){total.actual+=entry.actual;total.hasActual=true;}
        else if(entry.status==='reserved'){total.reserved+=entry.reserved;total.hasReserved=true;}
        else {total.uncertain+=entry.reserved;total.hasUncertain=true;}
        totals.set(unit,total);
      }
      const format=(n:number)=>n>0&&n<0.000001?'<0.000001':String(Number(n.toFixed(6)));
      return <p><small>费用：{[...totals].map(([unit,total])=>[total.hasActual?`已计 ${format(total.actual)} ${unit}`:'',total.hasReserved?`预留 ${format(total.reserved)} ${unit}`:'',total.hasUncertain?`未核实（保留 ${format(total.uncertain)} ${unit}）`:''].filter(Boolean).join(' · ')).join('；')}</small></p>;
    }
    function Activity({data,report}: {data:Snapshot;report:(s:string)=>void}) {
      const {jobs,usage,interactions}=data;
      const ledger=(data as Snapshot & {ledger?:Array<Ledger & {unit?:string}>}).ledger || [];
      const chatUncertain=(usage as typeof usage & {chatUncertain?:boolean}).chatUncertain===true;
      const succeeded=jobs.filter(j=>j.status==='succeeded').length;
      const failed=jobs.filter(j=>j.status==='failed'||j.status==='interrupted').length;
      return <div className="kw-stack"><div className="kw-heading"><div><h2>近况</h2><small>心情与正在进行的活动分别记录。</small></div><span className="kw-badge">心情：{data.companion.mood}</span></div>
        <div className="kw-row"><div className="kw-card kw-metric"><small>后台今日已用 / 预留</small><strong>{usage.spent.toFixed(4)} / {usage.reserved.toFixed(4)}</strong><small>{usage.unit} · 上限 {usage.limit}</small></div><div className="kw-card kw-metric"><small>任务记录</small><strong>{jobs.length} 次尝试</strong><small>{succeeded} 次完成 · {failed} 次未完成或中断</small></div><div className="kw-card kw-metric"><small>聊天单独计费</small><strong>{chatUncertain?'未核实':usage.chatSpent.toFixed(4)}</strong><small>{chatUncertain?'至少一笔聊天费用未知':usage.unit}</small></div></div>
        {usage.uncertain && <p className="kw-error" role="status">有调用的实际费用无法核实，后台任务已暂停，请检查计费记录。</p>}
        <div className="kw-heading"><h2>最近活动</h2></div>
        {!jobs.length && !interactions.length && <div className="kw-empty">暂时没有活动记录。</div>}
        {jobs.map(job=><article className="kw-card" key={job.id}><div className="kw-row kw-between"><strong>{label(job.kind)} · {label(job.status)}</strong><small>{date(job.updatedAt)}</small></div><p>{job.stage || '等待处理'}</p>{job.reason && <small>{job.reason}</small>}<JobCost jobId={job.id} entries={ledger}/>{job.kind==='memory'&&job.status!=='running'&&job.status!=='succeeded'&&<div className="kw-row"><button type="button" onClick={()=>void act('job.retry',{id:job.id}).catch(e=>report(formatError(e)))}>重试整理</button></div>}</article>)}
        {!!interactions.length && <div className="kw-card"><strong>最近互动</strong>{interactions.map(i=><p key={i.id}><small>{date(i.createdAt)} · {i.type==='pet'?'摸摸':'喂食'}</small><br/>{i.text}</p>)}</div>}
      </div>;
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
        const daily=number(limit); if(!unit.trim() || !Number.isFinite(daily) || daily<=0){report('请填写大于零的每日预算和费用单位。');return;}
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
        <section className="kw-card kw-stack"><h3>伙伴与形象</h3><label>伙伴名字<input value={name} maxLength={32} onChange={e=>setName(e.target.value)} placeholder="给伙伴起个名字"/></label><small>改名不会改变伙伴 ID 或清空记忆。</small><div className="kw-row"><img src={data.settings.skin || `${PREFIX}/portrait.png`} alt="当前伙伴形象" width="100" height="100" style={{objectFit:'contain'}}/><label className="kw-file">{skinUploading?'正在导入…':'导入本地皮肤'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={skinUploading} onChange={e=>{void skinChange(e.target.files?.[0]);e.target.value='';}}/></label><button type="button" onClick={()=>void act('skin.reset').then(()=>notice('已恢复默认形象。')).catch(e=>report(formatError(e)))}>恢复默认</button></div><small>图片保存在本机，不会上传到公开仓库。支持 PNG、JPEG、WebP。</small></section>
        <section className="kw-card kw-stack"><h3>模型与预算</h3><label>聊天及后台使用的模型<select value={model} onChange={e=>{setModel(e.target.value);if(e.target.value!==routeKey(initial.priceRoute)){setRateInput('');setRateCached('');setRateOutput('');}}}><option value="">请选择已有模型</option>{modelList.map((m:ModelInfo)=><option key={routeKey(m)} value={routeKey(m)}>{m.name}{m.vision?' · 支持图片':''}</option>)}</select></label><div className="kw-row"><button type="button" onClick={()=>void act('models.refresh').then(()=>notice('模型列表已刷新。')).catch(e=>report(formatError(e)))}>刷新模型列表</button></div><small>图片能力：{chosen?.vision?'已声明支持':'未确认'}。聊天调用单独计费；记忆整理与主动联系共用下方每日预算。</small>
          <div className="kw-form-grid"><label>费用单位<input value={unit} onChange={e=>setUnit(e.target.value)} maxLength={16}/></label><label>每日上限<input type="number" min="0.000001" step="any" value={limit} onChange={e=>setLimit(e.target.value)}/></label><label>每元对应积分（可选）<input type="number" min="0.000001" step="any" value={ratio} onChange={e=>setRatio(e.target.value)} placeholder="例如 30"/></label></div>
          <strong>所选线路单价（每百万 tokens）</strong><div className="kw-form-grid"><label>输入<input type="number" min="0" step="any" value={rateInput} onChange={e=>setRateInput(e.target.value)} placeholder="未设置"/></label><label>缓存命中<input type="number" min="0" step="any" value={rateCached} onChange={e=>setRateCached(e.target.value)} placeholder="未设置"/></label><label>输出<input type="number" min="0" step="any" value={rateOutput} onChange={e=>setRateOutput(e.target.value)} placeholder="未设置"/></label></div><small>单价必须与你选择的模型线路匹配。缺少价格或无法核实用量时，后台任务会暂停。</small>
        </section>
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
      const tabs:Array<[Tab,string]>=[['chat','聊聊'],['memory','记忆'],['activity','近况'],['settings','设置']];
      return <div className="kw-root kw-main"><style>{css}</style><div className="kw-shell">
        <header className="kw-header"><div><div className="kw-eyebrow">DSH Keep Whale</div><h1>{data?.companion.name || '陪伴伙伴'}</h1><p>一间属于你们的小空间</p></div><button type="button" onClick={()=>{try{selectPanel(ctx,null);}catch(e){setError(formatError(e));}}}>返回 DSH</button></header>
        <nav className="kw-tabs" role="tablist" aria-label="伙伴面板">{tabs.map(([id,title])=><button key={id} type="button" role="tab" aria-selected={tab===id} onClick={()=>{setTab(id);nextTab=id;}}>{title}{id==='chat'&&!!data?.unread?` · ${data.unread}`:''}</button>)}</nav>
        {offline && <p className="kw-error" role="status">{offline} {data && '下方是上次成功连接时的信息。'}</p>}
        {(error||data?.error) && <p className="kw-error" role="alert">{error||data?.error}</p>}{notice && <p className="kw-notice" role="status">{notice}</p>}
        {data ? tab==='chat'?<Chat data={data} report={setError}/>:tab==='memory'?<MemoryPage data={data} report={setError} notice={setNotice}/>:tab==='activity'?<Activity data={data} report={setError}/>:<SettingsPage data={data} report={setError} notice={setNotice}/> : <div className="kw-empty">正在连接伙伴服务…</div>}
      </div></div>;
    }

    type Pos = {x:number;y:number};
    // Keep these dimensions in sync with the 156px frame, 180px portrait and
    // caption styles. The caption adds about 27px; 210/42 leave a small margin.
    const overlaySize=(collapsed=false)=>({width:Math.min(156,innerWidth),height:Math.min(collapsed?42:210,innerHeight)});
    const clamp=(p:Pos,collapsed=false):Pos=>{const size=overlaySize(collapsed);return {x:Math.max(0,Math.min(p.x,Math.max(0,innerWidth-size.width))),y:Math.max(0,Math.min(p.y,Math.max(0,innerHeight-size.height)))};};
    const defaultPosition=(collapsed=false):Pos=>{const size=overlaySize(collapsed);return clamp({x:innerWidth-size.width-18,y:innerHeight-size.height-18},collapsed);};
    function Overlay({ctx}: {ctx:any}) {
      const {data,connectionError:offline}=useData(); usePresence();
      const [pos,setPos]=useState<Pos>(()=>{const isCollapsed=read(KEY_COLLAPSED,false);return clamp(read(KEY_POSITION,defaultPosition(isCollapsed)),isCollapsed);});
      const [collapsed,setCollapsed]=useState(()=>read(KEY_COLLAPSED,false));
      const [menu,setMenu]=useState(false), [bubble,setBubble]=useState('');
      const [anim,setAnim]=useState<'pet'|'feed'|null>(null), [interacting,setInteracting]=useState(false);
      const actionPending=useRef(false), animationTimer=useRef<ReturnType<typeof setTimeout>|null>(null), mounted=useRef(true);
      const drag=useRef<{x:number;y:number;origin:Pos;moved:boolean;pointerId:number}|null>(null);
      const suppressClick=useRef(false), previousUnread=useRef<number|null>(null), dismiss=useRef<ReturnType<typeof setTimeout>|null>(null);
      const positionRef=useRef(pos); positionRef.current=pos;
      useEffect(()=>{const resize=()=>setPos(p=>{const adjusted=clamp(p,collapsed);write(KEY_POSITION,adjusted);return adjusted;});window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[collapsed]);
      useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(dismiss.current)clearTimeout(dismiss.current);if(animationTimer.current)clearTimeout(animationTimer.current);};},[]);
      useEffect(()=>{
        if(!data)return;
        const before=previousUnread.current; previousUnread.current=data.unread;
        if(before===null || data.unread<=before || panelIsOpen || data.settings.quiet || document.visibilityState!=='visible')return;
        const latest=data.messages.findLast(m=>m.role==='assistant'&&m.origin==='proactive');
        if(!latest || read(KEY_NOTICE,'')===latest.id)return;
        write(KEY_NOTICE,latest.id);setMenu(false);setBubble('有一条新消息，想听听吗？');
        if(dismiss.current)clearTimeout(dismiss.current);dismiss.current=setTimeout(()=>setBubble(''),10000);
      },[data?.unread,data?.settings.quiet,data?.messages]);
      const toggle=()=>{const next=!collapsed;setCollapsed(next);write(KEY_COLLAPSED,next);setMenu(false);setBubble('');setPos(p=>{const nextPos=clamp({x:p.x,y:p.y+overlaySize(collapsed).height-overlaySize(next).height},next);write(KEY_POSITION,nextPos);return nextPos;});};
      const showPanel=(tab:Tab)=>{setMenu(false);setBubble(openPanel(ctx,tab)?'':'伙伴面板暂时无法打开，请从侧边栏「陪伴伙伴」进入。');};
      const interact=async(type:'pet'|'feed')=>{
        if(actionPending.current||animationTimer.current)return;
        actionPending.current=true;setInteracting(true);setMenu(false);setBubble('');setAnim(type);
        if(dismiss.current)clearTimeout(dismiss.current);
        // Start on the click, not after the next state poll. No model is involved.
        animationTimer.current=setTimeout(()=>{animationTimer.current=null;if(mounted.current)setAnim(null);},1700);
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
      return <div className={`kw-root kw-overlay ${collapsed?'kw-collapsed':''} ${offline?'kw-offline':''}`} style={{left:pos.x,top:pos.y}} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <style>{css}</style>
        <button type="button" className={`kw-pet ${anim?`is-${anim}`:''}`} aria-label={collapsed?'展开伙伴':`${data?.companion.name||'伙伴'}互动菜单`} aria-expanded={menu} onClick={()=>{if(suppressClick.current)return;if(collapsed){toggle();return;}setMenu(old=>!old);setBubble('');}}>
          {!collapsed&&<span className="kw-portrait-stage">
            <img src={data?.settings.skin||`${PREFIX}/portrait.png`} alt="" draggable={false} onError={e=>{if(!e.currentTarget.dataset.fallback){e.currentTarget.dataset.fallback='1';e.currentTarget.src=`${PREFIX}/portrait.png`;}}}/>
            {anim==='pet'&&<span className="kw-interaction-art kw-pat" aria-hidden="true">
              <svg className="kw-pat-hand" viewBox="0 0 64 48"><path d="M57 15 36 7c-4-2-7 3-3 5l8 4-23-5c-5-1-6 5-2 6l18 5-24-3c-5 0-5 6-1 7l25 3-20 1c-5 1-4 6 0 6l24 1-8 3c-4 2-2 7 2 6l17-6c7-3 9-9 10-15Z" fill="#ffe6cf" stroke="#796073" strokeWidth="2.2" strokeLinejoin="round"/><path d="m54 12 6 2-1 15-7-2" fill="#b5e2f6" stroke="#796073" strokeWidth="2.2"/></svg>
              <span className="kw-pat-ripple"/><span className="kw-pat-glint">✧</span>
            </span>}
            {anim==='feed'&&<span className="kw-interaction-art kw-feed" aria-hidden="true">
              <svg className="kw-snack" viewBox="0 0 48 48"><circle cx="24" cy="24" r="19" fill="#eec18a" stroke="#966b43" strokeWidth="2.5"/><path d="M14 16h3m11-4h3m2 18h3m-20 3h3m5-12h3" stroke="#916243" strokeWidth="4" strokeLinecap="round"/><circle cx="31" cy="23" r="2" fill="#fff1d4"/></svg>
              <span className="kw-crumb kw-crumb-one"/><span className="kw-crumb kw-crumb-two"/><span className="kw-crumb kw-crumb-three"/>
            </span>}
          </span>}
          <span className="kw-pet-caption"><span className="kw-dot"/>{data?.companion.name||'伙伴'} · {offline?'离线':data?.settings.quiet?'安静陪伴':data?.companion.mood||'平静'}{collapsed?' · 展开':''}</span>
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
