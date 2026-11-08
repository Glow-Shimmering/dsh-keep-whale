import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, allowedRequest } from '../src/server.js';
import { Model, ModelFailure, requestMessage } from '../src/model.js';
import { Store } from '../src/core/store.js';
import type { HostContext } from '../src/types.js';

const fakeRequest = (method: string, path: string, headers: Record<string, string> = {}, body = '') => {
  const stream = Readable.from(body ? [Buffer.from(body)] : []) as any;
  stream.method = method; stream.url = path; stream.headers = { host: '127.0.0.1:3000', ...headers };
  return stream;
};
const invoke = async (handler: ReturnType<typeof createHandler>, method: string, path: string, headers: Record<string,string> = {}, body = '') => {
  const response: any = { headersSent: false, status: 0, headers: {}, data: '',
    writeHead(status: number, headersOut: Record<string,string>) { this.status = status; this.headers = headersOut; this.headersSent = true; },
    end(data: unknown) { this.data = String(data ?? ''); },
  };
  await handler(fakeRequest(method, path, headers, body), response);
  let value: any; try { value = JSON.parse(response.data); } catch { value = response.data; }
  return { status: response.status, headers: response.headers, body: value };
};
const serverFixture = () => {
  const state = { calls: 0, before: undefined as string | undefined, count: 0 };
  const service: any = {
    snapshot: () => ({ companion: { id: 'test' } }),
    action: async (body: any) => { state.calls++; return { accepted: body.action }; },
    store: { messagePage: (before?: string) => { state.before = before; return Array.from({ length: state.count }, (_, i) => ({ id: 'm' + i })); }, patchSettings: () => {} },
    media: { upload: async () => ({ url: '/example' }), bytes: () => ({ ref: { mediaType: 'image/png' }, bytes: Buffer.from([1]) }) },
  };
  return { state, create: () => createHandler(service, new URL('../public/whale.svg', import.meta.url)) };
};

test('server rejects cross-site, foreign origins and malformed host; supports app and matching origin', async () => {
  assert.equal(allowedRequest(fakeRequest('GET', '/keep-whale/state', { origin: 'http://127.0.0.1:3000' })), true);
  assert.equal(allowedRequest(fakeRequest('GET', '/keep-whale/state', { origin: 'dsh-app://app' })), true);
  assert.equal(allowedRequest(fakeRequest('GET', '/keep-whale/state', { origin: 'https://example.com' })), false);
  assert.equal(allowedRequest(fakeRequest('GET', '/keep-whale/state', { 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(allowedRequest(fakeRequest('GET', '/keep-whale/state', { host: '127.0.0.1:3000@evil' })), false);
  const fixture = serverFixture(), h = fixture.create();
  const blocked = await invoke(h, 'GET', '/keep-whale/state', { origin: 'https://example.com' });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.token, undefined);
});

test('CSRF token required for mutations and re-created handler invalidates old token', async () => {
  const fixture = serverFixture(), first = fixture.create(), second = fixture.create();
  const original = await invoke(first, 'GET', '/keep-whale/state');
  const replacement = await invoke(second, 'GET', '/keep-whale/state');
  assert.notEqual(original.body.token, replacement.body.token);
  const input = JSON.stringify({ action: 'rename', name: '测试' });
  assert.equal((await invoke(first, 'POST', '/keep-whale/action', {}, input)).status, 403);
  assert.equal((await invoke(second, 'POST', '/keep-whale/action', { 'x-keep-whale-token': original.body.token }, input)).status, 403);
  assert.equal((await invoke(second, 'POST', '/keep-whale/action', { origin: 'https://example.com', 'x-keep-whale-token': replacement.body.token }, input)).status, 403);
  const success = await invoke(second, 'POST', '/keep-whale/action', { origin: 'http://127.0.0.1:3000', 'x-keep-whale-token': replacement.body.token }, input);
  assert.equal(success.status, 200); assert.equal(success.body.accepted, 'rename'); assert.equal(fixture.state.calls, 1);
  assert.equal(success.headers['cache-control'], 'no-store');
});

test('server limits body bytes before parsing and forwards history cursor without altering it', async () => {
  const fixture = serverFixture(), handler = fixture.create();
  const token = (await invoke(handler, 'GET', '/keep-whale/state')).body.token;
  const headers = { 'x-keep-whale-token': token };
  const large = await invoke(handler, 'POST', '/keep-whale/action', headers, JSON.stringify({ action: 'x', text: '测'.repeat(40000) }));
  assert.equal(large.status, 413); assert.equal(fixture.state.calls, 0);
  const malformed = await invoke(handler, 'POST', '/keep-whale/action', headers, '{');
  assert.equal(malformed.status, 400); assert.equal(malformed.body.error, '请求格式无效');
  fixture.state.count = 100;
  const history = await invoke(handler, 'GET', '/keep-whale/messages?before=a%3Ab%2Bc');
  assert.equal(history.status, 200); assert.equal(fixture.state.before, 'a:b+c'); assert.equal(history.body.hasMore, true);
  fixture.state.count = 2;
  assert.equal((await invoke(handler, 'GET', '/keep-whale/messages')).body.hasMore, false);
});

type Part = Record<string, any>;
const modelFixture = (parts: Part[], options: { contextWindow?: number; image?: boolean; imagesPriced?: boolean; free?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'keep-whale-model-'));
  const store = new Store(root);
  store.patchSettings({ model: { provider: 'test', model: 'flash' }, priceRoute: { provider: 'test', model: 'flash' }, prices: options.free ? { input: 0, cached: 0, output: 0 } : { input: 30, cached: 0.6, output: 120 } });
  const seen: any = { dispatched: 0 };
  const llm: any = {
    resolveModelInfo: async () => ({ context: { contextWindow: options.contextWindow ?? 100000 }, inputModalities: options.image ? ['text','image'] : ['text'] }),
    imageRequestPricing: options.imagesPriced ? () => ({ priceImages: (imgs: any[]) => imgs.map(() => ({ visualTokens: 1024, text: '' })) }) : () => undefined,
    async *stream(input: any) { seen.dispatched++; seen.options = input; for (const part of parts) yield part; },
  };
  const context = { get: (key: string) => key === 'llm' ? llm : undefined } as HostContext;
  const model = new Model(context, store);
  const call = (jobId: string, extras: Partial<Parameters<Model['call']>[0]> = {}) => model.call({ system: '种子', messages: [requestMessage('测试')], maxTokens: 1000, signal: new AbortController().signal, jobId, background: true, ...extras });
  const cleanup = () => { store.close(); rmSync(root, { recursive: true, force: true }); };
  return { store, seen, llm, model, call, cleanup };
};
const usage = { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 } };
const text = { type: 'text-delta', text: '好' };
const finish = (kind: string): Part => ({ type: 'finish', reason: { kind } });

test('model uses byte-conservative reservation and reconciles actual uncached, cache and output usage', async () => {
  const e = modelFixture([text, usage, finish('stop')]);
  try {
    assert.equal(await e.call('ok'), '好');
    assert.equal(e.seen.dispatched, 1); assert.equal(e.seen.options.maxTokens, 1000);
    assert.ok(e.store.ledger()[0].reserved > e.store.ledger()[0].actual!);
    assert.ok(Math.abs(e.store.usage().spent - ((100 + 20)*30 + 30*0.6 + 50*120)/1e6) < 1e-10);
  } finally { e.cleanup(); }
});

test('model blocks unverifiable context, unknown image cost or missing route pricing before dispatch', async () => {
  const small = modelFixture([], { contextWindow: 100 });
  try { await assert.rejects(small.call('small'), (e: unknown) => e instanceof ModelFailure && e.code === 'CONTEXT'); assert.equal(small.seen.dispatched, 0); assert.equal(small.store.ledger().length, 0); } finally { small.cleanup(); }
  const image = modelFixture([], { image: true });
  try {
    await assert.rejects(image.call('image', { messages: [{ id: 'x', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { id: 'abc' } }] }] }), (e: unknown) => e instanceof ModelFailure && e.code === 'VISION_COST');
    assert.equal(image.seen.dispatched, 0); assert.equal(image.store.ledger().length, 0);
  } finally { image.cleanup(); }
  const unpriced = modelFixture([]);
  try { unpriced.store.patchSettings({ priceRoute: null }); await assert.rejects(unpriced.call('price'), (e: unknown) => e instanceof ModelFailure && e.code === 'PRICE'); assert.equal(unpriced.seen.dispatched, 0); } finally { unpriced.cleanup(); }
});

