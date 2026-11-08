import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readlinkSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.js';
import { Service } from '../src/service.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const put = (path: string, contents: string) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, contents); };
function fixture(t: any) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-keep-whale-install-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const profile = join(tmp, 'profile'), home = join(tmp, 'home'), source = join(tmp, 'source'), backup = join(tmp, 'backup');
  mkdirSync(join(profile, 'node_modules'), { recursive: true }); mkdirSync(home, { recursive: true });
  const oldPkg = JSON.stringify({ name:'dsh-profile-desktop', dependencies:{ 'dsh-feed-the-seek':'1.0.1', 'dsh-xiaoyu-companion':'link:/old', 'dsh-whale-widget':'0.4.2' }, dsh:{ profile:{ bundles:['@deepseek-ai/dsh-base','dsh-feed-the-seek','dsh-whale-widget','dsh-xiaoyu-companion'] } } }, null, 2) + '\n';
  const oldLock = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dsh-feed-the-seek:\n        specifier: 1.0.1\n        version: 1.0.1\n      dsh-whale-widget:\n        specifier: 0.4.2\n        version: 0.4.2\n      dsh-xiaoyu-companion:\n        specifier: link:/old\n        version: link:../old\n\npackages:\n  dsh-feed-the-seek@1.0.1: {}\n";
  put(join(profile, 'package.json'), oldPkg); put(join(profile, 'pnpm-lock.yaml'), oldLock);
  put(join(profile, 'cordis.yml'), '[]\n'); put(join(profile, 'cordis.patch.yml'), '- id: unrelated-widget\n  disabled: false\n');
  put(join(source, 'package.json'), '{"name":"dsh-keep-whale"}'); put(join(source, 'dist/index.js'), 'export {}'); put(join(source, 'dist/client.js'), 'export {}'); put(join(source, 'cordis.patch.yml'), '- insert: []\n');
  const oldState = JSON.stringify({ version:1, initialized:true, companions:{ default:{ sessionId:'session-old-companion' } } });
  put(join(home, 'xiaoyu-companion/state.json'), oldState);
  put(join(home, 'xiaoyu-companion/bili/journal.json'), '{"records":["kept"]}');
  put(join(home, 'xiaoyu-companion/bili/accounts/default/secret-cookie'), 'do-not-copy');
  put(join(home, 'xiaoyu-companion/bili/billing.json'), JSON.stringify({routes:[{ provider:'tju',model:'DeepSeek-V4.1-Flash',unit:'points',input:30,cached:0.6,output:120,pointsPerYuan:30 }]}));
  mkdirSync(join(home,'feed-the-seek'), {recursive:true});
  const db = new DatabaseSync(join(home,'feed-the-seek','memory.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE memory(value TEXT); INSERT INTO memory VALUES ('wal-record'); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('persona:session:session-old-companion','\"default\"'),('persona:session:session-ordinary','\"default\"');");
  t.after(() => db.close());
  const common = ['--profile', profile, '--data-home', home, '--backup-dir', backup, '--source', source, '--confirm-stopped'];
  const run = (which: string, args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', which), ...args], { encoding:'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  return { tmp, profile, home, source, backup, oldPkg, oldLock, oldState, common, run };
}

test('installation backs up WAL consistently, preserves others, is idempotent and safely restores', t => {
  const f = fixture(t), args = [...f.common, '--name', '小余', '--tju', '--observe'];
  const result = f.run('install.mjs', args); assert.equal(result.status, 0, result.stderr);
  const packageJson = JSON.parse(readFileSync(join(f.profile,'package.json'),'utf8'));
  assert.deepEqual(packageJson.dsh.profile.bundles, ['@deepseek-ai/dsh-base','dsh-whale-widget','dsh-keep-whale']);
  assert.equal(packageJson.dependencies['dsh-feed-the-seek'], '1.0.1');
  assert.equal(packageJson.dependencies['dsh-whale-widget'], '0.4.2');
  assert.equal(packageJson.dependencies['dsh-keep-whale'], `link:${f.source}`);
  assert.equal(readlinkSync(join(f.profile,'node_modules/dsh-keep-whale')), f.source);
  const lock = readFileSync(join(f.profile,'pnpm-lock.yaml'),'utf8');
  assert.match(lock, /dsh-keep-whale:/); assert.match(lock, /dsh-feed-the-seek@1\.0\.1/);
  assert.equal(readFileSync(join(f.profile,'cordis.patch.yml'),'utf8'), '- id: unrelated-widget\n  disabled: false\n');
  assert.equal(readFileSync(join(f.backup,'profile/package.json'),'utf8'), f.oldPkg);
  const copiedDb = new DatabaseSync(join(f.backup,'legacy/feed-the-seek/memory.sqlite'), {readOnly:true});
  assert.equal(copiedDb.prepare('SELECT value FROM memory').get()?.value, 'wal-record'); copiedDb.close();
  assert.equal(readFileSync(join(f.backup,'legacy/xiaoyu-companion/state.json'),'utf8'), f.oldState);
  assert.equal(existsSync(join(f.backup,'legacy/xiaoyu-companion/bili/accounts')), false);
  const boot = JSON.parse(readFileSync(join(f.home,'dsh-keep-whale/bootstrap.json'),'utf8'));
  assert.equal(boot.name, '小余'); assert.equal(boot.settings.observeEnabled, true); assert.equal(boot.settings.dailyLimit, 100);
  assert.deepEqual(boot.settings.excludedSessions, ['session-old-companion']);
  assert.ok(!boot.settings.excludedSessions.includes('session-ordinary'));
  assert.deepEqual(boot.settings.prices, { input:30, cached:0.6, output:120 });
  assert.equal(f.run('install.mjs', args).status, 0);
  const changedArgs = f.run('install.mjs', f.common); assert.notEqual(changedArgs.status, 0); assert.match(changedArgs.stderr, /参数与原初始化不同/);
  put(join(f.home,'dsh-keep-whale/new-durable-data'), 'preserve');
  const restored = f.run('restore.mjs', f.common); assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readFileSync(join(f.profile,'package.json'),'utf8'), f.oldPkg);
  assert.equal(readFileSync(join(f.profile,'pnpm-lock.yaml'),'utf8'), f.oldLock);
  assert.equal(existsSync(join(f.profile,'node_modules/dsh-keep-whale')), false);
  assert.equal(readFileSync(join(f.home,'dsh-keep-whale/new-durable-data'),'utf8'), 'preserve');
  assert.equal(readFileSync(join(f.home,'xiaoyu-companion/bili/accounts/default/secret-cookie'),'utf8'), 'do-not-copy');
  assert.equal(f.run('restore.mjs', f.common).status, 0);
});

