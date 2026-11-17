// The review-queue predicate against a REAL schema. The mock-pool unit suite
// can prove the two statements carry the same predicate text; only a database
// can prove that text means what it should.
//
// The fixture is the set of rows that have historically been got wrong:
//   - an approval past expires_at but still status='pending' (the ~30 minute
//     window before the expiry sweeper flips it) — must be hidden
//   - an approval with expires_at IS NULL — a gate with no deadline, must stay
//   - a level-3 approval — neither Standard nor Critical, must still be counted
//   - a system_internal escalation — operator inbox material, must not surface
//   - a question parked under "Only exceptions" (review_listed = false) — waits
//     in its thread, must not surface and must not count
//   - two rows sharing a created_at — must paginate without loss or repeat
//
// Skipped unless TEST_DATABASE_URL points at a migrated database.

import { Pool } from 'pg';

// `mock`-prefixed name is required for a jest.mock factory to close over it.
const mockPool = process.env.TEST_DATABASE_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_URL })
  : (undefined as unknown as Pool);

jest.mock('../../infrastructure/database', () => ({
  pool: mockPool,
  getPoolForService: () => mockPool,
  withTenantScope: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(mockPool),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { hitlEnforcementService } from '../service';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT = '00000000-0000-0000-0000-00000000f001';
const OTHER_TENANT = '00000000-0000-0000-0000-00000000f002';
const AGENT = '00000000-0000-0000-0000-00000000f003';
const OTHER_AGENT = '00000000-0000-0000-0000-00000000f004';
const WORKFLOW = '00000000-0000-0000-0000-00000000f005';
const TASK = '00000000-0000-0000-0000-00000000f006';

const THREAD = '00000000-0000-0000-0000-00000000f007';
const LAPSED_THREAD = '00000000-0000-0000-0000-00000000f008';
const CLARIFICATION_THREAD = '00000000-0000-0000-0000-00000000f009';
const CLARIFICATION = '00000000-0000-0000-0000-0000000c0001';
const UNLISTED_THREAD = '00000000-0000-0000-0000-00000000f00a';
const UNLISTED_CLARIFICATION = '00000000-0000-0000-0000-0000000c0002';

// Shared timestamp for the two rows that must tie-break on (kind, id).
const TIED_AT = '2026-08-01T10:00:00.000000Z';

describeFn('review queue predicate (integration)', () => {
  beforeAll(async () => {
    await seedParents();
    await seedQueue();
  });

  afterAll(async () => {
    await cleanup();
    await mockPool.end();
  });

  it('counts exactly what it lists', async () => {
    const counts = await hitlEnforcementService.getPendingItemsCount(TENANT);
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });

    expect(counts.total).toBe(listed.items.length);
  });

  it('partitions the total across the buckets, leaving nothing out', async () => {
    const c = await hitlEnforcementService.getPendingItemsCount(TENANT);

    expect(
      c.approvalsStandard + c.approvalsCritical + c.approvalsOther +
      c.clarifications,
    ).toBe(c.total);
  });

  it('hides an approval whose decision window has passed, even before the sweeper runs', async () => {
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });
    const ids = listed.items.map(i => i.id);

    expect(ids).not.toContain(approvalId('lapsed'));
  });

  it('keeps an approval that has no deadline at all', async () => {
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });
    const ids = listed.items.map(i => i.id);

    expect(ids).toContain(approvalId('no-expiry'));
  });

  it('counts a level-3 approval as an approval rather than dropping it', async () => {
    const counts = await hitlEnforcementService.getPendingItemsCount(TENANT);

    expect(counts.approvalsOther).toBeGreaterThanOrEqual(1);
  });

  it('keeps every escalation out of the customer queue, whatever its kind', async () => {
    // An escalated run has already ended: no pause row, no resume payload,
    // nothing an answer could restart. A blocker a person can clear parks the
    // run as a clarification instead, and arrives here as one.
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });
    const ids = listed.items.map(i => i.id);

    expect(ids).not.toContain(escalationId('internal'));
    expect(ids).not.toContain(escalationId('user-facing'));
    expect(ids).not.toContain(escalationId('undated'));
  });

  it('paginates without dropping or repeating rows that share a created_at', async () => {
    const all = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
        limit: 2,
        cursor,
      });
      seen.push(...result.items.map(i => i.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);          // no repeats
    expect(seen.sort()).toEqual(all.items.map(i => i.id).sort()); // no losses
  });

  it('page two excludes everything page one returned', async () => {
    const first = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 2 });
    expect(first.nextCursor).not.toBeNull();

    const second = await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
      limit: 2,
      cursor: first.nextCursor!,
    });

    const firstIds = new Set(first.items.map(i => i.id));
    for (const item of second.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });

  it('scopes to one agent when asked, in the listing and the count alike', async () => {
    const counts = await hitlEnforcementService.getPendingItemsCount(TENANT, { agentId: OTHER_AGENT });
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
      limit: 1000,
      agentId: OTHER_AGENT,
    });

    expect(counts.total).toBe(listed.items.length);
    expect(listed.items.every(i => i.agentId === OTHER_AGENT)).toBe(true);
  });

  it('never leaks another tenant', async () => {
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });

    expect(listed.items.every(i => i.tenantId === TENANT)).toBe(true);
  });

  it('shows the lapsed approval in the passed view, and only there', async () => {
    const passed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
      limit: 1000, window: 'passed',
    });
    const ids = passed.items.map(i => i.id);

    expect(ids).toContain(approvalId('lapsed'));
    // Still-live approvals are not "passed", and nothing else has a window.
    expect(ids).not.toContain(approvalId('standard'));
    expect(ids).not.toContain(approvalId('no-expiry'));
    expect(ids).not.toContain(escalationId('user-facing'));
  });

  it('excludes an approval that was actually decided from the passed view', async () => {
    await mockPool.query(
      `UPDATE hitl_approval_requests SET status = 'approved', decision = 'approved' WHERE id = $1`,
      [approvalId('decided-late')],
    );

    const passed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
      limit: 1000, window: 'passed',
    });

    // It was answered, not missed: an approved row whose expires_at has since
    // slipped by is not a decision anyone still owes.
    expect(passed.items.map(i => i.id)).not.toContain(approvalId('decided-late'));
  });

  it('drops an approval older than the lookback out of the passed view', async () => {
    const passed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
      limit: 1000, window: 'passed',
    });

    expect(passed.items.map(i => i.id)).not.toContain(approvalId('ancient'));
  });

  it('finds the approval blocking a thread', async () => {
    const found = await hitlEnforcementService.findActionableApprovalForThread(TENANT, THREAD);

    expect(found?.id).toBe(approvalId('threaded'));
  });

  it('does not offer a lapsed approval as the one blocking a thread', async () => {
    const found = await hitlEnforcementService.findActionableApprovalForThread(
      TENANT, LAPSED_THREAD,
    );

    expect(found).toBeNull();
  });

  // The name has to be resolved here because it cannot be resolved anywhere
  // else: agent_id is a runtime agents.id and every surface downstream knows
  // teams by their control-plane id (INV-TR-010).
  it('names the agent on a listed approval', async () => {
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });
    const approval = listed.items.find(i => i.id === approvalId('standard'));

    expect(approval?.agentName).toBe('Fixture');
  });

  it('names the agent on a listed clarification', async () => {
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });
    const clarification = listed.items.find(i => i.id === CLARIFICATION);

    expect(clarification?.kind).toBe('clarification');
    expect(clarification?.agentName).toBe('Fixture');
  });

  it('keeps a question parked under "Only exceptions" off the page and out of the count', async () => {
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });
    const counts = await hitlEnforcementService.getPendingItemsCount(TENANT);

    expect(listed.items.map(i => i.id)).not.toContain(UNLISTED_CLARIFICATION);
    expect(listed.items.map(i => i.id)).toContain(CLARIFICATION);
    expect(counts.clarifications).toBe(1);
  });

  it('still answers a question parked under "Only exceptions" on status alone', async () => {
    // The row is not on the page, but a reply in its thread, a direct link and
    // the expiry sweeper all transition on status, not on review_listed.
    const row = await mockPool.query(
      `SELECT status, review_listed FROM agent_scheduled_invocations WHERE id = $1`,
      [UNLISTED_CLARIFICATION],
    );
    expect(row.rows[0]).toEqual({ status: 'pending', review_listed: false });
  });

  it('names the agent on a lapsed approval in the passed view', async () => {
    const passed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, {
      limit: 1000, window: 'passed',
    });

    expect(passed.items.find(i => i.id === approvalId('lapsed'))?.agentName).toBe('Fixture');
  });

  it('gives a listed approval its status and a real updatedAt', async () => {
    const listed = await hitlEnforcementService.listPendingItemsForTenant(TENANT, { limit: 1000 });
    const approval = listed.items.find(i => i.kind === 'approval');

    expect(approval).toBeDefined();
    if (!approval || approval.kind !== 'approval') throw new Error('expected an approval');
    expect(approval.status).toBe('pending');
    expect(Number.isNaN(approval.updatedAt.getTime())).toBe(false);
  });
});

