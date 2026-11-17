#!/usr/bin/env node
/**
 * Fail fast when the INSTALLED dependency tree does not match this checkout's
 * lockfile.
 *
 * Why this exists: this repo is worked in through many git worktrees, and the
 * convention has been to symlink each one's `node_modules` at the main
 * checkout's. Two dozen worktrees currently share one tree. That means an
 * `npm ci` / `npm install` run in ANY of them — or in the main checkout, on
 * whatever branch it happens to be sitting on — silently rewrites the
 * dependencies every other worktree is compiling and testing against.
 *
 * The dangerous case is not the loud one. A branch that bumps a dependency and
 * then verifies against an older installed copy can go GREEN locally and fail
 * in CI; worse, a branch that does not bump anything can go green against a
 * NEWER tree some other branch installed, and the verification means nothing.
 * Both are silent. This turns them into a hard error naming the exact packages.
 *
 * Deliberately conservative — it only compares DIRECT dependencies declared in
 * this package.json against the versions this lockfile resolved, so it cannot
 * fail on transitive-tree or platform-optional differences. It reads files
 * only: no network, no install, ~100ms.
 *
 * Escape hatch: SKIP_DEP_INTEGRITY=1 (say, mid-bisect). Use it knowing that a
 * green run under it proves nothing about the dependency tree.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

if (process.env.SKIP_DEP_INTEGRITY === '1') {
  process.exit(0);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const pkg = readJson(path.join(root, 'package.json'));
const lock = readJson(path.join(root, 'package-lock.json'));

// No lockfile (or no manifest) is not this check's problem to diagnose.
if (!pkg || !lock || !lock.packages) process.exit(0);

const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const mismatches = [];
const missing = [];

for (const name of Object.keys(direct)) {
  // Workspace packages resolve to a symlink into packages/ and carry their own
  // version independent of the lockfile's node_modules entry — skip them.
  const lockEntry = lock.packages[`node_modules/${name}`];
  if (!lockEntry || lockEntry.link || !lockEntry.version) continue;

  const installedManifest = readJson(path.join(root, 'node_modules', name, 'package.json'));
  if (!installedManifest) {
    // Optional/platform-specific packages legitimately go uninstalled.
    if (!lockEntry.optional) missing.push(name);
    continue;
  }
  if (installedManifest.version !== lockEntry.version) {
    mismatches.push({ name, expected: lockEntry.version, installed: installedManifest.version });
  }
}

if (mismatches.length === 0 && missing.length === 0) process.exit(0);

const nodeModules = path.join(root, 'node_modules');
let shared = '';
try {
  if (fs.lstatSync(nodeModules).isSymbolicLink()) {
    shared = `\n  node_modules is a SYMLINK -> ${fs.readlinkSync(nodeModules)}` +
             '\n  That tree is shared with other worktrees, so another checkout installed over it.';
  }
} catch { /* node_modules missing entirely — the missing[] list already says so */ }

const lines = [
  '',
  'Dependency integrity check FAILED — the installed packages do not match this checkout\'s lockfile.',
  shared,
  '',
];
for (const m of mismatches) {
  lines.push(`  ${m.name}: lockfile says ${m.expected}, installed is ${m.installed}`);
}
for (const m of missing) {
  lines.push(`  ${m}: required by this lockfile, not installed`);
}
lines.push(
  '',
  'Anything you run against this tree — tests, typecheck, build — is verifying the wrong code.',
  '',
  'Fix: give this checkout its own dependency tree.',
  '  rm -f node_modules && npm ci        # if node_modules is a shared symlink',
  '  npm ci                              # otherwise',
  '',
  'Override (proves nothing about dependencies): SKIP_DEP_INTEGRITY=1',
  '',
);

process.stderr.write(lines.join('\n'));
process.exit(1);
