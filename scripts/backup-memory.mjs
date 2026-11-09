#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export const absolute = (value, name) => {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`);
  return resolve(value);
};
export const within = (value, root) => value === root || value.startsWith(root + sep);
const regular = (path, description) => {
  let stat; try { stat=lstatSync(path); } catch { throw new Error(`${description}不存在`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${description}必须是普通文件`);
  return stat;
};
export function ordinaryDirectory(path, description) {
  let stat; try { stat=lstatSync(path); } catch { throw new Error(`${description}不存在`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${description}必须是普通目录`);
  return realpathSync(path);
}
/** The archive includes the build only, with no symlink traversal. */
export function distFiles(root) {
  ordinaryDirectory(root, 'dist');
  const files = {};
  function walk(dir, prefix='') {
    for (const name of readdirSync(dir).sort()) {
      const path=join(dir,name), key=prefix ? `${prefix}/${name}` : name, st=lstatSync(path);
      if (st.isSymbolicLink()) throw new Error('dist 不允许包含符号链接');
      if (st.isDirectory()) walk(path,key);
      else if (st.isFile()) files[key]=digest(path);
      else throw new Error('dist 包含不能备份的特殊文件');
    }
  }
  walk(root);
  if (!files['index.js'] || !files['client.js'] || !statSync(join(root,'index.js')).size || !statSync(join(root,'client.js')).size) throw new Error('dist 缺少有效的宿主或客户端入口');
  return files;
}
export function copyDist(source, target) {
  const before=distFiles(source);
  mkdirSync(target,{recursive:false,mode:0o700});
  for (const key of Object.keys(before)) {
    const src=join(source,...key.split('/')), dest=join(target,...key.split('/'));
    mkdirSync(dirname(dest),{recursive:true,mode:0o700});
    copyFileSync(src,dest); chmodSync(dest,0o600);
  }
  const copied=distFiles(target), after=distFiles(source);
  if (JSON.stringify(before)!==JSON.stringify(after) || JSON.stringify(before)!==JSON.stringify(copied)) throw new Error('备份期间 dist 已变化，请重新备份');
  return copied;
}
export function verifyDatabase(path) {
  regular(path,'伙伴数据库');
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const result=db.prepare('PRAGMA integrity_check').all();
    if (result.length!==1 || Object.values(result[0])[0]!=='ok') throw new Error('数据库完整性检查失败');
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()) throw new Error('数据库不是有效的伙伴数据库');
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } finally { db.close(); }
}
export function locations(pluginArg=DEFAULT_PLUGIN, homeArg=process.env.DSH_HOME || join(homedir(),'.dsh')) {
  const plugin=ordinaryDirectory(absolute(pluginArg,'--plugin-dir'),'插件目录');
  const home=ordinaryDirectory(absolute(homeArg,'--data-home'),'DSH 数据目录');
  const data=ordinaryDirectory(join(home,'dsh-keep-whale'),'伙伴数据目录');
  const packageFile=join(plugin,'package.json'); regular(packageFile,'插件清单');
  const pkg=JSON.parse(readFileSync(packageFile,'utf8'));
  if (pkg.name!=='dsh-keep-whale') throw new Error('插件目录名称不匹配');
  return {plugin,home,data,dataPath:join(data,'keep-whale.sqlite'),dist:join(plugin,'dist'),pluginVersion:String(pkg.version || '')};
}
function destination(path,loc) {
  const target=absolute(path,'--backup-dir');
  const parent=ordinaryDirectory(dirname(target),'备份目录的上级目录');
  const resolved=join(parent,basename(target));
  if (within(loc.plugin,resolved) || within(loc.data,resolved) || within(resolved,loc.dist)) throw new Error('备份目录不能覆盖插件、数据目录或位于 dist 内');
  if (existsSync(resolved)) {
    ordinaryDirectory(resolved,'备份目录');
    if (readdirSync(resolved).length) throw new Error('备份目录必须为空');
  } else mkdirSync(resolved,{mode:0o700});
  return resolved;
}
export async function backupMemory({pluginDir=DEFAULT_PLUGIN,dataHome=process.env.DSH_HOME || join(homedir(),'.dsh'),backupDir}) {
  const loc=locations(pluginDir,dataHome), dest=destination(backupDir,loc);
  regular(loc.dataPath,'伙伴数据库');
  const files=copyDist(loc.dist,join(dest,'dist'));
  const db=new DatabaseSync(loc.dataPath,{readOnly:true});
  try { await backup(db,join(dest,'keep-whale.sqlite')); } finally { db.close(); }
  chmodSync(join(dest,'keep-whale.sqlite'),0o600);
  // Make the independent snapshot self-contained; this does not touch the live WAL.
  const snapshotDb=new DatabaseSync(join(dest,'keep-whale.sqlite'));
  try { snapshotDb.exec('PRAGMA journal_mode=DELETE'); } finally { snapshotDb.close(); }
  const databaseVersion=verifyDatabase(join(dest,'keep-whale.sqlite'));
  const commit=spawnSync('git',['-C',loc.plugin,'rev-parse','HEAD'],{encoding:'utf8'});
  const manifest={format:'dsh-keep-whale-memory-backup',version:1,createdAt:new Date().toISOString(),pluginDir:loc.plugin,dataPath:loc.dataPath,pluginVersion:loc.pluginVersion,databaseVersion,commit:commit.status===0?commit.stdout.trim():null,files:{database:digest(join(dest,'keep-whale.sqlite')),dist:files}};
  writeFileSync(join(dest,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  return {status:'backed-up',backupDir:dest,manifest};
}
export function verifyBackup(path,loc) {
  const directory=ordinaryDirectory(absolute(path,'--backup-dir'),'备份目录');
  const manifestPath=join(directory,'manifest.json');regular(manifestPath,'备份清单');
  let manifest;try {manifest=JSON.parse(readFileSync(manifestPath,'utf8'));} catch {throw new Error('备份清单无效');}
  let sameDataPath=false;
  if(manifest && typeof manifest==='object' && typeof manifest.dataPath==='string' && isAbsolute(manifest.dataPath)) {
    sameDataPath=resolve(manifest.dataPath)===loc.dataPath;
    if(!sameDataPath)try{sameDataPath=realpathSync(manifest.dataPath)===realpathSync(loc.dataPath);}catch{/* Missing or inaccessible paths do not match. */}
  }
  if(!sameDataPath) throw new Error('备份数据路径与当前伙伴不匹配');
  const legacy=manifest.format===undefined && typeof manifest.commit==='string' && typeof manifest.createdAt==='string';
  if (!legacy && (manifest.format!=='dsh-keep-whale-memory-backup' || manifest.version!==1 || manifest.pluginDir!==loc.plugin)) throw new Error('备份格式、版本或插件路径不匹配');
  const db=join(directory,'keep-whale.sqlite'), dist=join(directory,'dist');
  // A nonempty sidecar changes database contents without changing the main-file
  // checksum; require a self-contained snapshot instead of silently dropping it.
  if(existsSync(db+'-wal') && statSync(db+'-wal').size>0)throw new Error('备份数据库存在未合并的 WAL，无法安全验证');
  const databaseVersion=verifyDatabase(db), files=distFiles(dist);
  if (!legacy && (!manifest.files || typeof manifest.files.database!=='string' || manifest.files.database!==digest(db) || JSON.stringify(manifest.files.dist)!==JSON.stringify(files) || manifest.databaseVersion!==databaseVersion)) throw new Error('备份文件校验失败');
  return {directory,db,dist,manifest,legacy};
}
export function parseArgs(argv,{restore=false}={}) {
  const opts={};
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if (restore && flag==='--confirm-stopped') {if(opts[flag])throw new Error('重复参数 --confirm-stopped');opts[flag]=true;continue;}
    if(!['--plugin-dir','--data-home','--backup-dir',...(restore?['--archive-dir']:[])].includes(flag) || opts[flag]!==undefined || !argv[i+1] || argv[i+1].startsWith('--'))throw new Error(`无效或重复参数：${flag}`);
    opts[flag]=argv[++i];
  }
  if(!opts['--backup-dir'])throw new Error('需要 --backup-dir 绝对路径');
  for(const [k,v] of Object.entries(opts)) if(typeof v==='string')absolute(v,k);
  return opts;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {const args=parseArgs(process.argv.slice(2));const result=await backupMemory({pluginDir:args['--plugin-dir'],dataHome:args['--data-home'],backupDir:args['--backup-dir']});console.log(JSON.stringify(result,null,2));}
  catch(e){console.error(`备份未完成：${e.message}`);process.exitCode=1;}
}