// ── Fixture ─────────────────────────────────────────────────────────────

const APPROVAL_IDS: Record<string, string> = {
  lapsed: '00000000-0000-0000-0000-0000000a0001',
  'no-expiry': '00000000-0000-0000-0000-0000000a0002',
  standard: '00000000-0000-0000-0000-0000000a0003',
  critical: '00000000-0000-0000-0000-0000000a0004',
  mid: '00000000-0000-0000-0000-0000000a0005',
  'other-agent': '00000000-0000-0000-0000-0000000a0006',
  threaded: '00000000-0000-0000-0000-0000000a0007',
  'lapsed-threaded': '00000000-0000-0000-0000-0000000a0008',
  'decided-late': '00000000-0000-0000-0000-0000000a0009',
  ancient: '00000000-0000-0000-0000-0000000a000a',
};

const ESCALATION_IDS: Record<string, string> = {
  'user-facing': '00000000-0000-0000-0000-0000000e0001',
  internal: '00000000-0000-0000-0000-0000000e0002',
  undated: '00000000-0000-0000-0000-0000000e0003',
};

const approvalId = (slug: keyof typeof APPROVAL_IDS | string): string => APPROVAL_IDS[slug];
const escalationId = (slug: keyof typeof ESCALATION_IDS | string): string => ESCALATION_IDS[slug];

