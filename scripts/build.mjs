import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/**
 * Content scripts cannot be ES modules, so every entry is bundled to a
 * self-contained IIFE. The service worker could be a module, but keeping the
 * output format uniform means one less thing to get wrong in the manifest.
 */
const entries = {
  'interceptor.js': 'src/inject/interceptor.ts',
  'bridge.js': 'src/content/bridge.ts',
  'worker.js': 'src/bg/worker.ts',
  'popup.js': 'src/popup/popup.ts',
};

async function copyStatic() {
  await cp(resolve(root, 'public'), out, { recursive: true });
}

const options = Object.entries(entries).map(([outfile, entry]) => ({
  entryPoints: [resolve(root, entry)],
  outfile: resolve(out, outfile),
  bundle: true,
  format: 'iife',
  target: 'chrome111', // world: "MAIN" content scripts land in 111
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  define: { __DEV__: String(dev) },
}));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(options.map((o) => esbuild.context(o)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[fotstats] watching…  load unpacked from dist/');
} else {
  await Promise.all(options.map((o) => esbuild.build(o)));
  console.log(`[fotstats] built -> ${out}`);
}
