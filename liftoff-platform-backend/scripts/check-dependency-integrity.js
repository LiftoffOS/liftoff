#!/usr/bin/env node
/**
 * Fail fast when the INSTALLED dependency tree does not describe THIS checkout.
 *
 * Two properties, both about the same hazard from opposite ends:
 *
 *   1. VERSIONS. The installed packages match this checkout's lockfile.
 *   2. WORKSPACE LINKAGE. Every package under packages/ resolves to THIS
 *      checkout's copy of it, not another checkout's.
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
 * WHY LINKAGE IS CHECKED SEPARATELY. A worktree that symlinks its node_modules
 * at the main checkout inherits that checkout's workspace links too, because
 * `node_modules/@scope/pkg -> ../../packages/pkg` is RELATIVE and resolves
 * through the symlink's real path. For third-party dependencies that sharing is
 * the point, and check (1) already polices it. For workspace packages it is
 * silent corruption in both directions: an edit to packages/ in this worktree
 * changes nothing that compiles here, and a BUILD of packages/ here overwrites
 * the dist every other checkout is compiling against.
 *
 * Neither direction announces itself. What surfaces instead is a type error in
 * a file nobody touched, in a checkout whose source is perfectly consistent
 * with itself — and the natural response, rebuilding the package, silently
 * overwrites whatever the other agent was mid-way through. Two checkouts then
 * take turns clobbering one directory, each seeing failures the other caused.
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

/** realpath, or null when the path does not exist. Comparing REAL paths is the
 *  whole check: a shared node_modules makes the symlink look local while it
 *  resolves somewhere else entirely. */
function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Directories matched by the `workspaces` globs. Only the `dir/*` form this
 *  repo uses is expanded; anything else is skipped rather than guessed at. */
function workspaceDirs() {
  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : [];
  const out = [];
  for (const g of globs) {
    if (!g.endsWith('/*')) continue;
    const base = path.join(root, g.slice(0, -2));
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() || e.isSymbolicLink()) out.push(path.join(base, e.name));
    }
  }
  return out;
}

const mislinked = [];
for (const dir of workspaceDirs()) {
  const manifest = readJson(path.join(dir, 'package.json'));
  if (!manifest || !manifest.name) continue;

  // A workspace package that is not linked into node_modules at all is not this
  // check's problem: importing it fails loudly at the first build, which is the
  // opposite of silent.
  const linkedReal = realpathOrNull(path.join(root, 'node_modules', manifest.name));
  if (!linkedReal) continue;

  const ownReal = realpathOrNull(dir);
  if (ownReal && linkedReal !== ownReal) {
    mislinked.push({ name: manifest.name, resolvesTo: linkedReal, expected: ownReal });
  }
}

if (mismatches.length === 0 && missing.length === 0 && mislinked.length === 0) process.exit(0);

const nodeModules = path.join(root, 'node_modules');
let shared = '';
try {
  if (fs.lstatSync(nodeModules).isSymbolicLink()) {
    shared = `\n  node_modules is a SYMLINK -> ${fs.readlinkSync(nodeModules)}` +
             '\n  That tree is shared with other checkouts, so its packages are theirs, not this one\'s.';
  }
} catch { /* node_modules missing entirely — the missing[] list already says so */ }

const versionProblem = mismatches.length > 0 || missing.length > 0;

const lines = [
  '',
  versionProblem
    ? 'Dependency integrity check FAILED — the installed packages do not match this checkout\'s lockfile.'
    : 'Dependency integrity check FAILED — workspace packages resolve to ANOTHER checkout.',
  shared,
  '',
];
for (const m of mismatches) {
  lines.push(`  ${m.name}: lockfile says ${m.expected}, installed is ${m.installed}`);
}
for (const m of missing) {
  lines.push(`  ${m}: required by this lockfile, not installed`);
}
if (mislinked.length > 0) {
  if (versionProblem) lines.push('');
  // Capped: a shared node_modules mislinks EVERY workspace package at once, and
  // twenty identical stanzas bury the fix under themselves. The count is what
  // carries the scale; the first few carry the diagnosis.
  const SHOWN = 4;
  for (const m of mislinked.slice(0, SHOWN)) {
    lines.push(`  ${m.name}: resolves to ${m.resolvesTo}`);
    lines.push(`  ${' '.repeat(m.name.length)}  should be ${m.expected}`);
  }
  if (mislinked.length > SHOWN) {
    lines.push(`  ... and ${mislinked.length - SHOWN} more workspace package(s), same cause.`);
  }
  lines.push(
    '',
    'These are SOURCE you can edit. Editing them here changes nothing that compiles',
    'here, and BUILDING them here overwrites the dist every other checkout compiles',
    'against — which surfaces as a type error in a file nobody touched, in someone',
    "else's checkout.",
  );
}
lines.push(
  '',
  'Anything you run against this tree — tests, typecheck, build — is verifying the wrong code.',
  '',
  'Fix: give this checkout its own dependency tree.',
  '',
  '  rm -f node_modules && npm ci',
  '',
  // The `rm -f` is not tidiness. `npm ci` deletes node_modules before
  // installing, and deleting a SYMLINK to another checkout's tree empties that
  // tree for every checkout sharing it — turning one broken worktree into
  // twenty. Remove the link first and npm installs into a fresh directory.
  '  The rm is load-bearing: npm ci deletes node_modules first, and deleting a',
  '  symlink to a shared tree empties it for every checkout pointing at it.',
  '',
  // Measured, because the belief that this is expensive is what keeps the
  // symlink convention alive — and it is the convention, not the install, that
  // costs. Someone who assumes a token is required and does not have one to
  // hand reaches for SKIP_DEP_INTEGRITY instead, which is the worst outcome.
  '  It costs seconds against a warm npm cache and needs no Artifact Registry',
  '  token. ~800MB of disk per checkout.',
  '',
  // A stale dist/ survives npm ci in an older worktree — npm only runs `prepare`
  // when there is nothing built yet. dist/ is gitignored, so git never mentions
  // that it is days behind its own src/, and what surfaces is a type error
  // naming a property on YOUR code.
  '  Then build the workspace packages, or a stale dist/ survives the install:',
  '    npm run build --workspaces --if-present',
  '',
  '  On a cold cache: export ARTIFACT_REGISTRY_TOKEN=$(gcloud auth print-access-token)',
  '',
  'Override (proves nothing about dependencies): SKIP_DEP_INTEGRITY=1',
  '',
);

process.stderr.write(lines.join('\n'));
process.exit(1);