async function seedParents(): Promise<void> {
  await mockPool.query(
    `INSERT INTO tenants (id, external_id) VALUES ($1, 'queue-fixture'), ($2, 'queue-fixture-other')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT, OTHER_TENANT],
  );
  await mockPool.query(
    `INSERT INTO agents (id, tenant_id, name)
     VALUES ($1, $2, 'Fixture'), ($3, $2, 'Other')
     ON CONFLICT (id) DO NOTHING`,
    [AGENT, TENANT, OTHER_AGENT],
  );
  await mockPool.query(
    `INSERT INTO workflows (id, tenant_id, agent_id, objective)
     VALUES ($1, $2, $3, 'queue-fixture')
     ON CONFLICT (id) DO NOTHING`,
    [WORKFLOW, TENANT, AGENT],
  );
  await mockPool.query(
    `INSERT INTO workflow_tasks (id, workflow_id, agent_id, idempotency_key)
     VALUES ($1, $2, $3, 'queue-fixture-task')
     ON CONFLICT (id) DO NOTHING`,
    [TASK, WORKFLOW, AGENT],
  );
}

async function insertApproval(args: {
  id: string;
  agentId?: string;
  tenantId?: string;
  hitlLevel: number;
  expiresAt: string | null;
  createdAt: string;
  threadId?: string;
}): Promise<void> {
  await mockPool.query(
    `INSERT INTO hitl_approval_requests
       (id, tenant_id, workflow_id, task_id, agent_id, hitl_level, pending_tool_calls,
        tool_calls_hash, reason, status, expires_at, created_at, updated_at, thread_id)
     VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'hash', 'level_1_gate', 'pending', $7, $8, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      args.id, args.tenantId ?? TENANT, WORKFLOW, TASK, args.agentId ?? AGENT,
      args.hitlLevel, args.expiresAt, args.createdAt, args.threadId ?? null,
    ],
  );
}

async function insertEscalation(args: {
  id: string;
  kind: 'escalation' | 'system_internal';
  createdAt: string | null;
  agentId?: string;
}): Promise<void> {
  await mockPool.query(
    `INSERT INTO workflow_escalations
       (id, tenant_id, workflow_id, task_id, agent_id, kind, reason, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'blocked on a credential', 'pending', $7)
     ON CONFLICT (id) DO NOTHING`,
    [args.id, TENANT, WORKFLOW, TASK, args.agentId ?? AGENT, args.kind, args.createdAt],
  );
}

/** A pending clarification: the other kind the queue renders, and the only one
 *  whose agent_id carries no FK back to `agents`. */