test('model handles known-free route, missing usage, and truncated output with correct billing state', async () => {
  const free = modelFixture([text, usage, finish('stop')], { free: true });
  try { assert.equal(await free.call('free'), '好'); assert.equal(free.store.usage().spent, 0); assert.equal(free.store.usage().uncertain, false); } finally { free.cleanup(); }
  const missing = modelFixture([text, finish('stop')]);
  try { assert.equal(await missing.call('missing'), '好'); assert.equal(missing.store.usage().uncertain, true); assert.ok(missing.store.usage().reserved > 0); await assert.rejects(missing.call('again'), /未核实/); } finally { missing.cleanup(); }
  const truncated = modelFixture([text, usage, finish('max-tokens')]);
  try { await assert.rejects(truncated.call('truncated'), (e: unknown) => e instanceof ModelFailure && e.code === 'TRUNCATED'); assert.ok(truncated.store.usage().spent > 0); assert.equal(truncated.store.usage().uncertain, false); } finally { truncated.cleanup(); }
});

test('model does not dispatch on pre-abort and accounts for abort during stream', async () => {
  const before = modelFixture([text, usage, finish('stop')]);
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(before.call('pre-abort', { signal: controller.signal }));
    assert.equal(before.seen.dispatched, 0); assert.equal(before.store.ledger().length, 0);
  } finally { before.cleanup(); }
  const during = modelFixture([]);
  try {
    const controller = new AbortController();
    during.llm.stream = async function* () { during.seen.dispatched++; yield usage; controller.abort(); yield finish('aborted'); };
    await assert.rejects(during.call('abort', { signal: controller.signal }), (e: unknown) => (e instanceof ModelFailure && e.code === 'CANCELLED') || (e instanceof Error && e.name === 'AbortError'));
    assert.equal(during.seen.dispatched, 1); assert.equal(during.store.usage().uncertain, true); assert.ok(during.store.usage().reserved > 0);
  } finally { during.cleanup(); }
});


test('cancellation returns promptly even when model stream ignores its signal', async () => {
  const e = modelFixture([]);
  try {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let resolveLate!: (value: IteratorResult<any>) => void;
    const pending = new Promise<IteratorResult<any>>(resolve => { resolveLate = resolve; });
    e.llm.stream = () => ({ [Symbol.asyncIterator]: () => ({ next: () => { entered(); return pending; }, return: () => Promise.resolve({done:true,value:undefined}) }) });
    let callbackCount = 0;
    const result = e.call('hang', { signal: controller.signal, onText: () => { callbackCount++; } });
    await started; controller.abort();
    await assert.rejects(result);
    assert.equal(e.store.usage().uncertain, true);
    resolveLate({done:false,value:text});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbackCount, 0);
  } finally { e.cleanup(); }
});
