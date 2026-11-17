import { SandboxExecutor, SandboxSession } from '../sandbox-executor';
import type { SandboxProvider, SandboxInstance, ExecResult } from '../types';
import { SandboxStateRepository } from '../sandbox-state-repository';
import { SandboxUsageRepository } from '../usage-repository';
import { SandboxAuditRepository } from '../audit-repository';
import { SandboxOutputSanitizer } from '../output-sanitizer';
import { SandboxRateLimiter } from '../rate-limiter';
import type { CreditCostProvider } from '../credit-calculator';
import { UsageLedgerService } from '../../usage-ledger/service';

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({
    query: jest.fn().mockResolvedValue({ rows: [{ cnt: '0' }] }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      release: jest.fn(),
    }),
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({
    recordUsage: jest.fn().mockResolvedValue(undefined),
  })),
}));

function createMockProvider(): jest.Mocked<SandboxProvider> {
  return {
    create: jest.fn().mockResolvedValue({
      sandboxId: 'test-sandbox-1',
      status: 'ready',
      workDir: '/workspace',
      createdAt: new Date(),
      lastHeartbeatAt: new Date(),
    } satisfies SandboxInstance),
    exec: jest.fn().mockResolvedValue({
      stdout: 'output',
      stderr: '',
      exitCode: 0,
    } satisfies ExecResult),
    readFile: jest.fn().mockResolvedValue('file content'),
    writeFile: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockStateRepo(): jest.Mocked<SandboxStateRepository> {
  return {
    // Provisioning is claimed before it starts, so the default is "this caller
    // won the claim" — the ordinary path every test below exercises.
    claimProvisioning: jest.fn().mockResolvedValue(true),
    hadDestroyedSandbox: jest.fn().mockResolvedValue(false),
    findFinishedAutonomous: jest.fn().mockResolvedValue([]),
    markProvisioned: jest.fn().mockResolvedValue(undefined),
    markProvisionFailed: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    getBySession: jest.fn().mockResolvedValue(null),
    getBySandboxId: jest.fn().mockResolvedValue(null),
    findOrphaned: jest.fn().mockResolvedValue([]),
    countActive: jest.fn().mockResolvedValue(0),
    stopBilling: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SandboxStateRepository>;
}

function createMockUsageRepo(): jest.Mocked<SandboxUsageRepository> {
  return {
    recordUsage: jest.fn().mockResolvedValue(undefined),
    getTotalCredits: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<SandboxUsageRepository>;
}

function createMockAuditRepo(): jest.Mocked<SandboxAuditRepository> {
  return {
    logToolCall: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SandboxAuditRepository>;
}

function createMockCreditProvider(): CreditCostProvider {
  return {
    getCreditCost: jest.fn().mockResolvedValue(2),
  };
}

const testSession: SandboxSession = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  invocationId: 'inv-1',
  sessionId: 'session-1',
};

function createExecutor(overrides?: {
  provider?: SandboxProvider;
  stateRepo?: SandboxStateRepository;
}) {
  const provider = overrides?.provider ?? createMockProvider();
  const stateRepo = overrides?.stateRepo ?? createMockStateRepo();
  const usageRepo = createMockUsageRepo();
  const auditRepo = createMockAuditRepo();
  const sanitizer = new SandboxOutputSanitizer();
  const rateLimiter = new SandboxRateLimiter();
  const creditProvider = createMockCreditProvider();
  const usageLedger = new UsageLedgerService();

  const executor = new SandboxExecutor(
    provider,
    stateRepo,
    usageRepo,
    auditRepo,
    sanitizer,
    rateLimiter,
    creditProvider,
    usageLedger,
  );

  return { executor, provider, stateRepo, usageRepo, auditRepo };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SandboxExecutor', () => {
  describe('execute — lifecycle', () => {
    it('creates a sandbox on first tool call', async () => {
      const { executor, provider, stateRepo } = createExecutor();

      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo', 'hi'] } });

      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(stateRepo.claimProvisioning).toHaveBeenCalledTimes(1);
      expect(stateRepo.markProvisioned).toHaveBeenCalledTimes(1);
    });

    it('claims the session BEFORE provisioning, not after', async () => {
      // Provisioning takes about a minute. Recording it only on completion
      // leaves that minute with no row at all: a second caller sees an unclaimed
      // session and provisions a duplicate, and a create that dies leaves a
      // Cloud Run service nothing references.
      const { executor, provider, stateRepo } = createExecutor();
      const order: string[] = [];
      (stateRepo.claimProvisioning as jest.Mock).mockImplementation(async () => {
        order.push('claim');
        return true;
      });
      (provider.create as jest.Mock).mockImplementation(async () => {
        order.push('create');
        return { sandboxId: 'sandbox-test', status: 'ready', workDir: '/workspace', createdAt: new Date(), lastHeartbeatAt: new Date() };
      });

      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo', 'hi'] } });

      expect(order).toEqual(['claim', 'create']);
    });

    it('releases the claim when provisioning throws', async () => {
      // Otherwise the session keeps a 'creating' row forever and every later
      // attempt waits on a provision that already died.
      const { executor, provider, stateRepo } = createExecutor();
      (provider.create as jest.Mock).mockRejectedValue(new Error('cloud run exploded'));

      // getOrCreate runs before execute's try block, so a provisioning failure
      // propagates rather than becoming a result — the claim must still be
      // released on the way out.
      await expect(
        executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo', 'hi'] } }),
      ).rejects.toThrow('cloud run exploded');

      expect(stateRepo.markProvisionFailed).toHaveBeenCalledTimes(1);
    });

    it('does not provision a second sandbox when another caller holds the claim', async () => {
      const { executor, provider, stateRepo } = createExecutor();
      (stateRepo.claimProvisioning as jest.Mock).mockResolvedValue(false);
      (stateRepo.getBySession as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValue({
          sandboxId: 'sandbox-winner', status: 'creating', createdAt: new Date(), lastHeartbeat: new Date(),
        });

      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo', 'hi'] } });

      expect(provider.create).not.toHaveBeenCalled();
    });

    it('reuses sandbox on subsequent tool calls', async () => {
      const { executor, provider } = createExecutor();

      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo', '1'] } });
      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo', '2'] } });

      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.exec).toHaveBeenCalledTimes(2);
    });

    it('returns error for unknown tool names', async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(testSession, { toolName: 'nonexistent', input: {} });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown sandbox tool');
    });
  });

  describe('execute — shell_exec', () => {
    it('passes args array to provider.exec', async () => {
      const { executor, provider } = createExecutor();
      await executor.execute(testSession, {
        toolName: 'shell_exec',
        input: { args: ['npm', 'test', '--verbose'] },
      });
      expect(provider.exec).toHaveBeenCalledWith(
        'test-sandbox-1',
        ['npm', 'test', '--verbose'],
        expect.objectContaining({ timeout: 60_000 }),
      );
    });

    it('caps timeout at 300000ms', async () => {
      const { executor, provider } = createExecutor();
      await executor.execute(testSession, {
        toolName: 'shell_exec',
        input: { args: ['sleep', '999'], timeout: 999_999 },
      });
      expect(provider.exec).toHaveBeenCalledWith(
        'test-sandbox-1',
        ['sleep', '999'],
        expect.objectContaining({ timeout: 300_000 }),
      );
    });
  });

  describe('execute — file operations', () => {
    it('file_read validates path', async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(testSession, {
        toolName: 'file_read',
        input: { path: '../../etc/passwd' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Path traversal');
    });

    it('file_read calls provider.readFile', async () => {
      const { executor, provider } = createExecutor();
      const result = await executor.execute(testSession, {
        toolName: 'file_read',
        input: { path: 'src/index.ts' },
      });
      expect(provider.readFile).toHaveBeenCalledWith('test-sandbox-1', '/workspace/src/index.ts');
      expect(result.success).toBe(true);
      expect(result.data.content).toBe('file content');
    });

    it('file_write validates path', async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(testSession, {
        toolName: 'file_write',
        input: { path: '/etc/shadow', content: 'hacked' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Path traversal');
    });

    it('file_write calls provider.writeFile', async () => {
      const { executor, provider } = createExecutor();
      await executor.execute(testSession, {
        toolName: 'file_write',
        input: { path: 'output.txt', content: 'hello' },
      });
      expect(provider.writeFile).toHaveBeenCalledWith('test-sandbox-1', '/workspace/output.txt', 'hello');
    });
  });

  describe('execute — git_commit_and_push', () => {
    it('rejects shell injection in branch name', async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(testSession, {
        toolName: 'git_commit_and_push',
        input: { files: ['a.ts'], message: 'test', branch: '; rm -rf /' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('rejects commit messages exceeding 500 chars', async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(testSession, {
        toolName: 'git_commit_and_push',
        input: { files: ['a.ts'], message: 'x'.repeat(501), branch: 'fix/test' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('filters secret files from staging', async () => {
      const { executor, provider } = createExecutor();
      await executor.execute(testSession, {
        toolName: 'git_commit_and_push',
        input: { files: ['app.ts', '.env', 'server.key'], message: 'test', branch: 'fix/test' },
      });
      // git add should only stage app.ts (not .env or server.key)
      expect(provider.exec).toHaveBeenCalledWith(
        'test-sandbox-1',
        ['git', 'add', '--', 'app.ts'],
        expect.anything(),
      );
    });

    it('rejects when all files are secrets', async () => {
      const { executor } = createExecutor();
      const result = await executor.execute(testSession, {
        toolName: 'git_commit_and_push',
        input: { files: ['.env', 'secrets.yaml'], message: 'test', branch: 'fix/test' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('No files to stage');
    });

    it('uses parameterized git commands (not shell string)', async () => {
      const { executor, provider } = createExecutor();
      await executor.execute(testSession, {
        toolName: 'git_commit_and_push',
        input: { files: ['app.ts'], message: 'fix: resolve bug', branch: 'fix/bug-123' },
      });
      // Verify git commit uses args array with -m flag (not interpolated shell string)
      expect(provider.exec).toHaveBeenCalledWith(
        'test-sandbox-1',
        ['git', 'commit', '-m', 'fix: resolve bug'],
        expect.anything(),
      );
      // Verify git push uses args array
      expect(provider.exec).toHaveBeenCalledWith(
        'test-sandbox-1',
        ['git', 'push', 'origin', 'fix/bug-123'],
        expect.anything(),
      );
    });
  });

  describe('cleanup', () => {
    it('calls provider.destroy and updates state', async () => {
      const stateRepo = createMockStateRepo();
      stateRepo.getBySession.mockResolvedValueOnce(null); // getOrCreate: no existing
      stateRepo.getBySandboxId.mockResolvedValueOnce({
        sandboxId: 'test-sandbox-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        invocationId: 'inv-1',
        status: 'ready',
        template: 'general-shell',
        createdAt: new Date(),
        lastHeartbeat: new Date(),
        destroyedAt: null,
      });

      const { executor, provider } = createExecutor({ stateRepo });

      // First execute to create sandbox
      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo'] } });
      // Then cleanup
      await executor.cleanup(testSession);

      expect(provider.destroy).toHaveBeenCalledWith('test-sandbox-1');
      expect(stateRepo.updateStatus).toHaveBeenCalledWith('test-sandbox-1', 'destroyed');
    });

    it('handles destroy failure gracefully (marks for GC)', async () => {
      const provider = createMockProvider();
      provider.destroy.mockRejectedValueOnce(new Error('Cloud Run API error'));

      const stateRepo = createMockStateRepo();
      stateRepo.getBySandboxId.mockResolvedValueOnce({
        sandboxId: 'test-sandbox-1',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        invocationId: 'inv-1',
        status: 'ready',
        template: 'general-shell',
        createdAt: new Date(),
        lastHeartbeat: new Date(),
        destroyedAt: null,
      });

      const { executor } = createExecutor({ provider, stateRepo });
      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo'] } });

      // Should not throw
      await expect(executor.cleanup(testSession)).resolves.not.toThrow();
      // Should still mark as destroyed (GC will handle the actual cleanup)
      expect(stateRepo.updateStatus).toHaveBeenCalledWith('test-sandbox-1', 'destroyed');
    });

    it('is idempotent — no-op if already destroyed', async () => {
      const stateRepo = createMockStateRepo();
      stateRepo.getBySession.mockResolvedValue(null);
      const { executor, provider } = createExecutor({ stateRepo });

      await executor.cleanup(testSession);
      expect(provider.destroy).not.toHaveBeenCalled();
    });
  });

  describe('gcSweep', () => {
    it('destroys orphaned sandboxes', async () => {
      const stateRepo = createMockStateRepo();
      stateRepo.findOrphaned.mockResolvedValueOnce([
        {
          sandboxId: 'orphan-1',
          sessionId: 'old-session',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          invocationId: 'inv-old',
          status: 'running',
          template: 'general-shell' as const,
          createdAt: new Date(Date.now() - 3_600_000),
          lastHeartbeat: new Date(Date.now() - 3_600_000),
          destroyedAt: null,
        },
      ]);

      const { executor, provider } = createExecutor({ stateRepo });
      const cleaned = await executor.gcSweep();

      expect(cleaned).toBe(1);
      expect(provider.destroy).toHaveBeenCalledWith('orphan-1');
      expect(stateRepo.updateStatus).toHaveBeenCalledWith('orphan-1', 'destroyed');
    });

    it('returns 0 when no orphans found', async () => {
      const { executor } = createExecutor();
      const cleaned = await executor.gcSweep();
      expect(cleaned).toBe(0);
    });
  });

  describe('cost tracking', () => {
    it('records usage in sandbox_usage_log', async () => {
      const { executor, usageRepo } = createExecutor();
      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo'] } });

      // Should record provision + execute usage
      expect(usageRepo.recordUsage).toHaveBeenCalledTimes(2); // 1 for provision, 1 for execute
    });

    it('records audit log entry via insertAuditLog', async () => {
      const { insertAuditLog } = jest.requireMock('../../audit') as { insertAuditLog: jest.Mock };
      const { executor } = createExecutor();

      await executor.execute(testSession, { toolName: 'shell_exec', input: { args: ['echo'] } });

      expect(insertAuditLog).toHaveBeenCalledWith(
        null,
        'tenant-1',
        expect.objectContaining({
          action: 'sandbox:shell_exec',
          outcome: 'success',
        }),
      );
    });
  });
});
