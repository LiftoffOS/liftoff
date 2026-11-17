/**
 * The Anthropic key id is discovered, and the dead twin must not win.
 *
 * Anthropic reports usage against the key ID (`apikey_01...`) and never the
 * secret, so something has to connect the two. Four env vars can pin the ids,
 * but the service's environment is Terraform managed, so setting them is an
 * infrastructure change, and while they are unset the vendor half of
 * `anthropic_billing_reconciliation` stays empty.
 *
 * The organisation's keys follow one naming convention, so the id is derivable.
 * The trap is that the SAME NAME appears twice: an `active` key inside a
 * workspace and an older `inactive` or `archived` twin outside one. Matching on
 * name alone picks the twin about half the time and reports a group that is
 * spending as having no vendor usage — a zero that looks like a reconciled
 * answer. Status is therefore part of the match, and that is what this pins.
 */

import { fetchOrgApiKeys, fetchOrgCostUsd } from '../anthropic-admin-api';

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** The shape the Admin API returns: an active key in a workspace and an
 *  identically-named dead twin outside one. */
const LIVE_SHAPE = {
  data: [
    { id: 'apikey_01ExecActive000000000001', name: 'liftoff-agent-execution-prod', status: 'active' },
    { id: 'apikey_01ExecInactive0000000002', name: 'liftoff-agent-execution-prod', status: 'inactive' },
    { id: 'apikey_01ReflArchived0000000003', name: 'liftoff-reflective-services-prod', status: 'archived' },
    { id: 'apikey_01ReflActive000000000004', name: 'liftoff-reflective-services-prod', status: 'active' },
    { id: 'apikey_01AnlyActive000000000005', name: 'liftoff-platform-analytics-prod', status: 'active' },
    { id: 'apikey_01BgndActive000000000006', name: 'liftoff-background-services-prod', status: 'active' },
  ],
};

const okJson = (body: unknown) =>
  jest.fn().mockResolvedValue({ ok: true, json: async () => body, text: async () => '' });

/** The matcher the reconciler applies. Asserted here on the real payload shape
 *  because the defect it prevents is a wrong ROW, not a thrown error. */
const activeIdNamed = (
  keys: Array<{ id: string; name: string; status: string }>,
  name: string,
): string | undefined => keys.find((k) => k.name === name && k.status === 'active')?.id;

describe('fetchOrgApiKeys', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('returns id, name and status for every key', async () => {
    global.fetch = okJson(LIVE_SHAPE) as unknown as typeof fetch;
    const keys = await fetchOrgApiKeys('sk-ant-admin01-x');
    expect(keys).toHaveLength(6);
    expect(keys![0]).toEqual({
      id: 'apikey_01ExecActive000000000001',
      name: 'liftoff-agent-execution-prod',
      status: 'active',
    });
  });

  it('sends the admin credential as x-api-key, not a bearer token', async () => {
    const spy = okJson(LIVE_SHAPE);
    global.fetch = spy as unknown as typeof fetch;
    await fetchOrgApiKeys('sk-ant-admin01-x');
    const headers = (spy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('sk-ant-admin01-x');
    expect(headers.authorization).toBeUndefined();
  });

  it('drops rows missing any of the three fields rather than half-typing them', async () => {
    global.fetch = okJson({ data: [{ id: 'apikey_01x' }, { name: 'n', status: 'active' }] }) as unknown as typeof fetch;
    expect(await fetchOrgApiKeys('sk-ant-admin01-x')).toEqual([]);
  });

  it('answers null when the list could not be fetched, which is not an empty org', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}),
    }) as unknown as typeof fetch;
    expect(await fetchOrgApiKeys('sk-ant-admin01-x')).toBeNull();
  });
});

describe('the ACTIVE key of that name wins', () => {
  const keys = LIVE_SHAPE.data;

  it('picks the active key when an inactive twin shares its name', () => {
    expect(activeIdNamed(keys, 'liftoff-agent-execution-prod'))
      .toBe('apikey_01ExecActive000000000001');
  });

  it('picks the active key even when the archived twin is listed FIRST', () => {
    // Ordering is the gateway's, not ours. A `find` on name alone would have
    // returned the archived id here, and zero usage with it.
    expect(activeIdNamed(keys, 'liftoff-reflective-services-prod'))
      .toBe('apikey_01ReflActive000000000004');
  });

  it('resolves all four purpose groups against the live shape', () => {
    expect([
      activeIdNamed(keys, 'liftoff-agent-execution-prod'),
      activeIdNamed(keys, 'liftoff-reflective-services-prod'),
      activeIdNamed(keys, 'liftoff-platform-analytics-prod'),
      activeIdNamed(keys, 'liftoff-background-services-prod'),
    ]).toEqual([
      'apikey_01ExecActive000000000001',
      'apikey_01ReflActive000000000004',
      'apikey_01AnlyActive000000000005',
      'apikey_01BgndActive000000000006',
    ]);
  });

  it('finds nothing when only a dead key carries the name', () => {
    expect(activeIdNamed(
      [{ id: 'apikey_01dead', name: 'liftoff-agent-execution-prod', status: 'archived' }],
      'liftoff-agent-execution-prod',
    )).toBeUndefined();
  });
});

describe('the day range is half-open, because same-day/23:59:59 fails silently', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('ends at the NEXT day 00:00:00Z', async () => {
    const spy = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ data: [] }), text: async () => '',
    });
    global.fetch = spy as unknown as typeof fetch;
    await fetchOrgCostUsd('2026-09-24', 'sk-ant-admin01-x');
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('starting_at=2026-09-24T00%3A00%3A00Z');
    expect(url).toContain('ending_at=2026-09-25T00%3A00%3A00Z');
    // The spelling that cost_report rejects and usage_report answers empty to.
    expect(url).not.toContain('23%3A59%3A59');
  });

  it('rolls the month over rather than producing day 32', async () => {
    const spy = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ data: [] }), text: async () => '',
    });
    global.fetch = spy as unknown as typeof fetch;
    await fetchOrgCostUsd('2026-09-30', 'sk-ant-admin01-x');
    expect(String(spy.mock.calls[0][0])).toContain('ending_at=2026-10-01T00%3A00%3A00Z');
  });
});
