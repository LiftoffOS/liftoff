// Claude MD Materializer Tests
// Tests workspace materialization, CLAUDE.md writing, cleanup, and input validation

import { promises as fs } from 'fs';
import * as path from 'path';
import { materializeInvocationWorkspace } from '../claude-md-materializer';

// Use a valid UUID-shaped invocation ID for tests
const VALID_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const INVOCATIONS_ROOT = '/tmp/invocations';

describe('materializeInvocationWorkspace', () => {
  afterEach(async () => {
    // Clean up any leftover test directories
    try {
      await fs.rm(path.join(INVOCATIONS_ROOT, VALID_ID), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates expected directory structure with cwd and home', async () => {
    const workspace = await materializeInvocationWorkspace(VALID_ID, '# Test');

    try {
      const cwdStat = await fs.stat(workspace.cwd);
      expect(cwdStat.isDirectory()).toBe(true);

      const homeStat = await fs.stat(workspace.home);
      expect(homeStat.isDirectory()).toBe(true);

      expect(workspace.cwd).toBe(path.join(INVOCATIONS_ROOT, VALID_ID));
      expect(workspace.home).toBe(path.join(INVOCATIONS_ROOT, VALID_ID, 'home'));
    } finally {
      await workspace.cleanup();
    }
  });

  it('writes CLAUDE.md with the provided content', async () => {
    const content = '# Agent Guide\n\nFollow these instructions.';
    const workspace = await materializeInvocationWorkspace(VALID_ID, content);

    try {
      const claudeMdPath = path.join(workspace.cwd, 'CLAUDE.md');
      const written = await fs.readFile(claudeMdPath, 'utf8');
      expect(written).toBe(content);
    } finally {
      await workspace.cleanup();
    }
  });

  it('cleanup removes the directory', async () => {
    const workspace = await materializeInvocationWorkspace(VALID_ID, '# Test');
    await workspace.cleanup();

    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
  });

  it('throws for an invocationId containing path traversal (..)', async () => {
    await expect(
      materializeInvocationWorkspace('../etc/passwd', '# Evil'),
    ).rejects.toThrow('invalid invocationId shape');
  });

  it('throws for an invocationId containing a forward slash', async () => {
    await expect(
      materializeInvocationWorkspace('abc/def', '# Evil'),
    ).rejects.toThrow('invalid invocationId shape');
  });

  it('throws for an empty invocationId', async () => {
    await expect(
      materializeInvocationWorkspace('', '# Empty'),
    ).rejects.toThrow('invalid invocationId shape');
  });

  it('cleanup is idempotent — calling it twice does not throw', async () => {
    const workspace = await materializeInvocationWorkspace(VALID_ID, '# Test');

    await workspace.cleanup();
    // Second call should not throw
    await expect(workspace.cleanup()).resolves.toBeUndefined();
  });

  it('when claudeMdContent is null, creates directory but does not write CLAUDE.md', async () => {
    const workspace = await materializeInvocationWorkspace(VALID_ID, null);

    try {
      // Directory structure should exist
      const cwdStat = await fs.stat(workspace.cwd);
      expect(cwdStat.isDirectory()).toBe(true);

      const homeStat = await fs.stat(workspace.home);
      expect(homeStat.isDirectory()).toBe(true);

      // CLAUDE.md should NOT exist
      await expect(fs.stat(path.join(workspace.cwd, 'CLAUDE.md'))).rejects.toThrow();
    } finally {
      await workspace.cleanup();
    }
  });
});
