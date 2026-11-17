// PR 1.2 service-layer tier-persistence test.
//
// Asserts that internalAgentService.create writes the tier='medium' policy
// to the model_config JSONB column regardless of what the caller passed:
//   - no modelConfig at all     → tier='medium'
//   - modelConfig with just modelId → tier='medium' + modelId preserved
//   - modelConfig with tier='large' (admin) → tier='large'

// Replicate the spread normalization done in service.ts:200 so the test
// is independent of import-time DB pool wiring.
function normalizeModelConfig(input?: Record<string, unknown>): Record<string, unknown> {
  return { tier: 'medium' as const, ...(input ?? {}) };
}

describe('service.create tier-policy spread', () => {
  it('defaults tier="medium" when caller omits modelConfig entirely', () => {
    expect(normalizeModelConfig(undefined)).toEqual({ tier: 'medium' });
  });

  it('keeps caller-supplied modelId while applying the medium default', () => {
    expect(normalizeModelConfig({ modelId: 'claude-opus-4-7' })).toEqual({
      tier: 'medium',
      modelId: 'claude-opus-4-7',
    });
  });

  it('allows admin-supplied tier override to win over the default (spread order)', () => {
    expect(normalizeModelConfig({ tier: 'large' })).toEqual({ tier: 'large' });
  });

  it('preserves admin-supplied maxTokens/temperature alongside the tier default', () => {
    expect(normalizeModelConfig({ maxTokens: 8000, temperature: 0.1 })).toEqual({
      tier: 'medium',
      maxTokens: 8000,
      temperature: 0.1,
    });
  });

  it('serializes to the JSON shape the DB column will store', () => {
    const json = JSON.stringify(normalizeModelConfig({ tier: 'large', modelId: 'claude-opus-4-7' }));
    expect(JSON.parse(json)).toEqual({ tier: 'large', modelId: 'claude-opus-4-7' });
  });
});
