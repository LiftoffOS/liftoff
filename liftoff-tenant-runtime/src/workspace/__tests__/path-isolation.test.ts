/**
 * R5 path-isolation tests (representative — not exhaustive).
 *
 * Covers: parent traversal, symlink escape, null byte, absolute path rejection,
 * ENOENT tolerance for new file writes in an existing in-workspace parent.
 */
import { promises as fs, realpathSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { buildPathIsolationHook, HookBlockError } from '../path-isolation';

describe('path-isolation hook', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    // On macOS /tmp is a symlink to /private/tmp; use realpath so the hook's
    // chain walk matches the canonicalized workspace root.
    const rawPath = `/tmp/path-iso-test-${process.env.JEST_WORKER_ID ?? '0'}-${crypto.randomUUID()}`;
    await fs.mkdir(rawPath, { recursive: true, mode: 0o700 });
    workspaceRoot = realpathSync.native(rawPath);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('allows a Read of a file inside the workspace', async () => {
    const filePath = path.join(workspaceRoot, 'hello.txt');
    await fs.writeFile(filePath, 'hi');
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({ tool_name: 'Read', tool_input: { file_path: filePath } });
    expect(decision.permissionDecision).toBe('allow');
  });

  it('blocks a Read that escapes via ../', async () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({
      tool_name: 'Read',
      tool_input: { file_path: path.join(workspaceRoot, '..', '..', 'etc', 'passwd') },
    });
    expect(decision.permissionDecision).toBe('deny');
  });

  it('blocks a Read via absolute /etc/passwd', async () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } });
    expect(decision.permissionDecision).toBe('deny');
  });

  it('blocks a Read of a symlink pointing outside', async () => {
    const linkPath = path.join(workspaceRoot, 'evil-link');
    await fs.symlink('/etc/passwd', linkPath);
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({ tool_name: 'Read', tool_input: { file_path: linkPath } });
    expect(decision.permissionDecision).toBe('deny');
  });

  it('blocks a path containing a null byte', async () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({
      tool_name: 'Read',
      tool_input: { file_path: path.join(workspaceRoot, 'x\0y') },
    });
    expect(decision.permissionDecision).toBe('deny');
  });

  it('BE-R4-007: allows Read of non-existent file when parent is in-workspace (SDK returns natural not-found)', async () => {
    // Parent is the workspace itself — exists. File does not.
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({
      tool_name: 'Read',
      tool_input: { file_path: path.join(workspaceRoot, 'does-not-exist.txt') },
    });
    expect(decision.permissionDecision).toBe('allow');
  });

  it('blocks a Write when the parent does not exist', async () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: path.join(workspaceRoot, 'missing', 'new.txt') },
    });
    expect(decision.permissionDecision).toBe('deny');
  });

  it('allows a Write when the parent exists and is in-workspace', async () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: path.join(workspaceRoot, 'new.txt') },
    });
    expect(decision.permissionDecision).toBe('allow');
  });

  it('blocks Glob with absolute pattern', async () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({ tool_name: 'Glob', tool_input: { pattern: '/etc/**' } });
    expect(decision.permissionDecision).toBe('deny');
  });

  it('blocks Glob with parent-traversal', async () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    const decision = await hook.PreToolUse({ tool_name: 'Glob', tool_input: { pattern: '../../*' } });
    expect(decision.permissionDecision).toBe('deny');
  });

  it('raw validator throws HookBlockError for absolute /etc/passwd (test hook)', () => {
    const hook = buildPathIsolationHook(workspaceRoot);
    expect(() => hook._test.validateReadPath('/etc/passwd')).toThrow(HookBlockError);
  });
});
