// Being able to undo what a run did to a workspace.
//
// The tests that matter here are about the git commands actually issued, not
// about the return values: the whole feature is a claim that a specific
// sequence of git operations leaves a restorable snapshot without touching the
// agent's own repository. A version that returned the right shape while writing
// into `.git` would pass any test written against the interface alone.

import {
  CHECKPOINT_GIT_DIR,
  MAX_CHECKPOINTS,
  isMutatingTool,
  listCheckpoints,
  prune,
  _resetCheckpointStateForTest,
  restoreCheckpoint,
  snapshotOnce,
} from '../checkpoint-manager';
import type { SandboxProvider } from '../types';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

interface FakeOpts {
  /** Refs the store already holds, newest first. */
  refs?: Array<{ id: string; commit: string; createdAt: string; label: string }>;
  /** Tree object id `write-tree` reports. */
  tree?: string;
  /** Tree of an existing commit, for the unchanged-tree check. */
  treeOfCommit?: Record<string, string>;
  storeExists?: boolean;
  fail?: (args: string[]) => boolean;
}

function fakeProvider(opts: FakeOpts = {}) {
  const calls: string[][] = [];
  const written: Array<{ path: string; content: string }> = [];
  let refs = [...(opts.refs ?? [])];

  const provider = {
    async exec(_id: string, args: string[]) {
      calls.push(args);
      if (opts.fail?.(args)) return { stdout: '', stderr: 'boom', exitCode: 1 };

      if (args[0] === 'test') {
        return { stdout: '', stderr: '', exitCode: opts.storeExists ? 0 : 1 };
      }
      const verb = args.find((a) => [
        'init', 'config', 'add', 'write-tree', 'commit-tree', 'update-ref',
        'for-each-ref', 'read-tree', 'gc', 'rev-parse',
      ].includes(a));

      switch (verb) {
        case 'write-tree':
          return { stdout: `${opts.tree ?? 'tree-new'}\n`, stderr: '', exitCode: 0 };
        case 'rev-parse': {
          const spec = args[args.length - 1];
          const commit = spec.replace('^{tree}', '');
          return { stdout: `${opts.treeOfCommit?.[commit] ?? 'tree-old'}\n`, stderr: '', exitCode: 0 };
        }
        case 'commit-tree':
          return { stdout: 'commit-abc\n', stderr: '', exitCode: 0 };
        case 'for-each-ref':
          return {
            stdout: refs.map((r) => `${r.id}\t${r.commit}\t${r.createdAt}\t${r.label}`).join('\n'),
            stderr: '',
            exitCode: 0,
          };
        case 'update-ref': {
          if (args.includes('-d')) {
            const id = args[args.length - 1];
            refs = refs.filter((r) => r.id !== id);
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        default:
          return { stdout: '', stderr: '', exitCode: 0 };
      }
    },
    async writeFile(_id: string, path: string, content: string) {
      written.push({ path, content });
    },
    async readFile() { return ''; },
    async create() { throw new Error('unused'); },
    async destroy() { /* unused */ },
  } as unknown as SandboxProvider;

  return { provider, calls, written, refsNow: () => refs };
}

const flat = (calls: string[][]): string[] => calls.map((c) => c.join(' '));

beforeEach(() => {
  _resetCheckpointStateForTest();
  jest.clearAllMocks();
});

describe('when a snapshot is worth taking', () => {
  it('covers every shape of mutation, not just file writes', () => {
    // A checkpoint that missed one mutating path would be a restore point that
    // quietly does not restore.
    for (const t of ['shell_exec', 'file_write', 'file_edit', 'code_execute', 'bash_session_exec', 'git_clone']) {
      expect(isMutatingTool(t)).toBe(true);
    }
  });

  it('ignores reads, so a read-heavy turn costs nothing', () => {
    for (const t of ['file_read', 'file_search', 'content_search', 'browser_navigate', 'file_glob']) {
      expect(isMutatingTool(t)).toBe(false);
    }
  });
});

describe('taking a snapshot', () => {
  it('never touches the agent\'s own repository', async () => {
    // The single most important property. Checkpoints written into the agent's
    // `.git` would appear in their history, fight their index, and end up in
    // their pull request.
    const { provider, calls } = fakeProvider();
    await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });

    const gitCalls = flat(calls).filter((c) => c.startsWith('git '));
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const c of gitCalls) {
      // Every git invocation names the shadow store — either pinned with
      // --git-dir, or the one `init` that creates it at that path. A call with
      // neither would pick up whatever repository /workspace happens to hold,
      // which is the agent's.
      expect(c).toContain(CHECKPOINT_GIT_DIR);
      expect(c.includes(`--git-dir=${CHECKPOINT_GIT_DIR}`) || c.includes('init')).toBe(true);
    }
  });

  it('excludes the agent\'s .git and the heavy directories', async () => {
    const { provider, written } = fakeProvider();
    await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });

    const exclude = written.find((w) => w.path.endsWith('info/exclude'));
    expect(exclude).toBeDefined();
    // node_modules is the difference between a snapshot that costs milliseconds
    // and one that costs a minute, and none of it is work the agent did.
    expect(exclude!.content).toContain('node_modules/');
    expect(exclude!.content).toContain('.git/');
    expect(exclude!.content).toContain('.checkpoints/');
  });

  it('records an orphan commit under its own ref', async () => {
    // No parent, one ref each. That is what makes pruning a ref delete rather
    // than a history rewrite, and restoring one independent of the rest.
    const { provider, calls } = fakeProvider();
    await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });

    const commitTree = calls.find((c) => c.includes('commit-tree'))!;
    expect(commitTree).toBeDefined();
    expect(commitTree).not.toContain('-p');
    expect(flat(calls).some((c) => c.includes('update-ref refs/checkpoints/'))).toBe(true);
  });

  it('takes one per turn, however many times the workspace is written', async () => {
    const { provider } = fakeProvider();
    const first = await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });
    const second = await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('takes one per turn per sandbox, not one globally', async () => {
    const { provider } = fakeProvider();
    await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });
    expect(await snapshotOnce({ provider, sandboxId: 's2', invocationId: 'inv1' })).not.toBeNull();
  });

  it('claims the turn before doing the work, so two calls at once cannot both snapshot', async () => {
    // Two mutating tool calls can be in flight together. Claiming after the
    // work would let both through and snapshot the same turn twice.
    const { provider, calls } = fakeProvider();
    await Promise.all([
      snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' }),
      snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' }),
    ]);
    expect(flat(calls).filter((c) => c.includes('commit-tree'))).toHaveLength(1);
  });

  it('skips when nothing actually changed since the last one', async () => {
    // A turn that mutated nothing in the end should not leave a duplicate
    // snapshot behind for someone to scroll past.
    const { provider } = fakeProvider({
      refs: [{ id: 'refs/checkpoints/1', commit: 'c1', createdAt: 'x', label: 'l' }],
      tree: 'same-tree',
      treeOfCommit: { c1: 'same-tree' },
    });
    expect(await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' })).toBeNull();
  });

  it('creates the store once, not before every snapshot', async () => {
    const { provider, calls } = fakeProvider();
    await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });
    await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv2' });
    expect(flat(calls).filter((c) => c.includes('init'))).toHaveLength(1);
  });

  it('makes the bare store accept a work tree', async () => {
    // `git init --bare` gives a repository with no working copy, which is right
    // for a store always pointed at one explicitly — but git refuses work-tree
    // operations while core.bare is true, so the pair is load-bearing.
    const { provider, calls } = fakeProvider();
    await snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' });
    expect(flat(calls).some((c) => c.includes('config core.bare false'))).toBe(true);
  });

  it('returns null rather than throwing when the store cannot be created', async () => {
    // Insurance that can fail the thing it insures is worse than none.
    const { provider } = fakeProvider({ fail: (a) => a.includes('init') });
    await expect(snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' }))
      .resolves.toBeNull();
  });

  it('returns null when staging fails', async () => {
    const { provider } = fakeProvider({ fail: (a) => a.includes('add') });
    await expect(snapshotOnce({ provider, sandboxId: 's1', invocationId: 'inv1' }))
      .resolves.toBeNull();
  });

  it('strips newlines from the label so one cannot forge a log line', async () => {
    const { provider, calls } = fakeProvider();
    await snapshotOnce({
      provider, sandboxId: 's1', invocationId: 'inv1',
      label: 'first\nsecond',
    });
    const commitTree = calls.find((c) => c.includes('commit-tree'))!;
    expect(commitTree[commitTree.length - 1]).not.toContain('\n');
  });
});

