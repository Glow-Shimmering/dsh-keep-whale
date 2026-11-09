import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, beijingDay } from '../src/core/store.js';
import type { Job, Message, Source } from '../src/types.js';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'keep-whale-test-'));
  let time = Date.parse('2026-11-08T01:00:00Z');
  const clock = () => time;
  const store = new Store(root, clock);
  return { root, store, clock, advance: (ms: number) => { time += ms; }, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
};
const source = (id: string, when: number, opts: Partial<Source> = {}): Source => ({ id, kind: 'user_fact', text: '用户提供的内容 ' + id, occasion: id, createdAt: when, processed: false, revoked: false, ...opts });
const job = (id: string, when: number, ids: string[] = []): Job => ({ id, kind: 'memory', status: 'running', stage: '整理', reason: '', createdAt: when, updatedAt: when, sourceIds: ids });
const msg = (id: string, requestId: string, role: 'user' | 'assistant', when: number): Message => ({ id, chatId: 'chat-1', role, text: id, images: [], status: 'complete', createdAt: when, origin: 'chat', requestId });
const priced = (s: Store) => s.patchSettings({ model: { provider: 'tju', model: 'flash' }, priceRoute: { provider: 'tju', model: 'flash' }, prices: { input: 30, cached: 0.6, output: 120 } });

test('identity is stable across rename and reopen and raw data is isolated', () => {
  const env = setup();
  try {
    const id = env.store.companion().id;
    assert.equal(env.store.companion().name, '大肥鱼');
    env.store.addSource(source('identity-memory-source', env.clock()));
    const memory = env.store.saveMemory({ kind: 'user_fact', text: '一条已有记忆', sourceIds: ['identity-memory-source'] });
    assert.ok(memory);
    env.store.rename('小余'); env.store.setMood('平静');
    assert.equal(env.store.memories()[0].id, memory.id);
    assert.equal(env.store.companion().id, id);
    assert.equal(env.store.settings().observeEnabled, false);
    assert.throws(() => env.store.rename(' '.repeat(3)));
    env.store.close();
    const reopened = new Store(env.root, env.clock);
    assert.deepEqual([reopened.companion().id, reopened.companion().name], [id, '小余']);
    reopened.close();
  } finally { env.cleanup(); }
});

test('observation starts at enable; excluded workspaces and subdirectories stop queued processing without deleting earlier memory', () => {
  const e = setup();
  try {
    const obs = (id: string, time: number, workspace = '/project/private/sub'): Source => source(id, time, { kind: 'observed_dialogue', sessionId: 'session-1', workspace });
    assert.equal(e.store.addSource(obs('before', e.clock())), false);
    e.advance(10); e.store.patchSettings({ observeEnabled: true });
    assert.equal(e.store.addSource(obs('old', e.clock() - 1)), false);
    assert.equal(e.store.addSource(obs('ok', e.clock())), true);
    assert.equal(e.store.addSource(obs('ok', e.clock())), false);
    const saved = e.store.saveMemory({ kind: 'observed_dialogue', text: '用户讨论了某事', sourceIds: ['ok'] });
    assert.ok(saved);
    e.store.putJob(job('read', e.clock(), ['ok']));
    const rev = e.store.revision();
    e.store.patchSettings({ excludedWorkspaces: ['/project/private'] });
    assert.ok(e.store.revision() > rev);
    assert.equal(e.store.pendingSources().length, 0);
    assert.equal(e.store.jobs()[0].status, 'interrupted');
    assert.equal(e.store.memories().length, 1);
    assert.equal(e.store.saveMemory({ kind: 'observed_dialogue', text: '新记忆', sourceIds: ['ok'] }, rev), null);
    assert.equal(e.store.addSource(obs('new', e.clock())), false);
    assert.equal(e.store.addSource(obs('missing-workspace', e.clock(), '')), false);
  } finally { e.cleanup(); }
});

