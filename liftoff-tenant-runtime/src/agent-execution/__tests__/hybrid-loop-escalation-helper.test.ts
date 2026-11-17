// Verifies the D14 extension of createEscalation: when opts.kind ===
// 'system_internal', the streamingService.emitHitlRequired SSE event must
// NOT fire (operator inbox only — not customer-facing /reviews).

jest.mock('../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn() },
}));

jest.mock('../../audit/service', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));


import { createEscalation } from '../engine/escalation-helper';
import { streamingService } from '../../streaming/service';
import { insertAuditLog } from '../../audit/service';

const baseCtx = {
  tenantId: 't',
  agentId: 'a',
  workflowId: 'w',
  taskId: 'k',
  instructionVersion: 0,
  instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' } as any,
  traceId: 'tr',
  agentType: 'agent' as const,
  hitlLevel: 3,
  modelConfig: {},
  execConfig: {},
  memoryScope: {},
  threadId: 'th',
  invocationId: 'inv',
} as any;

describe('createEscalation D14 kind dispatch', () => {
  beforeEach(() => {
    (streamingService.emitHitlRequired as jest.Mock).mockClear();
    (insertAuditLog as jest.Mock).mockClear();
    mockQuery.mockClear();
  });

  it("default kind='escalation' emits the HITL SSE event", async () => {
    await createEscalation(baseCtx, 'r');
    expect(streamingService.emitHitlRequired).toHaveBeenCalledTimes(1);
  });

  it("kind='system_internal' SKIPS the HITL SSE event (operator inbox only)", async () => {
    await createEscalation(baseCtx, 'r', { kind: 'system_internal' });
    expect(streamingService.emitHitlRequired).not.toHaveBeenCalled();
  });

  it("INSERT includes the kind column for both cases", async () => {
    await createEscalation(baseCtx, 'r');
    const escInsert = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO workflow_escalations'),
    );
    expect(escInsert).toBeDefined();
    // The INSERT carries (escalationId, workflowId, taskId, agentId, tenantId,
    // reason, kind, reason_fingerprint, instruction_version, context) as
    // positional params; `kind` is the seventh, the two dedupe keys follow it
    // (NULL when the caller supplied none), then the context (NULL unless the
    // writer said why the row landed on this surface, migration 429).
    const params1 = escInsert![1] as unknown[];
    expect(params1[6]).toBe('escalation');
    expect(params1.slice(7)).toEqual([null, null, null]);

    mockQuery.mockClear();
    await createEscalation(baseCtx, 'r', { kind: 'system_internal' });
    const escInsert2 = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO workflow_escalations'),
    );
    const params2 = escInsert2![1] as unknown[];
    expect(params2[6]).toBe('system_internal');
  });
});

describe('createEscalation dedup', () => {
  beforeEach(() => {
    (streamingService.emitHitlRequired as jest.Mock).mockClear();
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('bumps an existing open escalation instead of inserting a new one', async () => {
    // First query is the dedup UPDATE … RETURNING; returning a row means an
    // open escalation already exists for this agent.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-esc', occurrence_count: 2 }] });

    const id = await createEscalation(baseCtx, 'still blocked');

    expect(id).toBe('existing-esc');
    // No new INSERT and no SSE — the repeat collapsed into the existing row.
    const insertCall = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO workflow_escalations'),
    );
    expect(insertCall).toBeUndefined();
    expect(streamingService.emitHitlRequired).not.toHaveBeenCalled();
  });

  it('inserts a fresh escalation when none is open for the agent', async () => {
    // dedup UPDATE returns no row → falls through to the insert path.
    const id = await createEscalation(baseCtx, 'first time');

    const insertCall = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO workflow_escalations'),
    );
    expect(insertCall).toBeDefined();
    expect(id).not.toBe('existing-esc');
  });
});
