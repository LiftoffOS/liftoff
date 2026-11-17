// A person is never asked to approve an act this run has already completed.
//
// The lookup is the dispatch-time duplicate guard's own, run against the same
// ledger with the same key, so the two cannot disagree about what "the same
// act" is. What this pins is the seam: which calls are asked about, what the
// query is keyed on, and what the model is told.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockQuery(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { completedActHold } from '../completed-act-hold';
import { deriveTarget } from '../../action-ledger/target-ref';

const run = { tenantId: 'tenant-1', agentId: 'agent-1', traceId: 'resume-hitl-inv-1' };
const send = { to: 'person@example.com', subject: 'Lead enrichment result', body: 'first wording' };

const HIT = {
  rows: [{ id: 'action-9', created_at: '2026-09-15T02:37:00.000Z', external_response: { id: '1a0a2ecbe2dd5c77' } }],
  rowCount: 1,
};
const MISS = { rows: [], rowCount: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue(MISS);
});

describe('a repeat of a send this run already completed', () => {
  it('is answered with what the first send returned, keyed on the run and the derived target', async () => {
    mockQuery.mockResolvedValueOnce(HIT);

    const notice = await completedActHold(
      run,
      'mcp__liftoff-tool-gateway__google-mail-0105297e__send_email',
      { ...send, body: 'recomposed, different wording' },
    );

    expect(notice).toMatch(/^Already done in this run: `send_email` on google-mail:to\/person@example.com@[0-9a-f]{12}/);
    expect(notice).toMatch(/nothing was sent a second time/);

    // The query is the guard's run-scoped one: this run, this act.
    const params = mockQuery.mock.calls[0][1] as unknown[];
    const expectedRef = deriveTarget({ connector: 'google-mail-0105297e', actionType: 'send_email', payload: send }).ref;
    expect(params.slice(0, 4)).toEqual(['tenant-1', 'agent-1', null, 'resume-hitl-inv-1']);
    expect(params[4]).toEqual(expect.arrayContaining([`google-mail:send_email|${expectedRef.slice('google-mail:'.length)}`]));
    expect(params[6]).toBe(expectedRef);
    expect(params[7]).toBe('send_email');
  });

  it('is new when the ledger has no completed row for it', async () => {
    const notice = await completedActHold(run, 'google-mail-0105297e__send_email', send);
    expect(notice).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('a write-class capability', () => {
  const OP = '0123456789ab';

  it('is asked about, keyed on the operation the handle names and the shape of its arguments', async () => {
    mockQuery.mockResolvedValueOnce(HIT);
    const notice = await completedActHold(
      { ...run, invocationId: '6ebe2b95-0000-4000-8000-000000000001' },
      'mcp__liftoff-tool-gateway__run_capability',
      { capabilityId: `cap_w.${OP}.mail_send.aGVsbG8`, args: send },
    );
    expect(notice).toMatch(/^Already done in this run: `run_capability` on capability:to\/person@example.com@[0-9a-f]{12}/);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('6ebe2b95-0000-4000-8000-000000000001');
    // A mail_send capability's equivalents include the direct sends of the
    // same email, so a capability repeat of a bound-connector send is caught.
    expect(params[4]).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^cap:mail_send:${OP}\\|to/`)),
      expect.stringMatching(/^google-mail:send_email\|to\//),
    ]));
  });

  it('a capability with no family is asked about its own operation only', async () => {
    mockQuery.mockResolvedValueOnce(MISS);
    await completedActHold(run, 'run_capability', { capabilityId: `cap_w.${OP}.aGVsbG8`, args: send });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[4]).toEqual([expect.stringMatching(new RegExp(`^cap:${OP}\\|to/`))]);
    expect(params[5]).toBeNull();
  });

  it('reads the arguments in whatever shape the model proposed them', async () => {
    mockQuery.mockResolvedValueOnce(HIT);
    const notice = await completedActHold(
      run, 'run_capability', { capabilityId: `cap_w.${OP}.aGVsbG8`, arguments: JSON.stringify(send) },
    );
    expect(notice).toMatch(/Already done in this run/);
  });

  it('a handle with no operation segment cannot be keyed and is not asked about', async () => {
    const notice = await completedActHold(run, 'run_capability', { capabilityId: 'cap_w.legacybody', args: send });
    expect(notice).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a read-class capability is none of this guard\'s business', async () => {
    const notice = await completedActHold(run, 'run_capability', { capabilityId: `cap_r.${OP}.aGVsbG8`, args: send });
    expect(notice).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('calls the hold has no business with', () => {
  it('a standard tool other than run_capability writes no ledger row, so there is nothing to look up', async () => {
    const notice = await completedActHold(
      run, 'mcp__liftoff-tool-gateway__memory_save', { content: 'x' },
    );
    expect(notice).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a read is wasteful to repeat, not wrong', async () => {
    const notice = await completedActHold(run, 'google-mail-0105297e__search_emails', { query: 'from:x' });
    expect(notice).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a payload with nothing in it names no act and is not guessed at', async () => {
    const notice = await completedActHold(run, 'google-mail-0105297e__send_email', {});
    expect(notice).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('a write that names no target is keyed by what it writes', () => {
  // This used to be filed under "no business of this guard": with no target to
  // key on, the act had no identity and the lookup was skipped. That exempted
  // every CREATE on every connector from the duplicate guard — a create has no
  // target because the thing does not exist yet — and a run duplicated one
  // document because of it. A send with no subject is the same shape.
  const noSubject = { to: 'a@x.com', body: 'no subject' };

  it('is looked up rather than waved through', async () => {
    const notice = await completedActHold(run, 'google-mail-0105297e__send_email', noSubject);
    expect(notice).toBeNull();            // nothing in the ledger yet
    expect(mockQuery).toHaveBeenCalledTimes(1);  // but it did ask
  });

  it('is keyed on its content, under the same operation', async () => {
    await completedActHold(run, 'google-mail-0105297e__send_email', noSubject);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[4]).toEqual([expect.stringMatching(/^google-mail:send_email\|#[0-9a-f]{16}$/)]);
  });

  it('does NOT fall back to comparing an empty target, which would match anything', async () => {
    // The legacy clause matches on target_ref + action_type for rows written
    // before act keys existed. Handing it an empty target would make every
    // unkeyed row of this action type in the run a "duplicate".
    await completedActHold(run, 'google-mail-0105297e__send_email', noSubject);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[6]).toBeNull();
  });

  it('answers a repeat of the identical write from the ledger', async () => {
    mockQuery.mockResolvedValueOnce(HIT);
    const notice = await completedActHold(run, 'google-mail-0105297e__send_email', noSubject);
    expect(notice).toMatch(/Already done in this run/);
    expect(notice).toMatch(/nothing was sent a second time/);
  });

  it('treats a DIFFERENT write as a different act', async () => {
    await completedActHold(run, 'google-mail-0105297e__send_email', noSubject);
    await completedActHold(run, 'google-mail-0105297e__send_email', { ...noSubject, body: 'other' });
    const first = (mockQuery.mock.calls[0][1] as unknown[])[4] as string[];
    const second = (mockQuery.mock.calls[1][1] as unknown[])[4] as string[];
    expect(first[0]).not.toBe(second[0]);
  });
});
