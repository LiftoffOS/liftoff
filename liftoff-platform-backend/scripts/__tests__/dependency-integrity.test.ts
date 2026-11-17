// check-dependency-integrity — a workspace package must resolve to THIS
// checkout's copy of it.
//
// The hazard is silent in both directions. A worktree that symlinks its
// node_modules at another checkout inherits that checkout's workspace links,
// because `node_modules/@scope/pkg -> ../../packages/pkg` is relative and
// resolves through the symlink's real path. Editing packages/ here then changes
// nothing that compiles here, and BUILDING packages/ here overwrites the dist
// every other checkout compiles against. What surfaces is a type error in a file
// nobody touched, in a checkout whose own source is perfectly consistent.
//
// Exercised against a real temporary checkout rather than a mocked filesystem:
// the whole property is about what symlinks RESOLVE to, and a mock that models
// resolution is a mock of the thing under test.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A throwaway checkout: manifest, lockfile, one workspace package, and a
 *  copy of the script positioned exactly as it sits in the repo (it derives its
 *  root from __dirname/..). */
function makeCheckout(): string {
  // realpath the tmpdir: on macOS it is /var -> /private/var, and the check
  // compares REAL paths, so a fixture built under the symlinked form would
  // fail the equality for a reason that has nothing to do with the invariant.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dep-integrity-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'probe', workspaces: ['packages/*'], dependencies: {} }),
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ name: 'probe', lockfileVersion: 3, packages: {} }),
  );

  fs.mkdirSync(path.join(root, 'packages', 'pkg-a'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'pkg-a', 'package.json'),
    JSON.stringify({ name: '@probe/pkg-a', version: '1.0.0' }),
  );

  fs.mkdirSync(path.join(root, 'node_modules', '@probe'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'check-dependency-integrity.js'),
    path.join(root, 'scripts', 'check-dependency-integrity.js'),
  );
  return root;
}

function link(root: string, target: string): void {
  const linkPath = path.join(root, 'node_modules', '@probe', 'pkg-a');
  fs.rmSync(linkPath, { force: true });
  fs.symlinkSync(target, linkPath);
}

/** Run the check as the pre-scripts do. Returns exit status and stderr. */
function run(root: string): { status: number; stderr: string } {
  try {
    execFileSync('node', [path.join(root, 'scripts', 'check-dependency-integrity.js')], {
      encoding: 'utf8',
      env: { ...process.env, SKIP_DEP_INTEGRITY: '' },
    });
    return { status: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? '' };
  }
}

describe('workspace linkage', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  function checkout(): string {
    const r = makeCheckout();
    roots.push(r);
    return r;
  }

  it('passes when a workspace package resolves to this checkout', () => {
    const root = checkout();
    link(root, path.join(root, 'packages', 'pkg-a'));
    expect(run(root).status).toBe(0);
  });

  it('FAILS when it resolves to another checkout', () => {
    const root = checkout();
    const other = checkout();
    // Exactly what a shared node_modules produces: the link is present and
    // looks right, and points at somebody else's source.
    link(root, path.join(other, 'packages', 'pkg-a'));

    const { status, stderr } = run(root);
    expect(status).toBe(1);
    expect(stderr).toContain('workspace packages resolve to ANOTHER checkout');
    expect(stderr).toContain('@probe/pkg-a');
    // The message has to carry the remedy, or it is just an obstacle.
    expect(stderr).toContain('npm ci');
  });

  it('says nothing about a workspace package that is not linked at all', () => {
    // Absence is not this check's problem: importing it fails loudly at the
    // first build, which is the opposite of the silence being guarded against.
    const root = checkout();
    expect(run(root).status).toBe(0);
  });

  it('is skippable, and the skip covers linkage too', () => {
    const root = checkout();
    const other = checkout();
    link(root, path.join(other, 'packages', 'pkg-a'));

    const out = execFileSync(
      'node',
      [path.join(root, 'scripts', 'check-dependency-integrity.js')],
      { encoding: 'utf8', env: { ...process.env, SKIP_DEP_INTEGRITY: '1' } },
    );
    expect(out).toBe('');
  });
});
