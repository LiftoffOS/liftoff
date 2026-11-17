// Tenant-runtime branding CI guardrail (PR 1.4 + G2 cross-repo coverage).
//
// Same enforcement intent as platform-backend's guardrail:
//   1. Every model id in tenant-runtime's MODEL_PRICING must be representable
//      via MODEL_ID_MAP (or be a provider-prefixed key whose suffix is).
//   2. Every provider's TIER_MODELS entry must resolve through MODEL_ID_MAP.
//   3. Every LLMProvider literal is in PROVIDER_MAP.
//   4. Every LLMModelTier literal is in TIER_MAP.
//   5. No forbidden vendor token survives a representative-payload translation.
//
// A new SKU added to TR's pricing.ts without a registry update fails CI here.

import { MODEL_PRICING } from '../llm/pricing';
import { TIER_MODELS as ANTHROPIC_TIERS } from '../llm/providers/anthropic';
import { TIER_MODELS as OPENAI_TIERS } from '../llm/providers/openai';
import { TIER_MODELS as GOOGLE_TIERS } from '../llm/providers/google';
import {
  PROVIDER_MAP,
  TIER_MAP,
  MODEL_ID_MAP,
  liftoffifyJsonValue,
  liftoffifyString,
} from '../branding/registry';

// TR's MODEL_PRICING is keyed by "provider:modelId". Strip the prefix when
// asserting against MODEL_ID_MAP.
function modelOf(key: string): string {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(i + 1);
}

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\banthropic\b/i,
  /\bopenai\b/i,
  /\bvertex\b/i,
  /\bgoogle\b/i,
  /\bgemini\b/i,
  /\bclaude\b/i,
  /\bcodex\b/i,
  /claude-(?:opus|sonnet|haiku)/i,
  /gpt-5\.\d+/i,
  /gpt-6/i,
  /claude-fable/i,
  /gemini-[\d.]/i,
  /text-embedding-3/i,
  /claude-(?:agent-)?sdk/i,
  /codex-agent-sdk/i,
];

describe('tenant-runtime PR 1.1 coverage — every SKU is represented in the registry', () => {
  it('every model in MODEL_PRICING translates through the registry (direct map OR string fall-through)', () => {
    // Direct lookup via MODEL_KEYS first; if absent, MODEL_KEYS falls through
    // to liftoffifyString which applies STRING_REPLACEMENTS (e.g. the
    // claude-opus[\\w.-]+ regex covers legacy pricing rows like
    // "claude-opus-4" and "claude-opus-4.1").
    const leaks: string[] = [];
    for (const key of Object.keys(MODEL_PRICING)) {
      const model = modelOf(key);
      if (model === 'default') continue;
      const translated = liftoffifyString(model);
      if (translated === model) leaks.push(model);
    }
    expect(leaks).toEqual([]);
  });

  it('every provider TIER_MODELS entry resolves through MODEL_ID_MAP', () => {
    const providers: Record<string, Record<string, string>> = {
      anthropic: ANTHROPIC_TIERS,
      openai: OPENAI_TIERS,
      google: GOOGLE_TIERS,
    };
    const missing: Array<{ provider: string; model: string }> = [];
    for (const [provider, tiers] of Object.entries(providers)) {
      for (const m of Object.values(tiers)) {
        if (!(m in MODEL_ID_MAP)) missing.push({ provider, model: m });
      }
    }
    expect(missing).toEqual([]);
  });

  it('every LLMProvider literal is in PROVIDER_MAP', () => {
    for (const p of ['anthropic', 'google', 'openai']) {
      expect(PROVIDER_MAP[p]).toBe('liftoff');
    }
  });

  it('still redacts a provider name that only HISTORY carries', () => {
    // 'anthropic-vertex' is retired and is no longer an LLMProvider, so it is
    // deliberately absent from the list above. The entry stays anyway: an
    // unmapped provider returns the VENDOR'S OWN NAME to the customer, and
    // invocations and usage rows written while it existed still say it. The
    // map is the redaction gate for a structured `provider` field, so it has
    // to outlive the provider.
    expect(PROVIDER_MAP['anthropic-vertex']).toBe('liftoff');
  });

  it('every LLMModelTier literal is in TIER_MAP', () => {
    for (const t of ['large', 'medium', 'small']) {
      expect(typeof TIER_MAP[t]).toBe('string');
    }
  });

  it('brands a record written under the retired top-tier name as large', () => {
    // Usage rows and audit payloads are never rewritten, so they keep the name
    // the top tier had when they were written.
    expect(liftoffifyJsonValue({ tier: 'flagship' })).toEqual({ tier: TIER_MAP.large });
    expect(liftoffifyJsonValue({ name: 'Claude Opus 4.6', tier: 'flagship' }))
      .toEqual({ name: 'Liftoff Hyperion', tier: 'hyperion' });
  });
});

