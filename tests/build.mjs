// Bundles every Netlify function into ./out with the blobs store mocked.
import * as esbuild from 'esbuild';
import fs from 'fs';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const mock = new URL('./blobs-mock.mjs', import.meta.url).pathname;
const entries = fs.readdirSync(`${root}/netlify/functions`).filter((f) => f.endsWith('.mts'));
await esbuild.build({
  entryPoints: entries.map((f) => `${root}/netlify/functions/${f}`),
  outdir: new URL('./.out', import.meta.url).pathname,
  bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  nodePaths: [`${root}/node_modules`],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  plugins: [{ name: 'blobs', setup(b) { b.onResolve({ filter: /^@netlify\/blobs$/ }, () => ({ path: mock, external: true })); } }],
  logLevel: 'error',
});
console.log('built', entries.length, 'functions');
