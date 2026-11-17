#!/usr/bin/env node
/**
 * Fail fast when the INSTALLED dependency tree does not describe THIS checkout.
 *
 * The hazard is Node's module resolution, which walks UP the directory tree. A
 * git worktree can live inside the repository, so
 * a worktree whose own `node_modules` is missing or empty silently resolves
 * every import — and every binary on `node_modules/.bin` — to the PARENT
 * checkout's tree instead. Nothing announces this.
 *
 * What that costs is the verification itself. `npm ci` failing (an expired
 * Artifact Registry token returns 403 and leaves the directory empty) is loud,
 * but the `npm run typecheck` and `npm run lint` that follow are not: they find
 * the parent's TypeScript and ESLint, compile against the parent's dependency
 * versions, and PASS. The branch then looks verified when nothing in it was
 * checked against its own manifest. That happened, and the only reason it was
 * caught is that someone counted the installed packages afterwards.
 *
 * So this check reads `<this checkout>/node_modules/<pkg>/package.json` by
 * EXPLICIT path rather than through `require.resolve`. An explicit path cannot
 * walk up, which is the whole point: the parent's copy is invisible to it, and
 * an empty tree reports every direct dependency as missing instead of quietly
 * borrowing one.
 *
 * Deliberately conservative — it compares only the DIRECT dependencies this
 * package.json declares against the versions this lockfile resolved, so it
 * cannot fail on transitive-tree or platform-optional differences. Files only:
 * no network, no install, a few milliseconds.
 *
 * Escape hatch: SKIP_DEP_INTEGRITY=1, for a bisect or similar. A green run
 * under it proves nothing about the dependency tree.
 *
 * `.cjs` because this package is `"type": "module"` and the check has to run
 * before anything is installed, so it cannot depend on a loader or a transform.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

if (process.env.SKIP_DEP_INTEGRITY === '1') process.exit(0);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const pkg = readJson(path.join(root, 'package.json'));
const lock = readJson(path.join(root, 'package-lock.json'));

// No lockfile or no manifest is not this check's problem to diagnose.
if (!pkg || !lock || !lock.packages) process.exit(0);

const prodNames = new Set(Object.keys(pkg.dependencies || {}));
const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const missing = [];
const mismatches = [];

for (const name of Object.keys(direct)) {
  const lockEntry = lock.packages[`node_modules/${name}`];
  if (!lockEntry || lockEntry.link || !lockEntry.version) continue;

  // EXPLICIT path. require.resolve would find the parent checkout's copy and
  // report everything as fine, which is the failure this exists to catch.
  const installed = readJson(path.join(root, 'node_modules', name, 'package.json'));
  if (!installed) {
    // Optional and platform-specific packages legitimately go uninstalled.
    if (!lockEntry.optional) missing.push(name);
    continue;
  }
  if (installed.version !== lockEntry.version) {
    mismatches.push({ name, expected: lockEntry.version, installed: installed.version });
  }
}

// A production install (`npm ci --omit=dev`, as the migrate image does) leaves
// every devDependency absent and every dependency present. That is a correct
// tree for what it is, not a broken one, so it passes — otherwise adding a
// gated script to a production image would fail for the wrong reason.
const missingProd = missing.filter((n) => prodNames.has(n));
const productionInstall =
  missing.length > 0 && missingProd.length === 0 && mismatches.length === 0;

if ((missing.length === 0 && mismatches.length === 0) || productionInstall) process.exit(0);

const out = [];
out.push('');
out.push('  The installed dependencies do not describe this checkout.');
out.push('');
for (const name of missing) out.push(`  ${name}: required by this lockfile, not installed`);
for (const m of mismatches) {
  out.push(`  ${m.name}: lockfile wants ${m.expected}, installed is ${m.installed}`);
}
out.push('');
out.push('  Anything you run against this tree — tests, typecheck, lint, build —');
out.push('  is verifying the wrong code, or the parent checkout\'s copy of it.');
out.push('');
out.push('  Fix: give this checkout its own dependency tree.');
out.push('');
out.push('    npm ci');
out.push('');
out.push('  On a 403 from Artifact Registry the token has expired:');
out.push('');
out.push('    export ARTIFACT_REGISTRY_TOKEN=$(gcloud auth print-access-token)');
out.push('');
out.push('  Override (proves nothing about dependencies): SKIP_DEP_INTEGRITY=1');
out.push('');
console.error(out.join('\n'));
process.exit(1);
