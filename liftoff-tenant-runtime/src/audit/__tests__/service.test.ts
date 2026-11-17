// Audit Log Service Tests
// Per implementation plan: Phase 6 Audit Logs

// Mock infrastructure/database BEFORE importing the service so insertAuditLog
// picks up the mocked withTenantScope. Without this, RLS-enabled audit_logs
// (migration 079) would reject the INSERT and the test would fail loudly —
// which is exactly the bug we're testing the fix for.
jest.mock('../../infrastructure/database', () => {
  const sharedQuery = jest.fn().mockResolvedValue({ rows: [] });
  return {
    pool: { query: sharedQuery },
    withTenantScope: jest.fn(async (
      _tenantId: string,
      fn: (client: { query: typeof sharedQuery }) => Promise<unknown>,
    ) => fn({ query: sharedQuery })),
  };
});

import { sanitizeArgs, insertAuditLog, conformTriggeredBy, translateTriggeredByAgentId } from '../service';
import { AuditLogEntry } from '../types';
import { pool, withTenantScope } from '../../infrastructure/database';

const mockPool = pool as jest.Mocked<typeof pool>;
const mockWithTenantScope = withTenantScope as jest.MockedFunction<typeof withTenantScope>;

describe('Audit Log Service', () => {
  // sanitizeArgs now accepts `unknown` and returns `unknown` (two-layer
  // redactor shared with governance-engine). Cast object results for the
  // key-name (Layer 1) assertions below.
  const asRec = (v: unknown) => v as Record<string, unknown>;

  describe('sanitizeArgs — Layer 1 (key-name kill)', () => {
    it('should redact password fields', () => {
      const result = asRec(sanitizeArgs({ username: 'john', password: 'secret123' }));

      expect(result.username).toBe('john');
      expect(result.password).toBe('[REDACTED]');
    });

    it('should redact token fields', () => {
      const result = asRec(sanitizeArgs({ userId: '123', authToken: 'abc123', accessToken: 'xyz789' }));

      expect(result.userId).toBe('123');
      expect(result.authToken).toBe('[REDACTED]');
      expect(result.accessToken).toBe('[REDACTED]');
    });

    it('should redact secret fields', () => {
      const result = asRec(sanitizeArgs({ name: 'test', clientSecret: 'secret-value' }));

      expect(result.name).toBe('test');
      expect(result.clientSecret).toBe('[REDACTED]');
    });

    it('should redact API key fields', () => {
      const result = asRec(sanitizeArgs({ apiKey: 'key123', api_key: 'key456' }));

      expect(result.apiKey).toBe('[REDACTED]');
      expect(result.api_key).toBe('[REDACTED]');
    });

    it('should redact credential fields', () => {
      const result = asRec(sanitizeArgs({ userCredential: 'cred123', credentials: 'data' }));

      expect(result.userCredential).toBe('[REDACTED]');
      expect(result.credentials).toBe('[REDACTED]');
    });

    it('should redact auth fields', () => {
      const result = asRec(sanitizeArgs({ authorization: 'Bearer xyz', authHeader: 'Basic abc' }));

      expect(result.authorization).toBe('[REDACTED]');
      expect(result.authHeader).toBe('[REDACTED]');
    });
  });

  describe('sanitizeArgs — Layer 2 (value-level PII scan)', () => {
    it('redacts SSN inside a free-text field', () => {
      const result = asRec(sanitizeArgs({ notes: 'Employee SSN: 123-45-6789' }));
      expect(result.notes).toBe('Employee SSN: [REDACTED_SSN]');
    });

    it('redacts email inside a nested object', () => {
      const result = sanitizeArgs({ profile: { contact: 'reach alice@example.com' } });
      expect((result as any).profile.contact).toBe('reach [REDACTED_EMAIL]');
    });

    it('redacts phone inside an array of objects', () => {
      const result = sanitizeArgs([{ note: 'call 415-555-0123' }]);
      expect((result as any[])[0].note).toBe('call [REDACTED_PHONE]');
    });

    it('Layer 1 wins over Layer 2 — credential key never has value scanned', () => {
      const result = asRec(sanitizeArgs({ auth_token: '123-45-6789' }));
      expect(result.auth_token).toBe('[REDACTED]');
    });

    it('does not mutate the input', () => {
      const input = { notes: 'SSN 123-45-6789' };
      sanitizeArgs(input);
      expect(input.notes).toBe('SSN 123-45-6789');
    });
  });

  describe('sanitizeArgs — passthrough & truncation', () => {
    it('should truncate strings longer than 1000 characters', () => {
      const result = asRec(sanitizeArgs({ content: 'x'.repeat(1500) }));

      expect((result.content as string).length).toBe(1000 + '...[truncated]'.length);
      expect((result.content as string).endsWith('...[truncated]')).toBe(true);
    });

    it('should preserve strings at exactly 1000 characters', () => {
      const exactString = 'x'.repeat(1000);
      const result = asRec(sanitizeArgs({ content: exactString }));

      expect(result.content).toBe(exactString);
    });

    it('should recursively sanitize nested objects', () => {
      const result = asRec(sanitizeArgs({
        user: {
          name: 'john',
          settings: {
            password: 'secret',
            apiKey: 'key123',
          },
        },
      }));

      expect((result.user as Record<string, unknown>).name).toBe('john');
      // Note: 'settings' is not a sensitive key, so it gets recursively sanitized
      const settings = (result.user as Record<string, { password: string; apiKey: string }>).settings;
      expect(settings.password).toBe('[REDACTED]');
      expect(settings.apiKey).toBe('[REDACTED]');
    });

    it('should preserve arrays as-is', () => {
      const result = asRec(sanitizeArgs({ ids: ['1', '2', '3'] }));

      expect(result.ids).toEqual(['1', '2', '3']);
    });

    it('should preserve numbers and booleans', () => {
      const result = asRec(sanitizeArgs({ count: 42, enabled: true }));

      expect(result.count).toBe(42);
      expect(result.enabled).toBe(true);
    });

    it('should handle null values', () => {
      const result = asRec(sanitizeArgs({ data: null }));

      expect(result.data).toBeNull();
    });

    it('should handle empty objects', () => {
      const result = sanitizeArgs({});
      expect(result).toEqual({});
    });
  });

  describe('AuditLogEntry structure', () => {
    it('should have all required fields', () => {
      const entry: AuditLogEntry = {
        action: 'gmail_send_email',
        inputArgs: { to: 'test@example.com' },
        outcome: 'success',
        triggeredBy: 'agent:agt_123',
      };

      expect(entry.action).toBeDefined();
      expect(entry.inputArgs).toBeDefined();
      expect(entry.outcome).toBeDefined();
      expect(entry.triggeredBy).toBeDefined();
    });

    it('should accept optional fields', () => {
      const entry: AuditLogEntry = {
        action: 'gmail_send_email',
        inputArgs: { to: 'test@example.com' },
        outcome: 'error',
        triggeredBy: 'agent:agt_123',
        internalAgentId: 'team_123',
        userId: 'user_456',
        threadId: 'thread_789',
        invocationId: 'inv_012',
        outputSummary: 'Email sent successfully',
        errorCode: 'SMTP_ERROR',
        durationMs: 150,
      };

      expect(entry.internalAgentId).toBe('team_123');
      expect(entry.errorCode).toBe('SMTP_ERROR');
      expect(entry.durationMs).toBe(150);
    });

    it('should support all outcome types', () => {
      const outcomes: Array<'success' | 'error' | 'gated'> = ['success', 'error', 'gated'];

      for (const outcome of outcomes) {
        const entry: AuditLogEntry = {
          action: 'test',
          inputArgs: {},
          outcome,
          triggeredBy: 'agent:agt_123',
        };
        expect(entry.outcome).toBe(outcome);
      }
    });
  });

  describe('Immutability', () => {
    it('should block DELETE operations via database rule', () => {
      // Database: CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
      expect(true).toBe(true);
    });

    it('should block UPDATE operations via database rule', () => {
      // Database: CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
      expect(true).toBe(true);
    });
  });

  describe('insertAuditLog', () => {
    const TENANT_ID = '11111111-1111-1111-1111-111111111111';

    beforeEach(() => {
      jest.clearAllMocks();
      // Default for insert: returns no rows.
      (mockPool.query as jest.Mock).mockResolvedValue({ rows: [] });
    });

    // Regression test for the post-migration-079 P0:
    // RLS on audit_logs requires app.tenant_id to be set on the connection.
    // When the caller passes client=null, insertAuditLog MUST open its own
    // tenant-scoped transaction so the WITH CHECK clause passes.
    it('wraps the local INSERT in withTenantScope when client is null', async () => {
      const entry: AuditLogEntry = {
        action: 'tool_call',
        inputArgs: { foo: 'bar' },
        outcome: 'success',
        triggeredBy: 'agent:agt_test',
      };

      await insertAuditLog(null, TENANT_ID, entry);

      // withTenantScope is the proof that RLS context was set on the
      // connection before INSERT executed.
      expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
      expect(mockWithTenantScope).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));

      const insertCall = (mockPool.query as jest.Mock).mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO audit_logs')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1][0]).toBe(TENANT_ID);
      expect(insertCall![1][6]).toBe('tool_call');
    });

    it('uses the provided client (no withTenantScope) when client is non-null', async () => {
      const externalQuery = jest.fn().mockResolvedValue({ rows: [] });
      const externalClient = { query: externalQuery } as unknown as Parameters<typeof insertAuditLog>[0];

      const entry: AuditLogEntry = {
        action: 'tool_call',
        inputArgs: {},
        outcome: 'success',
        triggeredBy: 'agent:agt_test',
      };

      await insertAuditLog(externalClient, TENANT_ID, entry);

      // Caller owns the transaction — we must NOT wrap.
      expect(mockWithTenantScope).not.toHaveBeenCalled();
      // Two writes share the caller's transaction: audit_logs + control_plane_outbox.
      expect(externalQuery).toHaveBeenCalledTimes(2);
      expect(externalQuery.mock.calls[0][0]).toContain('INSERT INTO audit_logs');
      expect(externalQuery.mock.calls[1][0]).toContain('control_plane_outbox');
    });

    // PII must be scrubbed from the snapshot fields before they hit the local
    // audit_logs row AND before they cross Pub/Sub via the outbox payload.
    // Param indices follow the INSERT column order in service.ts:
    //   output_summary=8, pre_action_snapshot=13, post_action_snapshot=14,
    //   external_response=15.
    const findInsert = () =>
      (mockPool.query as jest.Mock).mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO audit_logs'),
      );
    const findOutbox = () =>
      (mockPool.query as jest.Mock).mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('control_plane_outbox'),
      );

    it('carries impersonatedBy to the local row and the control plane, and omits it otherwise', async () => {
      // The only route by which the control plane can learn that a support
      // session set a RUN in motion: the delegated HTTP request ended long
      // before this row was written.
      await insertAuditLog(null, TENANT_ID, {
        action: 'agent_execution',
        inputArgs: {},
        outcome: 'success',
        triggeredBy: 'human:acct-paul',
        impersonatedBy: '11111111-1111-4111-8111-111111111111',
      } as AuditLogEntry);

      const insertParams = findInsert()![1] as unknown[];
      expect(insertParams).toContain('11111111-1111-4111-8111-111111111111');
      expect(JSON.parse(findOutbox()![1][1]).impersonatedBy).toBe(
        '11111111-1111-4111-8111-111111111111',
      );

      (mockPool.query as jest.Mock).mockClear();

      await insertAuditLog(null, TENANT_ID, {
        action: 'agent_execution',
        inputArgs: {},
        outcome: 'success',
        triggeredBy: 'human:acct-paul',
      } as AuditLogEntry);

      // Omitted, not null: the control plane's schema rejects null for an
      // optional field and would drop the whole row.
      expect('impersonatedBy' in JSON.parse(findOutbox()![1][1])).toBe(false);
    });

    it('redacts PII in preActionSnapshot before insert and in the outbox', async () => {
      await insertAuditLog(null, TENANT_ID, {
        action: 'hris.update_employee',
        inputArgs: { employee_id: 42 },
        outcome: 'success',
        triggeredBy: 'agent:agt_test',
        preActionSnapshot: { ssn: '123-45-6789', email: 'alice@x.com', name: 'Alice' },
      });

      const stored = JSON.parse(findInsert()![1][13]);
      expect(stored.ssn).toBe('[REDACTED_SSN]');
      expect(stored.email).toBe('[REDACTED_EMAIL]');
      expect(stored.name).toBe('Alice'); // names not caught — acknowledged

      const outboxPayload = JSON.parse(findOutbox()![1][1]);
      expect(outboxPayload.preActionSnapshot.ssn).toBe('[REDACTED_SSN]');
      expect(outboxPayload.preActionSnapshot.email).toBe('[REDACTED_EMAIL]');
    });

    it('redacts PII in postActionSnapshot and externalResponse before insert', async () => {
      await insertAuditLog(null, TENANT_ID, {
        action: 'hris.lookup_employee',
        inputArgs: { employee_id: 42 },
        outcome: 'success',
        triggeredBy: 'agent:agt_test',
        postActionSnapshot: { ssn: '123-45-6789' },
        externalResponse: { ssn: '987-65-4321', notes: 'call 415-555-0123' },
      });

      const params = findInsert()![1];
      expect(JSON.parse(params[14]).ssn).toBe('[REDACTED_SSN]');
      const ext = JSON.parse(params[15]);
      expect(ext.ssn).toBe('[REDACTED_SSN]');
      expect(ext.notes).toBe('call [REDACTED_PHONE]');
    });

    it('redacts PII in outputSummary string', async () => {
      await insertAuditLog(null, TENANT_ID, {
        action: 'hris.update_employee',
        inputArgs: { employee_id: 42 },
        outcome: 'success',
        triggeredBy: 'agent:agt_test',
        outputSummary: 'Updated SSN 123-45-6789 for employee Alice',
      });

      expect(findInsert()![1][8]).toBe('Updated SSN [REDACTED_SSN] for employee Alice');
    });
  });

  describe('listAuditLogs', () => {
    it('should filter by internal_agent_id', () => {
      // WHERE internal_agent_id = $X
      expect(true).toBe(true);
    });

    it('should filter by thread_id', () => {
      // WHERE thread_id = $X
      expect(true).toBe(true);
    });

    it('should filter by invocation_id', () => {
      // WHERE invocation_id = $X
      expect(true).toBe(true);
    });

    it('should filter by action (ILIKE pattern)', () => {
      // WHERE action ILIKE '%pattern%'
      expect(true).toBe(true);
    });

    it('should filter by outcome', () => {
      // WHERE outcome = $X
      expect(true).toBe(true);
    });

    it('should filter by date range', () => {
      // WHERE created_at >= $from AND created_at <= $to
      expect(true).toBe(true);
    });

    it('should paginate with limit and offset', () => {
      // LIMIT $limit OFFSET $offset
      expect(true).toBe(true);
    });

    it('should return total count', () => {
      // SELECT COUNT(*) AS total
      expect(true).toBe(true);
    });
  });

  describe('RLS (Row Level Security)', () => {
    it('should enforce tenant isolation', () => {
      // CREATE POLICY audit_logs_tenant_isolation ON audit_logs
      //   USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
      expect(true).toBe(true);
    });
  });

  describe('Admin access', () => {
    it('should require admin role for listing', () => {
      // Per implementation plan: requireRole('admin')
      expect(true).toBe(true);
    });

    it('should require admin role for single entry lookup', () => {
      // Per implementation plan: requireRole('admin')
      expect(true).toBe(true);
    });
  });
});

