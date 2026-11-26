// Bundles the server and the workspace packages it imports (TypeScript
// source) into dist/. npm dependencies stay external and load from
// node_modules, so deploy the whole installed monorepo (npm ci at the root,
// npm run build, then node apps/server/dist/index.js).
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { cp, readFile, rm } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@trustphoto/'));

// A private photo checks module, when its folder is there (see src/checks/load.ts). Without it the server runs the reference checks.
const privateChecks = 'private/photo-checks/index.ts';
const hasPrivateChecks = existsSync(privateChecks);

await rm('dist', { recursive: true, force: true });
await build({
  // moderate.js is the operator tool, run on the server machine: node apps/server/dist/moderate.js reports
  entryPoints: {
    index: 'src/index.ts',
    moderate: 'scripts/moderate.ts',
    'backfill-features': 'scripts/backfill-features.ts',
    ...(hasPrivateChecks ? { 'photo-checks': privateChecks } : {}),
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [...external, '@bradford-tech/supabase-integrity-attest/*', 'js-sha256'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await cp('src/db/migrations', 'dist/migrations', { recursive: true });
console.log(`built dist/index.js, dist/moderate.js and dist/backfill-features.js (photo checks: ${hasPrivateChecks ? 'private module, dist/photo-checks.js' : 'reference'})`);
