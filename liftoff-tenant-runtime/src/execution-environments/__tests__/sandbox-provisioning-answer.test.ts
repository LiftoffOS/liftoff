// A workspace that is starting gets an answer, not a held-open request.
//
// Provisioning takes about a minute. The call that triggers it used to wait for
// it, but the hop in front of the executor gives up at 60 seconds, so the caller
// received a gateway timeout while the provision carried on and completed. The
// work then landed in a workspace whose requester had already been told the
// operation failed — a worse outcome than a plain error, because the two sides
// disagreed about what happened.
//
// So: answer immediately, name the condition, and say when to come back.

import { SandboxExecutor } from '../sandbox-executor';
import type { SandboxStateRepository } from '../sandbox-state-repository';

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../usage-ledger/service', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({
    recordUsage: jest.fn().mockResolvedValue(undefined),
  })),
}));

const session = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  agentId: '22222222-2222-2222-2222-222222222222',
  invocationId: '33333333-3333-3333-3333-333333333333',
  sessionId: '44444444-4444-4444-4444-444444444444',
  instructionVersion: 1,
};

/** A repo whose session already carries a claim someone else is working on. */
function repoWithProvisioningInFlight(): SandboxStateRepository {
  return {
    claimProvisioning: jest.fn().mockResolvedValue(false),
    hadDestroyedSandbox: jest.fn().mockResolvedValue(false),
    findFinishedAutonomous: jest.fn().mockResolvedValue([]),
    markProvisioned: jest.fn(),
    markProvisionFailed: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    getBySession: jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        sandboxId: 'sandbox-inflight',
        status: 'creating',
        createdAt: new Date(),
        lastHeartbeat: new Date(),
      }),
    getBySandboxId: jest.fn().mockResolvedValue(null),
    findOrphaned: jest.fn().mockResolvedValue([]),
    countActive: jest.fn().mockResolvedValue(0),
    stopBilling: jest.fn(),
  } as unknown as SandboxStateRepository;
}

function makeExecutor(stateRepo: SandboxStateRepository) {
  const provider = {
    create: jest.fn(),
    exec: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    destroy: jest.fn(),
  };
  const executor = new SandboxExecutor(
    provider as never,
    stateRepo,
    { recordUsage: jest.fn().mockResolvedValue(undefined) } as never,
    { logToolCall: jest.fn() } as never,
    { sanitize: (s: string) => s } as never,
    { checkCreationAllowed: jest.fn().mockResolvedValue({ allowed: true }) } as never,
    {} as never,
    {} as never,
  );
  return { executor, provider };
}

describe('a workspace that is still starting', () => {
  it('answers immediately instead of waiting for the provision', async () => {
    const { executor, provider } = makeExecutor(repoWithProvisioningInFlight());

    const result = await executor.execute(session as never, {
      toolName: 'shell_exec',
      input: { args: ['echo', 'hi'] },
    });

    expect(result.success).toBe(false);
    // It must not have gone on to provision a second sandbox or dispatch.
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.exec).not.toHaveBeenCalled();
  });

  it('is marked retryable, with a wait', async () => {
    const { executor } = makeExecutor(repoWithProvisioningInFlight());

    const result = await executor.execute(session as never, {
      toolName: 'shell_exec',
      input: { args: ['echo', 'hi'] },
    });

    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe('vendor_unavailable');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('says what is happening in words a reader can act on', async () => {
    const { executor } = makeExecutor(repoWithProvisioningInFlight());

    const result = await executor.execute(session as never, {
      toolName: 'shell_exec',
      input: { args: ['echo', 'hi'] },
    });

    expect(result.error).toMatch(/starting/i);
    expect(result.error).not.toMatch(/timeout|504/i);
  });
});
