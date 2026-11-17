// Naming what a reclaimed workspace held.
//
// The notice already told the agent that its files were gone; it could not say
// WHICH, because nothing captured them. An agent that wrote twelve files got a
// category and had to re-derive which of them mattered.

import {
  buildWorkspaceResetNotice,
  captureWorkspaceManifest,
  loadWorkspaceManifest,
  rememberWorkspaceManifest,
  _resetWorkspaceManifestsForTest,
  MANIFEST_NOTICE_LIMIT,
  type WorkspaceManifest,
} from '../workspace-manifest';

const GENERIC = 'This run resumed with a NEW, empty workspace — files are gone.';

function manifest(over: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
  return {
    sandboxId: 'sb-1',
    sessionId: 'sess-1',
    capturedAt: '2026-01-01T00:00:00Z',
    files: [{ path: '/workspace/a.ts', bytes: 120, sha256: 'a'.repeat(64) }],
    spillFiles: [],
    bashSessions: [],
    nodeSessions: [],
    ...over,
  };
}

afterEach(() => _resetWorkspaceManifestsForTest());

describe('the notice', () => {
  it('names the files when a manifest exists', () => {
    const notice = buildWorkspaceResetNotice(manifest(), GENERIC);
    expect(notice).toContain('/workspace/a.ts');
    expect(notice).toContain('120 bytes');
  });

  // A missing manifest must degrade to today's behaviour, not to silence.
  it('falls back to the generic text with no manifest', () => {
    expect(buildWorkspaceResetNotice(null, GENERIC)).toBe(GENERIC);
  });

  it('falls back when the manifest recorded no files', () => {
    expect(buildWorkspaceResetNotice(manifest({ files: [] }), GENERIC)).toBe(GENERIC);
  });

  it('truncates a long list and says how many more', () => {
    const files = Array.from({ length: MANIFEST_NOTICE_LIMIT + 5 }, (_, i) => ({
      path: `/workspace/f${i}.ts`, bytes: 10, sha256: '',
    }));
    const notice = buildWorkspaceResetNotice(manifest({ files }), GENERIC);
    expect(notice).toContain('and 5 more');
    expect(notice).not.toContain(`/workspace/f${MANIFEST_NOTICE_LIMIT + 1}.ts`);
  });

  // The handles an agent would otherwise discover are gone one failed call at
  // a time.
  it('mentions shell and node sessions when there were any', () => {
    const notice = buildWorkspaceResetNotice(
      manifest({ bashSessions: ['bs-1'], nodeSessions: [] }), GENERIC,
    );
    expect(notice).toMatch(/Shell and Node sessions/);
  });

  it('says nothing about sessions when there were none', () => {
    expect(buildWorkspaceResetNotice(manifest(), GENERIC)).not.toMatch(/Shell and Node sessions/);
  });

  it('mentions reclaimed spill files so the agent re-runs rather than re-reads', () => {
    const notice = buildWorkspaceResetNotice(manifest({ spillFiles: ['r1.txt', 'r2.txt'] }), GENERIC);
    expect(notice).toContain('2 parked tool result');
  });
});

describe('the store', () => {
  it('round-trips by session id', () => {
    rememberWorkspaceManifest(manifest({ sessionId: 'sess-x' }));
    expect(loadWorkspaceManifest('sess-x')?.sandboxId).toBe('sb-1');
  });

  it('returns null for a session it never saw', () => {
    expect(loadWorkspaceManifest('nope')).toBeNull();
  });

  it('is bounded, evicting oldest first', () => {
    for (let i = 0; i < 520; i++) rememberWorkspaceManifest(manifest({ sessionId: `s-${i}` }));
    expect(loadWorkspaceManifest('s-0')).toBeNull();
    expect(loadWorkspaceManifest('s-519')).not.toBeNull();
  });
});

describe('capture', () => {
  const provider = (execImpl: (args: string[]) => { exitCode: number; stdout: string }) => ({
    exec: jest.fn(async (_id: string, args: string[]) => execImpl(args)),
  }) as never;

  it('reads paths, sizes and hashes from the workspace', async () => {
    const p = provider((args) => {
      const cmd = args[2] ?? '';
      if (cmd.startsWith('find')) return { exitCode: 0, stdout: '120\t/workspace/a.ts\n8\t/workspace/b.txt' };
      if (cmd.includes('sha256sum')) {
        return { exitCode: 0, stdout: `${'a'.repeat(64)}  /workspace/a.ts\n${'b'.repeat(64)}  /workspace/b.txt` };
      }
      return { exitCode: 0, stdout: '' };
    });
    const m = await captureWorkspaceManifest({ provider: p, sandboxId: 'sb-1', sessionId: 'sess-c' });
    expect(m?.files).toEqual([
      { path: '/workspace/a.ts', bytes: 120, sha256: 'a'.repeat(64) },
      { path: '/workspace/b.txt', bytes: 8, sha256: 'b'.repeat(64) },
    ]);
    // And it is retrievable by the next run on the same session, which is the
    // only reason it is captured at all.
    expect(loadWorkspaceManifest('sess-c')).not.toBeNull();
  });

  // The path and size are the useful part; a missing hash must not cost the
  // whole manifest.
  it('keeps the files when hashing fails', async () => {
    const p = provider((args) => {
      const cmd = args[2] ?? '';
      if (cmd.startsWith('find')) return { exitCode: 0, stdout: '120\t/workspace/a.ts' };
      if (cmd.includes('sha256sum')) return { exitCode: 1, stdout: '' };
      return { exitCode: 0, stdout: '' };
    });
    const m = await captureWorkspaceManifest({ provider: p, sandboxId: 'sb-1', sessionId: 'sess-h' });
    expect(m?.files).toEqual([{ path: '/workspace/a.ts', bytes: 120, sha256: '' }]);
  });

  it('records spill files', async () => {
    const p = provider((args) => {
      const cmd = args[2] ?? '';
      if (cmd.startsWith('find')) return { exitCode: 0, stdout: '1\t/workspace/a.ts' };
      if (cmd.includes('results')) return { exitCode: 0, stdout: 'call_1.txt\ncall_2.txt' };
      return { exitCode: 0, stdout: '' };
    });
    const m = await captureWorkspaceManifest({ provider: p, sandboxId: 'sb-1', sessionId: 'sess-s' });
    expect(m?.spillFiles).toEqual(['call_1.txt', 'call_2.txt']);
  });

  // A courtesy that can fail the run it is being courteous to is worse than
  // none: the caller is at terminal state with a workspace about to be
  // destroyed.
  it('returns null rather than throwing when the workspace cannot be listed', async () => {
    const p = { exec: jest.fn(async () => { throw new Error('sandbox gone'); }) } as never;
    await expect(
      captureWorkspaceManifest({ provider: p, sandboxId: 'sb-1', sessionId: 'sess-e' }),
    ).resolves.toBeNull();
  });

  it('returns null on a non-zero find', async () => {
    const p = provider(() => ({ exitCode: 1, stdout: '' }));
    await expect(
      captureWorkspaceManifest({ provider: p, sandboxId: 'sb-1', sessionId: 'sess-f' }),
    ).resolves.toBeNull();
  });
});
