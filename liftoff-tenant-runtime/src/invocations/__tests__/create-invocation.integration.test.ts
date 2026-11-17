// Integration test for InvocationsService.createInvocation against a REAL schema
// (migration 321 applied). Proves the engine-provenance INSERT actually executes
// and resolves execution_engine from the provider — the mock-pool unit suite
// cannot catch a column/placeholder/constraint mismatch. Skipped unless
// TEST_DATABASE_URL is set (invocations table + migration 321 present).

import { Pool } from 'pg';

// getPoolForService is mocked to return a pool bound to TEST_DATABASE_URL so the
// real service SQL runs against the migrated test DB. `mock`-prefixed name is
// required for a jest.mock factory to close over it.
const mockPool = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : (undefined as unknown as Pool);
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => mockPool }));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { InvocationsService } from '../service';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('InvocationsService.createInvocation — engine provenance (integration)', () => {
  const svc = new InvocationsService();
  const tenantId = '00000000-0000-0000-0000-0000000000e1';
  const agentId = '00000000-0000-0000-0000-0000000000e2';

  afterAll(async () => {
    await mockPool.query('DELETE FROM invocations WHERE tenant_id = $1', [tenantId]);
    await mockPool.end();
  });

  function withEnv(flag: string | undefined, fn: () => Promise<void>): Promise<void> {
    const prev = process.env.OPENAI_ENGINE;
    if (flag === undefined) delete process.env.OPENAI_ENGINE; else process.env.OPENAI_ENGINE = flag;
    return fn().finally(() => { if (prev === undefined) delete process.env.OPENAI_ENGINE; else process.env.OPENAI_ENGINE = prev; });
  }

  it('persists execution_engine=openai-codex for an openai invocation (default flags)', async () => {
    await withEnv(undefined, async () => {
      const inv = await svc.createInvocation({ tenantId, agentId, triggeredBy: 'human', provider: 'openai' });
      expect(inv.executionEngine).toBe('openai-codex');
      const row = await mockPool.query('SELECT execution_engine FROM invocations WHERE id = $1', [inv.id]);
      expect(row.rows[0].execution_engine).toBe('openai-codex');
    });
  });

  it('persists execution_engine=openai-agents when OPENAI_ENGINE=agents', async () => {
    await withEnv('agents', async () => {
      const inv = await svc.createInvocation({ tenantId, agentId, triggeredBy: 'human', provider: 'openai' });
      expect(inv.executionEngine).toBe('openai-agents');
    });
  });

  it('persists execution_engine=claude-agent-sdk for anthropic, via the explicit-id branch', async () => {
    const id = '00000000-0000-0000-0000-0000000000e9';
    const inv = await svc.createInvocation({ id, tenantId, agentId, triggeredBy: 'agent', provider: 'anthropic' });
    expect(inv.id).toBe(id);
    expect(inv.executionEngine).toBe('claude-agent-sdk');
  });
});