test('evidence gate uses distinct occasions and Beijing dates; one sentence is not stable personality', () => {
  const e = setup();
  try {
    const t1 = e.clock();
    e.store.addSource(source('a', t1, { kind: 'shared_episode', occasion: 'first' }));
    e.store.addSource(source('b', t1 + 1000, { kind: 'shared_episode', occasion: 'second' }));
    e.store.addSource(source('c', t1 + 2000, { kind: 'shared_episode', occasion: 'third' }));
    assert.equal(e.store.saveMemory({ kind: 'tendency', text: '愿意认真讨论', sourceIds: ['a'] }), null);
    assert.equal(e.store.saveMemory({ kind: 'tendency', text: '愿意认真讨论', sourceIds: ['a', 'b', 'c'] }), null);
    e.advance(24 * 3600 * 1000);
    e.store.addSource(source('d', e.clock(), { kind: 'shared_episode', occasion: 'fourth' }));
    assert.ok(e.store.saveMemory({ kind: 'tendency', text: '愿意认真讨论', sourceIds: ['a', 'b', 'd'], evidence: ['a','b','d'].map(id=>({sourceId:id,quote:'用户提供的内容 '+id})) }));
    assert.equal(beijingDay(Date.parse('2026-11-08T15:59:00Z')), '2026-11-08');
    assert.equal(beijingDay(Date.parse('2026-11-08T16:00:00Z')), '2026-11-09');
    assert.equal(e.store.saveMemory({ kind: 'user_fact', text: '不可冒充用户事实', sourceIds: ['a'] }), null);
  } finally { e.cleanup(); }
});

test('deleting a memory retracts all dependent memories, running jobs and stale writes, but preserves chat', () => {
  const e = setup();
  try {
    e.store.putMessage(msg('u', 'r', 'user', e.clock())); e.store.putMessage(msg('a', 'r', 'assistant', e.clock()));
    e.store.addSource(source('s1', e.clock())); e.store.addSource(source('s2', e.clock()));
    const a = e.store.saveMemory({ kind: 'user_fact', text: '事实一', sourceIds: ['s1'] })!;
    const b = e.store.saveMemory({ kind: 'user_fact', text: '综合事实', sourceIds: ['s1', 's2'] })!;
    const c = e.store.saveMemory({ kind: 'user_fact', text: '事实二', sourceIds: ['s2'] })!;
    e.store.putJob(job('running', e.clock(), ['s1']));
    const revision = e.store.revision(); e.store.deleteMemories([a.id]);
    assert.deepEqual(e.store.memories().map(x => x.id), [c.id]);
    assert.equal(e.store.jobs()[0].status, 'interrupted');
    assert.equal(e.store.saveMemory({ kind: 'user_fact', text: '旧结果', sourceIds: ['s1'] }, revision), null);
    assert.equal(e.store.saveMemory({ kind: 'user_fact', text: '旧结果', sourceIds: ['s1'] }), null);
    assert.equal(e.store.addSource(source('s1', e.clock())), false);
    assert.equal(e.store.messages().length, 2);
    assert.ok(b.id);
    const corrected = e.store.editMemory(c.id, '更正后的事实')!;
    assert.equal(corrected.kind, 'user_fact');
    assert.match(corrected.sourceIds[0], /^manual-correction:/);
    assert.equal(e.store.memories()[0].text, '更正后的事实');
  } finally { e.cleanup(); }
});

