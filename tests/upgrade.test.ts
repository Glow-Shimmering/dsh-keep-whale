import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
function fixture(t:any) {
  const temp=mkdtempSync(join(tmpdir(),'keep-whale-upgrade-')); t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const plugin=join(temp,'plugin'),home=join(temp,'home'),data=join(home,'dsh-keep-whale'),backup=join(temp,'snapshot');
  mkdirSync(join(plugin,'dist'),{recursive:true});mkdirSync(data,{recursive:true});
  writeFileSync(join(plugin,'package.json'),JSON.stringify({name:'dsh-keep-whale',version:'0.1.0'}));
  writeFileSync(join(plugin,'dist/index.js'),'old host');writeFileSync(join(plugin,'dist/client.js'),'old client');
  writeFileSync(join(data,'embedding-secret.json'),'private-key');mkdirSync(join(data,'media'));writeFileSync(join(data,'media/image'),'private-image');
  mkdirSync(join(home,'another-plugin'));writeFileSync(join(home,'another-plugin/data'),'untouched');
  const dbPath=join(data,'keep-whale.sqlite'), db=new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE meta(key TEXT PRIMARY KEY,data TEXT);INSERT INTO meta VALUES('entry','old');");
  let open=true; t.after(()=>{if(open)db.close();});
  const close=()=>{if(open){db.close();open=false;}};
  const args=['--plugin-dir',plugin,'--data-home',home,'--backup-dir',backup];
  const run=(script:string,extra:string[]=[])=>spawnSync(process.execPath,[join(root,'scripts',script),...args,...extra],{encoding:'utf8'});
  return {temp,plugin,home,data,backup,db,dbPath,close,args,run};
}
function get(path:string) {const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare("SELECT data FROM meta WHERE key='entry'").get()?.data;}finally{db.close();}}

test('backup captures committed WAL data without exporting secrets or unrelated plugins',t=>{
  const f=fixture(t);assert.ok(existsSync(f.dbPath+'-wal'));
  const result=f.run('backup-memory.mjs');assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout);assert.equal(out.status,'backed-up');assert.equal(get(join(f.backup,'keep-whale.sqlite')),'old');
  assert.equal(readFileSync(join(f.backup,'dist/client.js'),'utf8'),'old client');
  assert.deepEqual(readdirSync(f.backup).sort(),['dist','keep-whale.sqlite','manifest.json']);
  assert.equal(existsSync(join(f.backup,'embedding-secret.json')),false);assert.equal(readFileSync(join(f.home,'another-plugin/data'),'utf8'),'untouched');
});

test('rollback archives current database and build, restores snapshot and preserves media/secret',t=>{
  const f=fixture(t);assert.equal(f.run('backup-memory.mjs').status,0);
  f.db.exec("UPDATE meta SET data='new' WHERE key='entry'");f.close();
  writeFileSync(join(f.plugin,'dist/index.js'),'new host');writeFileSync(join(f.plugin,'dist/client.js'),'new client');
  const result=f.run('rollback-memory.mjs',['--confirm-stopped']);assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout);assert.equal(out.status,'restored');assert.equal(get(f.dbPath),'old');
  assert.equal(readFileSync(join(f.plugin,'dist/client.js'),'utf8'),'old client');
  assert.equal(get(join(out.archiveDir,'keep-whale.sqlite')),'new');assert.equal(readFileSync(join(out.archiveDir,'dist/client.js'),'utf8'),'new client');
  assert.equal(readFileSync(join(f.data,'embedding-secret.json'),'utf8'),'private-key');assert.equal(readFileSync(join(f.data,'media/image'),'utf8'),'private-image');
  assert.equal(readFileSync(join(f.home,'another-plugin/data'),'utf8'),'untouched');
});

test('active lock and missing confirmation reject restore before archiving or changing data',t=>{
  const f=fixture(t);assert.equal(f.run('backup-memory.mjs').status,0);f.db.exec("UPDATE meta SET data='new' WHERE key='entry'");f.close();
  let result=f.run('rollback-memory.mjs');assert.notEqual(result.status,0);assert.match(result.stderr,/confirm-stopped/);
  writeFileSync(join(f.data,'host.lock'),JSON.stringify({pid:process.pid,nonce:'live'}));
  result=f.run('rollback-memory.mjs',['--confirm-stopped']);assert.notEqual(result.status,0);assert.match(result.stderr,/仍在运行/);
  assert.equal(get(f.dbPath),'new');assert.equal(readdirSync(f.temp).some(n=>n.includes('pre-restore')),false);
  assert.equal(JSON.parse(readFileSync(join(f.data,'host.lock'),'utf8')).nonce,'live');
});