async function insertClarification(id: string, opts: { threadId?: string; reviewListed?: boolean } = {}): Promise<void> {
  await mockPool.query(
    `INSERT INTO agent_scheduled_invocations
       (id, tenant_id, agent_id, thread_id, context_ref, schedule_key, fires_at,
        objective, status, clarification_source, workflow_resume_payload, created_at, review_listed)
     VALUES ($1, $2, $3, $4, 'clarification:queue-fixture', 'queue-fixture-key', $5,
             'clarification-expiry', 'pending', 'recovery_llm', $6::jsonb, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      id, TENANT, AGENT, opts.threadId ?? CLARIFICATION_THREAD,
      new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      JSON.stringify({ pauseContext: { originalQuestion: 'Which repository should I open the pull request against?' } }),
      '2026-08-06T10:00:00Z',
      opts.reviewListed ?? true,
    ],
  );
}

async function seedQueue(): Promise<void> {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();

  // Still status='pending' but past its window: the sweeper has not run yet.
  await insertApproval({ id: approvalId('lapsed'), hitlLevel: 1, expiresAt: past, createdAt: '2026-08-05T10:00:00Z' });
  // No deadline at all: stays actionable.
  await insertApproval({ id: approvalId('no-expiry'), hitlLevel: 1, expiresAt: null, createdAt: '2026-08-04T10:00:00Z' });
  // Standard and Critical.
  await insertApproval({ id: approvalId('standard'), hitlLevel: 1, expiresAt: future, createdAt: '2026-08-03T10:00:00Z' });
  await insertApproval({ id: approvalId('critical'), hitlLevel: 2, expiresAt: future, createdAt: TIED_AT });
  // Neither: the autonomy default.
  await insertApproval({ id: approvalId('mid'), hitlLevel: 3, expiresAt: future, createdAt: TIED_AT });
  // Another agent, for the agent filter.
  await insertApproval({
    id: approvalId('other-agent'), agentId: OTHER_AGENT, hitlLevel: 1,
    expiresAt: future, createdAt: '2026-07-30T10:00:00Z',
  });
  // Blocking a chat thread: what the in-chat banner resolves.
  await insertApproval({
    id: approvalId('threaded'), hitlLevel: 1, expiresAt: future,
    createdAt: '2026-08-02T10:00:00Z', threadId: THREAD,
  });
  // Blocking a thread but past its window: the banner must not offer it.
  await insertApproval({
    id: approvalId('lapsed-threaded'), hitlLevel: 1, expiresAt: past,
    createdAt: '2026-08-02T11:00:00Z', threadId: LAPSED_THREAD,
  });
  // Answered, then its window slipped by. Not "passed": it was decided.
  await insertApproval({
    id: approvalId('decided-late'), hitlLevel: 1, expiresAt: past,
    createdAt: '2026-08-01T09:00:00Z',
  });
  // Lapsed long ago, beyond the passed view's lookback.
  await insertApproval({
    id: approvalId('ancient'), hitlLevel: 1,
    expiresAt: new Date(Date.now() - 400 * 24 * 3600_000).toISOString(),
    createdAt: '2025-06-01T10:00:00Z',
  });

  await insertClarification(CLARIFICATION);
  // Parked under "Only exceptions": written, pending, waiting in its thread,
  // and not an item on the page.
  await insertClarification(UNLISTED_CLARIFICATION, { threadId: UNLISTED_THREAD, reviewListed: false });

  await insertEscalation({ id: escalationId('user-facing'), kind: 'escalation', createdAt: '2026-07-29T10:00:00Z' });
  await insertEscalation({ id: escalationId('internal'), kind: 'system_internal', createdAt: '2026-07-28T10:00:00Z' });
  // A blocker with no created_at: nullable column, must still paginate.
  await insertEscalation({ id: escalationId('undated'), kind: 'escalation', createdAt: null });
}

async function cleanup(): Promise<void> {
  await mockPool.query('DELETE FROM agent_scheduled_invocations WHERE tenant_id = $1', [TENANT]);
  await mockPool.query('DELETE FROM hitl_approval_requests WHERE tenant_id = $1', [TENANT]);
  await mockPool.query('DELETE FROM workflow_escalations WHERE tenant_id = $1', [TENANT]);
  await mockPool.query('DELETE FROM workflow_tasks WHERE id = $1', [TASK]);
  await mockPool.query('DELETE FROM workflows WHERE id = $1', [WORKFLOW]);
  await mockPool.query('DELETE FROM agents WHERE tenant_id = $1', [TENANT]);
  await mockPool.query('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT, OTHER_TENANT]]);
}