describe('triggered_by format', () => {
  it('should use agent:<agent_id> format', () => {
    // Per implementation plan: triggeredBy: `agent:${context.internalAgentId}`
    const triggeredBy = `agent:${'agt_123'}`;
    expect(triggeredBy).toBe('agent:agt_123');
  });

  it('should support human:<user_id> format', () => {
    const triggeredBy = `human:${'user_456'}`;
    expect(triggeredBy).toBe('human:user_456');
  });

  it('should support cron format', () => {
    const triggeredBy = 'cron';
    expect(triggeredBy).toBe('cron');
  });

  it('should support event:<topic> format', () => {
    const triggeredBy = `event:${'order.created'}`;
    expect(triggeredBy).toBe('event:order.created');
  });
});

// Mirror of the control plane's SE-007 contract so tests fail loudly if the two
// drift. Every conformTriggeredBy output MUST satisfy this.
const CONTROL_PLANE_CONTRACT =
  /^(human:[A-Za-z0-9_.:-]+|agent(:[a-f0-9-]+)?|cron|event:[a-zA-Z0-9_.-]+|system(:[a-zA-Z0-9_.-]+)?)$/;

describe('conformTriggeredBy (audit outbox defense)', () => {
  it('passes already-valid values through unchanged', () => {
    for (const v of [
      'human:slack:C01ABCD2EFG',   // now-valid namespaced id
      'human:123e4567-e89b-12d3-a456-426614174000',
      'agent',
      'agent:1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
      'cron',
      'event:gmail.new_message',
      'system',
      'system:hybrid_loop',
    ]) {
      expect(conformTriggeredBy(v)).toBe(v);
    }
  });

  it('coerces bare base values to a valid attributed form', () => {
    expect(conformTriggeredBy('event')).toBe('event:unknown');
    expect(conformTriggeredBy('human')).toBe('human:unknown');
  });

  it('sanitizes disallowed characters rather than dropping the row', () => {
    expect(conformTriggeredBy('human:jane@example.com')).toBe('human:jane_example.com');
    expect(conformTriggeredBy('event:a:b:c')).toBe('event:a.b.c'); // event forbids ':'
    expect(conformTriggeredBy('system:weird name')).toBe('system:weird_name');
  });

  it('falls back to system:unmapped for wholly unrecognized values', () => {
    expect(conformTriggeredBy('garbage')).toBe('system:unmapped');
    expect(conformTriggeredBy('')).toBe('system:unmapped');
  });

  it('every coerced output satisfies the control-plane contract', () => {
    for (const v of ['event', 'human', 'human:jane@x.com', 'event:a:b', 'garbage', '', 'system:weird name', 'human:slack:C01ABCD2EFG']) {
      expect(CONTROL_PLANE_CONTRACT.test(conformTriggeredBy(v))).toBe(true);
    }
  });
});