test('corrupt snapshot, nonempty destination and relative paths are rejected without changing data',t=>{
  const f=fixture(t);assert.equal(f.run('backup-memory.mjs').status,0);f.db.exec("UPDATE meta SET data='new' WHERE key='entry'");f.close();
  writeFileSync(join(f.backup,'dist/client.js'),'tampered');
  const invalid=f.run('rollback-memory.mjs',['--confirm-stopped']);assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/校验失败/);
  assert.equal(get(f.dbPath),'new');assert.equal(readFileSync(join(f.plugin,'dist/client.js'),'utf8'),'old client');
  assert.equal(readdirSync(f.temp).some(n=>n.includes('pre-restore')),false);
  const second=f.run('backup-memory.mjs');assert.notEqual(second.status,0);assert.match(second.stderr,/必须为空/);
  const relative=spawnSync(process.execPath,[join(root,'scripts/backup-memory.mjs'),'--plugin-dir',f.plugin,'--data-home',f.home,'--backup-dir','relative'],{encoding:'utf8'});
  assert.notEqual(relative.status,0);assert.match(relative.stderr,/绝对路径/);
});

test('legacy backup manifest is accepted and a dead host lock is safely replaced',t=>{
  const f=fixture(t);assert.equal(f.run('backup-memory.mjs').status,0);f.close();
  const oldSnapshot=new DatabaseSync(join(f.backup,'keep-whale.sqlite')); oldSnapshot.exec('PRAGMA journal_mode=WAL'); oldSnapshot.close();
  writeFileSync(join(f.backup,'manifest.json'),JSON.stringify({commit:'deadbeef',dataPath:f.dbPath,createdAt:'2026-11-09T00:00:00'}));
  writeFileSync(join(f.data,'host.lock'),JSON.stringify({pid:2147483647,nonce:'stale'}));
  const result=f.run('rollback-memory.mjs',['--confirm-stopped']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).legacy,true);
  assert.equal(existsSync(join(f.data,'host.lock')),false);
});

test('a failure after swapping the build restores both original build and database',t=>{
  const f=fixture(t);assert.equal(f.run('backup-memory.mjs').status,0);
  f.db.exec("UPDATE meta SET data='new' WHERE key='entry'");f.close();writeFileSync(join(f.plugin,'dist/client.js'),'new client');
  const rollback=pathToFileURL(join(root,'scripts/rollback-memory.mjs')).href;
  const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';\nconst rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(from).includes('.keep-whale-restore-')&&String(from).endsWith('.sqlite')&&String(to).endsWith('/keep-whale.sqlite'))throw Error('injected rename failure');return rename(from,to)};syncBuiltinESMExports();\nconst {rollbackMemory}=await import(${JSON.stringify(rollback)});try{await rollbackMemory({pluginDir:process.argv[1],dataHome:process.argv[2],backupDir:process.argv[3],confirmStopped:true});process.exitCode=2}catch(e){if(!String(e.message).includes('injected rename failure')){console.error(e);process.exitCode=3}}`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,f.plugin,f.home,f.backup],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(get(f.dbPath),'new');assert.equal(readFileSync(join(f.plugin,'dist/client.js'),'utf8'),'new client');
  assert.ok(readdirSync(f.temp).some(n=>n.includes('pre-restore')));
  assert.equal(existsSync(join(f.data,'host.lock')),false);
});

test('unmerged backup WAL is rejected without touching live data',t=>{
  const f=fixture(t);assert.equal(f.run('backup-memory.mjs').status,0);f.db.exec("UPDATE meta SET data='new' WHERE key='entry'");f.close();
  writeFileSync(join(f.backup,'keep-whale.sqlite-wal'),Buffer.from('unexpected content'));
  const r=f.run('rollback-memory.mjs',['--confirm-stopped']);assert.notEqual(r.status,0);assert.match(r.stderr,/未合并的 WAL/);
  assert.equal(get(f.dbPath),'new');assert.equal(readFileSync(join(f.plugin,'dist/client.js'),'utf8'),'old client');
});
