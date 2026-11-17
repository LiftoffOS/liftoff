// The standing-policy read has two postures. The gate reads fail-open: a
// lookup that cannot complete is "no policy", and a person is asked. The
// consumption point reads strict: an outage must surface as a throw so it
// defers, never as "no policy" — which it would read as a control tightened
// and re-ask about a change nobody made. A 404 and an unconfigured governance
// service are answers, not outages, in both postures.

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockResolvedValue({ Authorization: 'Bearer oidc' }),
}));

import { getGovernanceApprovalPolicy } from '../governance-service-client';

const originalFetch = global.fetch;
const originalUrl = process.env.GOVERNANCE_SERVICE_URL;

const respond = (status: number, body: unknown = null) =>
  jest.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300, json: async () => body });

beforeEach(() => {
  process.env.GOVERNANCE_SERVICE_URL = 'https://governance-engine.example.com';
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.GOVERNANCE_SERVICE_URL;
  else process.env.GOVERNANCE_SERVICE_URL = originalUrl;
});

describe('a policy that exists, or does not', () => {
  it('is returned in both postures', async () => {
    global.fetch = respond(200, { id: 'p1', decision: 'approved' }) as unknown as typeof fetch;
    expect((await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work'))?.decision).toBe('approved');
    expect((await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work', { strict: true }))?.decision).toBe('approved');
  });

  it('a 404 is "no policy" in both postures', async () => {
    global.fetch = respond(404) as unknown as typeof fetch;
    expect(await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work')).toBeNull();
    expect(await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work', { strict: true })).toBeNull();
  });

  it('no governance service configured is "no policy" in both postures, and nothing is fetched', async () => {
    delete process.env.GOVERNANCE_SERVICE_URL;
    const fetchMock = respond(500);
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work')).toBeNull();
    expect(await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work', { strict: true })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a read that cannot complete', () => {
  it('a 5xx is fail-open for the gate and a throw for consumption', async () => {
    global.fetch = respond(503) as unknown as typeof fetch;
    expect(await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work')).toBeNull();
    await expect(getGovernanceApprovalPolicy('t', 'a', 'sensitive_work', { strict: true })).rejects.toThrow(/503/);
  });

  it('a network failure is fail-open for the gate and a throw for consumption', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    expect(await getGovernanceApprovalPolicy('t', 'a', 'sensitive_work')).toBeNull();
    await expect(getGovernanceApprovalPolicy('t', 'a', 'sensitive_work', { strict: true })).rejects.toThrow(/ECONNREFUSED/);
  });
});