test('deleting either chat message removes its pair and retracts chat evidence', () => {
  const e = setup();
  try {
    e.store.putMessage(msg('user-1', 'req-1', 'user', e.clock()));
    e.store.putMessage(msg('assistant-1', 'req-1', 'assistant', e.clock()));
    e.store.putMessage(msg('user-2', 'req-2', 'user', e.clock()));
    e.store.addSource(source('chat:user-1', e.clock()));
    e.store.addSource(source('episode:user-1:more', e.clock(), { kind: 'shared_episode' }));
    e.store.addSource(source('chat:user-2', e.clock()));
    e.store.saveMemory({ kind: 'user_fact', text: '事实一', sourceIds: ['chat:user-1'] });
    e.store.saveMemory({ kind: 'shared_episode', text: '共同经历', sourceIds: ['episode:user-1:more'] });
    e.store.saveMemory({ kind: 'user_fact', text: '事实二', sourceIds: ['chat:user-2'] });
    e.store.putJob(job('related', e.clock(), ['episode:user-1:more']));
    const rev = e.store.revision(); e.store.deleteMessages(['assistant-1']);
    assert.deepEqual(e.store.messages().map(m => m.id), ['user-2']);
    assert.deepEqual(e.store.memories().map(m => m.text), ['事实二']);
    assert.deepEqual(e.store.sources().map(s => s.id), ['chat:user-2']);
    assert.equal(e.store.jobs()[0].status, 'interrupted');
    assert.ok(e.store.revision() > rev);
  } finally { e.cleanup(); }
});

test('interactions are idempotent, alternate lines, do not change mood or enqueue long-term sources', () => {
  const e = setup();
  try {
    e.store.setMood('担心');
    const first = e.store.recordInteraction('pet', 'x');
    assert.deepEqual(e.store.recordInteraction('pet', 'x'), first);
    assert.notEqual(e.store.recordInteraction('pet', 'y').text, first.text);
    for (const type of ['pet', 'feed'] as const) {
      const recent: string[] = [];
      for (let i = 0; i < 12; i++) {
        const response = e.store.recordInteraction(type, `${type}-${i}`);
        assert.ok(response.text.trim());
        assert.ok(!recent.slice(-5).includes(response.text), '最近五次同类互动不应重复');
        recent.push(response.text);
      }
    }
    assert.equal(e.store.companion().mood, '担心');
    assert.deepEqual(e.store.pendingSources(), []);
    assert.deepEqual(e.store.memories(), []);
    assert.deepEqual(e.store.messages(), []);
    assert.deepEqual(e.store.ledger(), []);
    e.advance(24 * 3600 * 1000 + 1);
    assert.equal(e.store.interactions().length, 0);
  } finally { e.cleanup(); }
});

test('Bilibili budget reserves atomically, tracks actual and uncertain cost; chat has separate budget', () => {
  const e = setup();
  try {
    assert.throws(() => e.store.reserve('unpriced', 1, true,undefined,'bilibili'), /价格|单价/);
    priced(e.store);
    const rev = e.store.revision();
    const id = e.store.reserve('j1', 80, true,undefined,'bilibili');
    assert.equal(e.store.reserve('j1', 80, true,undefined,'bilibili'), id);
    assert.throws(() => e.store.reserve('j2', 21, true,undefined,'bilibili'), /预算/);
    const chat = e.store.reserve('chat', 50, false); e.store.settle(chat, 40);
    assert.equal(e.store.usage().chatSpent, 40); assert.equal(e.store.usage().reserved, 80);
    e.store.settle(id, 30); assert.equal(e.store.usage().spent, 30);
    const next = e.store.reserve('j3', 1, true,undefined,'bilibili'); e.store.settle(next, null);
    assert.equal(e.store.usage().uncertain, true);
    assert.throws(() => e.store.reserve('j4', 1, true,undefined,'bilibili'), /未核实/);
    assert.equal(e.store.revision(), rev);
    e.advance(24 * 3600 * 1000); assert.equal(e.store.usage().spent, 0);
    assert.equal(e.store.usage().uncertain, false);
    assert.doesNotThrow(() => e.store.reserve('j5', 1, true,undefined,'bilibili'));
  } finally { e.cleanup(); }
});

