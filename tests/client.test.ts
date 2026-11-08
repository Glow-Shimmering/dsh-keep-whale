import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('client bundle registers the DSH panels without a global CommonJS require', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], {stdio: 'pipe'});
  const bundle = readFileSync('dist/client.js', 'utf8');
  let module: {id:string;factory:(require:(name:string)=>unknown)=>{inject:string[];apply:(ctx:unknown)=>void}} | undefined;
  runInNewContext(bundle, { window: { __ModuleLoader__: { load(value: typeof module) { module=value; } } }, Date, Math, Set });
  assert.equal(module?.id, 'dsh-keep-whale');
  const react = { createElement: () => null };
  const plugin = module!.factory((name: string) => { assert.equal(name,'react'); return react; });
  assert.ok(plugin.inject.includes('layout'), 'floating actions require the host layout service, not only the layout module dependency');
  const registrations: Array<{name:string;id?:string;key?:string}> = [];
  plugin.apply({ slots: {
    inject(name:string, callback:()=>void) { callback(); },
    register(meta: {name:string;id?:string;key?:string}) { registrations.push(meta); },
  }});
  assert.deepEqual(registrations.map(x=>[x.name,x.id || x.key]), [
    ['main','dsh-keep-whale'], ['sidebar.panellist','dsh-keep-whale'], ['shell.overlay','dsh-keep-whale'],
  ]);
});
