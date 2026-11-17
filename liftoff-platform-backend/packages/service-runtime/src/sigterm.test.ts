import { createReadinessRoutes, installSigtermHandler } from './sigterm.js';

describe('installSigtermHandler', () => {
  it('sets isReady=true initially', () => {
    const controls = installSigtermHandler({
      attachSignal: () => {},
      forceExitFn: () => {},
    });
    expect(controls.isReady()).toBe(true);
  });

  it('flips isReady to false on shutdown and runs drain fns in order', async () => {
    const drained: string[] = [];
    const exitCalls: number[] = [];
    const controls = installSigtermHandler({
      attachSignal: () => {},
      forceExitFn: (code) => exitCalls.push(code),
      drainFns: [
        async () => void drained.push('first'),
        async () => void drained.push('second'),
      ],
      inflightCountFn: () => 0,
    });
    expect(controls.isReady()).toBe(true);
    await controls.shutdown();
    expect(controls.isReady()).toBe(false);
    expect(drained).toEqual(['first', 'second']);
    expect(exitCalls).toEqual([0]);
  });

  it('waits for in-flight requests up to gracePeriodMs', async () => {
    let inflight = 1;
    const exits: number[] = [];
    const nowRef = { v: 0 };
    const controls = installSigtermHandler({
      gracePeriodMs: 500,
      attachSignal: () => {},
      forceExitFn: (c) => exits.push(c),
      inflightCountFn: () => inflight,
      now: () => nowRef.v,
    });
    const shutdownP = controls.shutdown();
    // simulate the request completing after 200ms
    setTimeout(() => {
      inflight = 0;
    }, 10);
    // advance virtual clock slowly so the loop sees progress
    const tick = setInterval(() => {
      nowRef.v += 50;
    }, 5);
    await shutdownP;
    clearInterval(tick);
    expect(exits).toEqual([0]);
  });

  it('exits even if in-flight never drains (grace period exceeded)', async () => {
    const exits: number[] = [];
    const nowRef = { v: 0 };
    const controls = installSigtermHandler({
      gracePeriodMs: 100,
      attachSignal: () => {},
      forceExitFn: (c) => exits.push(c),
      inflightCountFn: () => 5,
      now: () => nowRef.v,
    });
    const shutdownP = controls.shutdown();
    const tick = setInterval(() => {
      nowRef.v += 50;
    }, 5);
    await shutdownP;
    clearInterval(tick);
    expect(exits).toEqual([0]);
  });

  it('is idempotent — calling shutdown twice runs drain once', async () => {
    let drainCount = 0;
    const controls = installSigtermHandler({
      attachSignal: () => {},
      forceExitFn: () => {},
      drainFns: [async () => void drainCount++],
      inflightCountFn: () => 0,
    });
    await Promise.all([controls.shutdown(), controls.shutdown()]);
    expect(drainCount).toBe(1);
  });
});

describe('createReadinessRoutes', () => {
  it('returns 200 when ready, 503 when not', () => {
    let ready = true;
    const routes = createReadinessRoutes({ isReady: () => ready });

    const mkReply = () => {
      const payload: { code?: number; body?: unknown } = {};
      return {
        code(n: number) {
          payload.code = n;
          return {
            send(b: unknown) {
              payload.body = b;
              return payload;
            },
          };
        },
        payload,
      };
    };

    const r1 = mkReply();
    routes.health(null, r1);
    expect(r1.payload.code).toBe(200);
    const r2 = mkReply();
    routes.ready(null, r2);
    expect(r2.payload.code).toBe(200);
    ready = false;
    const r3 = mkReply();
    routes.ready(null, r3);
    expect(r3.payload.code).toBe(503);
  });
});