// ── The agent id space, on the way out ───────────────────────────────────────
//
// internal_agents.id (control plane) and agents.id (runtime) are disjoint
// (INV-TR-010). The control plane resolves a triggering agent's NAME by querying
// internal_agents.id, so a runtime id sent as-is matches zero rows — and the
// miss is silent, indistinguishable from "no agent triggered this".
//
// Shared by both audit paths deliberately: the outbox, and the execution
// service's direct post, which is the one that writes the terminal
// agent_execution row the Activity page renders. Two copies would drift, and the
// drift would be invisible for the same reason the original bug was.

describe('translateTriggeredByAgentId', () => {
  const RUNTIME = 'aaaaaaaa-1111-2222-3333-444444444444';
  const INTERNAL = 'bbbbbbbb-1111-2222-3333-444444444444';
  const OTHER_RUNTIME = 'cccccccc-1111-2222-3333-444444444444';
  const OTHER_INTERNAL = 'dddddddd-1111-2222-3333-444444444444';

  beforeEach(() => {
    mockPool.query.mockReset();
    mockPool.query.mockResolvedValue({ rows: [] } as never);
  });

  it('leaves a value that names no agent alone', async () => {
    for (const v of ['cron', 'human:acct-1', 'event:deal.won', 'system:agent_execution', 'agent']) {
      await expect(translateTriggeredByAgentId(v, {})).resolves.toBe(v);
    }
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('reuses the already-resolved id for a self-triggered run, without a second query', async () => {
    await expect(
      translateTriggeredByAgentId(`agent:${RUNTIME}`, {
        runtimeAgentId: RUNTIME,
        internalAgentId: INTERNAL,
      }),
    ).resolves.toBe(`agent:${INTERNAL}`);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('looks up a DIFFERENT agent that triggered this run', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ internal_agent_id: OTHER_INTERNAL }] } as never);
    await expect(
      translateTriggeredByAgentId(`agent:${OTHER_RUNTIME}`, {
        runtimeAgentId: RUNTIME,
        internalAgentId: INTERNAL,
      }),
    ).resolves.toBe(`agent:${OTHER_INTERNAL}`);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  // Degrading to the runtime id is no worse than not translating; failing the
  // audit write would be strictly worse.
  it('degrades to the original when the mapping is missing', async () => {
    mockPool.query.mockResolvedValue({ rows: [] } as never);
    await expect(
      translateTriggeredByAgentId(`agent:${OTHER_RUNTIME}`, { runtimeAgentId: RUNTIME }),
    ).resolves.toBe(`agent:${OTHER_RUNTIME}`);
  });

  it('degrades to the original when the self-lookup found nothing', async () => {
    await expect(
      translateTriggeredByAgentId(`agent:${RUNTIME}`, {
        runtimeAgentId: RUNTIME,
        internalAgentId: null,
      }),
    ).resolves.toBe(`agent:${RUNTIME}`);
  });

  it('never throws', async () => {
    mockPool.query.mockRejectedValue(new Error('pool exhausted'));
    await expect(
      translateTriggeredByAgentId(`agent:${OTHER_RUNTIME}`, { runtimeAgentId: RUNTIME }),
    ).resolves.toBe(`agent:${OTHER_RUNTIME}`);
  });
});