test('verified free model accepts zero reservation and missing usage still stops Bilibili calls', () => {
  const e = setup();
  try {
    e.store.patchSettings({ model: { provider: 'free', model: 'model' }, priceRoute: { provider: 'free', model: 'model' }, prices: { input: 0, cached: 0, output: 0 } });
    const id = e.store.reserve('free-1', 0, true,undefined,'bilibili'); e.store.settle(id, 0);
    assert.equal(e.store.usage().spent, 0);
    const id2 = e.store.reserve('free-2', 0, true,undefined,'bilibili'); e.store.settle(id2, null);
    assert.throws(() => e.store.reserve('free-3', 0, true,undefined,'bilibili'), /未核实/);
  } finally { e.cleanup(); }
});

test('recovery reports partial message, interrupted work and uncertain unsettled reservations', () => {
  const e = setup();
  try {
    priced(e.store);
    e.store.putMessage({ ...msg('answer', 'r', 'assistant', e.clock()), status: 'streaming' });
    e.store.putJob(job('work', e.clock())); e.store.reserve('work:attempt:1', 1, true);
    e.store.close();
    const restored = new Store(e.root, e.clock);
    restored.recover();
    assert.equal(restored.getMessage('answer')?.status, 'failed');
    assert.equal(restored.jobs()[0].status, 'interrupted');
    assert.equal(restored.usage().uncertain, true);
    restored.close();
  } finally { e.cleanup(); }
});

test('markProcessed updates every requested ID; revision does not change for ordinary writes', () => {
  const e = setup();
  try {
    e.store.addSource(source('a', e.clock())); e.store.addSource(source('b', e.clock()));
    const rev = e.store.revision();
    e.store.markProcessed(['a', 'b']);
    assert.deepEqual(e.store.pendingSources(), []);
    assert.equal(e.store.revision(), rev);
  } finally { e.cleanup(); }
});

test('message pages remain ordered and do not skip messages with the same timestamp', () => {
  const e = setup();
  try {
    for (let i = 0; i < 7; i++) e.store.putMessage(msg('m' + i, 'r' + i, 'user', e.clock()));
    const newest = e.store.messagePage(undefined, 3);
    const older = e.store.messagePage(newest[0].id, 3);
    const oldest = e.store.messagePage(older[0].id, 3);
    assert.deepEqual([...oldest, ...older, ...newest].map(m => m.id), ['m0','m1','m2','m3','m4','m5','m6']);
    assert.deepEqual(e.store.messagePage('missing', 3), []);
  } finally { e.cleanup(); }
});

test('a unit switch is prohibited on a day with charges and never relabels older ledger entries', () => {
  const e = setup();
  try {
    priced(e.store); const ticket = e.store.reserve('first', 10, true); e.store.settle(ticket, 7);
    assert.throws(() => e.store.patchSettings({ unit: '元' }), /今天已有费用记录/);
    assert.equal(e.store.settings().unit, '积分');
    e.advance(24 * 3600 * 1000);
    e.store.patchSettings({ unit: '元' });
    assert.equal(e.store.usage().unit, '元'); assert.equal(e.store.usage().spent, 0);
    assert.equal(e.store.settings().prices, null); assert.equal(e.store.settings().priceRoute, null);
    priced(e.store);
    const second = e.store.reserve('second', 1, true); e.store.settle(second, 1);
    assert.equal(e.store.usage().spent, 1);
  } finally { e.cleanup(); }
});


test('unknown chat charge is reported without blocking background budget', () => {
  const e = setup();
  try {
    priced(e.store); const chat = e.store.reserve('chat-unknown', 0, false); e.store.settle(chat, null);
    assert.equal(e.store.usage().chatUncertain, true);
    assert.equal(e.store.usage().uncertain, false);
    assert.doesNotThrow(() => e.store.reserve('background-ok', 1, true));
  } finally { e.cleanup(); }
});