test('restore refuses concurrent profile edits without partially restoring', t => {
  const f = fixture(t); assert.equal(f.run('install.mjs', f.common).status, 0);
  const pkg = readFileSync(join(f.profile,'package.json'),'utf8');
  put(join(f.profile,'pnpm-lock.yaml'), 'user modification\n');
  const r = f.run('restore.mjs', f.common);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /发生变化/);
  assert.equal(readFileSync(join(f.profile,'package.json'),'utf8'), pkg);
  assert.equal(readlinkSync(join(f.profile,'node_modules/dsh-keep-whale')), f.source);
});

test('legacy dedicated chat stays excluded while new messages in ordinary DeepSeek chats remain observable', t => {
  const f = fixture(t), result = f.run('install.mjs', [...f.common, '--observe']);
  assert.equal(result.status, 0, result.stderr);
  const root = join(f.home, 'dsh-keep-whale'), boot = JSON.parse(readFileSync(join(root, 'bootstrap.json'), 'utf8'));
  const store = new Store(root); t.after(() => store.close()); store.patchSettings(boot.settings);
  const service = new Service(store, { get: () => null, on: () => () => {}, inject: () => {} }, root);
  const userEvent = { type: 'user/message', seq: 1, time: Date.now() + 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '新消息' }] } };
  const assistantEvent = { type: 'assistant/message', seq: 2, time: Date.now() + 101, data: { message: { content: [{ type: 'text', text: 'DeepSeek 的回答' }] } } };
  service.observe({ id: 'session-old-companion', header: { cwd: '/workspace' } }, userEvent);
  service.observe({ id: 'session-old-companion', header: { cwd: '/workspace' } }, assistantEvent);
  service.observe({ id: 'session-ordinary', header: { cwd: '/workspace' } }, userEvent);
  service.observe({ id: 'session-ordinary', header: { cwd: '/workspace' } }, assistantEvent);
  assert.equal(store.sources().length, 1);
  assert.equal(store.sources()[0].sessionId, 'session-ordinary');
  assert.equal(store.sources()[0].context, 'DeepSeek 的回答');
});

test('active old process, unknown old YAML injection and ambiguous pricing fail before changes', t => {
  const f = fixture(t);
  put(join(f.home,'xiaoyu-companion/bili/host.lock'), String(process.pid));
  let r = f.run('install.mjs', f.common); assert.notEqual(r.status, 0); assert.match(r.stderr, /进程仍在运行/);
  rmSync(join(f.home,'xiaoyu-companion/bili/host.lock'));
  put(join(f.profile,'cordis.patch.yml'), '- id: xiaoyu-companion\n  disabled: false\n');
  r = f.run('install.mjs', f.common); assert.notEqual(r.status, 0); assert.match(r.stderr, /直接引用/);
  put(join(f.profile,'cordis.patch.yml'), '[]\n');
  put(join(f.home,'xiaoyu-companion/bili/billing.json'), '{"routes":[]}');
  r = f.run('install.mjs', [...f.common,'--tju']); assert.notEqual(r.status, 0); assert.match(r.stderr, /未找到唯一/);
  assert.equal(readFileSync(join(f.profile,'package.json'),'utf8'), f.oldPkg);
  assert.equal(readFileSync(join(f.profile,'pnpm-lock.yaml'),'utf8'), f.oldLock);
  assert.equal(existsSync(join(f.profile,'node_modules/dsh-keep-whale')), false);
});
