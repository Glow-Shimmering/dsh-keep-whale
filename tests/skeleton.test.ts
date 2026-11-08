import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('package identity and bundled entrypoints',()=>{const p=JSON.parse(readFileSync('package.json','utf8'));assert.equal(p.name,'dsh-keep-whale');assert.equal(p.dsh.bundle.patch,'./cordis.patch.yml');});
