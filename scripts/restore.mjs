#!/usr/bin/env node
import { restore } from './install.mjs';
try { console.log(JSON.stringify(restore(process.argv.slice(2)), null, 2)); }
catch (error) { console.error(`恢复未完成：${error.message}`); process.exitCode = 1; }
