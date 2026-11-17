import {
  calculateSandboxCredits,
  calculateExecuteMicroCredits,
  calculateInstanceAliveMicroCredits,
  getDefaultSandboxCreditCost,
  microCreditsToCredits,
  MICRO_CREDITS_PER_CREDIT,
  MICRO_CREDITS_PER_USD,
} from '../credit-calculator';
import type { CreditCostProvider } from '../credit-calculator';

/**
 * Mock cost provider — returns micro-credit rates keyed by actionType.
 * Real production rates live in DEFAULT_RATES_MICRO_CREDITS or the
 * credit_cost_model table; these tests use synthetic values to isolate the
 * arithmetic and unit-conversion behaviour from the seed numbers.
 */
function mockProvider(rates: Record<string, number>): CreditCostProvider {
  return {
    getCreditCost: async (_tenantId: string, lookup: { actionType: string }) => rates[lookup.actionType] ?? 0,
  };
}

const tenantId = 'test-tenant';

describe('unit constants', () => {
  it('1 USD = 1_000_000 micro-credits', () => {
    expect(MICRO_CREDITS_PER_USD).toBe(1_000_000);
  });

  it('1 credit = 1000 micro-credits', () => {
    expect(MICRO_CREDITS_PER_CREDIT).toBe(1000);
  });
});

describe('microCreditsToCredits', () => {
  it('rounds UP so a sub-credit charge still bills 1 credit', () => {
    expect(microCreditsToCredits(1)).toBe(1);
    expect(microCreditsToCredits(999)).toBe(1);
    expect(microCreditsToCredits(1000)).toBe(1);
    expect(microCreditsToCredits(1001)).toBe(2);
  });

  it('passes through zero', () => {
    expect(microCreditsToCredits(0)).toBe(0);
  });

  it('rounds 232 μcr/sec × 30 s = 6960 μcr → 7 credits', () => {
    // Default instance-alive rate × default tick interval.
    expect(microCreditsToCredits(6960)).toBe(7);
  });
});

describe('calculateExecuteMicroCredits', () => {
  it('routes shell tools to sandbox_exec', async () => {
    const provider = mockProvider({ sandbox_exec: 2_000, sandbox_browser_action: 9_999 });
    expect(await calculateExecuteMicroCredits(provider, tenantId, 'shell_exec')).toBe(2_000);
  });

  it('routes browser_* tools to sandbox_browser_action', async () => {
    const provider = mockProvider({ sandbox_exec: 2_000, sandbox_browser_action: 3_000 });
    expect(await calculateExecuteMicroCredits(provider, tenantId, 'browser_navigate')).toBe(3_000);
    expect(await calculateExecuteMicroCredits(provider, tenantId, 'browser_click')).toBe(3_000);
  });

  it('routes file_* tools to sandbox_file_op', async () => {
    const provider = mockProvider({ sandbox_exec: 9_999, sandbox_file_op: 2_000 });
    expect(await calculateExecuteMicroCredits(provider, tenantId, 'file_read')).toBe(2_000);
  });

  it('routes util_convert_to_markdown to sandbox_markitdown_op', async () => {
    const provider = mockProvider({ sandbox_exec: 9_999, sandbox_markitdown_op: 2_000 });
    expect(await calculateExecuteMicroCredits(provider, tenantId, 'util_convert_to_markdown')).toBe(2_000);
  });
});

describe('calculateInstanceAliveMicroCredits', () => {
  const provider = mockProvider({ sandbox_instance_alive_sec: 232 });

  it('zero elapsed = zero charge', async () => {
    expect(await calculateInstanceAliveMicroCredits(provider, tenantId, 0)).toBe(0);
  });

  it('negative elapsed = zero charge (clock skew defensive)', async () => {
    expect(await calculateInstanceAliveMicroCredits(provider, tenantId, -500)).toBe(0);
  });

  it('30 s window = 30 × 232 = 6 960 μcr', async () => {
    expect(await calculateInstanceAliveMicroCredits(provider, tenantId, 30_000)).toBe(6_960);
  });

  it('60 s window = 60 × 232 = 13 920 μcr', async () => {
    expect(await calculateInstanceAliveMicroCredits(provider, tenantId, 60_000)).toBe(13_920);
  });

  it('rounds UP partial seconds — never under-bills', async () => {
    // 30.5 s should bill 31 × 232 = 7 192 μcr
    expect(await calculateInstanceAliveMicroCredits(provider, tenantId, 30_500)).toBe(7_192);
  });
});

