import type { BiliAttempt, BiliRecord, BiliState } from '../bili/types.js';

type BiliViewState = BiliState & { confirmedMid?: string | null };
type PageResult = { items: BiliRecord[]; total: number };
type Props = {
  data: BiliViewState | undefined;
  companionName: string;
  quiet: boolean;
  onAction: (action:string, params?:object)=>Promise<any>;
  onChat: ()=>void;
  onSettings: ()=>void;
  report: (message:string)=>void;
  notice: (message:string)=>void;
};

/** Receives the host React instance; the plugin must not bundle another React. */
export function createBiliPage(React: typeof import('react')) {
  const { useState, useEffect, useRef } = React;
  const date=(at:number)=>Number.isFinite(at)?new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
  const duration=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
  const money=(n:number)=>Number.isFinite(n)?Number(n.toFixed(4)).toString():'--';
  const names:Record<BiliAttempt['status'],string>={running:'进行中',succeeded:'已完成',failed:'失败',interrupted:'已中断',skipped:'已略过'};

  function RecordCard({record,checked,onSelect,onDiscuss,onDelete,onBlock}: {
    record:BiliRecord;checked:boolean;onSelect:(id:string,checked:boolean)=>void;
    onDiscuss:(id:string)=>void;onDelete:(id:string)=>void;
    onBlock:(kind:'video'|'owner',id:string,label:string)=>void;
  }) {
    const {video}=record;
    const href=/^BV[0-9A-Za-z]{10}$/.test(video.bvid)?`https://www.bilibili.com/video/${encodeURIComponent(video.bvid)}`:null;
    return <article className="kw-card kw-bili-record">
      <div className="kw-bili-record-heading"><label className="kw-checkbox"><input type="checkbox" checked={checked} onChange={e=>onSelect(record.id,e.target.checked)} aria-label={`选择 ${video.title}`}/><strong>{video.title}</strong></label><small>{duration(video.duration)}</small></div>
      <small>{record.origin==='recommended'?'你推荐，她自己了解':'她自己了解'} · {date(record.createdAt)} · {video.owner} · {record.discussedAt?'你们聊过':'还没聊过'}</small>
      <p>{record.opinion}</p>{record.summary&&<p className="kw-muted">{record.summary}</p>}
      <details><summary>内容与理解范围</summary><p>{record.coverage}</p>{record.limitations.map((line,i)=><p key={i}>{line}</p>)}{!!record.frameTimes.length&&<p>抽样画面时间：{record.frameTimes.map(duration).join('、')}</p>}{!!record.excerpts.length&&<div className="kw-source">字幕片段：{record.excerpts.slice(0,8).map(x=>`${duration(x.from)} ${x.text}`).join(' / ')}</div>}</details>
      {(record.liked||record.favorited||record.actionReason||record.actionError)&&<p><small>{[record.liked?'已点赞':'',record.favorited?'已收藏':'',record.actionReason,record.actionError].filter(Boolean).join(' · ')}</small></p>}
      <div className="kw-row">{href&&<a href={href} target="_blank" rel="noopener noreferrer">打开原视频 ↗</a>}<button type="button" onClick={()=>onDiscuss(record.id)}>和她聊聊</button><button type="button" onClick={()=>onDelete(record.id)}>删除</button><button type="button" onClick={()=>onBlock('video',video.bvid,video.title)}>屏蔽视频</button><button type="button" onClick={()=>onBlock('owner',video.ownerId,video.owner)} disabled={!video.ownerId}>屏蔽 UP 主</button></div>
    </article>;
  }

  return function BiliPage({data,companionName,quiet,onAction,onChat,onSettings,report,notice}:Props) {
    const [tab,setTab]=useState<'now'|'watched'|'settings'>('now');
    const [input,setInput]=useState('');
    const [query,setQuery]=useState('');
    const [offset,setOffset]=useState(0);
    const [page,setPage]=useState<PageResult|null>(null);
    const [basis,setBasis]=useState<{topic:string;items:BiliRecord[]}|null>(null);
    const [selected,setSelected]=useState<string[]>([]);
    const [pending,setPending]=useState('');
    const [loading,setLoading]=useState(false);
    const [reload,setReload]=useState(0);
    const actionPending=useRef(false);
    const sequence=useRef(0);
    const count=25;
    const fingerprint=data?.records.map(r=>`${r.id}:${r.version}`).join('|')||'';
    useEffect(()=>{
      if(tab!=='watched')return;
      let alive=true; const current=++sequence.current;
      setLoading(true);
      const timer=setTimeout(()=>void onAction('bili.list',{query:query.trim(),offset,limit:count}).then((result:PageResult)=>{
        if(alive&&current===sequence.current){setPage(result);setLoading(false);}
      }).catch(e=>{if(alive&&current===sequence.current){setPage(null);setLoading(false);report(e instanceof Error?e.message:'读取浏览记录失败');}}),query?250:0);
      return()=>{alive=false;clearTimeout(timer);};
    },[tab,query,offset,fingerprint,reload]);
    if(!data)return <div className="kw-empty">B 站服务暂不可用，请确认插件已经加载。</div>;
    const {settings,account,stats,usage}=data;
    const confirmed=!!account.mid && data.confirmedMid===account.mid;
    const running=!!pending;
    const perform=async(action:string,params:object={},success='')=>{
      if(actionPending.current)return false;
      actionPending.current=true;setPending(action);report('');
      try{await onAction(action,params);if(success)notice(success);return true;}
      catch(e){report(e instanceof Error?e.message:'操作暂未完成');return false;}
      finally{actionPending.current=false;setPending('');}
    };
    const changeSettings=(patch:object)=>void perform('bili.settings',{patch},'B 站设置已保存。');
    const recommend=async(e:React.FormEvent)=>{
      e.preventDefault();const value=input.trim();if(!value)return;
      if(await perform('bili.recommend',{input:value},'已收到推荐，会在可以读取时处理。'))setInput('');
    };
    const showBasis=async(topic:string,ids:string[])=>{
      if(actionPending.current)return;
      actionPending.current=true;setPending('bili.list');report('');
      try { const result=await onAction('bili.list',{ids,offset:0,limit:50}) as PageResult;setBasis({topic,items:result.items}); }
      catch(e){report(e instanceof Error?e.message:'无法读取兴趣依据');}
      finally {actionPending.current=false;setPending('');}
    };
    const deleteRecords=async(ids:string[],clear=false)=>{
      if(!ids.length&&!clear)return;
      if((clear||ids.length>1)&&!window.confirm(clear?'清空全部 B 站浏览记录？这会撤回相关谈资与兴趣依据，已经发送的聊天消息会保留。':`删除选中的 ${ids.length} 条浏览记录？相关谈资与兴趣依据会一并撤回。`))return;
      if(await perform(clear?'bili.clear':'bili.delete',clear?{confirm:true}:{ids,confirm:ids.length>1},'浏览记录已删除。')){setSelected([]);setBasis(null);setOffset(0);setReload(n=>n+1);}
    };
    const block=(kind:'video'|'owner',id:string,label:string)=>void perform('bili.block',{kind,id,label},kind==='video'?'已屏蔽该视频。':'已屏蔽该 UP 主。');
    const discuss=async(id:string)=>{if(await perform('bili.discuss',{id}))onChat();};
    const display=page?.items||[];
    const select=(id:string,checked:boolean)=>setSelected(old=>checked?[...new Set([...old,id])]:old.filter(x=>x!==id));
    const renderRecord=(record:BiliRecord)=><RecordCard key={record.id} record={record} checked={selected.includes(record.id)} onSelect={select} onDiscuss={id=>void discuss(id)} onDelete={id=>void deleteRecords([id])} onBlock={block}/>;
    return <div className="kw-stack kw-bili">
      <div className="kw-heading"><div><h2>{companionName}逛 B 站</h2><small>看看她最近在关注什么。</small></div></div>
      <nav className="kw-bili-tabs" role="tablist" aria-label="逛 B 站">{([['now','现在'],['watched','看过'],['settings','设置']] as const).map(([id,title])=><button key={id} role="tab" type="button" aria-selected={tab===id} onClick={()=>setTab(id)}>{title}</button>)}</nav>
      {tab==='now'&&<div className="kw-stack">
        <section className="kw-card kw-stack"><small>此刻</small><h3 role="status">{data.status}</h3>{data.reason&&<p>{data.reason}</p>}{data.current&&<div><strong>{data.current.title}</strong><p><small>{data.current.owner} · {duration(data.current.duration)}</small></p></div>}</section>
        <div className="kw-row"><div className="kw-card kw-metric"><small>今日尝试读取</small><strong>{stats.attempted} 条</strong><small>成功 {stats.succeeded} · 失败 {stats.failed} · 中断 {stats.interrupted} · 略过 {stats.skipped}</small></div><div className="kw-card kw-metric"><small>今日 B 站费用与预留</small><strong>{money(usage.spent+usage.reserved+(usage.estimated||0))} / {money(usage.limit)} {usage.unit}</strong><small>已计 {money(usage.spent)} · 预留 {money(usage.reserved)}{usage.estimated?` · 暂记 ${money(usage.estimated)}`:''}{usage.uncertain?' · 有费用待核实':''}</small></div></div>
        <small>尝试、中断和成功是不同的记录；只有实际读取并形成看法的视频才会出现在「看过」。费用以配置的模型单价和用量核算。</small>
        <div className="kw-row">{settings.paused||!!settings.pausedUntil&&settings.pausedUntil>Date.now()?<button type="button" disabled={running} onClick={()=>void perform('bili.pause',{until:'resume'},'已恢复浏览。')}>恢复浏览</button>:<><button type="button" disabled={running} onClick={()=>void perform('bili.pause',{until:'manual'},'已暂停浏览。')}>暂停浏览</button><button type="button" disabled={running} onClick={()=>void perform('bili.pause',{until:'today'},'今天已暂停。')}>今天暂停</button></>}<button type="button" disabled={running||!data.busy} onClick={()=>void perform('bili.stop',{},'已请求停止当前视频。')}>停止当前视频</button></div>
        <form className="kw-card kw-stack" onSubmit={e=>void recommend(e)}><h3>推荐给她</h3><div className="kw-bili-recommend"><input value={input} onChange={e=>setInput(e.target.value)} aria-label="B 站视频链接或 BV 号" placeholder="粘贴 B 站视频链接或 BV 号" maxLength={1000}/><button type="submit" disabled={running||!input.trim()}>推荐</button></div><small>推荐不等于必须喜欢；需要登录已确认的小号和可用的视觉模型。</small></form>
        {!!data.recommendations.length&&<details className="kw-card"><summary>推荐处理情况</summary>{data.recommendations.slice(0,10).map(item=><p key={item.id}><small>{date(item.createdAt)} · {item.bvid||'待识别'} · {item.status==='pending'?'等待处理':item.status==='started'?'正在处理':item.status==='done'?'已处理':'未完成'}{item.reason?` · ${item.reason}`:''}</small></p>)}</details>}
        {!!data.attempts.length&&<section className="kw-card kw-stack"><h3>最近处理情况</h3>{data.attempts.slice(0,12).map(item=><article className="kw-source" key={item.id}><strong>{item.title||item.bvid||'挑选视频'} · {names[item.status]}</strong><br/>{date(item.createdAt)} · {item.stage}{item.reason?` · ${item.reason}`:''}{item.bvid&&(item.status==='failed'||item.status==='interrupted')&&<div><button type="button" disabled={running} onClick={()=>void perform('bili.retry',{id:item.id},'已安排重试。')}>重试</button></div>}</article>)}</section>}
        <div><button type="button" onClick={()=>setTab('settings')}>账号、额度与能力设置</button></div>
      </div>}
      {tab==='watched'&&<div className="kw-stack">
        <section className="kw-card kw-stack"><h3>最近在关注什么</h3>{data.interests.length?data.interests.map(interest=><div key={interest.topic} className="kw-row"><span>{interest.topic}</span><small>{interest.recordIds.length} 条浏览依据</small><button type="button" disabled={running} onClick={()=>void showBasis(interest.topic,interest.recordIds)}>查看依据</button></div>):<small>有多次、跨日的浏览依据后，这里才会呈现最近的关注；单条视频不会变成稳定喜好。</small>}</section>
        {basis&&<section className="kw-card kw-stack"><div className="kw-heading"><h3>「{basis.topic}」的依据</h3><button type="button" onClick={()=>setBasis(null)}>关闭依据</button></div>{basis.items.length?basis.items.map(renderRecord):<small>相关记录已删除或不可用。</small>}</section>}
        <label>搜索浏览记录<input value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);setSelected([]);}} placeholder="搜索标题、UP 主或她的看法"/></label>
        <div className="kw-row"><button type="button" disabled={running||!selected.length} onClick={()=>void deleteRecords(selected)}>删除所选（{selected.length}）</button><button type="button" disabled={running} onClick={()=>void deleteRecords([],true)}>清空浏览记录</button></div>
        {loading?<div className="kw-empty">正在读取…</div>:display.length?display.map(renderRecord):<div className="kw-empty">{query?'没有找到符合条件的浏览记录。':'还没有完成的视频记录。'}</div>}
        {!!page&&page.total>count&&<div className="kw-row"><button type="button" disabled={offset<=0||loading} onClick={()=>setOffset(Math.max(0,offset-count))}>上一页</button><small>{offset+1}–{Math.min(offset+count,page.total)} / {page.total}</small><button type="button" disabled={offset+count>=page.total||loading} onClick={()=>setOffset(offset+count)}>下一页</button></div>}
      </div>}
      {tab==='settings'&&<div className="kw-stack">
        <section className="kw-card kw-stack"><h3>独立小号</h3><p>{account.loggedIn?`已登录：${account.name||'B 站账号'}${account.mid?`（UID ${account.mid}）`:''}`:'尚未登录'}{confirmed?' · 已确认伙伴小号':''}</p>{account.reason&&<small>{account.reason}</small>}<small>请在单独打开的浏览器中手动登录伙伴的小号。观看可能影响该小号的历史和推荐；启用后可以按下面设置点赞、收藏。</small><div className="kw-row"><button type="button" disabled={running} onClick={()=>void perform('bili.login',{},'正在打开独立浏览器，请完成小号登录后返回检查。')}>{account.loggedIn?'重新登录':'登录小号'}</button><button type="button" disabled={running} onClick={()=>void perform('bili.account.check',{},'正在核对账号，请稍候。')}>检查登录状态</button>{account.loggedIn&&!confirmed&&account.mid&&<button type="button" className="kw-primary" disabled={running} onClick={()=>void perform('bili.account.confirm',{mid:account.mid},'已确认伙伴使用这个小号。')}>确认这是伙伴小号</button>}<button type="button" disabled={running||(!account.loggedIn&&!data.confirmedMid)} onClick={()=>{if(window.confirm('退出伙伴的 B 站小号？已有浏览记录会保留。'))void perform('bili.logout',{confirm:true},'已退出小号。');}}>退出登录</button></div></section>
        <section className="kw-card kw-stack"><h3>能力检查</h3>{data.reason&&<p role="status">{data.reason}</p>}<p>{data.capabilityReason||(!data.checked?'尚未检查':'能力已就绪')}</p><small>视频理解需要 B 站提供的字幕以及画面能力；无法读取时会如实停止，不用标题代替观看。</small><div><button type="button" disabled={running} onClick={()=>void perform('bili.check',{},'正在检查能力，请稍候。')}>检查能力</button></div></section>
        <section className="kw-card kw-stack"><h3>浏览与分享</h3><label className="kw-checkbox"><input type="checkbox" checked={settings.enabled} disabled={running||(!settings.enabled&&(!confirmed||!data.checked))} onChange={e=>changeSettings({enabled:e.target.checked})}/><span>自主浏览<br/><small>开启后可自行挑选视频；关闭会停止自动启动，保留已有经历。</small></span></label>
          <label className="kw-checkbox"><input type="checkbox" checked={settings.shareEnabled} disabled={running} onChange={e=>changeSettings({shareEnabled:e.target.checked})}/><span>偶尔主动分享<br/><small>有新的感受或见闻才说，不逐条汇报。你还没接话时会隔更久再考虑；没发出的内容留在「看过」，不排队催你。安静陪伴会抑制消息与提示。</small></span></label>
          <label className="kw-checkbox"><input type="checkbox" checked={settings.allowLike} disabled={running} onChange={e=>changeSettings({allowLike:e.target.checked})}/><span>允许点赞<br/><small>由伙伴根据视频自行决定，使用已确认的小号。</small></span></label>
          <label className="kw-checkbox"><input type="checkbox" checked={settings.allowFavorite} disabled={running} onChange={e=>changeSettings({allowFavorite:e.target.checked})}/><span>允许收藏<br/><small>由伙伴根据视频自行决定，使用已确认的小号。</small></span></label>
          <label>单条视频时长<select value={String(settings.maxVideoMinutes)} disabled={running} onChange={e=>changeSettings({maxVideoMinutes:Number(e.target.value)})}><option value="0">不限</option><option value="10">最多 10 分钟</option><option value="20">最多 20 分钟</option><option value="60">最多 60 分钟</option></select></label><small>长视频按可用能力分段理解，理解范围会在记录中说明。没有合适的内容时她也可以不看。</small>
          <p>当前每日预算：{money(usage.limit)} {usage.unit}{usage.uncertain?' · 有费用待核实':''}</p><div><button type="button" onClick={onSettings}>修改预算和模型</button></div>{quiet&&<small>当前处于安静陪伴：浏览不受影响，但不会主动分享或提示。</small>}</section>
        <section className="kw-card kw-stack"><h3>内容屏蔽</h3>{data.blocks.length?data.blocks.map(item=><div className="kw-row" key={`${item.kind}:${item.id}`}><span>{item.kind==='video'?'视频':'UP 主'}：{item.label}</span><button type="button" disabled={running} onClick={()=>void perform('bili.unblock',{kind:item.kind,id:item.id},'已解除屏蔽。')}>解除屏蔽</button></div>):<small>尚未屏蔽视频或 UP 主，可在浏览记录中操作。</small>}</section>
      </div>}
    </div>;
  };
}
