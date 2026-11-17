// Shadow mode's guards.
//
// Shadow mode doubles distillation spend and runs a second full pipeline behind
// every real hire. What keeps that safe is entirely in the guards below, and a
// guard that silently stops working looks exactly like a guard that is working:
// the shadow just runs, or just does not. So each one is pinned here.
//
// The rule these all serve: the measurement must never become a new failure mode
// for the thing being measured.

const mockIsEnabled = jest.fn();
jest.mock('../../feature-flags/service', () => ({
  FeatureFlagService: jest.fn().mockImplementation(() => ({ isEnabled: mockIsEnabled })),
}));

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, cb: (c: unknown) => unknown) =>
    cb({ query: mockQuery })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { maybeRunShadowDistill } from '../distill-shadow';
import type { DistillInput, DistillOutput } from '../distill-service';

const TENANT = '11111111-1111-1111-1111-111111111111';

const INPUT: DistillInput = {
  role: 'Campaign Analyst',
  responsibilities: 'Finds new campaigns daily.',
  integrations: [],
  tenantId: TENANT,
};

const OUTPUT = {
  agentType: 'agent',
  summary: 'Finds campaigns.',
  systemPrompt: 'You are a campaign analyst.',
  userInstructions: 'Do the thing.',
  instructionsMd: '# Guide',
  triggerConfig: { type: 'cron', reasoning: 'daily' },
  skills: [],
} as unknown as DistillOutput;

function ctx(overrides: Partial<Parameters<typeof maybeRunShadowDistill>[0]> = {}) {
  return {
    input: INPUT,
    realOutput: OUTPUT,
    realRunId: '22222222-2222-2222-2222-222222222222',
    realDurationMs: 1000,
    purpose: 'distill' as const,
    servedFromCache: false,
    ...overrides,
  };
}

describe('maybeRunShadowDistill guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockResolvedValue(true);
    mockQuery.mockResolvedValue({ rows: [] });
    delete process.env.DISTILL_SHADOW_SAMPLE_RATE;
  });

  it('runs and records when everything is in order', async () => {
    const runWaved = jest.fn().mockResolvedValue(OUTPUT);
    await maybeRunShadowDistill(ctx(), runWaved);

    expect(runWaved).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('never shadows a cache hit', async () => {
    // A cache hit did no generating, so there is no single-arm timing to pair
    // against — the comparison would be a fresh waved run against a result
    // produced days ago under a different catalog.
    const runWaved = jest.fn();
    await maybeRunShadowDistill(ctx({ servedFromCache: true }), runWaved);

    expect(runWaved).not.toHaveBeenCalled();
  });

  it('never shadows a shadow', async () => {
    // The recursion guard. A shadow runs with strategy 'waved'; if that could
    // itself be shadowed, one hire would fork indefinitely.
    const runWaved = jest.fn();
    await maybeRunShadowDistill(
      ctx({ input: { ...INPUT, strategy: 'waved' } }),
      runWaved,
    );

    expect(runWaved).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is off', async () => {
    mockIsEnabled.mockResolvedValue(false);
    const runWaved = jest.fn();
    await maybeRunShadowDistill(ctx(), runWaved);

    expect(runWaved).not.toHaveBeenCalled();
  });

  it('does nothing when the flag does not exist at all', async () => {
    // isEnabled returns false for an unknown key. That default is load-bearing:
    // this feature doubles spend, so the state before anyone has decided
    // anything must be off.
    mockIsEnabled.mockResolvedValue(false);
    const runWaved = jest.fn();
    await maybeRunShadowDistill(ctx(), runWaved);

    expect(runWaved).not.toHaveBeenCalled();
  });

  it('honours a zero sample rate as off', async () => {
    process.env.DISTILL_SHADOW_SAMPLE_RATE = '0';
    const runWaved = jest.fn();
    await maybeRunShadowDistill(ctx(), runWaved);

    expect(runWaved).not.toHaveBeenCalled();
  });

  it('treats a malformed sample rate as off rather than as one', async () => {
    // A typo in an env var must fail closed. The alternative is a fat-fingered
    // value quietly enabling 100% shadowing and doubling the bill.
    process.env.DISTILL_SHADOW_SAMPLE_RATE = 'banana';
    const runWaved = jest.fn();
    await maybeRunShadowDistill(ctx(), runWaved);

    expect(runWaved).not.toHaveBeenCalled();
  });

  it('skips when there is no tenant to scope the comparison row to', async () => {
    const runWaved = jest.fn();
    await maybeRunShadowDistill(
      ctx({ input: { ...INPUT, tenantId: undefined } }),
      runWaved,
    );

    expect(runWaved).not.toHaveBeenCalled();
  });

  it('swallows a failing shadow rather than propagating it', async () => {
    // The whole point. A shadow that throws must be a lost data point, never an
    // incident on somebody's hire.
    const runWaved = jest.fn().mockRejectedValue(new Error('branch exploded'));
    await expect(maybeRunShadowDistill(ctx(), runWaved)).resolves.toBeUndefined();
  });

  it('swallows a failing comparison write too', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    const runWaved = jest.fn().mockResolvedValue(OUTPUT);
    await expect(maybeRunShadowDistill(ctx(), runWaved)).resolves.toBeUndefined();
  });

  it('passes the waved strategy and the pairing ids to the shadow run', async () => {
    const runWaved = jest.fn().mockResolvedValue(OUTPUT);
    await maybeRunShadowDistill(ctx(), runWaved);

    const passed = runWaved.mock.calls[0][0] as DistillInput;
    expect(passed.strategy).toBe('waved');
    // Pre-minted so the comparison row can name the shadow's telemetry rows,
    // and linked back so the pair is joinable from either side.
    expect(passed.runId).toBeTruthy();
    expect(passed.shadowOfRunId).toBe('22222222-2222-2222-2222-222222222222');
  });
});
