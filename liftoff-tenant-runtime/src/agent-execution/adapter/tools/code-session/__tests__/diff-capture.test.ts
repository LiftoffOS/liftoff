// A coding session's diff is everything it did, not just its unstaged edits.
//
// Plain `git diff` / `git diff --name-only` compared the working tree with the
// index, so a file the agent created was missing, and anything it committed
// vanished entirely (the commit left a clean tree). Real git in a temp repo,
// run through the real in-process workspace, because the defect was in which
// git question was asked, and a stubbed git cannot answer that.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalCodeSessionWorkspace } from '../workspace';
import { captureSessionChanges, recordSessionBase } from '../diff-capture';

jest.mock('../../../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// CI's node:20-slim has no git; see sandbox-workspace-real-shell.test.ts.
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const itWithGit = HAS_GIT ? it : it.skip;

const IDENTITY = ['-c', 'user.email=agent@example.com', '-c', 'user.name=Agent'];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' });

let origin: string;
let ws: LocalCodeSessionWorkspace;

beforeEach(async () => {
  ws = await LocalCodeSessionWorkspace.create('diff-capture-');
  if (!HAS_GIT) return;
  origin = mkdtempSync(join(tmpdir(), 'diff-capture-origin-'));
  git(origin, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(origin, 'README.md'), 'hello\n');
  writeFileSync(join(origin, 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(origin, '.gitignore'), 'node_modules/\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'init');
  // The shape the handler clones with.
  const cloned = await ws.exec(['git', 'clone', '--quiet', '--depth=1', `file://${origin}`, ws.root]);
  expect(cloned.exitCode).toBe(0);
});

afterEach(async () => {
  await ws.destroy();
  if (origin) rmSync(origin, { recursive: true, force: true });
});

describe('captureSessionChanges', () => {
  itWithGit('reports a new file, an edit, and a commit the session made, together', async () => {
    const base = await recordSessionBase(ws, ws.root);
    expect(base).toMatch(/^[0-9a-f]{40,64}$/);

    // What a coding agent does: commit some work...
    appendFileSync(join(ws.root, 'app.ts'), 'export const b = 2;\n');
    writeFileSync(join(ws.root, 'committed.ts'), 'export const c = 3;\n');
    git(ws.root, 'add', '-A');
    git(ws.root, 'commit', '--quiet', '-m', 'agent work');
    // ...then leave an edit and a brand-new file uncommitted, plus a file the
    // repo ignores.
    appendFileSync(join(ws.root, 'README.md'), 'edited\n');
    writeFileSync(join(ws.root, 'new-file.ts'), 'export const d = 4;\n');
    execFileSync('mkdir', ['-p', join(ws.root, 'node_modules')]);
    writeFileSync(join(ws.root, 'node_modules', 'dep.js'), 'ignored\n');

    // The old capture, for the record: it saw only the uncommitted edit.
    const plain = await ws.exec(['git', 'diff', '--name-only']);
    expect(plain.stdout.split('\n').filter(Boolean)).toEqual(['README.md']);

    const captured = await captureSessionChanges(ws, ws.root, base);
    expect(captured.error).toBeUndefined();
    expect(captured.filesModified.sort()).toEqual(['README.md', 'app.ts', 'committed.ts', 'new-file.ts']);
    expect(captured.diff).toContain('+export const b = 2;'); // committed edit
    expect(captured.diff).toContain('+export const c = 3;'); // committed new file
    expect(captured.diff).toContain('+edited'); // uncommitted edit
    expect(captured.diff).toContain('+export const d = 4;'); // untracked new file
    expect(captured.diff).not.toContain('node_modules');
  });

  itWithGit('leaves the checkout\'s own index, HEAD and branch as the session left them', async () => {
    const base = await recordSessionBase(ws, ws.root);
    writeFileSync(join(ws.root, 'new-file.ts'), 'x\n');
    const headBefore = git(ws.root, 'rev-parse', 'HEAD');
    const branchBefore = git(ws.root, 'rev-parse', '--abbrev-ref', 'HEAD');

    await captureSessionChanges(ws, ws.root, base);

    expect(git(ws.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(ws.root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
    // Still untracked: nothing was added to the real index.
    expect(git(ws.root, 'status', '--porcelain')).toBe('?? new-file.ts\n');
    // And the throwaway index is gone.
    expect(git(ws.root, 'status', '--porcelain', '--ignored')).not.toContain('capture-index');
  });

  itWithGit('reports nothing for a session that changed nothing', async () => {
    const base = await recordSessionBase(ws, ws.root);
    const captured = await captureSessionChanges(ws, ws.root, base);
    expect(captured).toEqual({ diff: '', filesModified: [] });
  });

  itWithGit('measures a repository with no commits from the empty tree', async () => {
    const empty = await LocalCodeSessionWorkspace.create('diff-capture-empty-');
    try {
      git(empty.root, 'init', '--quiet', '-b', 'main');
      const base = await recordSessionBase(empty, empty.root);
      expect(base).toBeDefined();
      writeFileSync(join(empty.root, 'first.ts'), 'first\n');
      const captured = await captureSessionChanges(empty, empty.root, base);
      expect(captured.filesModified).toEqual(['first.ts']);
    } finally {
      await empty.destroy();
    }
  });

  it('reports a failure, not an empty diff, when no base was recorded', async () => {
    const captured = await captureSessionChanges(ws, ws.root, undefined);
    expect(captured.error).toMatch(/no base revision/);
    expect(captured.filesModified).toEqual([]);
  });
});
