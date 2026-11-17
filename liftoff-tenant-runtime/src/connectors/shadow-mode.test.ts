// Mirror of platform-backend/src/connectors/shadow-mode.test.ts.
// Any divergence here should be flagged as a bug — the behaviour must
// stay identical across the two callers.

import { ConnectError, Code } from '@connectrpc/connect';
import { withShadowAndFallback, _testUtils } from './shadow-mode';

const { defaultRedact, isNetworkLevelConnectError, isNodeNetworkError } = _testUtils;

describe('withShadowAndFallback (tenant-runtime)', () => {
  const origFlag = process.env.CONNECTOR_SERVICE_ENABLED;
  afterEach(() => {
    if (origFlag === undefined) delete process.env.CONNECTOR_SERVICE_ENABLED;
    else process.env.CONNECTOR_SERVICE_ENABLED = origFlag;
  });

  describe('flag=off', () => {
    beforeEach(() => { process.env.CONNECTOR_SERVICE_ENABLED = 'off'; });

    it('serves legacy without calling rpc', async () => {
      const legacy = jest.fn(async () => 42);
      const rpc = jest.fn(async () => 99);
      const result = await withShadowAndFallback({ method: 'test', legacy, rpc });
      expect(result).toBe(42);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('flag=shadow', () => {
    beforeEach(() => { process.env.CONNECTOR_SERVICE_ENABLED = 'shadow'; });

    it('runs both and serves legacy when they match', async () => {
      const result = await withShadowAndFallback({
        method: 'm',
        legacy: async () => 'v',
        rpc: async () => 'v',
      });
      expect(result).toBe('v');
    });

    it('logs mismatch and serves legacy when results differ', async () => {
      const result = await withShadowAndFallback({
        method: 'm',
        legacy: async () => 'legacy',
        rpc: async () => 'rpc',
      });
      expect(result).toBe('legacy');
    });

    it('legacy ok + rpc throws → legacy served', async () => {
      const result = await withShadowAndFallback({
        method: 'm',
        legacy: async () => 'legacy',
        rpc: async () => { throw new Error('rpc boom'); },
      });
      expect(result).toBe('legacy');
    });

    it('legacy throws → legacy error re-thrown', async () => {
      await expect(
        withShadowAndFallback({
          method: 'm',
          legacy: async () => { throw new Error('legacy boom'); },
          rpc: async () => 'rpc',
        }),
      ).rejects.toThrow('legacy boom');
    });

    it('both throw → legacy error re-thrown', async () => {
      await expect(
        withShadowAndFallback({
          method: 'm',
          legacy: async () => { throw new Error('legacy boom'); },
          rpc: async () => { throw new Error('rpc boom'); },
        }),
      ).rejects.toThrow('legacy boom');
    });
  });

  describe('flag=on', () => {
    beforeEach(() => { process.env.CONNECTOR_SERVICE_ENABLED = 'on'; });

    it('serves rpc when rpc succeeds', async () => {
      const legacy = jest.fn(async () => 'legacy');
      const result = await withShadowAndFallback({
        method: 'm',
        legacy,
        rpc: async () => 'rpc',
      });
      expect(result).toBe('rpc');
      expect(legacy).not.toHaveBeenCalled();
    });

    it('falls back when rpc throws Unavailable', async () => {
      const result = await withShadowAndFallback({
        method: 'm',
        legacy: async () => 'legacy',
        rpc: async () => { throw new ConnectError('down', Code.Unavailable); },
      });
      expect(result).toBe('legacy');
    });

    it('falls back on ECONNREFUSED', async () => {
      const err = new Error('ECONNREFUSED') as NodeJS.ErrnoException;
      err.code = 'ECONNREFUSED';
      const result = await withShadowAndFallback({
        method: 'm',
        legacy: async () => 'legacy',
        rpc: async () => { throw err; },
      });
      expect(result).toBe('legacy');
    });

    it('surfaces InvalidArgument without fallback', async () => {
      const legacy = jest.fn(async () => 'legacy');
      await expect(
        withShadowAndFallback({
          method: 'm',
          legacy,
          rpc: async () => { throw new ConnectError('bad', Code.InvalidArgument); },
        }),
      ).rejects.toThrow('bad');
      expect(legacy).not.toHaveBeenCalled();
    });
  });
});

describe('helpers', () => {
  it('defaultRedact scrubs secret fields', () => {
    const out = defaultRedact({ accessToken: 'abc', nested: { apiKey: 'k', safe: 1 } }) as any;
    expect(out.accessToken).toMatch(/\*\*\*/);
    expect(out.nested.apiKey).toMatch(/\*\*\*/);
    expect(out.nested.safe).toBe(1);
  });
  it('isNetworkLevelConnectError', () => {
    expect(isNetworkLevelConnectError(new ConnectError('x', Code.Unavailable))).toBe(true);
    expect(isNetworkLevelConnectError(new ConnectError('x', Code.InvalidArgument))).toBe(false);
    expect(isNetworkLevelConnectError(new Error('x'))).toBe(false);
  });
  it('isNodeNetworkError', () => {
    const mk = (code: string) => Object.assign(new Error(code), { code });
    expect(isNodeNetworkError(mk('ECONNREFUSED'))).toBe(true);
    expect(isNodeNetworkError(mk('EBADF'))).toBe(false);
  });
});
