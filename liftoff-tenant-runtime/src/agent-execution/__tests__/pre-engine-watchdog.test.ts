// A run whose setup hangs is failed with a typed error, not left silent.
//
// Everything before the engine starts is setup, normally seconds. When one of
// those awaits hung on a dead connection the run sat there with no engine, no
// error and nothing closing it for thirty minutes. The watchdog bounds setup
// only: it disarms as the engine starts, so a long run is never cut by it.

import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockTryAcquire = jest.fn();
const mockRelease = jest.fn();
jest.mock('../../execution-environments/agent-lock', () => ({
  tryAcquireAgentLock: (...a: unknown[]) => mockTryAcquire(...a),
  releaseAgentLock: (...a: unknown[]) => mockRelease(...a),
}));

jest.mock('../../infrastructure/database', () => ({
  ...jest.requireActual('../../infrastructure/database'),
  getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));

import {
  PreEngineWatchdog,
  PreEngineDeadlineError,
  preEngineDeadlineMs,
  PRE_ENGINE_DEADLINE_MS_DEFAULT,
} from '../pre-engine-watchdog';
import { classifyFailure } from '../failure-classification';
import { agentExecutionService } from '../service';
import { hitlEnforcementService } from '../../hitl-enforcement';
import type { ExecuteTaskInput } from '../types';

const never = <T>() => new Promise<T>(() => undefined);

describe('PreEngineWatchdog', () => {
  it('fails a setup await that outlives the deadline, naming the step', async () => {
    const wd = new PreEngineWatchdog(50);
    const err = await wd.guard(never(), 'memory retrieval').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreEngineDeadlineError);
    expect((err as PreEngineDeadlineError).phase).toBe('memory retrieval');
    expect((err as PreEngineDeadlineError).code).toBe('pre_engine_deadline_exceeded');
    expect(wd.tripped).toBe(true);
    wd.dispose();
  });

  it('passes a prompt setup step through untouched', async () => {
    const wd = new PreEngineWatchdog(1_000);
    await expect(wd.guard(Promise.resolve(7), 'admission')).resolves.toBe(7);
    await expect(wd.guard(Promise.reject(new Error('boom')), 'admission')).rejects.toThrow('boom');
    wd.dispose();
  });

  it('never cuts the run once the engine has started', async () => {
    const wd = new PreEngineWatchdog(50);
    let finish!: (_v: string) => void;
    const run = wd.guard(new Promise<string>((r) => { finish = r; }), 'engine setup');
    wd.engineStarting();
    await new Promise((r) => setTimeout(r, 150)); // well past the deadline
    finish('done');
    await expect(run).resolves.toBe('done');
    expect(wd.tripped).toBe(false);
  });

  it('refuses to start an engine for a run it already failed', async () => {
    const wd = new PreEngineWatchdog(20);
    await wd.guard(never(), 'engine setup').catch(() => undefined);
    expect(() => wd.engineStarting()).toThrow(PreEngineDeadlineError);
    wd.dispose();
  });

  it('is classified as a timeout, not an engine fault', () => {
    expect(classifyFailure(new PreEngineDeadlineError(120_000, 'engine setup'))).toBe('timeout');
  });

  it('defaults to two minutes, env-overridable', () => {
    const prev = process.env.PRE_ENGINE_DEADLINE_MS;
    try {
      delete process.env.PRE_ENGINE_DEADLINE_MS;
      expect(preEngineDeadlineMs()).toBe(PRE_ENGINE_DEADLINE_MS_DEFAULT);
      expect(PRE_ENGINE_DEADLINE_MS_DEFAULT).toBe(120_000);
      process.env.PRE_ENGINE_DEADLINE_MS = '300000';
      expect(preEngineDeadlineMs()).toBe(300_000);
      process.env.PRE_ENGINE_DEADLINE_MS = 'nonsense';
      expect(preEngineDeadlineMs()).toBe(120_000);
    } finally {
      if (prev === undefined) delete process.env.PRE_ENGINE_DEADLINE_MS;
      else process.env.PRE_ENGINE_DEADLINE_MS = prev;
    }
  });
});

