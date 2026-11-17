// Branding CI guardrail (PR 1.4).
//
// Two assertions:
//   1. Coverage. Every SKU known to the platform must be representable as a
//      Liftoff brand by the registry. New entries to MODEL_PRICING,
//      LLMProvider, LLMModelTier, EngineType, or any provider's TIER_MODELS
//      must show up in the registry maps — otherwise customer responses will
//      leak the new vendor identifier.
//   2. Customer-response scan. The string maps in the registry, when applied
//      to a representative output of every customer-facing response key, must
//      not contain any forbidden vendor token. This is the "leak test".

import {
  PROVIDER_MAP,
  TIER_MAP,
  MODEL_ID_MAP,
  ENGINE_MAP,
  liftoffifyJsonValue,
  liftoffifyString,
} from '../branding/registry';
import { MODEL_PRICING } from '../llm/pricing';

// Vendor tokens that must NEVER appear in a translated customer payload.
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
  // GPT-6 drops the dotted version, so /gpt-5\.\d+/ catches none of it. Without
  // this line the scan below would pass on a payload reading `gpt-6-sol` in
  // full — the leak test blind to the generation the ladder actually runs on.
  /gpt-6\b/i,
  /gemini-[\d.]/i,
  /text-embedding-3/i,
  /claude-(?:agent-)?sdk/i,
  /codex-agent-sdk/i,
];

describe('PR 1.1 coverage — every SKU is represented in the registry', () => {
  it('every model in MODEL_PRICING is in MODEL_ID_MAP', () => {
    const missing: string[] = [];
    for (const modelId of Object.keys(MODEL_PRICING)) {
      if (!(modelId in MODEL_ID_MAP)) missing.push(modelId);
    }
    expect(missing).toEqual([]);
  });

  it('every provider TIER_MODELS entry resolves through MODEL_ID_MAP', async () => {
    // Pull provider TIER_MODELS via dynamic import so this test stays valid
    // even if a new provider is added later — the loader will fail loudly if
    // a provider file lacks the named export.
    const providers = ['anthropic', 'google', 'openai'] as const;
    const missing: Array<{ provider: string; model: string }> = [];
    for (const p of providers) {
      const mod = require(`../llm/providers/${p}`);
      const tiers = Object.values(mod.TIER_MODELS ?? {}) as string[];
      for (const m of tiers) {
        if (!(m in MODEL_ID_MAP)) missing.push({ provider: p, model: m });
      }
    }
    expect(missing).toEqual([]);
  });

  it('every LLMProvider literal is in PROVIDER_MAP', () => {
    const llmProviders = ['anthropic', 'google', 'openai'];
    for (const p of llmProviders) {
      expect(PROVIDER_MAP[p]).toBe('liftoff');
    }
    // Retired, and deliberately still mapped: 'anthropic-vertex' is no longer
    // an LLMProvider, but usage rows and cost payloads written while it existed
    // still carry it, and an unmapped provider returns the VENDOR'S OWN NAME to
    // the customer. The redaction has to outlive the provider.
    expect(PROVIDER_MAP['anthropic-vertex']).toBe('liftoff');
  });

  it('every LLMModelTier literal is in TIER_MAP', () => {
    const tiers = ['large', 'medium', 'small'];
    for (const t of tiers) {
      expect(typeof TIER_MAP[t]).toBe('string');
    }
  });

  it('every EngineType vendor literal is in ENGINE_MAP', () => {
    const engines = ['claude-agent-sdk', 'claude-sdk', 'codex-agent-sdk'];
    for (const e of engines) {
      expect(typeof ENGINE_MAP[e]).toBe('string');
      expect(ENGINE_MAP[e]).toMatch(/^liftoff/);
    }
  });
});

describe('PR 1.4 customer-response leak scan', () => {
  it('no forbidden vendor token survives liftoffifyJsonValue on a representative payload', () => {
    // The payload exercises every allow-list key that the walker translates,
    // every error-class prefix, the engineConfig parent-key path, the name
    // derivation, and the model-id substring rules.
    const payload = {
      provider: 'anthropic',
      defaultProvider: 'openai',
      tier: 'large',
      defaultTier: 'medium',
      modelHint: 'small',
      modelId: 'claude-opus-4-6',
      model: 'gpt-5.4-mini',
      modelName: 'claude-sonnet-4-6',
      previousModelId: 'claude-haiku-4-5',
      taskOverrides: 'text-embedding-3-small',
      name: 'Claude Opus 4.7',
      engineConfig: { type: 'claude-agent-sdk' },
      engineType: 'claude-sdk',
      engine_type: 'codex-agent-sdk',
      outputSummary: 'Claude returned anthropic.RateLimitError on claude-sonnet-4-6',
      errorCode: 'openai.InvalidRequest',
      error_code: 'google.ResourceExhausted',
      message: 'Gemini-3.1-flash overloaded; falling back to claude-haiku-4-5',
      reason: 'vertex-ai timeout from anthropic-vertex',
    };
    const translated = JSON.stringify(liftoffifyJsonValue(payload));
    const leaks: string[] = [];
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(translated)) leaks.push(re.source);
    }
    expect({ leaks, translated }).toEqual({ leaks: [], translated });
  });

  it('liftoffifyString redacts every forbidden token in a free-text scan', () => {
    const samples = [
      'Anthropic upstream returned 429',
      'OpenAI invalid_request_error',
      'Google ResourceExhausted',
      'Gemini-3.1-pro is slow today',
      'Claude returned an error',
      'Vertex-AI ran out of quota',
      'codex-agent-sdk dispatch failed',
      'claude-agent-sdk dispatch failed',
      'claude-opus-4-20250514 was retried',
      'gpt-5.4-2026-03-05 is the latest snapshot',
      'gemini-3.1-flash-lite is cheap',
      'text-embedding-3-large failed',
      'anthropic.OverloadedError raised',
      'openai.InvalidRequestError raised',
      'google.ResourceExhausted raised',
    ];
    for (const input of samples) {
      const out = liftoffifyString(input);
      for (const re of FORBIDDEN_PATTERNS) {
        // Anthropic. / openai. / google. prefixes survive only via the
        // generic word-boundary patterns; the dotted forms get rewritten by
        // the prefix rules. After translation we expect zero forbidden hits.
        if (re.test(out)) {
          throw new Error(`Leak detected in "${input}" → "${out}" (pattern ${re.source})`);
        }
      }
    }
  });
});
