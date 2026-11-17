/**
 * Phase 4 of the deep-research-realtime-billing plan.
 *
 * publishWebToolEvent is the fire-and-forget Pub/Sub publisher used by every
 * web-tool emission site. Failures must NOT propagate (the 15-min ingester
 * backstop catches anything the push path drops), and must surface as a
 * structured WARN log so operators can correlate publish loss against the
 * ingester's catch-up landing.
 */

const mockPublish = jest.fn();
jest.mock('../../../infrastructure/pubsub', () => ({
  publisher: { publish: (...a: unknown[]) => mockPublish(...a) },
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockResolveInternalAgentId = jest.fn();
jest.mock('../../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => mockResolveInternalAgentId(...a),
}));

import { publishWebToolEvent } from '../event-publisher';

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveInternalAgentId.mockResolvedValue(null);
  process.env.ENVIRONMENT = 'dev';
  delete process.env.BILLING_PUBSUB_PROJECT_ID;
});

describe('publishWebToolEvent', () => {
  it('publishes to projects/<env-project>/topics/web-tool-events-<env>', () => {
    mockPublish.mockResolvedValueOnce('msg-id');
    publishWebToolEvent({
      tenantId: 't1',
      eventType: 'web_fetch_advanced',
      costUsd: 0.001,
      occurredAt: '2026-06-02T00:00:00Z',
      idempotencyKey: 'key-1',
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [topic, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(topic).toBe('projects/YOUR_CONTROL_PROJECT_STAGING/topics/web-tool-events-dev');
    expect(payload.tenantId).toBe('t1');
    expect(payload.eventType).toBe('web_fetch_advanced');
    expect(payload.costUsd).toBe(0.001);
    expect(payload.idempotencyKey).toBe('key-1');
  });

  it('honors BILLING_PUBSUB_PROJECT_ID override (for cross-project pushes in tests)', () => {
    process.env.BILLING_PUBSUB_PROJECT_ID = 'my-test-project';
    mockPublish.mockResolvedValueOnce('msg-id');
    publishWebToolEvent({
      tenantId: 't1',
      eventType: 'web_extract',
      costUsd: 0.005,
      occurredAt: '2026-06-02T00:00:00Z',
      idempotencyKey: 'key-2',
    });
    const [topic] = mockPublish.mock.calls[0] as [string];
    expect(topic).toBe('projects/my-test-project/topics/web-tool-events-dev');
  });

  it('forwards optional fields (agentId, invocationId, connector, threadId, metadata) in the payload', async () => {
    mockPublish.mockResolvedValueOnce('msg-id');
    await publishWebToolEvent({
      tenantId:       't1',
      agentId:        'agent-x',
      invocationId:   'inv-x',
      threadId:       null,
      connector:      'perplexity',
      eventType:      'web_deep_research',
      costUsd:        0.5,
      occurredAt:     '2026-06-02T00:00:00Z',
      idempotencyKey: 'deep-1',
      metadata:       { is_pre_charge: true, reasoning_effort: 'high' },
    });
    const payload = mockPublish.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.agentId).toBe('agent-x');
    expect(payload.invocationId).toBe('inv-x');
    expect(payload.threadId).toBeNull();
    expect(payload.connector).toBe('perplexity');
    expect((payload.metadata as Record<string, unknown>).is_pre_charge).toBe(true);
    expect((payload.metadata as Record<string, unknown>).reasoning_effort).toBe('high');
  });

  it("carries the agent's internal id, so the Platform Backend need not ask this runtime to translate", async () => {
    mockPublish.mockResolvedValueOnce('msg-id');
    mockResolveInternalAgentId.mockResolvedValueOnce('internal-x');
    await publishWebToolEvent({
      tenantId: 't1', agentId: 'agent-x', eventType: 'web_search', costUsd: 0.01,
      occurredAt: '2026-06-02T00:00:00Z', idempotencyKey: 'k',
    });
    expect(mockResolveInternalAgentId).toHaveBeenCalledWith('t1', 'agent-x', 'web-tool-spend');
    const payload = mockPublish.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.internalAgentId).toBe('internal-x');
    expect(payload.agentId).toBe('agent-x');
  });

  it('omits the internal id for an unmapped agent, and still publishes when the lookup fails', async () => {
    mockPublish.mockResolvedValue('msg-id');
    await publishWebToolEvent({
      tenantId: 't1', agentId: 'agent-x', eventType: 'web_search', costUsd: 0.01,
      occurredAt: '2026-06-02T00:00:00Z', idempotencyKey: 'k1',
    });
    mockResolveInternalAgentId.mockRejectedValueOnce(new Error('db down'));
    await publishWebToolEvent({
      tenantId: 't1', agentId: 'agent-x', eventType: 'web_search', costUsd: 0.01,
      occurredAt: '2026-06-02T00:00:00Z', idempotencyKey: 'k2',
    });
    expect(mockPublish).toHaveBeenCalledTimes(2);
    for (const [, payload] of mockPublish.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect('internalAgentId' in payload).toBe(false);
    }
  });

  it("does not look up the no-agent sentinel, a platform assistant's spend", async () => {
    mockPublish.mockResolvedValueOnce('msg-id');
    await publishWebToolEvent({
      tenantId: 't1', agentId: '00000000-0000-0000-0000-000000000000', purpose: 'liftoff',
      eventType: 'browser_session', costUsd: 0.01, occurredAt: '2026-06-02T00:00:00Z', idempotencyKey: 'k3',
    });
    expect(mockResolveInternalAgentId).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('is fire-and-forget — publish failure does NOT throw to the caller (ingester backstop catches the row)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('pubsub down'));
    expect(() => publishWebToolEvent({
      tenantId: 't1',
      eventType: 'web_fetch_advanced',
      costUsd: 0.001,
      occurredAt: '2026-06-02T00:00:00Z',
      idempotencyKey: 'key-3',
    })).not.toThrow();

    // Drain the microtask queue so the .catch fires.
    await new Promise(r => setImmediate(r));

    const { logger } = require('../../../infrastructure/logging') as {
      logger: { warn: jest.Mock };
    };
    const warns = logger.warn.mock.calls.filter(
      (c: unknown[]) => c[1] === 'web_tool_event_publish_lost',
    );
    expect(warns.length).toBe(1);
    const ctx = warns[0][0] as Record<string, unknown>;
    expect(ctx.tenant_id).toBe('t1');
    expect(ctx.idempotency_key).toBe('key-3');
    expect(ctx.event_type).toBe('web_fetch_advanced');
  });

  it('defaults to environment=dev when ENVIRONMENT is unset', () => {
    delete process.env.ENVIRONMENT;
    mockPublish.mockResolvedValueOnce('msg-id');
    publishWebToolEvent({
      tenantId: 't1',
      eventType: 'web_fetch_advanced',
      costUsd: 0,
      occurredAt: '2026-06-02T00:00:00Z',
      idempotencyKey: 'k',
    });
    const [topic] = mockPublish.mock.calls[0] as [string];
    expect(topic).toBe('projects/YOUR_CONTROL_PROJECT_STAGING/topics/web-tool-events-dev');
  });
});

describe('publishWebToolEvent — return value', () => {
  it('returns true on successful publish', async () => {
    mockPublish.mockResolvedValueOnce('msgid-1');
    const ok = await publishWebToolEvent({
      tenantId: 't1', connector: 'perplexity', eventType: 'web_deep_research',
      costUsd: 0.40, occurredAt: '2026-06-01T10:00:00Z', idempotencyKey: 'dr-1',
    });
    expect(ok).toBe(true);
  });

  it('returns false on publish rejection and logs web_tool_event_publish_lost', async () => {
    mockPublish.mockRejectedValueOnce(new Error('pubsub unavailable'));
    const ok = await publishWebToolEvent({
      tenantId: 't1', connector: 'perplexity', eventType: 'web_deep_research',
      costUsd: 0.40, occurredAt: '2026-06-01T10:00:00Z', idempotencyKey: 'dr-1',
    });
    expect(ok).toBe(false);
    const { logger } = require('../../../infrastructure/logging') as {
      logger: { warn: jest.Mock };
    };
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ idempotency_key: 'dr-1' }),
      'web_tool_event_publish_lost',
    );
  });
});
