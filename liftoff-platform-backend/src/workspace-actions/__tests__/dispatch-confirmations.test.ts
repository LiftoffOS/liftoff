// The preview → confirm protocol, end to end through dispatchWorkspaceAction:
// a handle is bound to the person, the action and the payload; it is consumed
// on first use through claim/settle on idempotency_keys with no transaction
// held across the action; a replay returns the first result; a claim that
// never settled is refused, never re-run; and two concurrent confirms of the
// same handle run the operation exactly once.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

// An in-memory idempotency_keys table with the UNIQUE(tenant_id, key,
// endpoint) constraint, so the concurrency case is decided the way Postgres
// decides it.
const table = new Map<string, { request_hash: string; response_status: number | null; response_body: unknown }>();
const k = (t: string, key: string, e: string) => `${t}|${key}|${e}`;
const mockClaim = jest.fn(async (tenantId: string, key: string, endpoint: string, requestHash: string) => {
  const id = k(tenantId, key, endpoint);
  if (!table.has(id)) {
    table.set(id, { request_hash: requestHash, response_status: null, response_body: null });
    return 'claimed';
  }
  const row = table.get(id)!;
  if (row.request_hash !== requestHash) return 'conflict';
  if (row.response_status === null) return 'unresolved';
  return { replay: { status: row.response_status, body: row.response_body } };
});
const mockSettle = jest.fn(async (tenantId: string, key: string, endpoint: string, status: number, body: unknown) => {
  const row = table.get(k(tenantId, key, endpoint));
  if (row && row.response_status === null) { row.response_status = status; row.response_body = body; }
});
jest.mock('../../infrastructure/idempotency', () => ({
  claimIdempotencyKey: (...a: unknown[]) => (mockClaim as unknown as (...x: unknown[]) => unknown)(...a),
  settleIdempotencyKey: (...a: unknown[]) => (mockSettle as unknown as (...x: unknown[]) => unknown)(...a),
}));

const mockResolveActor = jest.fn();
jest.mock('../actor', () => {
  const actual = jest.requireActual('../actor');
  return { ...actual, resolveActor: (...a: unknown[]) => mockResolveActor(...a) };
});

// One mutating tool and one read, in place of the real registry.
const mockExecute = jest.fn();
const mockPreview = jest.fn();
jest.mock('../tools/review', () => ({
  reviewTools: [
    {
      definition: { name: 'thing_change', description: 'change a thing', input_schema: { type: 'object', properties: {} } },
      permission: 'teams:update',
      mutating: true,
      preview: (...a: unknown[]) => mockPreview(...a),
      execute: (...a: unknown[]) => mockExecute(...a),
    },
    {
      definition: { name: 'thing_read', description: 'read a thing', input_schema: { type: 'object', properties: {} } },
      permission: null,
      execute: async (input: Record<string, unknown>) => ({ read: input }),
    },
  ],
}));
jest.mock('../tools/teams', () => ({ teamsTools: [] }));
jest.mock('../tools/activity', () => ({ activityTools: [] }));
jest.mock('../tools/team', () => ({ teamTools: [] }));
jest.mock('../tools/collaborator', () => ({ collaboratorTools: [] }));
jest.mock('../tools/connections', () => ({ connectionsTools: [] }));
jest.mock('../tools/workspace-admin', () => ({ workspaceAdminTools: [] }));

import { dispatchWorkspaceAction, toolsForActor } from '../tools';
import { mintConfirmation } from '../confirmations';
import type { Actor } from '../actor';

const actor = (over: Partial<Actor> = {}): Actor => ({
  tenantId: '22222222-2222-2222-2222-222222222222', accountId: 'acct-1', role: 'member', displayName: 'Ada', surface: 'liftoff', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  table.clear();
  mockResolveActor.mockImplementation(async (p: { accountId: string; role?: string }) => actor({ accountId: p.accountId }));
  mockPreview.mockResolvedValue({ will: 'change' });
  mockExecute.mockResolvedValue({ changed: true });
});

async function call(name: string, input: Record<string, unknown>, a: Actor = actor()): Promise<Record<string, unknown>> {
  return JSON.parse(await dispatchWorkspaceAction(name, input, a)) as Record<string, unknown>;
}

