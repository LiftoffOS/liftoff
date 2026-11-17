import type { Pool, PoolClient, PoolConfig } from 'pg';
import { DatabasePoolFactory } from './pool-factory.js';

type StubPool = Partial<Pool> & {
  _config: PoolConfig;
  _listeners: Record<string, Array<(...a: unknown[]) => void>>;
  _client: { query: jest.Mock; release: jest.Mock };
  _endSpy: jest.Mock;
  trigger: (event: string, ...args: unknown[]) => void;
};

function createPoolStubs() {
  const clients: Array<{ query: jest.Mock; release: jest.Mock }> = [];

  function PoolStubCtor(this: StubPool, config: PoolConfig) {
    this._config = config;
    this._listeners = {};
    const client = {
      query: jest.fn(async () => ({ rows: [] })),
      release: jest.fn(),
    };
    clients.push(client);
    this._client = client;
    this._endSpy = jest.fn(async () => {});

    this.on = ((event: string, fn: (...args: unknown[]) => void) => {
      (this._listeners[event] = this._listeners[event] ?? []).push(fn);
      return this;
    }) as Pool['on'];

    this.connect = (async () => this._client as unknown as PoolClient) as Pool['connect'];
    this.end = this._endSpy as unknown as Pool['end'];

    this.trigger = (event: string, ...args: unknown[]) => {
      (this._listeners[event] ?? []).forEach((fn) => fn(...args));
    };

    (this as unknown as { totalCount: number }).totalCount = 0;
    (this as unknown as { idleCount: number }).idleCount = 0;
    (this as unknown as { waitingCount: number }).waitingCount = 0;
  }

  return { PoolStubCtor: PoolStubCtor as unknown as new (c: PoolConfig) => Pool, clients };
}

describe('DatabasePoolFactory', () => {
  it('creates one pool per service and caches it', async () => {
    const { PoolStubCtor } = createPoolStubs();
    const buildCfg = jest.fn(async (svc: string) => ({
      host: '10.0.0.1',
      user: 'u',
      password: 'p',
      database: svc,
    }));

    const factory = new DatabasePoolFactory({
      servicePoolSizes: { api: 5, default: 3 },
      buildConnectionConfig: buildCfg,
      poolCtor: PoolStubCtor,
    });

    const p1 = await factory.getPool('api');
    const p2 = await factory.getPool('api');
    expect(p1).toBe(p2);
    expect(buildCfg).toHaveBeenCalledTimes(1);
  });

  it('applies Cloud-Run-friendly defaults + pool size from resolver', async () => {
    const { PoolStubCtor } = createPoolStubs();
    const factory = new DatabasePoolFactory({
      servicePoolSizes: { api: 7, default: 3 },
      buildConnectionConfig: async () => ({ host: 'h', user: 'u', password: 'p', database: 'd' }),
      poolCtor: PoolStubCtor,
    });

    const pool = (await factory.getPool('api')) as unknown as StubPool;
    expect(pool._config.max).toBe(7);
    expect(pool._config.idleTimeoutMillis).toBe(0);
    expect(pool._config.connectionTimeoutMillis).toBe(30_000);
    expect(pool._config.keepAlive).toBe(true);
    expect(pool._config.keepAliveInitialDelayMillis).toBe(5_000);
  });

  it('wires lifecycle events to the logger', async () => {
    const { PoolStubCtor } = createPoolStubs();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const factory = new DatabasePoolFactory({
      servicePoolSizes: { api: 5, default: 3 },
      buildConnectionConfig: async () => ({ host: 'h', user: 'u', password: 'p', database: 'd' }),
      logger,
      poolCtor: PoolStubCtor,
    });

    const pool = (await factory.getPool('api')) as unknown as StubPool;
    expect(logger.info).toHaveBeenCalledWith(
      { serviceType: 'api', poolSize: 5 },
      'Database pool created',
    );

    pool.trigger('error', new Error('boom'));
    expect(logger.error).toHaveBeenCalled();

    pool.trigger('connect');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ serviceType: 'api' }),
      'Database connection acquired',
    );
  });

  it('warmPools acquires + releases a connection per service', async () => {
    const { PoolStubCtor, clients } = createPoolStubs();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const factory = new DatabasePoolFactory({
      servicePoolSizes: { api: 5, default: 3 },
      buildConnectionConfig: async () => ({ host: 'h', user: 'u', password: 'p', database: 'd' }),
      logger,
      poolCtor: PoolStubCtor,
    });

    await factory.warmPools(['api', 'default']);
    expect(clients).toHaveLength(2);
    clients.forEach((c) => {
      expect(c.query).toHaveBeenCalledWith('SELECT 1');
      expect(c.release).toHaveBeenCalledTimes(1);
    });
  });

  it('entries() returns (name, pool) pairs for collectPoolStats', async () => {
    const { PoolStubCtor } = createPoolStubs();
    const factory = new DatabasePoolFactory({
      servicePoolSizes: { api: 5, default: 3 },
      buildConnectionConfig: async () => ({ host: 'h', user: 'u', password: 'p', database: 'd' }),
      poolCtor: PoolStubCtor,
    });

    await factory.getPool('api');
    await factory.getPool('default');

    const names = factory.entries().map(([n]) => n);
    expect(names.sort()).toEqual(['api', 'default']);
  });

  it('closeAll ends every pool and clears the cache', async () => {
    const { PoolStubCtor } = createPoolStubs();
    const factory = new DatabasePoolFactory({
      servicePoolSizes: { api: 5, default: 3 },
      buildConnectionConfig: async () => ({ host: 'h', user: 'u', password: 'p', database: 'd' }),
      poolCtor: PoolStubCtor,
    });

    const pool = (await factory.getPool('api')) as unknown as StubPool;
    await factory.closeAll();
    expect(pool._endSpy).toHaveBeenCalledTimes(1);
    expect(factory.entries()).toHaveLength(0);
  });
});
