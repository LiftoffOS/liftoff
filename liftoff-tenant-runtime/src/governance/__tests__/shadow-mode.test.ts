// Shadow-mode helper tests for the governance-engine flag.
//
// Semantic difference vs the connector-service variant: mode='on' MUST
// fail-closed (re-throw) rather than fall back to legacy. Governance is
// a safety system and the legacy in-process path will be stripped
// post-cutover.

import { withGovernanceShadowAndFallback } from '../shadow-mode';
import type { Logger } from '../../infrastructure/logging';

function makeLogger() {
  const calls: Array<{ level: string; payload: unknown; msg: string }> = [];
  const log = {
    info: jest.fn((payload: unknown, msg: string) => calls.push({ level: 'info', payload, msg })),
    warn: jest.fn((payload: unknown, msg: string) => calls.push({ level: 'warn', payload, msg })),
    error: jest.fn((payload: unknown, msg: string) => calls.push({ level: 'error', payload, msg })),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
    level: 'info',
  } as unknown as Logger;
  return { log, calls };
}

describe('withGovernanceShadowAndFallback — mode dispatch', () => {
  const original = process.env.GOVERNANCE_SERVICE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.GOVERNANCE_SERVICE_ENABLED;
    else process.env.GOVERNANCE_SERVICE_ENABLED = original;
  });

  it('off: calls legacy only', async () => {
    delete process.env.GOVERNANCE_SERVICE_ENABLED;
    const legacy = jest.fn(async () => 'legacy');
    const rpc = jest.fn(async () => 'rpc');
    const res = await withGovernanceShadowAndFallback({ operation: 'op', legacy, rpc });
    expect(res).toBe('legacy');
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(0);
  });

  it('shadow: calls both and returns legacy when they agree', async () => {
    process.env.GOVERNANCE_SERVICE_ENABLED = 'shadow';
    const { log, calls } = makeLogger();
    const legacy = jest.fn(async () => ({ allowed: true }));
    const rpc = jest.fn(async () => ({ allowed: true }));
    const res = await withGovernanceShadowAndFallback({ operation: 'preflight', legacy, rpc, log });
    expect(res).toEqual({ allowed: true });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.msg.includes('mismatch'))).toBeUndefined();
  });

  it('shadow: logs mismatch when legacy and RPC disagree', async () => {
    process.env.GOVERNANCE_SERVICE_ENABLED = 'shadow';
    const { log, calls } = makeLogger();
    const legacy = jest.fn(async () => ({ allowed: true }));
    const rpc = jest.fn(async () => ({ allowed: false }));
    const res = await withGovernanceShadowAndFallback({ operation: 'preflight', legacy, rpc, log });
    expect(res).toEqual({ allowed: true });
    expect(calls.some((c) => c.msg.includes('mismatch'))).toBe(true);
  });

  it('shadow: returns legacy when RPC throws', async () => {
    process.env.GOVERNANCE_SERVICE_ENABLED = 'shadow';
    const { log, calls } = makeLogger();
    const legacy = jest.fn(async () => 'ok');
    const rpc = jest.fn(async () => {
      throw new Error('boom');
    });
    const res = await withGovernanceShadowAndFallback({ operation: 'preflight', legacy, rpc, log });
    expect(res).toBe('ok');
    expect(calls.some((c) => c.msg.includes('RPC threw'))).toBe(true);
  });

  it('shadow: re-throws when legacy throws', async () => {
    process.env.GOVERNANCE_SERVICE_ENABLED = 'shadow';
    const { log } = makeLogger();
    const legacy = jest.fn(async () => {
      throw new Error('legacy-fail');
    });
    const rpc = jest.fn(async () => 'rpc-ok');
    await expect(
      withGovernanceShadowAndFallback({ operation: 'preflight', legacy, rpc, log }),
    ).rejects.toThrow('legacy-fail');
  });

  it('on: calls rpc only when RPC succeeds', async () => {
    process.env.GOVERNANCE_SERVICE_ENABLED = 'on';
    const legacy = jest.fn(async () => 'legacy');
    const rpc = jest.fn(async () => 'rpc');
    const res = await withGovernanceShadowAndFallback({ operation: 'preflight', legacy, rpc });
    expect(res).toBe('rpc');
    expect(legacy).toHaveBeenCalledTimes(0);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('on: FAILS CLOSED — re-throws RPC error without calling legacy', async () => {
    // CRITICAL semantic: governance is a safety system. A deploy that flips
    // GOVERNANCE_SERVICE_ENABLED=on has committed to using the engine; an
    // RPC failure must BLOCK the action, not silently re-route to legacy
    // (which may be stripped post-cutover).
    process.env.GOVERNANCE_SERVICE_ENABLED = 'on';
    const legacy = jest.fn(async () => 'legacy-should-not-run');
    const rpc = jest.fn(async () => {
      throw new Error('governance-engine unavailable');
    });
    await expect(
      withGovernanceShadowAndFallback({ operation: 'authorize', legacy, rpc }),
    ).rejects.toThrow('governance-engine unavailable');
    expect(legacy).toHaveBeenCalledTimes(0);
  });
});