describe('calculateSandboxCredits (phase-driven entry)', () => {
  it('provision returns the flat μcr cost rounded UP to credits', async () => {
    const provider = mockProvider({ sandbox_provision: 30_000 });
    // 30 000 μcr / 1000 = 30 credits
    expect(await calculateSandboxCredits('provision', 0, provider, tenantId)).toBe(30);
  });

  it('provision ignores wallClockMs', async () => {
    const provider = mockProvider({ sandbox_provision: 30_000 });
    expect(await calculateSandboxCredits('provision', 999_999, provider, tenantId)).toBe(30);
  });

  it('teardown returns the flat μcr cost rounded UP', async () => {
    const provider = mockProvider({ sandbox_teardown: 1_000 });
    expect(await calculateSandboxCredits('teardown', 0, provider, tenantId)).toBe(1);
  });

  it('execute returns sandbox_exec (flat) rounded UP — compute_sec is NOT added', async () => {
    // The instance-alive ticker bills compute time separately; execute is
    // ORCHESTRATION-only here.
    const provider = mockProvider({ sandbox_exec: 2_000 });
    expect(await calculateSandboxCredits('execute', 1000, provider, tenantId, 'shell_exec')).toBe(2);
    expect(await calculateSandboxCredits('execute', 999_999, provider, tenantId, 'shell_exec')).toBe(2);
  });

  it('execute for browser_* uses the browser-action rate', async () => {
    const provider = mockProvider({ sandbox_browser_action: 3_000 });
    expect(await calculateSandboxCredits('execute', 100, provider, tenantId, 'browser_navigate')).toBe(3);
  });

  it('instance_alive scales linearly with elapsed time', async () => {
    const provider = mockProvider({ sandbox_instance_alive_sec: 232 });
    expect(await calculateSandboxCredits('instance_alive', 30_000, provider, tenantId)).toBe(7);
    expect(await calculateSandboxCredits('instance_alive', 60_000, provider, tenantId)).toBe(14);
  });

  it('every result is an integer', async () => {
    const provider = mockProvider({
      sandbox_provision: 30_000,
      sandbox_exec: 2_000,
      sandbox_teardown: 1_000,
      sandbox_instance_alive_sec: 232,
    });
    for (const phase of ['provision', 'execute', 'teardown', 'instance_alive'] as const) {
      const credits = await calculateSandboxCredits(phase, 1234, provider, tenantId, 'shell_exec');
      expect(Number.isInteger(credits)).toBe(true);
      expect(credits).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('getDefaultSandboxCreditCost (returns micro-credits)', () => {
  it('returns seed rates from DEFAULT_RATES_MICRO_CREDITS', () => {
    expect(getDefaultSandboxCreditCost('sandbox_provision')).toBe(30_000);
    expect(getDefaultSandboxCreditCost('sandbox_exec')).toBe(2_000);
    expect(getDefaultSandboxCreditCost('sandbox_teardown')).toBe(1_000);
    expect(getDefaultSandboxCreditCost('sandbox_instance_alive_sec')).toBe(232);
  });

  it('per-tool-family overrides default to sensible values', () => {
    expect(getDefaultSandboxCreditCost('sandbox_browser_action')).toBe(3_000);
    expect(getDefaultSandboxCreditCost('sandbox_file_op')).toBe(2_000);
    expect(getDefaultSandboxCreditCost('sandbox_markitdown_op')).toBe(2_000);
  });

  it('mcp_dispatch is free on the sandbox side (charged at the MCP boundary)', () => {
    expect(getDefaultSandboxCreditCost('sandbox_mcp_dispatch')).toBe(0);
  });

  it('falls back to sandbox_exec for unknown action types', () => {
    expect(getDefaultSandboxCreditCost('unknown_action')).toBe(2_000);
  });
});
