// Provisioner tests — token uniqueness, secret entropy, idempotent
// re-provision (no new secret), default rule creation, lifecycle (pause +
// resume preserves credentials), credentials reset (atomic url + secret
// rotation + audit-log emit via logAudit).

// Set encryption key BEFORE importing modules that touch encryptSecret.
process.env.EVENT_SOURCE_ENCRYPTION_KEY = 'a'.repeat(64);

const logAuditMock = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  __esModule: true,
  logAudit: (...args: unknown[]) => logAuditMock(...args),
  // Keep the other exports the source files import (createLogger, log)
  // available as no-ops so the module loads cleanly.
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  shutdownLogger: jest.fn(),
}));

jest.mock('../../infrastructure/database', () => {
  type Row = Record<string, unknown>;
  // In-memory mock of event_sources and event_trigger_rules. The dedicated
  // event_source_audit_log table is gone post-migration 219; audit rows now
  // land in audit_log via the buffered logAudit() pipeline (mocked above).
  const tables = {
    event_sources: [] as Row[],
    event_trigger_rules: [] as Row[],
  };
  const clientMock = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT s\.id, s\.url_token FROM event_sources s JOIN event_trigger_rules r/.test(s)) {
        const [tenantId, agentId] = params as [string, string];
        const row = tables.event_sources.find((src) => {
          if (src.tenant_id !== tenantId) return false;
          return tables.event_trigger_rules.some(
            (r) => r.source_id === src.id && r.tenant_id === tenantId && r.agent_id === agentId,
          );
        });
        return { rows: row ? [{ id: row.id, url_token: row.url_token }] : [], rowCount: row ? 1 : 0 };
      }
      if (/UPDATE event_sources SET name = \$1, updated_at = NOW\(\)/.test(s)) {
        const [name, sourceId, tenantId] = params as string[];
        const row = tables.event_sources.find((r) => r.id === sourceId && r.tenant_id === tenantId);
        if (row) row.name = name;
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (/INSERT INTO event_sources/.test(s)) {
        const [tenant_id, name, url_token, signing_secret_ciphertext, signing_secret_hint] =
          params as [string, string, string, Buffer, string];
        const id = `src-${tables.event_sources.length + 1}`;
        tables.event_sources.push({
          id, tenant_id, name, url_token,
          signing_secret_ciphertext, signing_secret_hint,
          enabled: false,
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/INSERT INTO event_trigger_rules/.test(s)) {
        const [tenant_id, source_id, agent_id] = params as string[];
        tables.event_trigger_rules.push({
          id: `rule-${tables.event_trigger_rules.length + 1}`,
          tenant_id, source_id, agent_id, event_type_pattern: '*', enabled: true,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE event_sources SET url_token/.test(s)) {
        const [urlToken, ciphertext, hint, sourceId, tenantId] =
          params as [string, Buffer, string, string, string];
        const row = tables.event_sources.find((r) => r.id === sourceId && r.tenant_id === tenantId);
        if (!row) return { rows: [], rowCount: 0 };
        row.url_token = urlToken;
        row.signing_secret_ciphertext = ciphertext;
        row.signing_secret_hint = hint;
        return { rows: [{ id: sourceId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return {
    withTenantScope: jest.fn(async (_tenantId: string, fn: (c: typeof clientMock) => unknown) =>
      fn(clientMock),
    ),
    __tables: tables,
    __clientMock: clientMock,
  };
});

import { provisionForAgent, resetCredentials, findExistingSourceForAgent } from '../provisioner';
import * as db from '../../infrastructure/database';

const tables = (db as unknown as { __tables: {
  event_sources: Array<Record<string, unknown>>;
  event_trigger_rules: Array<Record<string, unknown>>;
} }).__tables;
const clientMock = (db as unknown as { __clientMock: { query: jest.Mock } }).__clientMock;

beforeEach(() => {
  tables.event_sources.length = 0;
  tables.event_trigger_rules.length = 0;
  clientMock.query.mockClear();
  logAuditMock.mockClear();
});

describe('provisionForAgent', () => {
  it('creates source + default rule + emits webhook.created audit on first call', async () => {
    const result = await provisionForAgent({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      agentName: 'Acme Bot',
      actorUserId: 'user-1',
    });

    expect(result.newSecret).toBeTruthy();
    expect(result.newSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.urlToken).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(tables.event_sources).toHaveLength(1);
    const src = tables.event_sources[0];
    expect(src.name).toBe('Acme Bot webhook');
    expect(src.enabled).toBe(false);

    expect(tables.event_trigger_rules).toHaveLength(1);
    const rule = tables.event_trigger_rules[0];
    expect(rule.event_type_pattern).toBe('*');
    expect(rule.agent_id).toBe('agent-1');
    expect(rule.enabled).toBe(true);

    // Audit row emitted exactly once with the right shape.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      'webhook.created',
      { tenantId: 'tenant-1', userId: 'user-1' },
      expect.objectContaining({
        resourceType: 'event_source',
        resourceId: result.sourceId,
        newState: expect.objectContaining({ agentId: 'agent-1' }),
      }),
    );
  });

  it('is idempotent — second call returns existing url + null secret and emits NO audit', async () => {
    const first = await provisionForAgent({
      tenantId: 'tenant-1', agentId: 'agent-1', actorUserId: 'user-1',
    });
    logAuditMock.mockClear();
    const second = await provisionForAgent({
      tenantId: 'tenant-1', agentId: 'agent-1', actorUserId: 'user-1',
    });
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.urlToken).toBe(first.urlToken);
    expect(second.newSecret).toBeNull();
    expect(tables.event_sources).toHaveLength(1);
    expect(tables.event_trigger_rules).toHaveLength(1);
    // No second webhook.created audit row — re-provisioning is a no-op.
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it('generates unique tokens across agents', async () => {
    const a = await provisionForAgent({ tenantId: 't', agentId: 'a1', actorUserId: 'u' });
    const b = await provisionForAgent({ tenantId: 't', agentId: 'a2', actorUserId: 'u' });
    expect(a.urlToken).not.toBe(b.urlToken);
    expect(a.newSecret).not.toBe(b.newSecret);
  });
});

describe('findExistingSourceForAgent', () => {
  it('returns null when no source exists', async () => {
    const result = await findExistingSourceForAgent(clientMock as never, 'tenant-1', 'agent-1');
    expect(result).toBeNull();
  });

  it('returns the source after provisioning', async () => {
    await provisionForAgent({ tenantId: 'tenant-1', agentId: 'agent-1', actorUserId: 'u' });
    const result = await findExistingSourceForAgent(clientMock as never, 'tenant-1', 'agent-1');
    expect(result).toMatchObject({ sourceId: expect.any(String), urlToken: expect.any(String) });
  });
});

describe('resetCredentials (lifecycle)', () => {
  it('rotates url AND secret atomically and emits a webhook.credentials_reset audit', async () => {
    const original = await provisionForAgent({
      tenantId: 'tenant-1', agentId: 'agent-1', actorUserId: 'u',
    });
    logAuditMock.mockClear();

    const reset = await resetCredentials({
      tenantId: 'tenant-1', sourceId: original.sourceId, actorUserId: 'u',
    });

    expect(reset.urlToken).not.toBe(original.urlToken);
    expect(reset.newSecret).not.toBe(original.newSecret);
    expect(reset.newSecret).toMatch(/^[0-9a-f]{64}$/);

    // Source row reflects the new credentials. The secret is stored as an
    // AES-GCM ciphertext buffer — we verify rotation by decrypting back to
    // the plaintext we expect.
    const src = tables.event_sources[0];
    expect(src.url_token).toBe(reset.urlToken);
    const { decryptSecret } = await import('../secret-encryption');
    expect(decryptSecret(src.signing_secret_ciphertext as Buffer)).toBe(reset.newSecret);

    // Trigger rule is preserved (lifecycle: pause/reset doesn't touch rules).
    expect(tables.event_trigger_rules).toHaveLength(1);
    expect(tables.event_trigger_rules[0].source_id).toBe(original.sourceId);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      'webhook.credentials_reset',
      { tenantId: 'tenant-1', userId: 'u' },
      expect.objectContaining({
        resourceType: 'event_source',
        resourceId: original.sourceId,
        newState: expect.objectContaining({ urlToken: reset.urlToken }),
      }),
    );
  });

  it('throws when the source does not exist', async () => {
    await expect(
      resetCredentials({ tenantId: 'tenant-1', sourceId: 'does-not-exist', actorUserId: 'u' }),
    ).rejects.toThrow('event source not found');
  });
});