describe('listing', () => {
  it('parses what for-each-ref returned', async () => {
    const { provider } = fakeProvider({
      refs: [
        { id: 'refs/checkpoints/2', commit: 'c2', createdAt: '2026-08-05T10:00:00Z', label: 'before this turn' },
        { id: 'refs/checkpoints/1', commit: 'c1', createdAt: '2026-08-05T09:00:00Z', label: 'before this turn' },
      ],
    });
    const out = await listCheckpoints(provider, 's1');
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('refs/checkpoints/2');
    expect(out[0].commit).toBe('c2');
    expect(out[0].label).toBe('before this turn');
  });

  it('is empty rather than throwing when there is no store yet', async () => {
    const { provider } = fakeProvider({ fail: (a) => a.includes('for-each-ref') });
    await expect(listCheckpoints(provider, 's1')).resolves.toEqual([]);
  });
});

describe('restoring', () => {
  const existing = [{ id: 'refs/checkpoints/1', commit: 'c1', createdAt: 'x', label: 'l' }];

  it('replaces the working tree, rather than only restoring edited files', async () => {
    // `checkout -- .` would put the edits back and leave files created after
    // the checkpoint in place, which is not what "go back" means.
    const { provider, calls } = fakeProvider({ refs: existing, storeExists: true });
    const r = await restoreCheckpoint({
      provider, sandboxId: 's1', checkpointId: 'refs/checkpoints/1',
    });
    expect(r.restored).toBe(true);
    expect(flat(calls).some((c) => c.includes('read-tree -u --reset refs/checkpoints/1'))).toBe(true);
  });

  it('checkpoints the current state first, so the restore itself is undoable', async () => {
    // The person reaching for this is already having a bad time; a restore that
    // cannot be undone is a second way to lose the work.
    const { provider, calls } = fakeProvider({
      refs: existing, storeExists: true, tree: 'different-tree', treeOfCommit: { c1: 'old-tree' },
    });
    const r = await restoreCheckpoint({
      provider, sandboxId: 's1', checkpointId: 'refs/checkpoints/1',
    });
    expect(r.safetyCheckpoint).toBeTruthy();
    const order = flat(calls);
    expect(order.findIndex((c) => c.includes('commit-tree')))
      .toBeLessThan(order.findIndex((c) => c.includes('read-tree')));
  });

  it('refuses an id that is not a checkpoint ref', async () => {
    // Otherwise this is an arbitrary `read-tree` of any object in the store.
    const { provider, calls } = fakeProvider({ refs: existing, storeExists: true });
    const r = await restoreCheckpoint({ provider, sandboxId: 's1', checkpointId: 'HEAD' });
    expect(r.restored).toBe(false);
    expect(flat(calls).some((c) => c.includes('read-tree'))).toBe(false);
  });

  it('refuses a checkpoint that does not exist', async () => {
    const { provider } = fakeProvider({ refs: existing, storeExists: true });
    const r = await restoreCheckpoint({
      provider, sandboxId: 's1', checkpointId: 'refs/checkpoints/999',
    });
    expect(r.restored).toBe(false);
    expect(r.error).toBe('unknown checkpoint');
  });

  it('reports a failed reset rather than claiming success', async () => {
    const { provider } = fakeProvider({
      refs: existing, storeExists: true, fail: (a) => a.includes('read-tree'),
    });
    const r = await restoreCheckpoint({
      provider, sandboxId: 's1', checkpointId: 'refs/checkpoints/1',
    });
    expect(r.restored).toBe(false);
  });
});

