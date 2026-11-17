import { fireOuMeterEvent, fireOuMeterEventDurable, toStripeIdentifier, OU_METER_EVENT_NAME } from '../ou-meter-event';

const meterEventsCreate = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    billing: { meterEvents: { create: (...args: unknown[]) => meterEventsCreate(...args) } },
  }));
});

jest.mock('../../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_dummy'),
}));

const poolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => poolQuery(...a) }),
}));

const warn = jest.fn();
const errorLog = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: (...a: unknown[]) => errorLog(...a), debug: jest.fn() },
}));

describe('fireOuMeterEvent', () => {
  beforeEach(() => {
    meterEventsCreate.mockReset();
    warn.mockReset();
    errorLog.mockReset();
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('posts an operating_unit_consumed meter event with the right payload shape', async () => {
    meterEventsCreate.mockResolvedValue({});
    const ok = await fireOuMeterEvent({
      stripeCustomerId: 'cus_abc123',
      costUsd: 1.234,
      identifier: 'src_xyz',
      occurredAt: new Date('2026-06-07T18:00:00Z'),
    });
    expect(ok).toBe(true);
    expect(meterEventsCreate).toHaveBeenCalledTimes(1);
    expect(meterEventsCreate).toHaveBeenCalledWith({
      event_name: OU_METER_EVENT_NAME,
      payload: { value: '1.234000', stripe_customer_id: 'cus_abc123' },
      identifier: 'src_xyz',
      timestamp: Math.floor(new Date('2026-06-07T18:00:00Z').getTime() / 1000),
    });
  });

  it('serializes float-artifact costs at 6 decimal places (Stripe rejects >12)', async () => {
    meterEventsCreate.mockResolvedValue({});
    // A value of the exact shape Stripe rejects.
    await fireOuMeterEvent({
      stripeCustomerId: 'cus_abc123',
      costUsd: 0.16381859999999998,
      identifier: 'src_artifact',
      occurredAt: new Date('2026-08-06T05:00:00Z'),
    });
    const value = meterEventsCreate.mock.calls[0][0].payload.value as string;
    expect(value).toBe('0.163819');
    const decimals = value.split('.')[1] ?? '';
    expect(decimals.length).toBeLessThanOrEqual(12);
  });

  it('returns false and logs at ERROR (but does not throw) when Stripe rejects', async () => {
    meterEventsCreate.mockRejectedValue(new Error('rate_limit'));
    const ok = await fireOuMeterEvent({
      stripeCustomerId: 'cus_abc123',
      costUsd: 0.50,
      identifier: 'src_xyz',
      occurredAt: new Date(),
    });
    expect(ok).toBe(false);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0][0]).toMatchObject({
      error: 'rate_limit',
      identifier: 'src_xyz',
      stripeCustomerId: 'cus_abc123',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('hashes identifiers over Stripe\'s 100-char limit deterministically; short ones pass through', async () => {
    const longId = `dd7d80bd-3b77-4677-817c-053fdb8668cd/${'x'.repeat(90)}`;
    expect(longId.length).toBeGreaterThan(100);
    const hashed = toStripeIdentifier(longId);
    expect(hashed.length).toBeLessThanOrEqual(100);
    expect(hashed).toMatch(/^ou-sha256-[0-9a-f]{64}$/);
    // Deterministic: same input → same identifier → Stripe idempotency holds.
    expect(toStripeIdentifier(longId)).toBe(hashed);
    // Short identifiers keep their historical dedup keys untouched.
    expect(toStripeIdentifier('src_xyz')).toBe('src_xyz');

    meterEventsCreate.mockResolvedValue({});
    await fireOuMeterEvent({
      stripeCustomerId: 'cus_abc123',
      costUsd: 1,
      identifier: longId,
      occurredAt: new Date('2026-08-06T05:00:00Z'),
    });
    expect(meterEventsCreate.mock.calls[0][0].identifier).toBe(hashed);
  });

  it('uses `identifier` as the Stripe dedup key (retries collapse server-side)', async () => {
    meterEventsCreate.mockResolvedValue({});
    await fireOuMeterEvent({
      stripeCustomerId: 'cus_x',
      costUsd: 1,
      identifier: 'shared-id',
      occurredAt: new Date('2026-06-07T18:00:00Z'),
    });
    await fireOuMeterEvent({
      stripeCustomerId: 'cus_x',
      costUsd: 1,
      identifier: 'shared-id',
      occurredAt: new Date('2026-06-07T18:00:00Z'),
    });
    expect(meterEventsCreate).toHaveBeenCalledTimes(2);
    expect(meterEventsCreate.mock.calls[0][0].identifier).toBe('shared-id');
    expect(meterEventsCreate.mock.calls[1][0].identifier).toBe('shared-id');
  });
});

describe('fireOuMeterEventDurable', () => {
  beforeEach(() => {
    meterEventsCreate.mockReset();
    errorLog.mockReset();
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('does not touch the retry table on success', async () => {
    meterEventsCreate.mockResolvedValue({});
    const ok = await fireOuMeterEventDurable({
      stripeCustomerId: 'cus_abc123',
      costUsd: 0.25,
      identifier: 'src_ok',
      occurredAt: new Date('2026-08-06T05:00:00Z'),
    });
    expect(ok).toBe(true);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('persists a failed fire to ou_meter_event_retries keyed by the ORIGINAL identifier', async () => {
    meterEventsCreate.mockRejectedValue(new Error('rate_limit'));
    const occurredAt = new Date('2026-08-06T05:00:00Z');
    const ok = await fireOuMeterEventDurable({
      stripeCustomerId: 'cus_abc123',
      costUsd: 0.163819,
      identifier: 'src_fail',
      occurredAt,
    });
    expect(ok).toBe(false);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO ou_meter_event_retries/);
    expect(sql).toMatch(/ON CONFLICT \(identifier\) DO UPDATE/);
    expect(params).toEqual(['src_fail', 'cus_abc123', 0.163819, occurredAt]);
  });

  it('logs at ERROR and swallows when the retry persistence itself fails (never aborts the caller)', async () => {
    meterEventsCreate.mockRejectedValue(new Error('rate_limit'));
    poolQuery.mockRejectedValue(new Error('db down'));
    const ok = await fireOuMeterEventDurable({
      stripeCustomerId: 'cus_abc123',
      costUsd: 0.5,
      identifier: 'src_fail2',
      occurredAt: new Date(),
    });
    expect(ok).toBe(false);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'src_fail2' }),
      'ou_meter_event_retry_persist_failed',
    );
  });
});