describe('tenant-runtime PR 1.4 customer-response leak scan', () => {
  it('no forbidden vendor token survives liftoffifyJsonValue on a representative payload', () => {
    const payload = {
      provider: 'anthropic',
      tier: 'large',
      modelId: 'claude-opus-4-6',
      model: 'gpt-5.4-mini',
      name: 'Claude Sonnet 4.6',
      engineConfig: { type: 'claude-agent-sdk' },
      outputSummary: 'anthropic.RateLimitError on claude-sonnet-4-6',
      errorCode: 'openai.InvalidRequest',
      message: 'Gemini-3.1-flash overloaded',
      reason: 'vertex-ai timeout',
    };
    const translated = JSON.stringify(liftoffifyJsonValue(payload));
    const leaks: string[] = [];
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(translated)) leaks.push(re.source);
    }
    expect({ leaks, translated }).toEqual({ leaks: [], translated });
  });

  it('liftoffifyString redacts every forbidden token in representative free text', () => {
    const samples = [
      'anthropic.OverloadedError',
      'openai.InvalidRequest',
      'google.ResourceExhausted',
      'Claude returned an error',
      'gemini-3.1-pro is slow',
      'text-embedding-3-large failed',
      'vertex-ai timeout',
    ];
    for (const input of samples) {
      const out = liftoffifyString(input);
      for (const re of FORBIDDEN_PATTERNS) {
        if (re.test(out)) {
          throw new Error(`Leak in "${input}" → "${out}" (pattern ${re.source})`);
        }
      }
    }
  });
});

describe('codenames for the Frontier model and the GPT-6 line', () => {
  it('Claude Fable 5.1 is Cronus in both spellings and in free text', () => {
    expect(MODEL_ID_MAP['claude-fable-5-1']).toBe('cronus');
    expect(MODEL_ID_MAP['claude-fable-5.1']).toBe('cronus');
    expect(liftoffifyString('overloaded: claude-fable-5-1-20261001')).toBe('overloaded: cronus');
  });

  it('a registry row naming Fable displays as Liftoff Cronus', () => {
    const out = liftoffifyJsonValue({ name: 'Claude Fable 5.1', modelId: 'claude-fable-5-1' }) as Record<string, unknown>;
    expect(out).toEqual({ name: 'Liftoff Cronus', modelId: 'cronus' });
  });

  it.each([
    ['gpt-6-astra', 'hyperion'],
    ['gpt-6-sol', 'apollo'],
    ['gpt-6-luna', 'eos'],
    ['gpt-5.6-sol', 'hyperion'],
    ['gpt-5.6-terra', 'apollo'],
    ['gpt-5.6-luna', 'eos'],
  ])('%s brands as %s by map and by free text', (model, codename) => {
    expect(MODEL_ID_MAP[model]).toBe(codename);
    expect(liftoffifyString(`timeout on ${model}`)).toBe(`timeout on ${codename}`);
  });
});
