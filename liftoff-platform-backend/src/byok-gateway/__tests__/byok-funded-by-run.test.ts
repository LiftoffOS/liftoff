// wasRunByokFunded answers for the RUN, whichever half of it asks.
//
// A run that paused for a person and resumed bills its continuation under
// `<invocation>:resume:<pause>` — a completion of its own, so the spend
// subscriber's one-completion-per-id dedup counts it. The gateway recorded
// the run's requests under the run's own id, on both sides of the pause, so
// a lookup under the continuation's id found nothing and billed a BYOK
// customer's turn as managed consumption.

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) => fn({ query: queryMock }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runIdOfBillingId, wasRunByokFunded } from '../usage-recorder';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const RUN = 'f399e6ff-f11b-4b94-ad8e-9c23ca936a7e';
const PAUSE = '5e250fbf-00cf-4c9a-bf57-143566d80699';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [{ total: '2', byok: '2' }] });
});

describe('runIdOfBillingId', () => {
  it('is the run for the run itself, its continuation, and a bucket sibling of either', () => {
    expect(runIdOfBillingId(RUN)).toBe(RUN);
    expect(runIdOfBillingId(`${RUN}:resume:${PAUSE}`)).toBe(RUN);
    expect(runIdOfBillingId(`${RUN}/included`)).toBe(RUN);
    expect(runIdOfBillingId(`${RUN}:resume:${PAUSE}/reload`)).toBe(RUN);
  });
});

describe('wasRunByokFunded', () => {
  it('reads the gateway requests under the run when the continuation asks', async () => {
    await expect(wasRunByokFunded(TENANT, `${RUN}:resume:${PAUSE}`)).resolves.toBe(true);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('byok_gateway_requests'), [TENANT, RUN]);
  });

  it('reads them under the run when the run asks', async () => {
    await expect(wasRunByokFunded(TENANT, RUN)).resolves.toBe(true);
    expect(queryMock).toHaveBeenCalledWith(expect.anything(), [TENANT, RUN]);
  });

  it('still fails toward charging on a read failure', async () => {
    queryMock.mockRejectedValueOnce(new Error('db away'));
    await expect(wasRunByokFunded(TENANT, `${RUN}:resume:${PAUSE}`)).resolves.toBe(false);
  });

  it('asks only of the sessions that were trying to spend a customer key', async () => {
    // A MANAGED-PRIMARY ROW IS NOT A FALLBACK. Liftoff was always paying for that
    // session; it came through the gateway so its tokens could be counted. But a
    // run opens more than one session under one invocation id — the turn, a coding
    // session sent to another vendor, a browser agent loop — so a customer-funded
    // Anthropic turn can sit beside a managed OpenRouter row from the coding
    // session it spawned.
    //
    // Counted in the total, that row makes the run read as "not customer-funded"
    // and bills it in full: a double charge on a turn the customer already paid
    // their provider for, which is the one outcome this whole design exists to
    // prevent. `session_mode` is what keeps the two apart, and the predicate is
    // the only thing enforcing it.
    await wasRunByokFunded(TENANT, RUN);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("session_mode = 'byok'");
  });
});
