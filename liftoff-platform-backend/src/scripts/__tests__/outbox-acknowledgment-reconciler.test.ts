// Outbox ack reconciler unit tests. Mocks the DB pool, fetch, runtime URL
// resolution, publisher, and metric writer to exercise the dispatch logic.

const withAdminScopeMock = jest.fn();
const resolveRuntimeBaseUrlMock = jest.fn();
const buildRuntimeHeadersMock = jest.fn();
const publishEventWithExplicitIdMock = jest.fn();
const writeCustomMetricMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: withAdminScopeMock,
  initDatabase: jest.fn(),
  closePools: jest.fn(),
}));

jest.mock('../../infrastructure/secrets', () => ({
  initSecrets: jest.fn(),
}));

jest.mock('../../connectors/tenant-runtime-url', () => ({
  resolveRuntimeBaseUrl: resolveRuntimeBaseUrlMock,
  buildRuntimeHeaders: buildRuntimeHeadersMock,
}));

jest.mock('../../events/publisher', () => ({
  publishEventWithExplicitId: publishEventWithExplicitIdMock,
}));

jest.mock('../../infrastructure/monitoring', () => ({
  writeCustomMetric: writeCustomMetricMock,
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const TENANT_A = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const TENANT_B = '511e1439-61c0-49c9-bf57-c722f3d22584';

function makeRow(overrides: Partial<{ table: string; tenant: string; event_id: string; age_h: number }> = {}): {
  table: string;
  event_id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  entity_version: number | null;
  event_payload: Record<string, unknown>;
  completed_at: Date;
} {
  const ageH = overrides.age_h ?? 1;
  return {
    table: overrides.table ?? 'internal_agent_outbox',
    event_id: overrides.event_id ?? '97ad66e5-25d5-4bf1-aef0-342def728d7b',
    tenant_id: overrides.tenant ?? TENANT_A,
    entity_type: 'internal_agent',
    entity_id: 'e8af341f-4d82-43c8-ba7b-6ca64bc8d983',
    event_type: 'tenant.internal_agent.created',
    entity_version: 1,
    event_payload: { foo: 'bar' },
    completed_at: new Date(Date.now() - ageH * 3600_000),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  resolveRuntimeBaseUrlMock.mockResolvedValue('https://agent-service.example/');
  buildRuntimeHeadersMock.mockResolvedValue({ 'X-Service-Auth': 'token' });
  // Default UPDATE inside processOne — returns nothing.
  withAdminScopeMock.mockImplementation(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    return fn(client);
  });
});

it('processed → no republish, status recorded', async () => {
  const row = makeRow();
  // First call: fetch rows. Subsequent: per-row UPDATE.
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    return fn(client);
  });
  const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
    new Response(JSON.stringify({ status: 'processed' }), { status: 200 }) as never,
  );

  const { runOutboxAckReconciler } = await import('../outbox-acknowledgment-reconciler');
  const summary = await runOutboxAckReconciler();

  expect(summary).toEqual({ scanned: 1, republished: 0, stuck24h: 0, unreachable: 0 });
  expect(publishEventWithExplicitIdMock).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('unknown + recent → republish', async () => {
  const row = makeRow({ age_h: 1 });
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    return fn(client);
  });
  const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
    new Response(JSON.stringify({ status: 'unknown' }), { status: 200 }) as never,
  );

  const { runOutboxAckReconciler } = await import('../outbox-acknowledgment-reconciler');
  const summary = await runOutboxAckReconciler();

  expect(summary.republished).toBe(1);
  expect(summary.stuck24h).toBe(0);
  expect(publishEventWithExplicitIdMock).toHaveBeenCalledWith(expect.objectContaining({
    eventId: row.event_id,
    entityType: 'internal_agent',
    entityId: row.entity_id,
    eventType: row.event_type,
    tenantId: row.tenant_id,
    entityVersion: 1,
    eventVersion: 1,
    payload: row.event_payload,
  }));
  // event-status URL must carry tenant_id query param.
  const fetchUrl = String(fetchSpy.mock.calls[0][0]);
  expect(fetchUrl).toContain(`tenant_id=${TENANT_A}`);
  fetchSpy.mockRestore();
});

