import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Companion, Interaction, Job, Ledger, Memory, MemoryKind, Message, Settings, Source, Usage } from '../types.js';

const DAY_MS = 86_400_000;
/** The product's budget and evidence day follows Beijing time, independent of host locale. */
export function beijingDay(timestamp: number): string { return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10); }
export const DEFAULT_SETTINGS: Settings = {
  model: null, priceRoute: null, prices: null, unit: '积分', pointsPerYuan: null, dailyLimit: 100,
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

  constructor(root: string, now: () => number = Date.now) {
    this.clock = now;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'keep-whale.sqlite');
    this.db = new DatabaseSync(path);
    try { chmodSync(path, 0o600); } catch { /* The host may impose stricter permissions. */ }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(request_id, role));
      CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sources_pending ON sources(revoked,processed,created_at);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS interaction_time ON interactions(created_at);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, day TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, background INTEGER NOT NULL, unit TEXT NOT NULL DEFAULT '', reserved REAL NOT NULL, actual REAL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ledger_day ON ledger(day,background,status);
    `);
    const columns = this.db.prepare('PRAGMA table_info(ledger)').all();
    if (!columns.some(column => column.name === 'unit')) this.db.exec("ALTER TABLE ledger ADD COLUMN unit TEXT NOT NULL DEFAULT ''");
    this.transaction(() => {
      if (!this.getMeta<Companion>('companion')) this.setMeta('companion', { id: randomUUID(), name: '小鲸鱼', mood: '平静', createdAt: this.clock() } satisfies Companion);
      if (!this.getMeta<Settings>('settings')) this.setMeta('settings', DEFAULT_SETTINGS);
      if (this.getMeta<number>('revision') === undefined) this.setMeta('revision', 0);
      if (this.getMeta<number>('readAt') === undefined) this.setMeta('readAt', 0);
      this.db.prepare("UPDATE ledger SET unit=? WHERE unit=''").run(this.settings().unit);
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
  private bump(): void { this.setMeta('revision', this.revision() + 1); }
  companion(): Companion { return copy(this.getMeta<Companion>('companion')!); }
  rename(name: string): Companion {
    const valid = bounded(name, '伙伴名字', 32);
    return this.transaction(() => { const current = this.companion(); current.name = valid; this.setMeta('companion', current); return current; });
  }
  setMood(value: string): Companion {
    const mood = bounded(value, '心情', 24);
    return this.transaction(() => { const current = this.companion(); current.mood = mood; this.setMeta('companion', current); return current; });
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
  getMessage(id: string): Message | undefined { const row = this.db.prepare('SELECT data FROM messages WHERE id=?').get(id); return row ? parse<Message>(row.data) : undefined; }
  putMessage(message: Message): boolean {
    bounded(message.id, '消息 ID', 200); bounded(message.requestId, '请求 ID', 200);
    if (!['user', 'assistant'].includes(message.role) || !['chat', 'proactive'].includes(message.origin) || !['streaming', 'complete', 'failed', 'cancelled'].includes(message.status)) throw new Error('消息格式无效');
    if (typeof message.text !== 'string' || message.text.length > 200_000 || !Array.isArray(message.images) || message.images.length > 8) throw new Error('消息内容过长或格式无效');
    return this.transaction(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO messages(id,request_id,role,created_at,data) VALUES(?,?,?,?,?)').run(message.id, message.requestId, message.role, message.createdAt, JSON.stringify(message));
      return Number(result.changes) > 0;
    });
  }
  updateMessage(id: string, patch: Partial<Message>): Message | undefined {
    return this.transaction(() => {
      const m = this.getMessage(id); if (!m) return undefined;
      // Identity and provenance are immutable, preventing a retry from becoming a second user turn.
      const next = { ...m, ...patch, id: m.id, chatId: m.chatId, requestId: m.requestId, role: m.role, createdAt: m.createdAt, origin: m.origin };
      if (!['streaming', 'complete', 'failed', 'cancelled'].includes(next.status) || typeof next.text !== 'string' || next.text.length > 200_000 || !Array.isArray(next.images)) throw new Error('消息格式无效');
      this.db.prepare('UPDATE messages SET data=? WHERE id=?').run(JSON.stringify(next), id); return next;
    });
  }
  deleteMessages(ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string')) throw new Error('删除消息范围无效');
    this.transaction(() => {
      const get = this.db.prepare('SELECT request_id FROM messages WHERE id=?');
      const requests = new Set(ids.map(id => get.get(id)).filter(Boolean).map(row => String(row!.request_id)));
      const pairs = [...requests].flatMap(requestId => this.db.prepare('SELECT id,role FROM messages WHERE request_id=?').all(requestId));
      const userIds = pairs.filter(row => row.role === 'user').map(row => String(row.id));
      const sourceIds = new Set<string>();
      for (const row of this.db.prepare('SELECT id FROM sources WHERE revoked=0').all()) {
        const sourceId = String(row.id);
        if (userIds.some(id => sourceId === `chat:${id}` || sourceId.startsWith(`chat:${id}:`) || sourceId === `episode:${id}` || sourceId.startsWith(`episode:${id}:`))) sourceIds.add(sourceId);
      }
      this.retractInside([], sourceIds);
      const remove = this.db.prepare('DELETE FROM messages WHERE request_id=?');
      for (const requestId of requests) remove.run(requestId);
      if (requests.size) this.bump();
    });
  }
  private sourceById(id: string): Source | undefined {
    const row = this.db.prepare('SELECT data,processed,revoked FROM sources WHERE id=?').get(id); if (!row) return undefined;
    return { ...parse<Source>(row.data), processed: !!row.processed, revoked: !!row.revoked };
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
      return Number(result.changes) > 0;
    });
  }
  pendingSources(limit = 12): Source[] {
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    // A bounded recent set avoids loading archived content; filtering happens before taking the requested count.
    const rows = this.db.prepare('SELECT id FROM sources WHERE revoked=0 AND processed=0 ORDER BY created_at ASC').all();
    const settings = this.settings();
    return rows.map(row => this.sourceById(String(row.id))!).filter(source => source && this.isEligible(source, settings)).slice(0, n);
  }
  markProcessed(ids: string[]): void {
    if (!ids.length) return;
    this.transaction(() => {
      const q = this.db.prepare('UPDATE sources SET processed=1 WHERE id=? AND revoked=0');
      let changed = false; for (const id of new Set(ids)) if (Number(q.run(id).changes) > 0) changed = true;
      void changed;
    });
  }
  memories(): Memory[] { return dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories ORDER BY updated_at DESC LIMIT 5000').all()); }
  saveMemory(input: { kind: MemoryKind; text: string; sourceIds: string[] }, expectedRevision?: number): Memory | null {
    if (!['user_fact', 'shared_episode', 'observed_dialogue', 'tendency'].includes(input.kind)) throw new Error('记忆类型无效');
    const value = bounded(input.text, '记忆内容', 4000);
    if (!Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 100) throw new Error('记忆需要有效来源');
    const sourceIds = [...new Set(input.sourceIds)];
    return this.transaction(() => {
      if (expectedRevision !== undefined && expectedRevision !== this.revision()) return null;
      const sources = sourceIds.map(id => this.sourceById(id));
      if (sources.some(source => !source || !this.isEligible(source, this.settings()) || source.kind === 'interaction')) return null;
      const valid = sources as Source[];
      if (input.kind === 'user_fact' && valid.some(s => s.kind !== 'user_fact')) return null;
      if (input.kind === 'observed_dialogue' && valid.some(s => s.kind !== 'observed_dialogue')) return null;
      if (input.kind === 'shared_episode' && valid.some(s => s.kind !== 'shared_episode')) return null;
      if (input.kind === 'tendency' && (new Set(valid.map(s => s.occasion)).size < 3 || new Set(valid.map(s => beijingDay(s.createdAt))).size < 2)) return null;
      const now = this.clock(); const memory: Memory = { id: randomUUID(), kind: input.kind, text: value, sourceIds, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO memories(id,updated_at,data) VALUES(?,?,?)').run(memory.id, now, JSON.stringify(memory)); return memory;
    });
  }
  private retractInside(ids: string[], sourceIds = new Set<string>()): void {
    const targets = new Set(ids);
    const memories = dataFromRows<Memory>(this.db.prepare('SELECT data FROM memories').all());
    for (const id of memories.filter(m => targets.has(m.id)).flatMap(m => m.sourceIds)) sourceIds.add(id);
    // A single user message produces both user-fact and episode evidence. Revoke
    // both views when either one is deleted so the other cannot recreate it.
    for (const id of [...sourceIds]) {
      if (id.startsWith('chat:')) sourceIds.add('episode:' + id.slice('chat:'.length));
      else if (id.startsWith('episode:')) sourceIds.add('chat:' + id.slice('episode:'.length));
    }
    // All derived entries sharing revoked evidence must disappear too; never hide an active derivative.
    for (const memory of memories) if (targets.has(memory.id) || memory.sourceIds.some(id => sourceIds.has(id))) targets.add(memory.id);
    const revoke = this.db.prepare('UPDATE sources SET revoked=1 WHERE id=?');
    for (const id of sourceIds) revoke.run(id);
    const remove = this.db.prepare('DELETE FROM memories WHERE id=?'); for (const id of targets) remove.run(id);
    for (const job of this.runningJobs()) if (job.status === 'running' && job.sourceIds.some(id => sourceIds.has(id))) this.updateJobInside(job.id, { status: 'interrupted', reason: '关联记忆已删除或更正', stage: '已撤回' });
  }
  deleteMemories(ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 5000) throw new Error('删除范围无效');
    this.transaction(() => { this.retractInside(ids); this.bump(); });
  }
  editMemory(id: string, text: string): Memory | null {
    const value = bounded(text, '记忆内容', 4000);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM memories WHERE id=?').get(id); if (!row) return null;
      const old = parse<Memory>(row.data);
      this.retractInside([id]);
      const now = this.clock();
      const source: Source = { id: 'manual-correction:' + randomUUID(), kind: 'user_fact', text: value, occasion: 'manual-correction:' + randomUUID(), createdAt: now, processed: true, revoked: false };
      this.db.prepare('INSERT INTO sources(id,created_at,processed,revoked,data) VALUES(?,?,1,0,?)').run(source.id, now, JSON.stringify(source));
      const memory: Memory = { id: randomUUID(), kind: 'user_fact', text: value, sourceIds: [source.id], createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO memories(id,updated_at,data) VALUES(?,?,?)').run(memory.id, now, JSON.stringify(memory)); this.bump(); return memory;
    });
  }
  recordInteraction(type: 'pet' | 'feed', requestId: string): Interaction {
    if (type !== 'pet' && type !== 'feed') throw new Error('互动类型无效'); bounded(requestId, '互动 ID', 200);
    return this.transaction(() => {
      const id = 'interaction:' + requestId;
      const previous = this.db.prepare('SELECT data FROM interactions WHERE id=?').get(id); if (previous) return parse<Interaction>(previous.data);
      const lines = type === 'pet' ? ['轻轻蹭了蹭你的手。', '安静地靠近了一点。', '抬头看了看你。'] : ['收下了你给的食物。', '认真尝了一口。', '把食物小心地接住了。'];
      const last = this.interactions().find(x => x.type === type)?.text;
      const index = Math.max(0, lines.indexOf(last || '') + 1) % lines.length;
      const interaction: Interaction = { id, type, text: lines[index], createdAt: this.clock() };
      this.db.prepare('INSERT INTO interactions(id,created_at,data) VALUES(?,?,?)').run(id, interaction.createdAt, JSON.stringify(interaction)); return interaction;
    });
  }
  interactions(): Interaction[] { return dataFromRows<Interaction>(this.db.prepare('SELECT data FROM interactions WHERE created_at>=? ORDER BY created_at DESC,rowid DESC LIMIT 32').all(this.clock() - DAY_MS)); }
  jobs(): Job[] { return dataFromRows<Job>(this.db.prepare('SELECT data FROM jobs ORDER BY created_at DESC LIMIT 500').all()); }
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
  reserve(jobId: string, amount: number, background: boolean): string {
    bounded(jobId, '任务 ID', 200);
    if (!numberAtLeastZero(amount)) throw new Error('预留费用无效');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM ledger WHERE job_id=?').get(jobId);
      if (existing) return String(existing.id);
      if (background) {
        const settings = this.settings();
        if (!settings.backgroundEnabled || !settings.prices || !sameRoute(settings.model, settings.priceRoute)) throw new Error('后台任务需要启用并为当前模型配置已核实单价');
        if (amount === 0 && Math.max(settings.prices.input, settings.prices.cached, settings.prices.output) !== 0) throw new Error('非免费线路不能零费用预留');
        const usage = this.usage();
        if (usage.uncertain) throw new Error('存在未核实费用，后台任务已暂停');
        if (usage.spent + usage.reserved + amount > settings.dailyLimit + 1e-9) throw new Error('今日后台预算不足');
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO ledger(id,day,job_id,background,unit,reserved,actual,status,created_at) VALUES(?,?,?,?,?,?,NULL,'reserved',?)").run(id, beijingDay(this.clock()), jobId, background ? 1 : 0, this.settings().unit, amount, this.clock());
      return id;
    });
  }
  settle(ticket: string, actual: number | null): void {
    if (actual !== null && !numberAtLeastZero(actual)) throw new Error('实际费用无效');
    this.transaction(() => {
      const row = this.db.prepare('SELECT status,actual,reserved,background FROM ledger WHERE id=?').get(ticket); if (!row) throw new Error('费用记录不存在');
      if (row.status !== 'reserved') {
        if (row.status === 'settled' && actual !== null && Number(row.actual) === actual || row.status === 'uncertain' && (actual === null && row.actual === null || actual !== null && row.actual !== null && Number(row.actual) === actual)) return;
        throw new Error('费用记录已结算，不能重复修改');
      }
      const uncertain = actual === null || (!!row.background && actual > Number(row.reserved) + 1e-9);
      this.db.prepare('UPDATE ledger SET status=?,actual=? WHERE id=?').run(uncertain ? 'uncertain' : 'settled', actual, ticket);
    });
  }
  ledger(): Ledger[] {
    return this.db.prepare('SELECT * FROM ledger ORDER BY created_at DESC LIMIT 500').all().map(row => ({ unit:String(row.unit), id: String(row.id), day: String(row.day), jobId: String(row.job_id), background: !!row.background, reserved: Number(row.reserved), actual: row.actual === null ? null : Number(row.actual), status: row.status as Ledger['status'], createdAt: Number(row.created_at) }));
  }
  usage(): Usage {
    const day = beijingDay(this.clock());
    const settings = this.settings();
    const row = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN actual IS NOT NULL THEN actual ELSE 0 END),0) AS spent,COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') AND actual IS NULL THEN reserved ELSE 0 END),0) AS reserved FROM ledger WHERE background=1 AND day=? AND unit=?").get(day, settings.unit)!;
    const uncertain = this.db.prepare("SELECT 1 FROM ledger WHERE background=1 AND day=? AND unit=? AND status='uncertain' LIMIT 1").get(day, settings.unit);
    const chat = this.db.prepare("SELECT COALESCE(SUM(actual),0) AS spent FROM ledger WHERE background=0 AND day=? AND unit=? AND status='settled'").get(day, settings.unit)!;
    const chatUncertain = this.db.prepare("SELECT 1 FROM ledger WHERE background=0 AND day=? AND unit=? AND status='uncertain' LIMIT 1").get(day, settings.unit);
    return { day, spent: Number(row.spent), reserved: Number(row.reserved), uncertain: !!uncertain, chatSpent: Number(chat.spent), chatUncertain: !!chatUncertain, limit: settings.dailyLimit, unit: settings.unit };
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
