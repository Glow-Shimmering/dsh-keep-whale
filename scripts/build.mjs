import { build } from 'esbuild';
await build({entryPoints:['src/index.ts'],outfile:'dist/index.js',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
await build({entryPoints:['src/client/index.tsx'],outfile:'dist/client.js',bundle:true,platform:'browser',format:'iife',jsx:'transform',tsconfigRaw:{compilerOptions:{jsx:'react'}},target:'es2022',external:['react','react/jsx-runtime'],loader:{'.css':'text'}});
