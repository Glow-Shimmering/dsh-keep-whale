#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { absolute, backupMemory, copyDist, locations, ordinaryDirectory, parseArgs, verifyBackup, verifyDatabase, within } from './backup-memory.mjs';

/** Reserve the plugin's own host lock, preventing a new host from starting during recovery. */
function acquireStoppedLock(dataRoot,confirmed) {
  if(!confirmed)throw new Error('请先完全退出 DSH，并传入 --confirm-stopped');
  const lock=join(dataRoot,'host.lock'), nonce=randomUUID();
  for(let i=0;i<2;i++) {
    try {
      writeFileSync(lock,JSON.stringify({pid:process.pid,nonce,purpose:'restore'}),{flag:'wx',mode:0o600});
      return ()=>{try{const saved=JSON.parse(readFileSync(lock,'utf8'));if(saved.pid===process.pid&&saved.nonce===nonce)unlinkSync(lock);}catch{/* never unlink another owner's lock */}};
    } catch(e) {
      if(e.code!=='EEXIST')throw e;
      const st=lstatSync(lock); if(!st.isFile()||st.isSymbolicLink())throw new Error('伙伴运行锁不是普通文件，无法安全恢复');
      let value;try{value=JSON.parse(readFileSync(lock,'utf8'));}catch{throw new Error('伙伴运行锁格式无效，无法确认是否停止');}
      const pid=value?.pid;if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('伙伴运行锁 PID 无效，无法确认是否停止');
      try{process.kill(pid,0);throw new Error('伙伴进程仍在运行，不能恢复');}
      catch(error){if(error.code!=='ESRCH')throw error;}
      // A dead host's lock is explicitly recoverable by the plugin too. If a new
      // host races us, exclusive creation below fails instead of overwriting it.
      unlinkSync(lock);
    }
  }
  throw new Error('无法取得伙伴运行锁，请确认 DSH 已停止');
}
export async function rollbackMemory({pluginDir,dataHome,backupDir,archiveDir,confirmStopped=false}) {
  const loc=locations(pluginDir,dataHome);
  const source=verifyBackup(backupDir,loc); // Validate the entire snapshot before touching live data.
  if(!confirmStopped)throw new Error('请先完全退出 DSH，并传入 --confirm-stopped');
  const requestedArchive=archiveDir ? absolute(archiveDir,'--archive-dir') : join(dirname(source.directory),`${basename(source.directory)}-pre-restore-${randomUUID()}`);
  const archive=join(ordinaryDirectory(dirname(requestedArchive),'归档目录的上级目录'),basename(requestedArchive));
  if(within(archive,source.directory)||within(source.directory,archive))throw new Error('恢复前归档不能位于快照内或覆盖快照');
  const unlock=acquireStoppedLock(loc.data,true);
  const nonce=randomUUID(), stageDist=join(loc.plugin,`.keep-whale-restore-${nonce}`), stageDb=join(loc.data,`.keep-whale-restore-${nonce}.sqlite`);
  const oldDist=join(loc.plugin,`.keep-whale-before-${nonce}`), oldDb=join(loc.data,`.keep-whale-before-${nonce}.sqlite`);
  const moves=[]; let installedDb=false;
  const move=(from,to)=>{if(existsSync(to))throw new Error('恢复暂存路径已存在');renameSync(from,to);moves.push({from,to});};
  try {
    // A full, consistent archive of current state is mandatory before replacements.
    const saved=await backupMemory({pluginDir:loc.plugin,dataHome:loc.home,backupDir:archive});
    copyDist(source.dist,stageDist);
    copyFileSync(source.db,stageDb); chmodSync(stageDb,0o600); verifyDatabase(stageDb);
    // Revalidate after staging, so concurrent edits to the snapshot are detected.
    verifyBackup(source.directory,loc);
    move(loc.dist,oldDist); move(stageDist,loc.dist);
    for(const suffix of ['-wal','-shm']) {
      const side=loc.dataPath+suffix;
      if(existsSync(side)) {
        const st=lstatSync(side); if(!st.isFile()||st.isSymbolicLink())throw new Error('数据库附属文件不是普通文件');
        move(side,oldDb+suffix);
      }
    }
    move(loc.dataPath,oldDb); move(stageDb,loc.dataPath); installedDb=true;
    verifyDatabase(loc.dataPath);
    // Old files are retained in the verified archive; remove transient copies.
    const retained=[];
    try {rmSync(oldDist,{recursive:true,force:true});} catch {retained.push(oldDist);}
    for(const suffix of ['','-wal','-shm'])try{rmSync(oldDb+suffix,{force:true});}catch{retained.push(oldDb+suffix);}
    return {status:'restored',backupDir:source.directory,archiveDir:saved.backupDir,legacy:source.legacy,...(retained.length?{retained}: {})};
  } catch(error) {
    const failures=[];
    if(installedDb)for(const suffix of ['-wal','-shm']) {try{rmSync(loc.dataPath+suffix,{force:true});}catch(e){failures.push(e.message);}}
    for(const {from,to} of moves.reverse())try{if(existsSync(to)){if(existsSync(from))throw new Error(`原路径已存在：${from}`);renameSync(to,from);}}catch(e){failures.push(e.message);}
    if(failures.length)throw new Error(`恢复未完成且自动回滚不完整；请保留恢复前归档 ${archive} 并人工核查：${failures.join('；')}`,{cause:error});
    throw error;
  } finally {
    // Only our own staging paths are cleaned; the verified pre-restore archive stays.
    try{rmSync(stageDist,{recursive:true,force:true});}catch{}
    for(const suffix of ['','-wal','-shm'])try{rmSync(stageDb+suffix,{force:true});}catch{}
    unlock();
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {const args=parseArgs(process.argv.slice(2),{restore:true});const result=await rollbackMemory({pluginDir:args['--plugin-dir'],dataHome:args['--data-home'],backupDir:args['--backup-dir'],archiveDir:args['--archive-dir'],confirmStopped:args['--confirm-stopped']===true});console.log(JSON.stringify(result,null,2));}
  catch(e){console.error(`恢复未完成：${e.message}`);process.exitCode=1;}
}
