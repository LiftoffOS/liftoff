// Unit tests for StripeMeterClient.getCustomerId — cache hit, cache miss,
// expired row, and env-fallback behaviour.

jest.mock('./logging', () => {
  const silent = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { logger: silent, log: silent };
});

const mockQuery = jest.fn();
jest.mock('./database', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// Stub out the Stripe SDK — we never call the network in these tests.
jest.mock('stripe', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      billing: {
        meterEvents: { create: jest.fn().mockResolvedValue({}) },
        meters: {
          list: jest.fn().mockResolvedValue({ data: [] }),
          listEventSummaries: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
    })),
  };
});

import { StripeMeterClient } from './stripe-meter';

describe('StripeMeterClient.getCustomerId', () => {
  let origOverride: string | undefined;
  let origNodeEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    origOverride = process.env.STRIPE_CUSTOMER_ID_OVERRIDE;
    origNodeEnv = process.env.NODE_ENV;
    delete process.env.STRIPE_CUSTOMER_ID_OVERRIDE;
  });

  afterEach(() => {
    if (origOverride === undefined) delete process.env.STRIPE_CUSTOMER_ID_OVERRIDE;
    else process.env.STRIPE_CUSTOMER_ID_OVERRIDE = origOverride;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  });

  it('returns the cached customer id when the row is fresh', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          entitlements_json: { customerId: 'cus_live_123' },
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });

    const client = new StripeMeterClient();
    const got = await client.getCustomerId('tenant-1');
    expect(got).toBe('cus_live_123');
  });

  it('falls back to stripeCustomerId key if customerId is absent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          entitlements_json: { stripeCustomerId: 'cus_alt' },
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });

    const client = new StripeMeterClient();
    const got = await client.getCustomerId('tenant-2');
    expect(got).toBe('cus_alt');
  });

  it('returns null when no cached row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const client = new StripeMeterClient();
    const got = await client.getCustomerId('tenant-3');
    expect(got).toBeNull();
  });

  it('returns null when the cached row has expired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          entitlements_json: { customerId: 'cus_stale' },
          expires_at: new Date(Date.now() - 60_000),
        },
      ],
    });
    const client = new StripeMeterClient();
    const got = await client.getCustomerId('tenant-4');
    expect(got).toBeNull();
  });

  it('returns null when cached row lacks any customer id even when fresh', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          entitlements_json: { plan: 'pro' },
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });
    const client = new StripeMeterClient();
    const got = await client.getCustomerId('tenant-5');
    expect(got).toBeNull();
  });

  it('uses STRIPE_CUSTOMER_ID_OVERRIDE in non-production as last-resort fallback', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    process.env.STRIPE_CUSTOMER_ID_OVERRIDE = 'cus_local_dev';
    process.env.NODE_ENV = 'development';

    const client = new StripeMeterClient();
    const got = await client.getCustomerId('tenant-dev');
    expect(got).toBe('cus_local_dev');
  });

  it('ignores STRIPE_CUSTOMER_ID_OVERRIDE in production', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    process.env.STRIPE_CUSTOMER_ID_OVERRIDE = 'cus_should_not_use';
    process.env.NODE_ENV = 'production';

    const client = new StripeMeterClient();
    const got = await client.getCustomerId('tenant-prod');
    expect(got).toBeNull();
  });
});
