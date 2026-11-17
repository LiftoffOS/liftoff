// Copy the generated JSON tool sets into dist/ after tsc.
//
// The generated tool sets ship as JSON DATA (src/catalog/generated/*.generated.json)
// and are read at runtime by native-hris-functions.ts via readFileSync. tsc excludes
// that dir (they're not code — an 8037-tool TS literal OOM'd CI), so tsc does NOT copy
// them to dist. The runtime image contains only dist/ (see Dockerfile), so without
// this step the runtime readFileSync would 404. Runs as part of `npm run build`.

const { mkdirSync, readdirSync, copyFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const src = join(__dirname, '..', 'src', 'catalog', 'generated');
const dst = join(__dirname, '..', 'dist', 'catalog', 'generated');

if (!existsSync(src)) {
  console.error('copy-generated-assets: no src/catalog/generated — nothing to copy');
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (f.endsWith('.json')) { copyFileSync(join(src, f), join(dst, f)); n += 1; }
}
console.error(`copy-generated-assets: copied ${n} JSON files → dist/catalog/generated`);
