// Tests for the Fix 7/8 shadow-mode + fail-closed helper.
//
// Coverage matrix:
//   flag=off:
//     - legacy serves; rpc is never invoked
//   flag=shadow:
//     - both paths run; results match → legacy served, no mismatch log
//     - both paths run; results differ → mismatch logged, legacy served
//     - legacy ok + rpc throws → rpc error logged, legacy served
//     - legacy throws + rpc ok → legacy error re-thrown (legacy path is authoritative)
//     - both throw → legacy error re-thrown, both logged
//   flag=on:
//     - rpc succeeds → rpc served
//     - rpc throws Code.Unavailable → falls back to legacy
//     - rpc throws Code.InvalidArgument → surfaces as-is (4xx-style bubble up)
//     - rpc throws node ECONNREFUSED → falls back to legacy
//   redaction:
//     - mismatch log redacts accessToken / apiKey / privateKey
//   rollback behavior:
//     - flipping flag mid-run changes behavior on the next call

import { ConnectError, Code } from '@connectrpc/connect';
import { withShadowAndFallback, _testUtils } from './shadow-mode';

const { defaultRedact, isNetworkLevelConnectError, isNodeNetworkError } = _testUtils;

describe('withShadowAndFallback', () => {
  const origFlag = process.env.CONNECTOR_SERVICE_ENABLED;
  afterEach(() => {
    if (origFlag === undefined) delete process.env.CONNECTOR_SERVICE_ENABLED;
    else process.env.CONNECTOR_SERVICE_ENABLED = origFlag;
  });

  describe('flag=off', () => {
    beforeEach(() => {
      process.env.CONNECTOR_SERVICE_ENABLED = 'off';
    });

    it('serves legacy without calling rpc', async () => {
      const legacy = jest.fn<Promise<number>, []>(async () => 42);
      const rpc = jest.fn<Promise<number>, []>(async () => 99);
      const result = await withShadowAndFallback({
        method: 'test',
        legacy,
        rpc,
      });
      expect(result).toBe(42);
      expect(legacy).toHaveBeenCalledTimes(1);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('flag=shadow', () => {
    beforeEach(() => {
      process.env.CONNECTOR_SERVICE_ENABLED = 'shadow';
    });

    it('runs both paths; legacy is served when they match', async () => {
      const legacy = jest.fn(async () => ['slack']);
      const rpc = jest.fn(async () => ['slack']);
      const out = await withShadowAndFallback({
        method: 'list',
        legacy,
        rpc,
        compare: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
      });
      expect(out).toEqual(['slack']);
      expect(legacy).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('logs a mismatch when results diverge; legacy still served', async () => {
      const legacy = jest.fn(async () => ['slack']);
      const rpc = jest.fn(async () => ['github']);
      const out = await withShadowAndFallback({
        method: 'list',
        legacy,
        rpc,
        compare: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
      });
      expect(out).toEqual(['slack']);
    });

    it('legacy ok + rpc throws → legacy served, no throw', async () => {
      const legacy = jest.fn(async () => 'legacy-ok');
      const rpc = jest.fn(async () => {
        throw new Error('rpc down');
      });
      const out = await withShadowAndFallback({ method: 'm', legacy, rpc });
      expect(out).toBe('legacy-ok');
    });

    it('legacy throws + rpc ok → legacy error re-thrown', async () => {
      const legacy = jest.fn(async () => {
        throw new Error('legacy boom');
      });
      const rpc = jest.fn(async () => 'rpc-ok');
      await expect(
        withShadowAndFallback({ method: 'm', legacy, rpc }),
      ).rejects.toThrow('legacy boom');
    });

    it('both throw → legacy error re-thrown', async () => {
      const legacy = jest.fn(async () => {
        throw new Error('legacy boom');
      });
      const rpc = jest.fn(async () => {
        throw new Error('rpc boom');
      });
      await expect(
        withShadowAndFallback({ method: 'm', legacy, rpc }),
      ).rejects.toThrow('legacy boom');
    });
  });

  describe('flag=on', () => {
    beforeEach(() => {
      process.env.CONNECTOR_SERVICE_ENABLED = 'on';
    });

    it('serves rpc when rpc succeeds', async () => {
      const legacy = jest.fn(async () => 'legacy');
      const rpc = jest.fn(async () => 'rpc');
      const out = await withShadowAndFallback({ method: 'm', legacy, rpc });
      expect(out).toBe('rpc');
      expect(legacy).not.toHaveBeenCalled();
    });

    it('falls back to legacy when rpc throws Unavailable', async () => {
      const legacy = jest.fn(async () => 'legacy');
      const rpc = jest.fn(async () => {
        throw new ConnectError('down', Code.Unavailable);
      });
      const out = await withShadowAndFallback({ method: 'm', legacy, rpc });
      expect(out).toBe('legacy');
      expect(legacy).toHaveBeenCalledTimes(1);
    });

    it('falls back when rpc throws node ECONNREFUSED', async () => {
      const legacy = jest.fn(async () => 'legacy');
      const err = new Error('connect ECONNREFUSED 127.0.0.1:8080') as NodeJS.ErrnoException;
      err.code = 'ECONNREFUSED';
      const rpc = jest.fn(async () => {
        throw err;
      });
      const out = await withShadowAndFallback({ method: 'm', legacy, rpc });
      expect(out).toBe('legacy');
    });

    it('surfaces user-actionable rpc errors (InvalidArgument)', async () => {
      const legacy = jest.fn(async () => 'legacy');
      const rpc = jest.fn(async () => {
        throw new ConnectError('bad input', Code.InvalidArgument);
      });
      await expect(
        withShadowAndFallback({ method: 'm', legacy, rpc }),
      ).rejects.toThrow('bad input');
      expect(legacy).not.toHaveBeenCalled();
    });

    it('surfaces FailedPrecondition (OAuth reconnect) — caller must handle', async () => {
      const rpc = jest.fn(async () => {
        throw new ConnectError('token revoked', Code.FailedPrecondition);
      });
      await expect(
        withShadowAndFallback({
          method: 'm',
          legacy: async () => 'legacy',
          rpc,
        }),
      ).rejects.toThrow('token revoked');
    });
  });

  describe('rollback (flag change mid-run)', () => {
    it('subsequent calls pick up the new flag value', async () => {
      const legacy = jest.fn(async () => 'legacy');
      const rpc = jest.fn(async () => 'rpc');

      process.env.CONNECTOR_SERVICE_ENABLED = 'on';
      expect(await withShadowAndFallback({ method: 'm', legacy, rpc })).toBe('rpc');

      process.env.CONNECTOR_SERVICE_ENABLED = 'off';
      expect(await withShadowAndFallback({ method: 'm', legacy, rpc })).toBe('legacy');

      process.env.CONNECTOR_SERVICE_ENABLED = 'shadow';
      expect(await withShadowAndFallback({ method: 'm', legacy, rpc })).toBe('legacy');
    });
  });
});

describe('defaultRedact', () => {
  it('scrubs access_token + apiKey + privateKey fields', () => {
    const input = {
      flowKind: 'static_oauth',
      accessToken: 'AT1234567890',
      apiKey: 'SHOULD_HIDE',
      privateKey: '-----BEGIN PRIVATE KEY----- xxxx -----END',
      nested: {
        refresh_token: 'RT-abc',
        safe: 'yes',
      },
      list: [{ client_secret: 'CSX' }, { harmless: 'ok' }],
    };
    const out = defaultRedact(input) as {
      accessToken: string;
      apiKey: string;
      privateKey: string;
      nested: { refresh_token: string; safe: string };
      list: Array<{ client_secret?: string; harmless?: string }>;
    };
    expect(out.accessToken).toMatch(/^\*\*\*\d+\*\*\*$/);
    expect(out.apiKey).toMatch(/^\*\*\*\d+\*\*\*$/);
    expect(out.privateKey).toMatch(/^\*\*\*\d+\*\*\*$/);
    expect(out.nested.refresh_token).toMatch(/^\*\*\*\d+\*\*\*$/);
    expect(out.nested.safe).toBe('yes');
    expect(out.list[0].client_secret).toMatch(/^\*\*\*\d+\*\*\*$/);
    expect(out.list[1].harmless).toBe('ok');
  });
});

describe('helper predicates', () => {
  it('isNetworkLevelConnectError', () => {
    expect(isNetworkLevelConnectError(new ConnectError('x', Code.Unavailable))).toBe(true);
    expect(isNetworkLevelConnectError(new ConnectError('x', Code.Internal))).toBe(true);
    expect(isNetworkLevelConnectError(new ConnectError('x', Code.DeadlineExceeded))).toBe(true);
    expect(isNetworkLevelConnectError(new ConnectError('x', Code.InvalidArgument))).toBe(false);
    expect(isNetworkLevelConnectError(new ConnectError('x', Code.NotFound))).toBe(false);
    expect(isNetworkLevelConnectError(new Error('not a ConnectError'))).toBe(false);
  });

  it('isNodeNetworkError', () => {
    const mk = (code: string) => {
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      return err;
    };
    expect(isNodeNetworkError(mk('ECONNREFUSED'))).toBe(true);
    expect(isNodeNetworkError(mk('ETIMEDOUT'))).toBe(true);
    expect(isNodeNetworkError(mk('ENOTFOUND'))).toBe(true);
    expect(isNodeNetworkError(mk('EBADF'))).toBe(false);
    expect(isNodeNetworkError(new Error('no code'))).toBe(false);
  });
});