test('exceeding the reserved amount records actual spend and stops the day without double counting', () => {
  const e = setup();
  try {
    priced(e.store);
    const ticket = e.store.reserve('overspend', 1, true,undefined,'bilibili'); e.store.settle(ticket, 3);
    assert.equal(e.store.usage().spent, 3); assert.equal(e.store.usage().reserved, 0);
    assert.equal(e.store.usage().uncertain, true);
    assert.throws(() => e.store.reserve('later', 1, true,undefined,'bilibili'), /未核实/);
    assert.doesNotThrow(() => e.store.settle(ticket, 3));
    e.advance(24 * 3600 * 1000);
    assert.equal(e.store.usage().uncertain, false);
    assert.doesNotThrow(() => e.store.reserve('tomorrow', 1, true,undefined,'bilibili'));
  } finally { e.cleanup(); }
});

test('deleting one memory revokes sibling fact and episode evidence of the same chat turn', () => {
  const e = setup();
  try {
    e.store.addSource(source('chat:uuid', e.clock()));
    e.store.addSource(source('episode:uuid', e.clock(), {kind:'shared_episode'}));
    const memory = e.store.saveMemory({kind:'user_fact',text:'用户事实',sourceIds:['chat:uuid']})!;
    e.store.putJob(job('sibling-job',e.clock(),['episode:uuid']));
    e.store.deleteMemories([memory.id]);
    assert.deepEqual(e.store.pendingSources(), []);
    assert.deepEqual(e.store.sources(), []);
    assert.equal(e.store.jobs()[0].status,'interrupted');
    assert.equal(e.store.addSource(source('episode:uuid', e.clock(), {kind:'shared_episode'})),false);
  } finally { e.cleanup(); }
});


test('findRequest resolves idempotency directly across full history', () => {
  const e = setup();
  try {
    e.store.putMessage(msg('user', 'stable-request', 'user', e.clock()));
    e.store.putMessage(msg('assistant', 'stable-request', 'assistant', e.clock()));
    assert.equal(e.store.findRequest('stable-request')?.id, 'user');
    assert.equal(e.store.findRequest('stable-request', 'assistant')?.id, 'assistant');
    assert.equal(e.store.putMessage(msg('another-user', 'stable-request', 'user', e.clock())), false);
  } finally { e.cleanup(); }
});

test('budget acknowledgment rejects an uncertain nested call while its enclosing Bilibili job runs',()=>{
 const e=setup();try{
  priced(e.store);const now=e.clock();
  e.store.putJob({id:'bili:job1',kind:'bilibili',status:'running',stage:'正在了解',reason:'',sourceIds:[],createdAt:now,updatedAt:now});
  const ticket=e.store.reserve('bili:job1:segment:0:attempt:0',.2,true,undefined,'bilibili');e.store.settle(ticket,null);
  const row=e.store.budgetBlockers()[0];assert.throws(()=>e.store.acknowledgeBudget(row.id,row.day,row.unit!,row.reserved),/任务仍在运行/);
  assert.equal(e.store.budgetBlockers().length,1);assert.equal(e.store.usage(true).uncertain,true);
  e.store.updateJob('bili:job1',{status:'failed',stage:'未完成'});
  assert.doesNotThrow(()=>e.store.acknowledgeBudget(row.id,row.day,row.unit!,row.reserved));
  assert.equal(e.store.budgetBlockers().length,0);assert.equal(e.store.ledger().find(l=>l.id===ticket)?.actual,null);
 }finally{e.cleanup();}
});

test('unrelated running job whose prefix happens to match does not block acknowledgment',()=>{
 const e=setup();try{
  priced(e.store);const now=e.clock();
  e.store.putJob({id:'bili:job1',kind:'bilibili',status:'running',stage:'正在了解',reason:'',sourceIds:[],createdAt:now,updatedAt:now});
  const ticket=e.store.reserve('bili:job10:segment:0',.2,true,undefined,'bilibili');e.store.settle(ticket,null);
  const row=e.store.budgetBlockers()[0];assert.doesNotThrow(()=>e.store.acknowledgeBudget(row.id,row.day,row.unit!,row.reserved));
 }finally{e.cleanup();}
});