describe('executeTask fails a run whose setup hangs', () => {
  const svc = agentExecutionService as unknown as Record<string, any>;
  const input: ExecuteTaskInput = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    workflowId: 'w',
    taskId: 't',
    objective: 'hello',
  };
  const prev = process.env.PRE_ENGINE_DEADLINE_MS;
  let setStatus: jest.SpyInstance;

  beforeEach(() => {
    process.env.PRE_ENGINE_DEADLINE_MS = '1000';
    mockTryAcquire.mockReset().mockResolvedValue({ lockId: 'l' });
    mockRelease.mockReset().mockResolvedValue(undefined);
    jest.spyOn(svc.agentLifecycle, 'getAgent').mockResolvedValue({ lifecycle: 'ACTIVE' });
    jest.spyOn(svc.admissionService, 'checkAdmission').mockResolvedValue({ allowed: true });
    jest.spyOn(svc, 'verifyCanonicalAgentStatus').mockResolvedValue('active');
    jest.spyOn(svc, 'getActiveInstruction').mockResolvedValue({ systemPrompt: 'p', userInstructions: 'u' });
    setStatus = jest.spyOn(svc, 'setRuntimeStatus').mockResolvedValue(undefined);
    jest.spyOn(svc, 'loadRuntimeConfig').mockResolvedValue({ memoryScope: {}, modelConfig: {}, execConfig: {} });
    jest.spyOn(hitlEnforcementService, 'getOversightSettings').mockResolvedValue(null as never);
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PRE_ENGINE_DEADLINE_MS;
    else process.env.PRE_ENGINE_DEADLINE_MS = prev;
  });

  it('a hung admission check: typed timeout result, agent status untouched, no lock taken', async () => {
    jest.spyOn(svc.admissionService, 'checkAdmission').mockReturnValue(never());

    const startedAt = Date.now();
    const res = await agentExecutionService.executeTask(input);

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(res).toEqual({
      success: false,
      error: 'Run setup timed out after 1s before the engine started (waiting on: admission)',
      failureClass: 'timeout',
      toolCallsExecuted: 0,
      reasoningSteps: 0,
    });
    expect(setStatus).not.toHaveBeenCalled();
    expect(mockTryAcquire).not.toHaveBeenCalled();
  });

  it('a hung memory retrieval: typed timeout result, agent put back from RUNNING, lock released', async () => {
    jest.spyOn(svc, 'retrieveContextMemories').mockReturnValue(never());

    const startedAt = Date.now();
    const res = await agentExecutionService.executeTask(input);

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(res.success).toBe(false);
    expect(res.failureClass).toBe('timeout');
    expect(res.error).toBe('Run setup timed out after 1s before the engine started (waiting on: memory retrieval)');
    expect(setStatus.mock.calls.map((c) => c[1])).toEqual(['RUNNING', 'FAILED']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// Standing up the engine half of the service is the alternative to reading the
// source here, and the wiring is what these pin: the loop's setup runs under
// the deadline and the deadline ends exactly where the engine or the graph
// takes over. (The unit tests above pin what each of those calls does.)
describe('the deadline ends where the engine starts', () => {
  const src = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

  it('the hybrid loop, setup included, is awaited under the watchdog', () => {
    expect(src).toMatch(/await watchdog\.guard\(this\.runAgentHybridLoop\(/);
  });

  it('the conversational engine disarms it immediately before engine.invoke', () => {
    const at = src.indexOf('for await (const event of engine.invoke(invocationInput, abortController.signal)) {\n        if (event.type === \'session_started\')');
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/state\.preEngineWatchdog\?\.engineStarting\(\);\s*try \{\s*$/);
  });

  it('the workflow graph disarms it before its steps run', () => {
    // The graph's entry is the preflight, which the tool catalog build now
    // lives inside: `run_routine_now` awaits that same memoized thunk from
    // inside the conversational segment, where the conversational engine has
    // already disarmed the deadline.
    const at = src.indexOf('const preflight = await runPreflight();');
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 700), at);
    expect(before).toMatch(/state\.preEngineWatchdog\?\.engineStarting\(\);/);
  });
});