it('rejects rows with an unexpected table name (defence in depth)', async () => {
  const row = makeRow();
  (row as { table: string }).table = 'something_else';
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    return fn(client);
  });
  const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
    new Response(JSON.stringify({ status: 'processed' }), { status: 200 }) as never,
  );
  const { runOutboxAckReconciler } = await import('../outbox-acknowledgment-reconciler');
  const summary = await runOutboxAckReconciler();
  // processOne throws, Promise.all swallows via unhandled rejection — but in
  // tests the throw bubbles and the row is skipped (no republish, no UPDATE).
  expect(summary.scanned).toBe(1);
  expect(summary.republished).toBe(0);
  expect(publishEventWithExplicitIdMock).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('unknown + >24h → stuck, no republish, error logged', async () => {
  const row = makeRow({ age_h: 25 });
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    return fn(client);
  });
  const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
    new Response(JSON.stringify({ status: 'unknown' }), { status: 200 }) as never,
  );

  const { runOutboxAckReconciler } = await import('../outbox-acknowledgment-reconciler');
  const summary = await runOutboxAckReconciler();

  expect(summary.republished).toBe(0);
  expect(summary.stuck24h).toBe(1);
  expect(publishEventWithExplicitIdMock).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

// A non-2xx is the ABSENCE of an answer, not an answer of 'unknown'.
//
// This test previously asserted the opposite — that a 500 republished — and
// that expectation was the defect written down. `unknown` is a real answer
// from the runtime meaning the event is not in its ledger, which is exactly
// why republishing on it is right; a refusal supports no such claim.
//
// For example, a tenant with agent execution disabled has the runtime's kill
// switch answer 503 on /event-status every cycle; treated as 'unknown', every
// event of theirs is republished every few minutes for 24 hours and then
// reported stuck. The kill switch exempts that endpoint, and this is the half
// that stops ANY unreachable runtime — outage, deploy, network — from doing it.
it.each([
  ['500 from the runtime', 500],
  ['503, which is what the kill switch returns', 503],
  ['429', 429],
])('subscriber unreachable (%s) → recorded, NOT republished', async (_label, status) => {
  const row = makeRow({ age_h: 1 });
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    return fn(client);
  });
  const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
    new Response('', { status }) as never,
  );
  const { runOutboxAckReconciler } = await import('../outbox-acknowledgment-reconciler');
  const summary = await runOutboxAckReconciler();
  expect(summary.republished).toBe(0);
  expect(publishEventWithExplicitIdMock).not.toHaveBeenCalled();
  // Reported, not just not-acted-on. Doing neither would make an unreachable
  // runtime indistinguishable from a tick with nothing to do — which is the
  // same invisibility that let the republish loop run for 24 hours.
  expect(summary.unreachable).toBe(1);
  fetchSpy.mockRestore();
});

it('an unreachable row older than 24h is not called stuck either', async () => {
  // `stuck24h` means the subscriber did not process it in 24 hours. If it never
  // answered, we do not know that — and raising it would turn one unreachable
  // runtime into a stream of per-event alerts about events that may be fine.
  const row = makeRow({ age_h: 30 });
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [row] }) };
    return fn(client);
  });
  const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
    new Response('', { status: 503 }) as never,
  );
  const { runOutboxAckReconciler } = await import('../outbox-acknowledgment-reconciler');
  const summary = await runOutboxAckReconciler();
  expect(summary.stuck24h).toBe(0);
  expect(summary.republished).toBe(0);
  fetchSpy.mockRestore();
});

it('two tenants → both processed independently', async () => {
  const rowA = makeRow({ tenant: TENANT_A, event_id: '97ad66e5-25d5-4bf1-aef0-342def72aaaa' });
  const rowB = makeRow({ tenant: TENANT_B, event_id: '97ad66e5-25d5-4bf1-aef0-342def72bbbb' });
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [rowA, rowB] }) };
    return fn(client);
  });
  const fetchSpy = jest.spyOn(global, 'fetch' as never).mockResolvedValue(
    new Response(JSON.stringify({ status: 'processed' }), { status: 200 }) as never,
  );
  const { runOutboxAckReconciler } = await import('../outbox-acknowledgment-reconciler');
  const summary = await runOutboxAckReconciler();
  expect(summary.scanned).toBe(2);
  fetchSpy.mockRestore();
});
