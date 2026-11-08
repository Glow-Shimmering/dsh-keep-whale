#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'dsh-keep-whale';
const OLD = new Set(['dsh-feed-the-seek', 'dsh-xiaoyu-companion']);
const OLD_MARK = /(?:^|[\s'"\[\],:-])(?:dsh-feed-the-seek|feed-the-seek|dsh-xiaoyu-companion|xiaoyu-companion)(?=$|[\s'"\],#])/i;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const privateFile = (path, data) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, data, { mode: 0o600, flag: 'wx' }); };
const hashFile = path => existsSync(path) ? sha(readFileSync(path)) : null;
const isInside = (candidate, root) => candidate === root || candidate.startsWith(root + sep);
const absolute = (value, key) => { if (!value || !isAbsolute(value)) throw Error(`${key} 必须是绝对路径`); return resolve(value); };
function atomicWrite(path, data, mode = 0o600) {
  const tmp = `${path}.keep-whale-${randomUUID()}.tmp`;
  try { writeFileSync(tmp, data, { mode, flag: 'wx' }); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--tju', '--observe', '--confirm-stopped'].includes(flag)) { if (options[flag]) throw Error(`重复参数 ${flag}`); options[flag] = true; continue; }
    if (!['--profile', '--data-home', '--backup-dir', '--source', '--name'].includes(flag) || options[flag] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`无效或重复参数：${flag}`);
    options[flag] = argv[++i];
  }
  return options;
}
function pidIsLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw Error('无法确认旧插件进程是否结束，请检查后重试'); }
}
function assertStopped(dataHome, confirmed) {
  if (!confirmed) throw Error('请先完整退出 DSH，再传入 --confirm-stopped；运行中切换插件可能造成重复任务或写入');
  const lock = join(dataHome, 'xiaoyu-companion', 'bili', 'host.lock');
  if (!existsSync(lock)) return;
  const value = readFileSync(lock, 'utf8').trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(+value) || +value <= 0) throw Error('旧插件进程锁格式不明，请先确认 DSH 已退出；未更改任何文件');
  if (pidIsLive(+value)) throw Error('旧插件进程仍在运行，请先完整退出 DSH；未更改任何文件');
}
function rejectDirectLegacy(profile) {
  // Removing the two bundle entries disables their injected ids. Extra direct
  // YAML insertions can use arbitrary aliases and must not silently survive.
  for (const file of ['cordis.yml', 'cordis.yaml', 'cordis.patch.yml', 'patch.yml']) {
    const path = join(profile, file); if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim(); if (!line || line.startsWith('#')) continue;
      if (OLD_MARK.test(line)) throw Error(`${file}:${i + 1} 还含旧插件的直接引用；无法安全自动判断 YAML 别名，请先手动核对并停用`);
    }
  }
}
function patchLock(source, profile, text) {
  const lineEnd = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (!/^lockfileVersion:\s*['"]?9(?:\.0)?['"]?\s*$/.test(lines[0])) throw Error('只支持可核实的 pnpm 9 锁文件；其他格式请先使用包管理器安装');
  const index = lines.findIndex(x => /^importers:\s*$/.test(x));
  const roots = lines.map((x, i) => /^  (?:\.|['"]\.['"]):\s*$/.test(x) && i > index ? i : -1).filter(i => i >= 0);
  if (index < 0 || roots.length !== 1) throw Error('无法唯一识别 pnpm 根 importer，未修改锁文件');
  const root = roots[0]; let end = root + 1;
  while (end < lines.length && (!lines[end].trim() || !/^\S|^  \S/.test(lines[end]))) end++;
  let dep = -1;
  for (let i = root + 1; i < end; i++) if (/^    dependencies:\s*$/.test(lines[i])) { if (dep !== -1) throw Error('pnpm dependencies 有重复段'); dep = i; }
  if (lines.slice(root, end).some(x => /^      ['"]?dsh-keep-whale['"]?:\s*$/.test(x))) throw Error('pnpm 锁中已有同名条目，请人工核查');
  const spec = 'link:' + source.split(sep).join('/');
  const rel = relative(profile, source).split(sep).join('/') || '.';
  const entry = ['      dsh-keep-whale:', `        specifier: ${JSON.stringify(spec)}`, `        version: ${JSON.stringify('link:' + rel)}`];
  if (dep < 0) lines.splice(root + 1, 0, '    dependencies:', ...entry);
  else {
    let insert = dep + 1;
    while (insert < end && (!lines[insert].trim() || !/^    \S/.test(lines[insert]))) insert++;
    // Keep trailing blank lines separating the importer sections.
    while (insert > dep + 1 && !lines[insert - 1].trim()) insert--;
    lines.splice(insert, 0, ...entry);
  }
  return lines.join(lineEnd);
}
function bootstrap(dataHome, options) {
  const result = { settings: {} };
  const statePath = join(dataHome, 'xiaoyu-companion', 'state.json');
  if (existsSync(statePath)) {
    const old = JSON.parse(readFileSync(statePath, 'utf8'));
    if (old.version !== 1 || !old.companions || typeof old.companions !== 'object' || Array.isArray(old.companions)) throw Error('旧小余会话绑定格式不明，请先人工核对，避免意外旁观旧会话');
    const bindings = Object.entries(old.companions).flatMap(([persona, entry]) => {
      if (!entry || typeof entry !== 'object' || entry.sessionId == null) return [];
      if (typeof entry.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(entry.sessionId)) throw Error('旧小余会话标识无效，请先人工核对');
      return [{ persona, sessionId: entry.sessionId }];
    });
    if (bindings.length > 2000) throw Error('旧伙伴会话数量超出可安全导入的排除范围，请先人工核对');
    const dbPath = join(dataHome, 'feed-the-seek', 'memory.sqlite');
    if (existsSync(dbPath) && bindings.length) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        // Feed binds ordinary DeepSeek sessions to personas too. Cross-check
        // only explicitly dedicated companion sessions; never bulk-exclude
        // every persona binding or copy any memory/content from this database.
        const get = db.prepare('SELECT value FROM meta WHERE key=?');
        for (const item of bindings) {
          const row = get.get('persona:session:' + item.sessionId);
          if (!row) continue; // Explicit old binding is still excluded safely.
          let value; try { value = JSON.parse(String(row.value)); } catch { throw Error('旧伙伴会话元数据无法解析，请先人工核对'); }
          if (value != null && value !== item.persona) throw Error('旧伙伴会话绑定出现冲突，请先人工核对');
        }
      } finally { db.close(); }
    }
    if (bindings.length) result.settings.excludedSessions = [...new Set(bindings.map(b => b.sessionId))];
  }
  if (options['--name'] !== undefined) {
    const name = options['--name'].trim(); if (!name || name.length > 32) throw Error('伙伴名须为 1–32 个字符'); result.name = name;
  }
  if (options['--observe']) result.settings.observeEnabled = true;
  if (options['--tju']) {
    const billing = JSON.parse(readFileSync(join(dataHome, 'xiaoyu-companion', 'bili', 'billing.json'), 'utf8'));
    const routes = (billing.routes || []).filter(r => r.provider === 'tju' && r.model === 'DeepSeek-V4.1-Flash');
    if (routes.length !== 1) throw Error('未找到唯一的 tju 精确计费线路，未写入或猜测价格');
    const r = routes[0];
    if (r.unit !== 'points' || r.input !== 30 || r.cached !== 0.6 || r.output !== 120 || r.pointsPerYuan !== 30) throw Error('tju 现有费率与已确认信息不同，请先核对；未写入价格');
    const route = { provider: r.provider, model: r.model };
    Object.assign(result.settings, { model: route, priceRoute: route, prices: { input: r.input, cached: r.cached, output: r.output }, unit: '积分', dailyLimit: 100, pointsPerYuan: 30 });
  }
  return result;
}
function legacyFiles(root, rel = '') {
  const path = join(root, rel); if (!existsSync(path)) return [];
  const st = lstatSync(path); if (st.isSymbolicLink()) throw Error(`旧数据中存在符号链接，需人工核查：${path}`);
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) throw Error(`旧数据包含特殊文件，需人工核查：${path}`);
  return readdirSync(path).flatMap(name => {
    const child = join(rel, name);
    if (child === 'bili/accounts' || /(?:^|\/)host\.lock$/.test(child)) return [];
    return legacyFiles(root, child);
  });
}
async function snapshotLegacy(dataHome, dir) {
  const oldDir = join(dataHome, 'xiaoyu-companion');
  for (const f of legacyFiles(oldDir)) {
    const from = join(oldDir, f), to = join(dir, 'legacy', 'xiaoyu-companion', f);
    privateFile(to, readFileSync(from));
  }
  const dbPath = join(dataHome, 'feed-the-seek', 'memory.sqlite');
  if (existsSync(dbPath)) {
    const destination = join(dir, 'legacy', 'feed-the-seek', 'memory.sqlite');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { await backup(db, destination); } finally { db.close(); }
    chmodSync(destination, 0o600);
    // SQLite's online backup includes committed WAL data; no source checkpoint.
  }
}
function parseManifest(dir) {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw Error('备份目录没有安装清单，不能恢复');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  if (m.version !== 1 || m.kind !== NAME || !Array.isArray(m.changed) || !['prepared', 'installed', 'restored'].includes(m.status)) throw Error('安装清单不兼容');
  return m;
}
function assertCurrent(path, expected, label) {
  if (hashFile(path) !== expected) throw Error(`${label} 在安装后发生变化；为避免覆盖后续修改已停止，请先人工核对`);
}
function symlinkMatches(link, source) {
  try { return lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(source); } catch { return false; }
}
export async function install(raw) {
  const o = Array.isArray(raw) ? parseArgs(raw) : raw;
  const profile = absolute(o['--profile'], '--profile');
  const dataHome = absolute(o['--data-home'], '--data-home');
  const dir = absolute(o['--backup-dir'], '--backup-dir');
  const source = absolute(o['--source'] || ROOT, '--source');
  for (const [key, path] of [['profile',profile], ['data-home',dataHome], ['source',source]]) if (!existsSync(path) || !statSync(path).isDirectory()) throw Error(`${key} 目录不存在`);
  const realProfile = realpathSync(profile), realData = realpathSync(dataHome), realSource = realpathSync(source);
  const parent = realpathSync(dirname(dir)); const safeDir = join(parent, dir.slice(dirname(dir).length + 1));
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw Error('备份目录不能是符号链接');
  if ([realProfile, realData, realSource].some(root => isInside(safeDir, root) || isInside(root, safeDir))) throw Error('备份目录必须与 profile、数据目录和源码目录分离，避免递归或提交敏感数据');
  assertStopped(dataHome, o['--confirm-stopped']);
  const manifestPath = join(dir, 'manifest.json');
  const link = join(profile, 'node_modules', NAME);
  if (existsSync(manifestPath)) {
    const m = parseManifest(dir);
    if (m.status !== 'installed' || m.profile !== profile || m.dataHome !== dataHome || m.source !== source) throw Error('此备份目录属于其他安装或未完成操作');
    for (const f of m.changed) assertCurrent(join(profile, f.path), f.after, f.path);
    if (!symlinkMatches(link, source)) throw Error('插件链接已变化，请先人工核对');
    if (sha(JSON.stringify(bootstrap(dataHome, o), null, 2) + '\n') !== m.bootstrapHash) throw Error('此安装已完成，参数与原初始化不同；请在插件设置中更改，避免重置数据');
    return { status: 'already-installed', backupDir: dir };
  }
  if (existsSync(dir) && readdirSync(dir).length) throw Error('备份目录不是空目录，拒绝覆盖已有文件');
  rejectDirectLegacy(profile);
  const pkgPath = join(profile, 'package.json'), lockPath = join(profile, 'pnpm-lock.yaml');
  if (!existsSync(pkgPath) || !existsSync(lockPath) || !existsSync(join(profile, 'node_modules'))) throw Error('profile 缺少 package.json、pnpm-lock.yaml 或 node_modules，不能安全安装');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bundles = pkg.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.every(x => typeof x === 'string')) throw Error('无法识别 DSH bundle 列表');
  if (bundles.some(x => !OLD.has(x) && OLD_MARK.test(' ' + x + ' '))) throw Error('发现旧插件的非标准 bundle 别名，请先人工核查');
  if (bundles.includes(NAME) || pkg.dependencies?.[NAME] || existsSync(link) || (() => { try { lstatSync(link); return true; } catch { return false; } })()) throw Error('已存在同名插件配置或链接，请先核查，未覆盖');
  const plugin = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (plugin.name !== NAME || !existsSync(join(source, 'dist', 'index.js')) || !existsSync(join(source, 'dist', 'client.js')) || !existsSync(join(source, 'cordis.patch.yml'))) throw Error('源码名称不匹配或构建产物不完整，请先运行构建');
  const dataDir = join(dataHome, NAME), bootstrapPath = join(dataDir, 'bootstrap.json');
  if (existsSync(dataDir) && lstatSync(dataDir).isSymbolicLink()) throw Error('新插件的数据目录不能是符号链接');
  if (existsSync(dataDir) && readdirSync(dataDir).length) throw Error('新插件的数据目录已有内容；为防止覆盖伙伴资料，停止安装');
  const initial = JSON.stringify(bootstrap(dataHome, o), null, 2) + '\n';
  const beforePkg = readFileSync(pkgPath), beforeLock = readFileSync(lockPath);
  const spec = 'link:' + source.split(sep).join('/');
  pkg.dependencies ||= {}; pkg.dependencies[NAME] = spec;
  pkg.dsh.profile.bundles = [...bundles.filter(x => !OLD.has(x)), NAME];
  const newPkg = JSON.stringify(pkg, null, 2) + '\n', newLock = patchLock(source, profile, beforeLock.toString('utf8'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const copied = [];
  for (const f of ['cordis.yml','cordis.yaml','cordis.patch.yml','patch.yml','package.json','package-lock.json','pnpm-lock.yaml','pnpm-workspace.yaml']) {
    const p = join(profile, f); if (!existsSync(p)) continue;
    const bytes = readFileSync(p); privateFile(join(dir, 'profile', f), bytes); copied.push({ path: f, sha256: sha(bytes), mode: statSync(p).mode & 0o777 });
  }
  await snapshotLegacy(dataHome, dir);
  const changed = [{ path: 'package.json', before: sha(beforePkg), after: sha(newPkg), mode: statSync(pkgPath).mode & 0o777 }, { path: 'pnpm-lock.yaml', before: sha(beforeLock), after: sha(newLock), mode: statSync(lockPath).mode & 0o777 }];
  const m = { version: 1, kind: NAME, status: 'prepared', createdAt: new Date().toISOString(), profile, dataHome, source, copied, changed, link, bootstrap: bootstrapPath, bootstrapHash: sha(initial), oldBundles: bundles.filter(x => OLD.has(x)), legacyAccountsCopied: false };
  privateFile(manifestPath, JSON.stringify(m, null, 2) + '\n');
  const wrote = [];
  try {
    for (const item of changed) assertCurrent(join(profile, item.path), item.before, item.path);
    if (existsSync(link)) throw Error('插件链接在备份时出现，请重试');
    atomicWrite(pkgPath, newPkg, changed[0].mode); wrote.push(changed[0]);
    atomicWrite(lockPath, newLock, changed[1].mode); wrote.push(changed[1]);
    symlinkSync(source, link, 'dir');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    privateFile(bootstrapPath, initial);
    m.status = 'installed'; atomicWrite(manifestPath, JSON.stringify(m, null, 2) + '\n');
    return { status: 'installed', backupDir: dir, disabledBundles: m.oldBundles, bootstrap: bootstrapPath };
  } catch (error) {
    if (symlinkMatches(link, source)) rmSync(link);
    if (hashFile(bootstrapPath) === m.bootstrapHash) rmSync(bootstrapPath);
    for (const item of wrote.reverse()) {
      if (hashFile(join(profile, item.path)) !== item.after) throw Error(`安装中断且 ${item.path} 已被其他进程修改；保留备份并请人工恢复：${dir}`, { cause: error });
      atomicWrite(join(profile, item.path), readFileSync(join(dir, 'profile', item.path)), item.mode);
    }
    throw error;
  }
}

export function restore(raw) {
  const o = Array.isArray(raw) ? parseArgs(raw) : raw;
  const dir = absolute(o['--backup-dir'], '--backup-dir'), m = parseManifest(dir);
  if (absolute(o['--profile'], '--profile') !== m.profile) throw Error('指定 profile 与备份不匹配');
  if (absolute(o['--data-home'], '--data-home') !== m.dataHome) throw Error('指定数据目录与备份不匹配');
  if (m.status === 'restored') return { status: 'already-restored', backupDir: dir };
  if (m.status !== 'installed') throw Error('安装未完成，不能自动恢复；请检查备份清单');
  assertStopped(m.dataHome, o['--confirm-stopped']);
  // Preflight every path before the first mutation; never clobber later edits.
  for (const item of m.changed) {
    if (!['package.json','pnpm-lock.yaml'].includes(item.path)) throw Error('安装清单含未知目标');
    assertCurrent(join(m.profile, item.path), item.after, item.path);
    assertCurrent(join(dir, 'profile', item.path), item.before, `备份 ${item.path}`);
  }
  if (m.link !== join(m.profile, 'node_modules', NAME) || !symlinkMatches(m.link, m.source)) throw Error('插件链接已变化，不能自动恢复');
  const current = new Map(m.changed.map(item => [item.path, readFileSync(join(m.profile, item.path))]));
  const written = []; let removedLink = false;
  try {
    for (const item of m.changed) {
      assertCurrent(join(m.profile, item.path), item.after, item.path);
      atomicWrite(join(m.profile, item.path), readFileSync(join(dir, 'profile', item.path)), item.mode);
      written.push(item);
    }
    if (!symlinkMatches(m.link, m.source)) throw Error('插件链接在恢复时发生变化');
    rmSync(m.link); removedLink = true;
    // The new plugin's data and old data remain in place. Never restore over a DB.
    m.status = 'restored'; m.restoredAt = new Date().toISOString(); atomicWrite(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  } catch (error) {
    if (removedLink) {
      try { lstatSync(m.link); throw Error('插件链接位置在恢复期间被占用'); }
      catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
      symlinkSync(m.source, m.link, 'dir');
    }
    for (const item of written.reverse()) {
      if (hashFile(join(m.profile, item.path)) !== item.before) throw Error(`恢复中断且 ${item.path} 已被其他进程修改；保留备份并请人工处理：${dir}`, { cause: error });
      atomicWrite(join(m.profile, item.path), current.get(item.path), item.mode);
    }
    throw error;
  }
  return { status: 'restored', backupDir: dir, retainedNewData: true, retainedLegacyData: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await install(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`安装未完成：${error.message}`); process.exitCode = 1; }
}
