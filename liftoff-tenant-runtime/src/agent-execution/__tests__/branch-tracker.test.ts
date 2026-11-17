import { extractBranchFromToolCalls, writeBranchCompletionMemory } from '../branch-tracker';
import { memoryService } from '../../memory/service';

jest.mock('../../memory/service', () => ({
  memoryService: { saveMemory: jest.fn().mockResolvedValue({ id: 'mem-1' }) },
}));

describe('extractBranchFromToolCalls', () => {
  it('extracts from git push origin branch', () =>
    expect(extractBranchFromToolCalls([{ name: 'bash', input: { command: 'git push origin feature/my-branch' } }]))
      .toBe('feature/my-branch'));

  it('extracts from git push --set-upstream origin branch', () =>
    expect(extractBranchFromToolCalls([{ name: 'bash', input: { command: 'git push --set-upstream origin fix/bug-123' } }]))
      .toBe('fix/bug-123'));

  it('extracts from git push -u origin branch', () =>
    expect(extractBranchFromToolCalls([{ name: 'bash', input: { command: 'git push -u origin refactor/x' } }]))
      .toBe('refactor/x'));

  it('extracts from git checkout -b', () =>
    expect(extractBranchFromToolCalls([{ name: 'bash', input: { command: 'git checkout -b fix/billing-guard' } }]))
      .toBe('fix/billing-guard'));

  it('extracts from git switch -c', () =>
    expect(extractBranchFromToolCalls([{ name: 'shell', input: { cmd: 'git switch -c refactor/auth-layer' } }]))
      .toBe('refactor/auth-layer'));

  it('extracts from explicit git_push tool', () =>
    expect(extractBranchFromToolCalls([{ name: 'git_push', input: { branch: 'deploy/v2' } }]))
      .toBe('deploy/v2'));

  it('returns null when no branch operations found', () =>
    expect(extractBranchFromToolCalls([
      { name: 'bash', input: { command: 'npm test' } },
      { name: 'read_file', input: { path: '/src/x.ts' } },
    ])).toBeNull());

  it('returns null for empty array', () =>
    expect(extractBranchFromToolCalls([])).toBeNull());

  it('does not match flags as branch names (e.g. --force)', () =>
    expect(extractBranchFromToolCalls([{ name: 'bash', input: { command: 'git push --force origin' } }]))
      .toBeNull());
});

describe('writeBranchCompletionMemory', () => {
  it('saves a global-layer memory with correct tags', async () => {
    await writeBranchCompletionMemory('tenant-1', 'agent-1', 'feature/xyz', 'Done the thing');
    expect(memoryService.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      layer: 'global',
      tags: expect.arrayContaining(['task_completed', 'branch_tracking', 'branch:feature/xyz']),
      content: expect.stringContaining('feature/xyz'),
    }));
  });

  it('does not throw when saveMemory fails (non-fatal)', async () => {
    (memoryService.saveMemory as jest.Mock).mockRejectedValueOnce(new Error('DB down'));
    await expect(writeBranchCompletionMemory('t', 'a', 'main', null)).resolves.not.toThrow();
  });
});
