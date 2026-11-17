import { withOutboxConsumer } from './consumer.js';
import type { EventEnvelope } from './envelope.js';

type MockClient = {
  query: jest.Mock;
  release: jest.Mock;
};

type MockPool = {
  connect: jest.Mock<Promise<MockClient>>;
};

function makeClient(insertBehavior: 'ok' | 'unique_violation' | 'throw_other'): MockClient {
  const client: MockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  client.query.mockImplementation(async (sql: string) => {
    if (/BEGIN/.test(sql)) return { rows: [] };
    if (/INSERT INTO processed_events/.test(sql)) {
      if (insertBehavior === 'unique_violation') {
        const err = new Error('dup') as Error & { code: string };
        err.code = '23505';
        throw err;
      }
      if (insertBehavior === 'throw_other') {
        throw new Error('db unavailable');
      }
      return { rows: [] };
    }
    if (/COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  return client;
}

const envelope: EventEnvelope = {
  eventId: 'e1',
  eventType: 't',
  schemaVersion: 1,
  tenantId: 'ten',
  occurredAt: new Date(),
  sourceService: 'svc',
  traceId: null,
  payload: {},
};

describe('withOutboxConsumer', () => {
  it('invokes handler once on a new event', async () => {
    const client = makeClient('ok');
    const pool: MockPool = { connect: jest.fn().mockResolvedValue(client) };
    const handler = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withOutboxConsumer(pool as any, envelope, handler);
    expect(result.alreadyProcessed).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.some((c) => /COMMIT/.test(c[0]))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('skips handler on duplicate event_id (unique violation)', async () => {
    const client = makeClient('unique_violation');
    const pool: MockPool = { connect: jest.fn().mockResolvedValue(client) };
    const handler = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withOutboxConsumer(pool as any, envelope, handler);
    expect(result.alreadyProcessed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some((c) => /ROLLBACK/.test(c[0]))).toBe(true);
  });

  it('rolls back on non-unique db error', async () => {
    const client = makeClient('throw_other');
    const pool: MockPool = { connect: jest.fn().mockResolvedValue(client) };
    const handler = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(withOutboxConsumer(pool as any, envelope, handler)).rejects.toThrow('db unavailable');
    expect(handler).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back if the handler throws', async () => {
    const client = makeClient('ok');
    const pool: MockPool = { connect: jest.fn().mockResolvedValue(client) };
    const handler = jest.fn().mockRejectedValue(new Error('handler failed'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(withOutboxConsumer(pool as any, envelope, handler)).rejects.toThrow('handler failed');
    expect(client.query.mock.calls.some((c) => /ROLLBACK/.test(c[0]))).toBe(true);
  });
});
