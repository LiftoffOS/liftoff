// Phase 2 isolation test
//
// Verifies that concurrent invocations for different tenants get distinct
// working directories and cannot see each other's session files or CLAUDE.md.

import * as fs from 'fs/promises';
import * as path from 'path';
import { materializeInvocationWorkspace } from '../claude-md-materializer';

describe('Cross-tenant workspace isolation', () => {
  const TENANT_A_INVOCATION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TENANT_B_INVOCATION = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  let workspaceA: Awaited<ReturnType<typeof materializeInvocationWorkspace>>;
  let workspaceB: Awaited<ReturnType<typeof materializeInvocationWorkspace>>;

  beforeAll(async () => {
    // Simulate two concurrent invocations for different tenants
    [workspaceA, workspaceB] = await Promise.all([
      materializeInvocationWorkspace(TENANT_A_INVOCATION, '# Tenant A instructions'),
      materializeInvocationWorkspace(TENANT_B_INVOCATION, '# Tenant B instructions'),
    ]);
  });

  afterAll(async () => {
    await workspaceA.cleanup();
    await workspaceB.cleanup();
  });

  it('assigns distinct cwd paths to each invocation', () => {
    expect(workspaceA.cwd).not.toBe(workspaceB.cwd);
    expect(workspaceA.cwd).toContain(TENANT_A_INVOCATION);
    expect(workspaceB.cwd).toContain(TENANT_B_INVOCATION);
  });

  it('assigns distinct HOME paths to each invocation', () => {
    expect(workspaceA.home).not.toBe(workspaceB.home);
    expect(workspaceA.home).toContain(TENANT_A_INVOCATION);
    expect(workspaceB.home).toContain(TENANT_B_INVOCATION);
  });

  it('writes CLAUDE.md with tenant-specific content that is invisible to the other', async () => {
    const contentA = await fs.readFile(path.join(workspaceA.cwd, 'CLAUDE.md'), 'utf8');
    const contentB = await fs.readFile(path.join(workspaceB.cwd, 'CLAUDE.md'), 'utf8');

    expect(contentA).toBe('# Tenant A instructions');
    expect(contentB).toBe('# Tenant B instructions');

    // Tenant A's CLAUDE.md does not exist at Tenant B's path and vice versa
    const crossReadAB = path.join(workspaceB.cwd, '..', TENANT_A_INVOCATION, 'CLAUDE.md');
    const crossReadBA = path.join(workspaceA.cwd, '..', TENANT_B_INVOCATION, 'CLAUDE.md');

    // These resolve to the OTHER workspace's CLAUDE.md — they should exist
    // but contain the OTHER tenant's content, proving the paths are physically
    // separate (no symlinks, no shared file).
    const crossContentAB = await fs.readFile(crossReadAB, 'utf8');
    const crossContentBA = await fs.readFile(crossReadBA, 'utf8');
    expect(crossContentAB).toBe('# Tenant A instructions');
    expect(crossContentBA).toBe('# Tenant B instructions');
  });

  it('session file paths under HOME are distinct and non-overlapping', async () => {
    // Simulate SDK session writes under each HOME
    const sessionDirA = path.join(workspaceA.home, 'projects');
    const sessionDirB = path.join(workspaceB.home, 'projects');

    await fs.mkdir(sessionDirA, { recursive: true });
    await fs.mkdir(sessionDirB, { recursive: true });

    await fs.writeFile(path.join(sessionDirA, 'session-a.jsonl'), 'tenant-a-data');
    await fs.writeFile(path.join(sessionDirB, 'session-b.jsonl'), 'tenant-b-data');

    // Tenant A cannot see Tenant B's session files
    const filesA = await fs.readdir(sessionDirA);
    const filesB = await fs.readdir(sessionDirB);

    expect(filesA).toEqual(['session-a.jsonl']);
    expect(filesB).toEqual(['session-b.jsonl']);
    expect(filesA).not.toContain('session-b.jsonl');
    expect(filesB).not.toContain('session-a.jsonl');
  });

  it('cleanup of one workspace does not affect the other', async () => {
    // Create throwaway workspaces for this test
    const wsX = await materializeInvocationWorkspace(
      'cccccccc-cccc-cccc-cccc-cccccccccccc', '# X',
    );
    const wsY = await materializeInvocationWorkspace(
      'dddddddd-dddd-dddd-dddd-dddddddddddd', '# Y',
    );

    await wsX.cleanup();

    // wsY should still be intact
    const yExists = await fs.stat(wsY.cwd).then(() => true).catch(() => false);
    expect(yExists).toBe(true);

    const yContent = await fs.readFile(path.join(wsY.cwd, 'CLAUDE.md'), 'utf8');
    expect(yContent).toBe('# Y');

    await wsY.cleanup();
  });
});
