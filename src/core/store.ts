import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Companion, Interaction, Job, Ledger, Memory, MemoryKind, Message, Settings, Source, Usage, MemoryInput, MemoryRelation, RecallResult, RecallHit, MemoryQuery, MemoryPage, MemoryDetail, DeletePreview, PersonalityProfile, Evidence, CostDetails } from '../types.js';
import { searchTerms, indexText, cosine, recencyWeight, isHistoricalQuery } from './memory.js';
import { interactionFeedback } from './interaction.js';

const DAY_MS = 86_400_000;
// Acknowledgment only changes budget admission. Original ledger facts stay intact,
// and old versions that do not understand this metadata continue to pause safely.
const BUDGET_ACK_JOIN = `LEFT JOIN meta budget_ack ON budget_ack.key='budget-ack:' || l.id
  AND l.status='uncertain' AND json_extract(budget_ack.data,'$.day')=l.day
  AND json_extract(budget_ack.data,'$.unit')=l.unit
  AND json_extract(budget_ack.data,'$.amount')=COALESCE(l.actual,l.reserved)
  AND json_extract(budget_ack.data,'$.at')>0`;
// Only explicitly tagged future Bilibili calls use the spending limit. Existing
// ledger rows remain untouched and are not silently reclassified as Bilibili.
const BILIBILI_SCOPE = `EXISTS (SELECT 1 FROM meta budget_scope WHERE budget_scope.key='budget-scope:' || l.id AND json_extract(budget_scope.data,'$.kind')='bilibili')`;
/** The product's budget and evidence day follows Beijing time, independent of host locale. */
export function beijingDay(timestamp: number): string { return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10); }
export const DEFAULT_SETTINGS: Settings = {
  model: null, priceRoute: null, prices: null, unit: '积分', pointsPerYuan: null, dailyLimit: 100, embedding: null,
  observeEnabled: false, observeSince: 0, excludedSessions: [], excludedWorkspaces: [],
  backgroundEnabled: true, proactiveEnabled: true, quiet: false, skin: null,
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const parse = <T>(s: unknown): T => JSON.parse(String(s)) as T;
const bounded = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不能为空或超过 ${max} 字符`);
  return value.trim();
};
const validRoute = (value: unknown): value is { provider: string; model: string } => {
  if (!value || typeof value !== 'object') return false;
  const route = value as Record<string, unknown>;
  return typeof route.provider === 'string' && !!route.provider.trim() && route.provider.length <= 200 && typeof route.model === 'string' && !!route.model.trim() && route.model.length <= 200;
};
const sameRoute = (a: Settings['model'], b: Settings['priceRoute']): boolean => !!a && !!b && a.provider === b.provider && a.model === b.model;
const numberAtLeastZero = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const dataFromRows = <T>(rows: Record<string, unknown>[]): T[] => rows.map(row => parse<T>(row.data));

export class Store {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private closed = false;
  private ftsAvailable = false;

  constructor(root: string, now: () => number = Date.now) {
    this.clock = now;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'keep-whale.sqlite');
    const existed = existsSync(path);
    this.db = new DatabaseSync(path);
    if (existed) {
      try {
        const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
        if (version < 2) {
          const backup = join(root, `keep-whale.before-memory-network-${randomUUID()}.sqlite`);
          this.db.prepare('VACUUM INTO ?').run(backup);
          chmodSync(backup, 0o600);
        }
      } catch (error) { this.db.close(); throw error; }
    }
    try { chmodSync(path, 0o600); } catch { /* The host may impose stricter permissions. */ }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(request_id, role));
      CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sources_pending ON sources(revoked,processed,created_at);
      CREATE INDEX IF NOT EXISTS sources_occasion ON sources(json_extract(data,'$.occasion')) WHERE revoked=0;
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_topic ON memories(json_extract(data,'$.topicKey'));
      CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS interaction_time ON interactions(created_at);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, day TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, background INTEGER NOT NULL, unit TEXT NOT NULL DEFAULT '', reserved REAL NOT NULL, actual REAL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ledger_day ON ledger(day,background,status);
    `);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_links (memory_id TEXT NOT NULL, source_id TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', start_offset INTEGER, end_offset INTEGER, counter INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(memory_id,source_id,quote,counter));
      CREATE INDEX IF NOT EXISTS memory_links_source ON memory_links(source_id);
      CREATE TABLE IF NOT EXISTS memory_relations (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_relations_from ON memory_relations(from_id);
      CREATE INDEX IF NOT EXISTS memory_relations_to ON memory_relations(to_id);
      CREATE TABLE IF NOT EXISTS memory_vectors (memory_id TEXT NOT NULL, version INTEGER NOT NULL, route_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(memory_id,route_key));
      CREATE TABLE IF NOT EXISTS source_redactions (source_id TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(source_id,start_offset,end_offset));
      CREATE TABLE IF NOT EXISTS memory_history (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,version));
    `);
    try { this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, terms, tokenize='unicode61')"); this.ftsAvailable = true; } catch { this.ftsAvailable = false; }
    const columns = this.db.prepare('PRAGMA table_info(ledger)').all();
    if (!columns.some(column => column.name === 'unit')) this.db.exec("ALTER TABLE ledger ADD COLUMN unit TEXT NOT NULL DEFAULT ''");
    if (!columns.some(column => column.name === 'details')) this.db.exec("ALTER TABLE ledger ADD COLUMN details TEXT");
    this.transaction(() => {
      if (!this.getMeta<Companion>('companion')) this.setMeta('companion', { id: randomUUID(), name: '大肥鱼', mood: '平静', createdAt: this.clock() } satisfies Companion);
      if (!this.getMeta<Settings>('settings')) this.setMeta('settings', DEFAULT_SETTINGS);
      if (this.getMeta<number>('revision') === undefined) this.setMeta('revision', 0);
      if (this.getMeta<number>('previewRevision') === undefined) this.setMeta('previewRevision', 0);
      if (this.getMeta<number>('readAt') === undefined) this.setMeta('readAt', 0);
      this.db.prepare("UPDATE ledger SET unit=? WHERE unit=''").run(this.settings().unit);
      const schema = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n ?? 0);
      const indexed = this.ftsAvailable ? Number(this.db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get()?.n ?? 0) : count;
      if (schema < 2 || indexed !== count || this.ftsAvailable && this.getMeta<number>('ftsTokenizerVersion') !== 1) {
        if (this.ftsAvailable) this.db.exec('DELETE FROM memory_fts');
        for (const row of this.db.prepare('SELECT data FROM memories').all()) {
          const memory = parse<Memory>(row.data);
          this.reindexMemory(memory);
        }
        if (this.ftsAvailable) this.setMeta('ftsTokenizerVersion',1);
        this.db.exec('PRAGMA user_version=2');
      }
    });
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM meta WHERE key=?').get(key);
    return row ? parse<T>(row.data) : undefined;
  }
  private setMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO meta(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(value));
  }
  revision(): number { return this.getMeta<number>('revision') ?? 0; }
  private bump(): void { this.setMeta('revision', this.revision() + 1); this.bumpPreview(); }
  previewRevision(): number { return this.getMeta<number>('previewRevision') ?? 0; }
  private bumpPreview(): void { this.setMeta('previewRevision', this.previewRevision() + 1); }
  private reindexMemory(memory: Memory): void {
    this.db.prepare('DELETE FROM memory_links WHERE memory_id=?').run(memory.id);
    const evidence = [...(memory.evidence ?? []).map(e => ({ ...e, counter: 0 })), ...(memory.counterEvidence ?? []).map(e => ({ ...e, counter: 1 }))];
    const linked = new Set(evidence.map(e => e.sourceId));
    for (const sourceId of memory.sourceIds) if (!linked.has(sourceId)) evidence.push({ sourceId, quote: '', counter: 0 });
    const insert = this.db.prepare('INSERT OR IGNORE INTO memory_links(memory_id,source_id,quote,start_offset,end_offset,counter) VALUES(?,?,?,?,?,?)');
    for (const e of evidence) insert.run(memory.id, e.sourceId, e.quote, e.start ?? null, e.end ?? null, e.counter);
    if (this.ftsAvailable) {
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(memory.id);
      this.db.prepare('INSERT INTO memory_fts(id,terms) VALUES(?,?)').run(memory.id, indexText(memory.text + ' ' + (memory.topicKey ?? '') + ' ' + [...(memory.evidence??[]),...(memory.counterEvidence??[])].map(e=>e.quote).join(' ')));
    }
  }
  /** Build only bounded retrieval edges backed by source occasions or an explicit subject:topic key. */
  private linkNearby(memory: Memory): void {
    const evidence=(memory.evidence??[]).filter(e=>!!this.sourceById(e.sourceId) && !this.sourceById(e.sourceId)!.revoked);
    if(!evidence.length)return; // Do not manufacture provenance for legacy entries.
    const occasions=new Set(evidence.map(e=>this.sourceById(e.sourceId)!.occasion));
    const topic=(key:string|undefined) => {
      if(!key)return null;
      const clean=key.normalize('NFKC').trim().toLocaleLowerCase();
      const match=/^([^:：|/·]{1,40})[:：|/·](.{1,120})$/u.exec(clean);
      if(!match || /^(?:兴趣|偏好|主题|看法|日常|一般|其他|general|topic)$/i.test(match[1].trim()))return null;
      return match[1].trim()+':'+match[2].trim();
    };
    const key=topic(memory.topicKey);
    const statement=this.db.prepare('INSERT INTO memory_relations(id,from_id,to_id,kind,data) VALUES(?,?,?,?,?)');
    const create=(other:Memory,kind:'same_event'|'related', proof:Evidence[]) => {
      const relation:MemoryRelation={id:randomUUID(),fromId:memory.id,toId:other.id,kind,evidence:proof,createdAt:this.clock()};
      statement.run(relation.id,relation.fromId,relation.toId,relation.kind,JSON.stringify(relation));
    };
    const items=[...occasions];
    const marks=items.map(()=>'?').join(',');
    if(items.length) {
      const sql=`SELECT DISTINCT memories.data,memories.updated_at FROM memories JOIN memory_links ON memory_links.memory_id=memories.id JOIN sources ON sources.id=memory_links.source_id WHERE memories.id<>? AND sources.revoked=0 AND memory_links.counter=0 AND memory_links.quote<>'' AND json_extract(sources.data,'$.occasion') IN (${marks}) ORDER BY memories.updated_at DESC LIMIT 3`;
      for(const other of dataFromRows<Memory>(this.db.prepare(sql).all(memory.id,...items))) {
        if(other.status==='superseded')continue;
        const found=(other.evidence??[]).find(e=>{const source=this.sourceById(e.sourceId);return !!source&&!source.revoked&&occasions.has(source.occasion);});
        if(!found)continue;
        const shared=this.sourceById(found.sourceId)!.occasion;
        const first=evidence.find(e=>this.sourceById(e.sourceId)!.occasion===shared)!;
        create(other,'same_event',[first,found]);
      }
    }
    if(key && memory.topicKey) {
      const candidates=dataFromRows<Memory>(this.db.prepare("SELECT data FROM memories WHERE id<>? AND json_extract(data,'$.topicKey')=? ORDER BY updated_at DESC LIMIT 50").all(memory.id,memory.topicKey));
      let count=0;
      for(const other of candidates) {
        if(other.status==='superseded'||!other.evidence?.length||topic(other.topicKey)!==key)continue;
        if(!other.evidence.some(e=>{const source=this.sourceById(e.sourceId);return !!source&&!source.revoked;}))continue;
        create(other,'related',[]);if(++count>=3)break; // retrieval only, never evidence
      }
    }
  }
  private getMemory(id: string): Memory | undefined {
    const row = this.db.prepare('SELECT data FROM memories WHERE id=?').get(id);
    return row ? parse<Memory>(row.data) : undefined;
  }
  private putMemory(memory: Memory): void {
    this.db.prepare('INSERT INTO memories(id,updated_at,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data').run(memory.id,memory.updatedAt,JSON.stringify(memory));
    this.reindexMemory(memory);
  }
  private archiveMemory(memory: Memory): void {
    this.db.prepare('INSERT OR IGNORE INTO memory_history(id,version,data) VALUES(?,?,?)').run(memory.id,memory.version ?? 1,JSON.stringify(memory));
  }
  eligibleSource(source: Source): boolean { return this.isEligible(source,this.settings()); }
  companion(): Companion { return copy(this.getMeta<Companion>('companion')!); }
  rename(name: string): Companion {
    const valid = bounded(name, '伙伴名字', 32);
    return this.transaction(() => { const current = this.companion(); current.name = valid; this.setMeta('companion', current); return current; });
  }
  setMood(value: string, evidence?: { at: number; reason: string; sourceIds: string[] }): Companion {
    const mood = bounded(value, '心情', 24);
    return this.transaction(() => {
      if (evidence && (!Number.isFinite(evidence.at) || !evidence.reason.trim() || !evidence.sourceIds.length || evidence.sourceIds.some(id => {const s=this.sourceById(id);return !s || s.revoked || s.kind==='observed_dialogue'&&!this.isEligible(s,this.settings());}))) throw new Error('心情依据无效');
      const current = this.companion(); current.mood = mood;
      if (evidence) current.moodEvidence = copy(evidence); else delete current.moodEvidence;
      this.setMeta('companion', current); return current;
    });
  }
  settings(): Settings { return { ...copy(DEFAULT_SETTINGS), ...copy(this.getMeta<Settings>('settings') || DEFAULT_SETTINGS) }; }
  patchSettings(patch: Partial<Settings>): Settings {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效');
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    for (const key of Object.keys(patch)) if (!allowed.has(key) || key === 'observeSince') throw new Error(`不能修改设置：${key}`);
    return this.transaction(() => {
      const before = this.settings();
      const next: Settings = { ...before, ...copy(patch) };
      for (const key of ['observeEnabled', 'backgroundEnabled', 'proactiveEnabled', 'quiet'] as const) if (typeof next[key] !== 'boolean') throw new Error(`${key}必须是开关`);
      for (const key of ['model', 'priceRoute'] as const) if (next[key] !== null && !validRoute(next[key])) throw new Error('模型线路无效');
      if (next.prices !== null && (!next.prices || !numberAtLeastZero(next.prices.input) || !numberAtLeastZero(next.prices.cached) || !numberAtLeastZero(next.prices.output))) throw new Error('价格必须是非负数');
      if (!numberAtLeastZero(next.dailyLimit)) throw new Error('每日上限必须是非负数');
      if (next.pointsPerYuan !== null && (!numberAtLeastZero(next.pointsPerYuan) || next.pointsPerYuan === 0)) throw new Error('兑换率必须大于零');
      next.unit = bounded(next.unit, '费用单位', 16);
      if (next.unit !== before.unit && this.db.prepare('SELECT 1 FROM ledger WHERE day=? LIMIT 1').get(beijingDay(this.clock()))) throw new Error('今天已有费用记录，不能修改计费单位；可在明天修改');
      if (next.unit !== before.unit) { next.prices = null; next.priceRoute = null; }
      for (const key of ['excludedSessions', 'excludedWorkspaces'] as const) {
        if (!Array.isArray(next[key]) || next[key].length > 2000 || next[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 4096)) throw new Error('排除范围无效');
        next[key] = [...new Set(next[key].map(x => x.trim()))];
      }
      if (next.embedding != null) {
        const e=next.embedding;
        let endpoint: URL; try { endpoint=new URL(e.endpoint); } catch { throw new Error('Embedding 地址无效'); }
        if (typeof e.enabled!=='boolean' || !['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !e.model.trim() || !Number.isSafeInteger(e.dimensions) || e.dimensions<1 || e.dimensions>16384 || !numberAtLeastZero(e.inputPrice) || !e.unit.trim() || e.unitsPerYuan!==null && (!numberAtLeastZero(e.unitsPerYuan) || e.unitsPerYuan===0)) throw new Error('Embedding 配置无效');
      }
      if (next.skin !== null && (typeof next.skin !== 'string' || !/^\/keep-whale\/media\/[0-9a-f-]{36}$/.test(next.skin))) throw new Error('皮肤无效');
      if (!before.observeEnabled && next.observeEnabled) next.observeSince = this.clock();
      this.setMeta('settings', next);
      // Running model requests must check revision and abort or discard on any relevant settings change.
      const eligibilityChanged = before.observeEnabled !== next.observeEnabled || JSON.stringify(before.excludedSessions) !== JSON.stringify(next.excludedSessions) || JSON.stringify(before.excludedWorkspaces) !== JSON.stringify(next.excludedWorkspaces);
      if (eligibilityChanged || before.backgroundEnabled !== next.backgroundEnabled) this.bump();
      if (eligibilityChanged) for (const job of this.runningJobs()) {
        if (job.kind === 'memory' && job.status === 'running' && job.sourceIds.some(id => { const source = this.sourceById(id); return source && !this.isEligible(source, next); })) {
          this.updateJobInside(job.id, { status: 'interrupted', reason: '观察范围已变更', stage: '已停止' });
        }
      }
      return copy(next);
    });
  }
  messages(limit = 200): Message[] {
    const n = Math.max(1, Math.min(5000, Math.floor(limit)));
    return dataFromRows<Message>(this.db.prepare('SELECT data FROM (SELECT data,created_at,rowid FROM messages ORDER BY created_at DESC,rowid DESC LIMIT ?) ORDER BY created_at ASC,rowid ASC').all(n));
  }
  messagePage(beforeId?: string, limit = 100): Message[] {
    const n = Math.max(1, Math.min(500, Math.floor(limit)));
    if (!beforeId) return this.messages(n);
    const cursor = this.db.prepare('SELECT created_at,rowid FROM messages WHERE id=?').get(beforeId);
    if (!cursor) return [];
    return dataFromRows<Message>(this.db.prepare('SELECT data FROM (SELECT data,created_at,rowid FROM messages WHERE created_at<? OR (created_at=? AND rowid<?) ORDER BY created_at DESC,rowid DESC LIMIT ?) ORDER BY created_at ASC,rowid ASC').all(Number(cursor.created_at), Number(cursor.created_at), Number(cursor.rowid), n));
  }
  findRequest(requestId: string, role: 'user' | 'assistant' = 'user'): Message | undefined {
    const row = this.db.prepare('SELECT data FROM messages WHERE request_id=? AND role=?').get(requestId, role);
    return row ? parse<Message>(row.data) : undefined;
  }
  /** Keep only timing, not deleted messages or their content, for contact pacing. */
  private saveContactTime(key: 'contact:lastProactiveAt' | 'contact:lastUserAt', at: unknown): void {
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return;
    const previous = this.getMeta<unknown>(key);
    if (typeof previous !== 'number' || !Number.isFinite(previous) || previous < at) this.setMeta(key, at);
  }
  private rememberContact(message: Message, at = message.createdAt): void {
    if (message.status !== 'complete') return;
    if (message.role === 'assistant' && message.origin === 'proactive') this.saveContactTime('contact:lastProactiveAt', at);
    if (message.role === 'user') this.saveContactTime('contact:lastUserAt', at);
  }
  contactTimestamps(): { lastProactiveAt: number | null; lastUserAt: number | null } {
    // Legacy entries predate the high-water marks, so search all persisted
    // messages rather than the UI's limited or paginated message window.
    const recent = (role: 'assistant' | 'user', proactive: boolean): number | null => {
      const row = this.db.prepare(`SELECT created_at FROM messages WHERE role=? AND json_extract(data,'$.status')='complete'${proactive ? " AND json_extract(data,'$.origin')='proactive'" : ''} ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(role);
      const n = row ? Number(row.created_at) : NaN;
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const combine = (stored: unknown, history: number | null): number | null => {
      const valid = typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : null;
      return valid === null ? history : history === null ? valid : Math.max(valid, history);
    };
    return {
      lastProactiveAt: combine(this.getMeta('contact:lastProactiveAt'), recent('assistant', true)),
      lastUserAt: combine(this.getMeta('contact:lastUserAt'), recent('user', false)),
    };
  }
  getMessage(id: string): Message | undefined { const row = this.db.prepare('SELECT data FROM messages WHERE id=?').get(id); return row ? parse<Message>(row.data) : undefined; }
  putMessage(message: Message): boolean {
    bounded(message.id, '消息 ID', 200); bounded(message.requestId, '请求 ID', 200);
    if (!['user', 'assistant'].includes(message.role) || !['chat', 'proactive'].includes(message.origin) || !['streaming', 'complete', 'failed', 'cancelled'].includes(message.status)) throw new Error('消息格式无效');
    if (typeof message.text !== 'string' || message.text.length > 200_000 || !Array.isArray(message.images) || message.images.length > 8) throw new Error('消息内容过长或格式无效');
    return this.transaction(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO messages(id,request_id,role,created_at,data) VALUES(?,?,?,?,?)').run(message.id, message.requestId, message.role, message.createdAt, JSON.stringify(message));
      const inserted = Number(result.changes) > 0;
      if (inserted) this.rememberContact(message);
      return inserted;
    });
  }
  updateMessage(id: string, patch: Partial<Message>): Message | undefined {
    return this.transaction(() => {
      const m = this.getMessage(id); if (!m) return undefined;
      // Identity and provenance are immutable, preventing a retry from becoming a second user turn.
      const next = { ...m, ...patch, id: m.id, chatId: m.chatId, requestId: m.requestId, role: m.role, createdAt: m.createdAt, origin: m.origin };
      if (!['streaming', 'complete', 'failed', 'cancelled'].includes(next.status) || typeof next.text !== 'string' || next.text.length > 200_000 || !Array.isArray(next.images)) throw new Error('消息格式无效');
      this.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(next), id);
      if (m.status !== 'complete' && next.status === 'complete') this.rememberContact(next, Math.max(next.createdAt, this.clock()));
      return next;
    });
  }
  deleteMessages(ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string')) throw new Error('删除消息范围无效');
    this.transaction(() => {
      // Capture legacy messages before deletion, without keeping their bodies.
      const times = this.contactTimestamps();
      this.saveContactTime('contact:lastProactiveAt', times.lastProactiveAt);
      this.saveContactTime('contact:lastUserAt', times.lastUserAt);
      const get = this.db.prepare('SELECT request_id FROM messages WHERE id=?');
      const requests = new Set(ids.map(id => get.get(id)).filter(Boolean).map(row => String(row!.request_id)));
      const pairs = [...requests].flatMap(requestId => this.db.prepare('SELECT id,role FROM messages WHERE request_id=?').all(requestId));
      const userIds = pairs.filter(row => row.role === 'user').map(row => String(row.id));
      const sourceIds = new Set<string>();
      for (const row of this.db.prepare('SELECT id FROM sources WHERE revoked=0').all()) {
        const sourceId = String(row.id);
        if (userIds.some(id => sourceId === `chat:${id}` || sourceId.startsWith(`chat:${id}:`) || sourceId === `episode:${id}` || sourceId.startsWith(`episode:${id}:`) || sourceId === `behavior:${id}` || sourceId.startsWith(`behavior:${id}:`))) sourceIds.add(sourceId);
      }
      this.retractInside([], sourceIds);
      const remove = this.db.prepare('DELETE FROM messages WHERE request_id=?');
      for (const requestId of requests) remove.run(requestId);
      if (requests.size) this.bump();
    });
  }
  private sourceById(id: string): Source | undefined {
    const row = this.db.prepare('SELECT data,processed,revoked FROM sources WHERE id=?').get(id); if (!row) return undefined;
    const source = { ...parse<Source>(row.data), processed: !!row.processed, revoked: !!row.revoked };
    const redactions = this.db.prepare('SELECT start_offset,end_offset FROM source_redactions WHERE source_id=? ORDER BY start_offset DESC').all(id);
    if (redactions.length) {
      for (const r of redactions) source.text = source.text.slice(0,Number(r.start_offset)) + '█'.repeat(Number(r.end_offset)-Number(r.start_offset)) + source.text.slice(Number(r.end_offset));
      // Context may repeat the removed text and cannot be safely attributed after redaction.
      delete source.context;
    }
    return source;
  }
  messageForModel(id: string): Message | undefined {
    const message=this.getMessage(id); if (!message) return undefined;
    const user=message.role==='user'?message:this.findRequest(message.requestId,'user');
    if (!user) return message;
    const sourceId='chat:'+user.id;
    const sourceRow=this.db.prepare('SELECT revoked FROM sources WHERE id=?').get(sourceId);
    if(sourceRow && sourceRow.revoked) { message.text='[相关记忆已删除]'; return message; }
    const rows=this.db.prepare('SELECT start_offset,end_offset,quote FROM source_redactions WHERE source_id=? ORDER BY start_offset DESC').all(sourceId);
    if (message.role==='user') for (const r of rows) message.text=message.text.slice(0,Number(r.start_offset))+'█'.repeat(Number(r.end_offset)-Number(r.start_offset))+message.text.slice(Number(r.end_offset));
    else for (const r of rows) if (r.quote) message.text=message.text.split(String(r.quote)).join('[已删除]');
    return message;
  }
  private isEligible(source: Source, settings: Settings): boolean {
    if (source.revoked) return false;
    if (source.kind !== 'observed_dialogue') return true;
    return settings.observeEnabled && source.createdAt >= settings.observeSince && !!source.sessionId && !settings.excludedSessions.includes(source.sessionId) && (source.workspace ? !settings.excludedWorkspaces.some(path => source.workspace === path || source.workspace!.startsWith(path.replace(/\/$/, '') + '/')) : settings.excludedWorkspaces.length === 0);
  }
  sources(): Source[] { return dataFromRows<Source>(this.db.prepare('SELECT data FROM sources WHERE revoked=0 ORDER BY created_at DESC').all()).map(s => this.sourceById(s.id)!).filter(Boolean); }
  addSource(source: Source): boolean {
    bounded(source.id, '来源 ID', 300); bounded(source.text, '来源内容', 20_000); bounded(source.occasion, '场合', 300);
    if (!['user_fact', 'shared_episode', 'observed_dialogue', 'interaction'].includes(source.kind) || !Number.isFinite(source.createdAt)) throw new Error('来源格式无效');
    if (source.context !== undefined && (typeof source.context !== 'string' || source.context.length > 20_000)) throw new Error('来源上下文无效');
    return this.transaction(() => {
      const next = { ...source, processed: false, revoked: false };
      if (!this.isEligible(next, this.settings())) return false;
      const result = this.db.prepare('INSERT OR IGNORE INTO sources(id,created_at,processed,revoked,data) VALUES(?,?,0,0,?)').run(next.id, next.createdAt, JSON.stringify(next));
      if(Number(result.changes)) this.bumpPreview();
      return Number(result.changes) > 0;
    });
  }
  pendingSources(limit = 12, options: {unattempted?:boolean} = {}): Source[] {
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    // A bounded recent set avoids loading archived content; filtering happens before taking the requested count.
    const rows = this.db.prepare('SELECT id FROM sources WHERE revoked=0 AND processed=0 ORDER BY created_at ASC').all();
    const settings = this.settings();
    const found:Source[]=[];
    for(const row of rows) { const source=this.sourceById(String(row.id)); if(source && this.isEligible(source,settings) && (!options.unattempted || !this.hasSourceJob('memory',[source.id]))) found.push(source); if(found.length>=n)break; }
    return found;
  }
  markProcessed(ids: string[]): void {
    if (!ids.length) return;
    this.transaction(() => {
      const q = this.db.prepare('UPDATE sources SET processed=1 WHERE id=? AND revoked=0');
      let changed = false; for (const id of new Set(ids)) if (Number(q.run(id).changes) > 0) changed = true;
      void changed;
    });
  }
  memories(): Memory[] { return dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories ORDER BY updated_at DESC').all()); }
  private validatedEvidence(items: Evidence[] | undefined, allowedIds: string[]): Evidence[] | null {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 100) return null;
    const result: Evidence[] = [];
    for (const item of items) {
      if (!item || !allowedIds.includes(item.sourceId) || typeof item.quote !== 'string' || !item.quote.trim() || /█/.test(item.quote) || item.quote.length > 4000) return null;
      const source = this.sourceById(item.sourceId); if (!source || source.revoked) return null;
      const start = item.start === undefined ? source.text.indexOf(item.quote) : item.start;
      const end = item.end === undefined ? start + item.quote.length : item.end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || source.text.slice(start,end) !== item.quote) return null;
      result.push({ sourceId: item.sourceId, quote: item.quote, start, end });
    }
    return result;
  }
  saveMemory(input: MemoryInput, expectedRevision?: number): Memory | null {
    if (!['user_fact', 'shared_episode', 'observed_dialogue', 'understanding', 'tendency'].includes(input.kind)) throw new Error('记忆类型无效');
    const value = bounded(input.text, '记忆内容', 4000);
    if (!Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 100) throw new Error('记忆需要有效来源');
    const sourceIds = [...new Set(input.sourceIds)];
    return this.transaction(() => {
      if (expectedRevision !== undefined && expectedRevision !== this.revision()) return null;
      const sources = sourceIds.map(id => this.sourceById(id));
      if (sources.some(source => !source || source.revoked || source.kind === 'interaction' || source.kind === 'observed_dialogue' && !this.isEligible(source, this.settings()))) return null;
      const valid = sources as Source[];
      const evidence = this.validatedEvidence(input.evidence,sourceIds); const counters = this.validatedEvidence(input.counterEvidence,sourceIds);
      if (!evidence || !counters) return null;
      const positive=valid.filter(s=>!counters.some(c=>c.sourceId===s.id) || evidence.some(e=>e.sourceId===s.id));
      if (input.kind === 'user_fact' && positive.some(s => s.kind !== 'user_fact' || s.provenance === 'behavior')) return null;
      if (input.kind === 'observed_dialogue' && positive.some(s => s.kind !== 'observed_dialogue')) return null;
      if (input.kind === 'shared_episode' && positive.some(s => s.kind !== 'shared_episode' || s.provenance === 'behavior')) return null;
      if (input.kind === 'tendency') {
        const supporting = evidence.filter(e => !counters.some(c => c.sourceId === e.sourceId));
        if (new Set(supporting.map(e=>e.sourceId)).size !== sourceIds.filter(id => !counters.some(c => c.sourceId === id)).length || new Set(supporting.map(e=>e.sourceId)).size < 3) return null;
        const facts = supporting.map(e => ({ evidence:e, source: valid.find(s => s.id === e.sourceId)! }));
        if (facts.some(({evidence,source}) => source.provenance === 'behavior' && /(?:我一直|我(?:已经|现在|从此|正在)?(?:变得|变成|改变|成长|进步|不再像以前))/.test(evidence.quote) || source.provenance !== 'behavior' && /希望你|想让你|请你(?:变|要|更|温柔)|要求你|你(?:应该|要|必须)(?:变|更|温柔|有主见)/.test(evidence.quote))) return null;
        if (new Set(facts.map(({source}) => source.occasion)).size < 3 || new Set(facts.map(({source}) => beijingDay(source.createdAt))).size < 2) return null;
      }
      if (input.parentMemoryIds?.some(id => !this.getMemory(id))) return null;
      const now = this.clock();
      const normalized = (text:string) => text.normalize('NFKC').trim().replace(/\s+/g,' ');
      const existing = dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories').all()).find(m => m.kind === input.kind && normalized(m.text) === normalized(value) && (m.topicKey ?? '') === (input.topicKey ?? ''));
      if (existing) {
        const mergedEvidence = [...(existing.evidence ?? []),...evidence].filter((e,i,a) => a.findIndex(v=>v.sourceId===e.sourceId && v.quote===e.quote)===i);
        const mergedCounters = [...(existing.counterEvidence ?? []),...counters].filter((e,i,a) => a.findIndex(v=>v.sourceId===e.sourceId && v.quote===e.quote)===i);
        const mergedIds=[...new Set([...existing.sourceIds,...sourceIds])];
        if(mergedIds.length===existing.sourceIds.length && mergedEvidence.length===(existing.evidence??[]).length && mergedCounters.length===(existing.counterEvidence??[]).length) return existing;
        this.archiveMemory(existing);
        const memory: Memory = {...existing,sourceIds:mergedIds,evidence:mergedEvidence,counterEvidence:mergedCounters,updatedAt:now,reinforcedAt:now,version:(existing.version??1)+1,status:mergedCounters.length?'uncertain':input.status??existing.status??'active'};
        this.putMemory(memory); this.db.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(memory.id); this.bumpPreview(); return memory;
      }
      const memory: Memory = { id: randomUUID(), kind: input.kind, text: value, sourceIds, createdAt: now, updatedAt: now, version:1, evidence, counterEvidence:counters, parentMemoryIds:input.parentMemoryIds ?? [], status:counters.length?'uncertain':input.status??'active', validFrom:input.validFrom, validTo:input.validTo, boundary:input.boundary, topicKey:input.topicKey, reinforcedAt:now };
      this.putMemory(memory);
      for (const parentId of memory.parentMemoryIds ?? []) {
        const relation: MemoryRelation = {id:randomUUID(),fromId:memory.id,toId:parentId,kind:'derived_from',evidence:[],createdAt:now};
        this.db.prepare('INSERT INTO memory_relations(id,from_id,to_id,kind,data) VALUES(?,?,?,?,?)').run(relation.id,relation.fromId,relation.toId,relation.kind,JSON.stringify(relation));
      }
      this.linkNearby(memory);
      this.bumpPreview(); return memory;
    });
  }
  private deletionImpact(ids: string[], forced = new Set<string>()): { targets: Set<string>; whole: Set<string>; spans: Evidence[] } {
    const memories=dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories').all());
    const byId=new Map(memories.map(m=>[m.id,m]));
    const targets=new Set(ids.filter(id=>byId.has(id))); const whole=new Set(forced); const spans:Evidence[]=[];
    for (const id of targets) {
      const memory=byId.get(id)!; const evidence=[...(memory.evidence??[]),...(memory.counterEvidence??[])];
      for (const sid of memory.sourceIds) {
        const supporting=evidence.filter(e=>e.sourceId===sid && e.start!==undefined && e.end!==undefined);
        if (supporting.length) spans.push(...supporting); else whole.add(sid);
      }
    }
    const siblings=(sid:string) => { const match=/^(chat|episode|behavior):([^:]+)$/.exec(sid); return match?['chat:','episode:','behavior:'].map(prefix=>prefix+match[2]):[sid]; };
    for (const sid of [...whole]) for (const sibling of siblings(sid)) whole.add(sibling);
    // Mirror an exact quote into sibling event views, without inventing offsets.
    for (const span of [...spans]) for (const sibling of siblings(span.sourceId)) {
      if (sibling===span.sourceId) continue;
      const source=this.sourceById(sibling); if (!source) continue;
      let from=0,at:number; while ((at=source.text.indexOf(span.quote,from))>=0) { spans.push({sourceId:sibling,quote:span.quote,start:at,end:at+span.quote.length}); from=at+span.quote.length; }
    }
    let changed=true;
    while (changed) {
      changed=false;
      for (const memory of memories) {
        if (targets.has(memory.id)) continue;
        const refs=[...(memory.evidence??[]),...(memory.counterEvidence??[])];
        const overlap=refs.some(e=>spans.some(r=>e.sourceId===r.sourceId && e.start!==undefined && e.end!==undefined && r.start!==undefined && r.end!==undefined && e.start<r.end && r.start<e.end));
        const legacyOverlap=memory.sourceIds.some(sid=>spans.some(r=>r.sourceId===sid) && !refs.some(e=>e.sourceId===sid));
        const derived=(memory.parentMemoryIds??[]).some(id=>targets.has(id)) || this.db.prepare("SELECT to_id FROM memory_relations WHERE from_id=? AND kind='derived_from'").all(memory.id).some(row=>targets.has(String(row.to_id)));
        if (memory.sourceIds.some(id=>whole.has(id)) || overlap || legacyOverlap || derived) {
          targets.add(memory.id); changed=true;
          if (legacyOverlap) for (const sid of memory.sourceIds) if (spans.some(r=>r.sourceId===sid)) for (const sibling of siblings(sid)) whole.add(sibling);
        }
      }
    }
    return {targets,whole,spans};
  }
  deletePreview(ids: string[]): DeletePreview {
    if (!Array.isArray(ids) || ids.some(id=>typeof id!=='string'||!id||id.length>200)) throw new Error('删除范围无效');
    const impact=this.deletionImpact(ids); const memories=[...impact.targets].map(id=>this.getMemory(id)!).filter(Boolean);
    return {ids:ids.filter(id=>!!this.getMemory(id)),memories,sourceIds:[...new Set([...impact.whole,...impact.spans.map(s=>s.sourceId)])],revision:this.previewRevision()};
  }
  private retractInside(ids: string[], sourceIds = new Set<string>()): void {
    const {targets,whole,spans}=this.deletionImpact(ids,sourceIds);
    const add=this.db.prepare('INSERT OR IGNORE INTO source_redactions(source_id,start_offset,end_offset,quote) VALUES(?,?,?,?)');
    for (const span of spans) if (span.start!==undefined && span.end!==undefined) add.run(span.sourceId,span.start,span.end,span.quote);
    const revoke=this.db.prepare('UPDATE sources SET revoked=1 WHERE id=?'); for (const id of whole) revoke.run(id);
    const remove=this.db.prepare('DELETE FROM memories WHERE id=?');
    const links=this.db.prepare('DELETE FROM memory_links WHERE memory_id=?');
    const vectors=this.db.prepare('DELETE FROM memory_vectors WHERE memory_id=?');
    const history=this.db.prepare('DELETE FROM memory_history WHERE id=?');
    for (const id of targets) { remove.run(id);links.run(id);vectors.run(id);history.run(id);if(this.ftsAvailable)this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id); }
    const allRelations=dataFromRows<MemoryRelation>(this.db.prepare('SELECT data FROM memory_relations').all());
    const affectedRelation=(r:MemoryRelation) => targets.has(r.fromId)||targets.has(r.toId)||r.evidence.some(e=>whole.has(e.sourceId)||spans.some(span=>span.sourceId===e.sourceId && span.start!==undefined && span.end!==undefined && e.start!==undefined && e.end!==undefined && e.start<span.end && span.start<e.end));
    const removed=allRelations.filter(affectedRelation), kept=allRelations.filter(r=>!affectedRelation(r));
    for(const relation of removed)this.db.prepare('DELETE FROM memory_relations WHERE id=?').run(relation.id);
    // Removing the new claim or its contradiction also removes the reason the
    // old claim was superseded/uncertain. Restore the last backed state only
    // if no surviving relation still justifies that state.
    for(const id of new Set(removed.flatMap(r=>r.kind==='updates'?[r.toId]:r.kind==='contradicts'?[r.fromId,r.toId]:[]))) {
      if(targets.has(id))continue;
      if(kept.some(r=>r.kind==='updates'&&r.toId===id || r.kind==='contradicts'&&(r.fromId===id||r.toId===id)))continue;
      const memory=this.getMemory(id); const row=this.db.prepare('SELECT data FROM memory_history WHERE id=? ORDER BY version DESC LIMIT 1').get(id);
      if(!memory||!row)continue;
      const prior=parse<Memory>(row.data);this.archiveMemory(memory);
      memory.status=prior.status??'active';memory.validTo=prior.validTo;memory.version=(memory.version??1)+1;memory.updatedAt=this.clock();
      this.putMemory(memory);this.db.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(id);
    }
    const affected=new Set([...whole,...spans.map(s=>s.sourceId)]);
    for (const job of this.runningJobs()) if (job.sourceIds.some(id=>affected.has(id))) this.updateJobInside(job.id,{status:'interrupted',reason:'关联记忆已删除或更正',stage:'已撤回'});
    const companion=this.companion();
    if (companion.moodEvidence?.sourceIds.some(id=>affected.has(id))) { companion.mood='平静'; delete companion.moodEvidence; this.setMeta('companion',companion); }
  }
  deleteMemories(ids: string[], expectedRevision?:number): void {
    if (!Array.isArray(ids) || ids.some(id=>typeof id!=='string'||!id||id.length>200)) throw new Error('删除范围无效');
    this.transaction(() => { if(expectedRevision!==undefined && expectedRevision!==this.previewRevision()) throw new Error('记忆已变化，请重新预览'); this.retractInside(ids); this.bump(); });
  }
  editMemory(id: string, text: string): Memory | null {
    const value = bounded(text, '记忆内容', 4000);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM memories WHERE id=?').get(id); if (!row) return null;
      const old = parse<Memory>(row.data);
      if(old.kind!=='user_fact') throw new Error('只能直接更正用户事实；其他记忆请删除后重新整理');
      this.retractInside([id]);
      const now = this.clock();
      const source: Source = { id: 'manual-correction:' + randomUUID(), kind: 'user_fact', text: value, occasion: 'manual-correction:' + randomUUID(), createdAt: now, processed: true, revoked: false };
      this.db.prepare('INSERT INTO sources(id,created_at,processed,revoked,data) VALUES(?,?,1,0,?)').run(source.id, now, JSON.stringify(source));
      const memory: Memory = { id: randomUUID(), kind: old.kind, text: value, sourceIds: [source.id], createdAt: now, updatedAt: now, version:1, status:'uncertain', evidence:[{sourceId:source.id,quote:value,start:0,end:value.length}] };
      this.putMemory(memory); this.bump(); return memory;
    });
  }
  linkMemories(input: Omit<MemoryRelation,'id'|'createdAt'>, expectedRevision?: number): MemoryRelation | null {
    if (!input || input.fromId===input.toId || !['related','same_event','supports','contradicts','updates','derived_from'].includes(input.kind)) return null;
    return this.transaction(() => {
      if (expectedRevision!==undefined && expectedRevision!==this.revision()) return null;
      const from=this.getMemory(input.fromId),to=this.getMemory(input.toId); if(!from||!to) return null;
      const allowed=[...new Set([...from.sourceIds,...to.sourceIds])];
      const evidence=this.validatedEvidence(input.evidence,allowed); if(!evidence) return null;
      if (['updates','contradicts'].includes(input.kind) && !evidence.length) return null;
      const old=this.db.prepare('SELECT data FROM memory_relations WHERE from_id=? AND to_id=? AND kind=?').get(input.fromId,input.toId,input.kind);
      if(old)return parse<MemoryRelation>(old.data);
      const relation: MemoryRelation={...input,evidence,id:randomUUID(),createdAt:this.clock()};
      this.db.prepare('INSERT INTO memory_relations(id,from_id,to_id,kind,data) VALUES(?,?,?,?,?)').run(relation.id,relation.fromId,relation.toId,relation.kind,JSON.stringify(relation));
      if(input.kind==='updates') {
        this.archiveMemory(to); to.status='superseded'; to.validTo=from.validFrom??to.validTo??null; to.version=(to.version??1)+1;to.updatedAt=this.clock();this.putMemory(to);this.db.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(to.id);
      }
      if(input.kind==='contradicts') for(const memory of [from,to]) {this.archiveMemory(memory);memory.status='uncertain';memory.version=(memory.version??1)+1;memory.updatedAt=this.clock();this.putMemory(memory);this.db.prepare('DELETE FROM memory_vectors WHERE memory_id=?').run(memory.id);}
      this.bumpPreview(); return relation;
    });
  }
  private canEmbed(memory:Memory):boolean { return memory.sourceIds.every(id=>{const source=this.sourceById(id);return !!source && !source.revoked && (source.kind!=='observed_dialogue'||this.isEligible(source,this.settings()));}); }
  pendingVectors(routeKey: string, limit=8, excludeIds:string[]=[]): Memory[] {
    bounded(routeKey,'模型线路',2048); const n=Math.max(1,Math.min(100,Math.floor(limit))), excluded=new Set(excludeIds);
    return dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories ORDER BY updated_at DESC').all()).filter(m=>!excluded.has(m.id) && m.status!=='superseded' && this.canEmbed(m) && !this.db.prepare('SELECT 1 FROM memory_vectors WHERE memory_id=? AND version=? AND route_key=?').get(m.id,m.version??1,routeKey)).slice(0,n);
  }
  saveVector(memoryId:string, version:number, routeKey:string, vector:number[], expectedRevision:number):boolean {
    bounded(routeKey,'模型线路',2048);
    if(!Array.isArray(vector)||!vector.length||vector.length>16384||vector.some(x=>typeof x!=='number'||!Number.isFinite(x))||!vector.some(x=>x!==0))return false;
    return this.transaction(()=>{
      if(expectedRevision!==this.revision())return false;
      const memory=this.getMemory(memoryId);if(!memory||memory.status==='superseded'||!this.canEmbed(memory)||(memory.version??1)!==version)return false;
      this.db.prepare('INSERT INTO memory_vectors(memory_id,version,route_key,data) VALUES(?,?,?,?) ON CONFLICT(memory_id,route_key) DO UPDATE SET version=excluded.version,data=excluded.data').run(memoryId,version,routeKey,JSON.stringify(vector));return true;
    });
  }
  vectorCounts(routeKey:string):{indexed:number;total:number;pending:number} {
    bounded(routeKey,'模型线路',2048);
    const memories=dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories').all()).filter(m=>m.status!=='superseded'&&this.canEmbed(m));
    const indexed=memories.filter(m=>!!this.db.prepare('SELECT 1 FROM memory_vectors WHERE memory_id=? AND version=? AND route_key=?').get(m.id,m.version??1,routeKey)).length;
    return {indexed,total:memories.length,pending:memories.length-indexed};
  }
  recall(query:string,opts:{vector?:number[];routeKey?:string;limit?:number;maxChars?:number}={}):RecallResult {
    if(typeof query!=='string'||query.length>20000)throw new Error('检索内容无效');
    const limit=Math.max(1,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(opts.limit??24))); const maxChars=Math.max(256,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(opts.maxChars??20000)));
    const all=dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories ORDER BY updated_at DESC').all());
    const eligible=all.filter(m=>m.status!=='superseded'||isHistoricalQuery(query));const byId=new Map(eligible.map(m=>[m.id,m]));
    const terms=searchTerms(query); const ranks=new Map<string,{score:number;reasons:Set<string>}>();
    const add=(id:string,score:number,reason:string)=>{if(!byId.has(id))return;const row=ranks.get(id)??{score:0,reasons:new Set<string>()};row.score+=score;row.reasons.add(reason);ranks.set(id,row);};
    if (terms.length && this.ftsAvailable) {
      const fts=terms.map(term=>'"'+term.replace(/"/g,'""')+'"').join(' OR ');
      try { this.db.prepare('SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts)').all(fts).forEach((row,i)=>add(String(row.id),1/(60+i+1),'关键词')); } catch { /* deterministic local fallback below */ }
    }
    if (terms.length && !ranks.size) {
      const ranked=eligible.map(m=>{const content=new Set(searchTerms(m.text+' '+(m.topicKey??''),true));return {id:m.id,score:terms.reduce((n,t)=>n+(content.has(t)?(t.length>1?2:1):0),0)};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
      ranked.forEach((row,i)=>add(row.id,1/(60+i+1),'本地关键词'));
    }
    let vectorCount=0;
    if(opts.vector?.length && opts.routeKey) {
      const vectors=this.db.prepare('SELECT memory_id,version,data FROM memory_vectors WHERE route_key=?').all(opts.routeKey).map(row=>({id:String(row.memory_id),version:Number(row.version),vector:parse<number[]>(row.data)}));
      const ranked=vectors.flatMap(v=>{const m=byId.get(v.id);const score=m&&this.canEmbed(m)&&(m.version??1)===v.version?cosine(opts.vector!,v.vector):null;return score!==null&&score>0?[{id:v.id,score}]:[];}).sort((a,b)=>b.score-a.score);
      vectorCount=ranked.length;ranked.forEach((row,i)=>add(row.id,1/(60+i+1),'语义'));
    }
    if(!terms.length) eligible.slice(0,Math.max(limit,30)).forEach((m,i)=>add(m.id,1/(60+i+1),'近期'));
    for(const memory of eligible)if(memory.boundary)add(memory.id,0.01,'用户边界');
    // Expand at most two relation hops; each later hop contributes less than its root.
    let frontier=[...ranks.keys()].slice(0,100);const visited=new Set(frontier);
    for(let hop=1;hop<=2 && frontier.length;hop++) {
      const next:string[]=[];
      for(const id of frontier) for(const row of this.db.prepare('SELECT from_id,to_id FROM memory_relations WHERE from_id=? OR to_id=?').all(id,id)) {
        const other=String(row.from_id)===id?String(row.to_id):String(row.from_id);if(visited.has(other)||!byId.has(other))continue;
        visited.add(other);next.push(other);add(other,0.006/hop,'关联 '+hop+' 跳');if(next.length>=200)break;
      }
      frontier=next.slice(0,200);
    }
    const hits:RecallHit[]=[...ranks.entries()].map(([id,r])=>{const memory=byId.get(id)!; const score=r.score*(memory.boundary?1:recencyWeight(memory.reinforcedAt??memory.updatedAt,this.clock()));return {memory,score,reasons:[...r.reasons]};}).sort((a,b)=>b.score-a.score||b.memory.updatedAt-a.memory.updatedAt);
    let bytes=0;const selected:RecallHit[]=[];for(const hit of hits){const size=hit.memory.text.length;if(bytes+size>maxChars)continue;bytes+=size;selected.push(hit);if(selected.length>=limit)break;}
    return {hits:selected,mode:vectorCount?'hybrid':'local',...(!vectorCount?{reason:opts.vector?.length?'当前线路没有可用的匹配向量':'本地关键词与关系检索'}:{})};
  }
  memoryPage(query:MemoryQuery={}, recall?:RecallResult):MemoryPage {
    const offset=Math.max(0,Math.floor(query.offset??0)),limit=Math.max(1,Math.min(200,Math.floor(query.limit??50)));
    const all=dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories ORDER BY updated_at DESC').all());
    let list:Memory[];
    if(query.query?.trim()) {
      const terms=searchTerms(query.query), found=new Map((recall?.hits??[]).map(hit=>[hit.memory.id,hit.memory]));
      for(const m of all) { const searchable=new Set(searchTerms(m.text+' '+(m.topicKey??''),true)); if(terms.some(t=>searchable.has(t)))found.set(m.id,m); }
      list=[...found.values()];
    } else list=all;
    const state=(m:Memory)=>m.status==='superseded'?'superseded':m.status==='uncertain'||m.kind==='tendency'&&!m.evidence?.length?'uncertain':!m.boundary&&this.clock()-(m.reinforcedAt??m.updatedAt)>90*DAY_MS?'dormant':'active';
    list=list.filter(m=>(!query.kind||m.kind===query.kind)&&(!query.state||state(m)===query.state)&&(!Number.isFinite(query.from)||m.createdAt>=query.from!)&&(!Number.isFinite(query.to)||m.createdAt<=query.to!)).map(m=>({...m,recallState:state(m)}));
    return {items:list.slice(offset,offset+limit),total:list.length,offset,limit,mode:recall?.mode??'local',reason:recall?.reason};
  }
  memoryDetail(id:string):MemoryDetail|null {
    const memory=this.getMemory(id);if(!memory)return null;
    const relations=dataFromRows<MemoryRelation>(this.db.prepare('SELECT data FROM memory_relations WHERE from_id=? OR to_id=?').all(id,id));
    const related=[...new Set(relations.map(r=>r.fromId===id?r.toId:r.fromId))].map(id=>this.getMemory(id)).filter((x):x is Memory=>!!x);
    const sources=memory.sourceIds.map(id=>this.sourceById(id)).filter((x):x is Source=>!!x&&!x.revoked);
    const history=dataFromRows<Memory>(this.db.prepare('SELECT data FROM memory_history WHERE id=? ORDER BY version DESC').all(id));
    return {memory,sources,relations,related,history};
  }
  personalityProfile():PersonalityProfile {
    const all=dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories ORDER BY updated_at DESC').all());
    return {initial:['温和','有主见'],tentative:all.filter(m=>m.kind==='understanding'||m.kind==='tendency'&&(m.status==='uncertain'||!m.evidence?.length)).map(m=>({...m,recallState:'uncertain'})),tendencies:all.filter(m=>m.kind==='tendency'&&(m.status??'active')==='active'&&!!m.evidence?.length)};
  }
  recordInteraction(type: 'pet' | 'feed', requestId: string): Interaction {
    if (type !== 'pet' && type !== 'feed') throw new Error('互动类型无效'); bounded(requestId, '互动 ID', 200);
    return this.transaction(() => {
      const id = 'interaction:' + requestId;
      const previous = this.db.prepare('SELECT data FROM interactions WHERE id=?').get(id); if (previous) return parse<Interaction>(previous.data);
      const now = this.clock();
      const text = interactionFeedback(type, this.companion().mood, this.interactions(), now);
      const interaction: Interaction = { id, type, text, createdAt: now };
      this.db.prepare('INSERT INTO interactions(id,created_at,data) VALUES(?,?,?)').run(id, interaction.createdAt, JSON.stringify(interaction)); return interaction;
    });
  }
  interactions(): Interaction[] { return dataFromRows<Interaction>(this.db.prepare('SELECT data FROM interactions WHERE created_at>=? ORDER BY created_at DESC,rowid DESC LIMIT 32').all(this.clock() - DAY_MS)); }
  embeddingJobs(): Job[] { return dataFromRows<Job>(this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.kind')='embedding' ORDER BY created_at DESC").all()); }
  jobs(): Job[] { return dataFromRows<Job>(this.db.prepare('SELECT data FROM jobs ORDER BY created_at DESC LIMIT 500').all()); }
  jobById(id:string):Job|undefined { const row=this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);return row?parse<Job>(row.data):undefined; }
  hasSourceJob(kind:Job['kind'],sourceIds:string[],completedOnly=true):boolean {
    if (!sourceIds.length) return false;
    for(let i=0;i<sourceIds.length;i+=200){
      const batch=sourceIds.slice(i,i+200), placeholders=batch.map(()=>'?').join(',');
      const row=this.db.prepare(`SELECT 1 FROM jobs,json_each(jobs.data,'$.sourceIds') AS source WHERE json_extract(jobs.data,'$.kind')=? AND (?=0 OR json_extract(jobs.data,'$.status')<>'running') AND source.value IN (${placeholders}) LIMIT 1`).get(kind,completedOnly?1:0,...batch);
      if(row)return true;
    }
    return false;
  }
  private runningJobs(): Job[] { return dataFromRows<Job>(this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.status')='running'").all()); }
  putJob(job: Job): boolean {
    bounded(job.id, '任务 ID', 200);
    return this.transaction(() => { const result = this.db.prepare('INSERT OR IGNORE INTO jobs(id,created_at,data) VALUES(?,?,?)').run(job.id, job.createdAt, JSON.stringify(job)); return Number(result.changes) > 0; });
  }
  private updateJobInside(id: string, patch: Partial<Job>): Job | undefined {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); if (!row) return undefined;
    const job = parse<Job>(row.data); const next = { ...job, ...patch, id: job.id, kind: job.kind, createdAt: job.createdAt, updatedAt: this.clock() };
    this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(next), id); return next;
  }
  updateJob(id: string, patch: Partial<Job>): Job | undefined { return this.transaction(() => { const next = this.updateJobInside(id, patch); return next; }); }
  reserve(jobId: string, amount: number, background: boolean, details?: CostDetails, budgetScope?: 'bilibili'): string {
    bounded(jobId, '任务 ID', 200);
    if (!numberAtLeastZero(amount)) throw new Error('预留费用无效');
    if (budgetScope!==undefined && (budgetScope!=='bilibili'||!background)) throw new Error('预算用途无效');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM ledger WHERE job_id=?').get(jobId);
      if (existing) {
        if(this.getMeta<{kind:string}>('budget-scope:'+existing.id)?.kind!==budgetScope) throw new Error('任务预算用途已变化，不能重复使用同一调用');
        return String(existing.id);
      }
      if (background) {
        const settings = this.settings();
        if (!settings.backgroundEnabled && budgetScope!=='bilibili') throw new Error('后台任务未启用');
        if (details) {
          if (!details.priceVerified || !details.provider || !details.model || !details.rawUnit || !Number.isFinite(details.conversionRate) || details.conversionRate<=0 || !numberAtLeastZero(details.rawReserved) || Math.abs(details.rawReserved*details.conversionRate-amount)>1e-8) throw new Error('Embedding 费用或换算尚未核实');
        } else {
          if (!settings.prices || !sameRoute(settings.model, settings.priceRoute)) throw new Error('后台任务需要启用并为当前模型配置已核实单价');
          if (amount === 0 && Math.max(settings.prices.input, settings.prices.cached, settings.prices.output) !== 0) throw new Error('非免费线路不能零费用预留');
        }
        if (budgetScope==='bilibili') {
          const usage = this.usage(true);
          if (usage.uncertain) throw new Error('存在未核实的 B 站费用，B 站任务已暂停');
          if (usage.spent + (usage.estimated ?? 0) + usage.reserved + amount > settings.dailyLimit + 1e-9) throw new Error('今日 B 站预算不足');
        }
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO ledger(id,day,job_id,background,unit,reserved,actual,status,created_at,details) VALUES(?,?,?,?,?,?,NULL,'reserved',?,?)").run(id, beijingDay(this.clock()), jobId, background ? 1 : 0, this.settings().unit, amount, this.clock(),details?JSON.stringify(details):null);
      if(budgetScope) this.setMeta('budget-scope:'+id,{kind:budgetScope});
      return id;
    });
  }
  settle(ticket: string, actual: number | null, details?: Partial<CostDetails>): void {
    if (actual !== null && !numberAtLeastZero(actual)) throw new Error('实际费用无效');
    this.transaction(() => {
      const row = this.db.prepare('SELECT status,actual,reserved,background,details FROM ledger WHERE id=?').get(ticket); if (!row) throw new Error('费用记录不存在');
      if (row.status !== 'reserved') {
        if (row.status === 'settled' && actual !== null && Number(row.actual) === actual || row.status === 'uncertain' && (actual === null && row.actual === null || actual !== null && row.actual !== null && Number(row.actual) === actual)) return;
        throw new Error('费用记录已结算，不能重复修改');
      }
      const uncertain = actual === null || (this.getMeta<{kind:string}>('budget-scope:'+ticket)?.kind==='bilibili' && actual > Number(row.reserved) + 1e-9);
      const merged=details?{...(row.details?parse<CostDetails>(row.details):{}),...details}:row.details?parse<CostDetails>(row.details):null;
      if (row.details && actual!==null && (!merged || !numberAtLeastZero(merged.rawActual) || Math.abs(merged.rawActual*Number(merged.conversionRate)-actual)>1e-8)) throw new Error('实际费用与换算不一致');
      if (merged && [merged.inputTokens,merged.outputTokens,merged.cachedTokens].some(n=>n!==undefined && (!Number.isSafeInteger(n)||n<0))) throw new Error('模型用量无效');
      this.db.prepare('UPDATE ledger SET status=?,actual=?,details=? WHERE id=?').run(uncertain ? 'uncertain' : 'settled', actual, merged?JSON.stringify(merged):null, ticket);
    });
  }
  private ledgerEntries(where:string,...params:Array<string|number>):Ledger[] {
    return this.db.prepare(`SELECT l.*,${BILIBILI_SCOPE} AS bilibili,json_extract(budget_ack.data,'$.at') AS ack_at FROM ledger l ${BUDGET_ACK_JOIN} ${where}`).all(...params).map(row => ({ unit:String(row.unit), id: String(row.id), day: String(row.day), jobId: String(row.job_id), background: !!row.background, reserved: Number(row.reserved), actual: row.actual === null ? null : Number(row.actual), status: row.status as Ledger['status'], createdAt: Number(row.created_at), ...(row.details?{details:parse<CostDetails>(row.details)}:{}), ...(row.ack_at?{budgetAcknowledgedAt:Number(row.ack_at)}:{}), ...(row.bilibili?{budgetScope:'bilibili' as const}:{}) }));
  }
  ledger(): Ledger[] { return this.ledgerEntries('ORDER BY l.created_at DESC LIMIT 500'); }
  budgetBlockers():Ledger[] {
    return this.ledgerEntries(`WHERE l.background=1 AND ${BILIBILI_SCOPE} AND l.day=? AND l.unit=? AND l.status='uncertain' AND budget_ack.key IS NULL ORDER BY l.created_at DESC`,beijingDay(this.clock()),this.settings().unit);
  }
  acknowledgeBudget(id:string,day:string,unit:string,amount:number):Usage {
    bounded(id,'费用记录 ID',200);
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM ledger WHERE id=?').get(id);
      if(!row||!row.background||this.getMeta<{kind:string}>('budget-scope:'+id)?.kind!=='bilibili'||row.status!=='uncertain'||day!==beijingDay(this.clock())||unit!==this.settings().unit||row.day!==day||row.unit!==unit||!numberAtLeastZero(amount)||amount!==Number(row.actual??row.reserved)) throw new Error('费用记录或预算已变化，请刷新后重新确认');
      const jobId=String(row.job_id);
      if(this.runningJobs().some(job=>jobId===job.id||jobId.startsWith(job.id+':'))) throw new Error('该任务仍在运行，请等待结束后核对费用');
      const key='budget-ack:'+id;
      const existing=this.getMeta<{at:number;day:string;unit:string;amount:number}>(key);
      if(existing && (existing.day!==day||existing.unit!==unit||existing.amount!==amount||!Number.isFinite(existing.at)||existing.at<=0)) throw new Error('费用确认记录不一致，请核对后再处理');
      if(!existing) this.setMeta(key,{at:this.clock(),day,unit,amount});
      return this.usage(true);
    });
  }
  hasUnknownCost(jobId:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM ledger WHERE job_id=? AND actual IS NULL AND status='uncertain'").get(jobId);
  }
  usage(budgetOnly=false): Usage {
    const day = beijingDay(this.clock());
    const settings = this.settings();
    const scope=budgetOnly?` AND ${BILIBILI_SCOPE}`:'';
    const row = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN l.actual IS NOT NULL THEN l.actual ELSE 0 END),0) AS spent,COALESCE(SUM(CASE WHEN l.status IN ('reserved','uncertain') AND l.actual IS NULL AND budget_ack.key IS NULL THEN l.reserved ELSE 0 END),0) AS reserved,COALESCE(SUM(CASE WHEN l.actual IS NULL AND budget_ack.key IS NOT NULL THEN l.reserved ELSE 0 END),0) AS estimated FROM ledger l ${BUDGET_ACK_JOIN} WHERE l.background=1 AND l.day=? AND l.unit=?${scope}`).get(day, settings.unit)!;
    const uncertain = this.db.prepare(`SELECT 1 FROM ledger l ${BUDGET_ACK_JOIN} WHERE l.background=1 AND l.day=? AND l.unit=?${scope} AND l.status='uncertain' AND budget_ack.key IS NULL LIMIT 1`).get(day, settings.unit);
    const chat = this.db.prepare("SELECT COALESCE(SUM(actual),0) AS spent FROM ledger WHERE background=0 AND day=? AND unit=? AND status='settled'").get(day, settings.unit)!;
    const chatUncertain = this.db.prepare("SELECT 1 FROM ledger WHERE background=0 AND day=? AND unit=? AND status='uncertain' LIMIT 1").get(day, settings.unit);
    return { day, spent: Number(row.spent), reserved: Number(row.reserved), estimated:Number(row.estimated), uncertain: !!uncertain, chatSpent: Number(chat.spent), chatUncertain: !!chatUncertain, limit: settings.dailyLimit, unit: settings.unit };
  }
  readAt(): number { return this.getMeta<number>('readAt') ?? 0; }
  markRead(): void { this.transaction(() => { this.setMeta('readAt', this.clock()); }); }
  recover(): void {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT id,data FROM messages').all()) {
        const m = parse<Message>(row.data); if (m.status !== 'streaming') continue;
        m.status = 'failed'; m.error = 'DSH 已关闭或中断，本次回复未完成';
        this.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(m), String(row.id));
      }
      for (const job of this.runningJobs()) if (job.status === 'running') this.updateJobInside(job.id, { status: 'interrupted', reason: 'DSH 已关闭或中断', stage: '已中断' });
      this.db.prepare("UPDATE ledger SET status='uncertain' WHERE status='reserved'").run();
    });
  }
}