describe('preview → confirm', () => {
  it('without a confirmationId: the preview and a handle, nothing executed', async () => {
    const r = await call('thing_change', { id: 'x' });
    expect(r.preview).toEqual({ will: 'change' });
    expect(String(r.confirmationId)).toMatch(/^cfm_/);
    expect(mockExecute).not.toHaveBeenCalled();
    // The preview ran as the freshly resolved actor.
    expect(mockResolveActor).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1', surface: 'liftoff' }));
  });

  it('same handle twice → one write; the second result is the replay', async () => {
    const { confirmationId } = await call('thing_change', { id: 'x' });
    const first = await call('thing_change', { id: 'x', confirmationId });
    const second = await call('thing_change', { id: 'x', confirmationId });
    expect(first).toEqual({ changed: true });
    expect(second).toEqual({ changed: true });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({ id: 'x' }, expect.objectContaining({ accountId: 'acct-1' }));
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it('altered payload → refused (the handle is bound to what was previewed)', async () => {
    const { confirmationId } = await call('thing_change', { id: 'x' });
    const r = await call('thing_change', { id: 'y', confirmationId });
    expect(r).toMatchObject({ refused: true, reason: 'confirmation_payload_changed' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('a handle minted for someone else, another action, or that expired is refused', async () => {
    const other = mintConfirmation(actor({ accountId: 'someone-else' }), 'thing_change', { id: 'x' });
    expect(await call('thing_change', { id: 'x', confirmationId: other })).toMatchObject({ reason: 'confirmation_wrong_person' });
    const wrongAction = mintConfirmation(actor(), 'other_action', { id: 'x' });
    expect(await call('thing_change', { id: 'x', confirmationId: wrongAction })).toMatchObject({ reason: 'confirmation_wrong_action' });
    expect(await call('thing_change', { id: 'x', confirmationId: 'cfm_garbage' })).toMatchObject({ reason: 'confirmation_malformed' });
    const spy = jest.spyOn(Date, 'now');
    const now = Date.now();
    spy.mockReturnValue(now - 11 * 60_000);
    const stale = mintConfirmation(actor(), 'thing_change', { id: 'x' });
    spy.mockReturnValue(now);
    expect(await call('thing_change', { id: 'x', confirmationId: stale })).toMatchObject({ reason: 'confirmation_expired' });
    spy.mockRestore();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('claim then a simulated crash (no settle) → the next attempt is unresolved and the operation is not re-run', async () => {
    const { confirmationId } = await call('thing_change', { id: 'x' });
    // The operation hangs and the process dies before settle: emulate by
    // leaving the claimed row unsettled.
    mockSettle.mockImplementationOnce(async () => undefined);
    mockExecute.mockImplementationOnce(async () => { throw Object.assign(new Error('process died'), { fatal: true }); });
    const crashed = await call('thing_change', { id: 'x', confirmationId });
    expect(crashed).toMatchObject({ refused: true, reason: 'failed' });
    // Now the row is claimed and unsettled (the settle above was a no-op).
    const again = await call('thing_change', { id: 'x', confirmationId });
    expect(again).toMatchObject({ refused: true, reason: 'confirmation_unresolved' });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('two concurrent confirms of the same handle → exactly one runs', async () => {
    const { confirmationId } = await call('thing_change', { id: 'x' });
    let release: () => void = () => undefined;
    mockExecute.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ changed: true }); }));
    const a = call('thing_change', { id: 'x', confirmationId });
    await new Promise((r) => setTimeout(r, 5));
    const b = call('thing_change', { id: 'x', confirmationId });
    await new Promise((r) => setTimeout(r, 5));
    // b found the claimed-but-unsettled row and refused; a is still running.
    expect(await b).toMatchObject({ refused: true, reason: 'confirmation_unresolved' });
    release();
    expect(await a).toEqual({ changed: true });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('the actor is re-resolved at execution: a person removed mid-turn cannot complete a write', async () => {
    const { confirmationId } = await call('thing_change', { id: 'x' });
    mockResolveActor.mockResolvedValueOnce(null);
    const r = await call('thing_change', { id: 'x', confirmationId });
    expect(r).toMatchObject({ refused: true, reason: 'not_a_member' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('a person demoted mid-turn is refused by the fresh role, and reads keep the turn-start actor', async () => {
    mockResolveActor.mockResolvedValue(actor({ role: 'viewer' }));
    const r = await call('thing_change', { id: 'x' }, actor({ role: 'member' }));
    expect(r).toMatchObject({ refused: true, reason: 'forbidden' });
    mockResolveActor.mockClear();
    const read = await call('thing_read', { q: 1 }, actor({ role: 'member' }));
    expect(read).toEqual({ read: { q: 1 } });
    expect(mockResolveActor).not.toHaveBeenCalled();
  });

  it('toolsForActor filters by permission', () => {
    expect(toolsForActor(actor({ role: 'viewer' })).map((t) => t.definition.name)).toEqual(['thing_read']);
    expect(toolsForActor(actor({ role: 'member' })).map((t) => t.definition.name)).toEqual(['thing_change', 'thing_read']);
  });
});

// A preview that cannot be shown is a typed refusal, not a generic failure.
describe('preview refusals', () => {
  it('relays the preview\'s own reason, message and context', async () => {
    const { PreviewRefused } = jest.requireActual('../tools/types') as typeof import('../tools/types');
    mockPreview.mockImplementationOnce(async () => { throw new PreviewRefused('not_found', 'No such thing.', { id: 'x' }); });
    const r = await call('thing_change', { id: 'x' });
    expect(r).toEqual({ refused: true, reason: 'not_found', message: 'No such thing.', context: { id: 'x' } });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('an unexpected preview error is still a failure, never a handle', async () => {
    mockPreview.mockImplementationOnce(async () => { throw new Error('boom'); });
    const r = await call('thing_change', { id: 'x' });
    expect(r).toMatchObject({ refused: true, reason: 'failed', message: 'boom' });
    expect(r.confirmationId).toBeUndefined();
  });
});