describe('pruning', () => {
  const many = Array.from({ length: MAX_CHECKPOINTS + 5 }, (_, i) => ({
    id: `refs/checkpoints/${i}`,
    commit: `c${i}`,
    createdAt: `2026-08-05T${String(i).padStart(2, '0')}:00:00Z`,
    label: 'l',
  }));

  it('does nothing while under the cap', async () => {
    const { provider, calls } = fakeProvider({ refs: many.slice(0, MAX_CHECKPOINTS), storeExists: true });
    expect(await prune(provider, 's1')).toBe(0);
    expect(flat(calls).some((c) => c.includes('update-ref -d'))).toBe(false);
  });

  it('drops the oldest past the cap', async () => {
    const { provider } = fakeProvider({ refs: many, storeExists: true });
    expect(await prune(provider, 's1')).toBe(5);
  });

  it('keeps the newest, not the oldest', async () => {
    // for-each-ref is sorted newest-first, so slicing the wrong end would throw
    // away exactly the checkpoints anyone would want.
    const { provider, calls } = fakeProvider({ refs: many, storeExists: true });
    await prune(provider, 's1');
    const deleted = flat(calls).filter((c) => c.includes('update-ref -d'));
    expect(deleted.some((c) => c.endsWith(`refs/checkpoints/${MAX_CHECKPOINTS}`))).toBe(true);
    expect(deleted.some((c) => c.endsWith('refs/checkpoints/0'))).toBe(false);
  });

  it('collects the objects, not just the refs', async () => {
    // Deleting a ref only makes its objects unreachable, and an unreachable
    // snapshot of a large workspace still occupies the disk the agent is
    // trying to build on.
    const { provider, calls } = fakeProvider({ refs: many, storeExists: true });
    await prune(provider, 's1');
    expect(flat(calls).some((c) => c.includes('gc --prune=now'))).toBe(true);
  });
});

describe('the wiring', () => {
  const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8') as string;

  it('snapshots from the executor, before the mutation runs', () => {
    const src = read('sandbox-executor.ts');
    expect(src).toMatch(/isMutatingTool\(call\.toolName\)/);
    // Before the dispatch switch, not after — a snapshot taken afterwards
    // records the state it was supposed to protect against.
    expect(src.indexOf('snapshotOnce(')).toBeLessThan(src.indexOf('switch (call.toolName)'));
  });

  it('awaits the snapshot rather than racing the write it precedes', () => {
    expect(read('sandbox-executor.ts')).toMatch(/await snapshotOnce\(/);
  });

  it('releases the per-sandbox state when the sandbox is destroyed', () => {
    expect(read('sandbox-executor.ts')).toMatch(/clearCheckpointState\(sandboxId\)/);
  });

  it('exposes rollback to operators and to nothing else', () => {
    // A model that can see its own checkpoints starts rolling back and retrying
    // from the same state, which spends a run rediscovering one failure.
    expect(read('router.ts')).toMatch(/checkpoints\/restore/);
    const registry = read('function-registry.ts');
    expect(registry).not.toMatch(/checkpoint/i);
  });
});
