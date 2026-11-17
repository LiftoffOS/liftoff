// Liftoff brand registry — single source of truth for vendor → Liftoff
// translation. Imported by all customer-facing response paths.
//
// Adding a new provider / model / tier / engine requires a one-line edit to
// the relevant map. The CI guardrail (src/__tests__/branding-guardrail.test.ts)
// fails until coverage assertions are updated.

import { RESOLVED_PROVIDERS } from '../agent-execution/adapter/types';
import { normalizeTier } from '../llm/types';

export const REBRAND_VERSION = 1;

/** Provider map: every LLM provider collapses to 'liftoff'.
 *
 *  DERIVED, because a miss here is a LEAK rather than a gap: the lookup is
 *  `PROVIDER_MAP[value] ?? value`, so a provider nobody added returns the
 *  vendor's own name to the customer, on a surface whose whole purpose is that
 *  they never see one. Written out, it was missing five — xai, glm, qwen,
 *  deepseek and kimi had all become providers while this held the six it was
 *  born with.
 *
 *  The extras are the names that are NOT families: the transports Anthropic has
 *  been reached over, and the gateway, which stored rows still carry.
 *
 *  'anthropic-vertex' is listed EXPLICITLY and must stay that way. It used to
 *  arrive through RESOLVED_PROVIDERS; the provider is retired, so deriving the
 *  map alone silently dropped it — and an unmapped provider returns the
 *  VENDOR'S OWN NAME to the customer, which is the one thing this map exists to
 *  prevent. Invocations, usage rows and cost payloads written while it existed
 *  still say it, so the redaction has to outlive the provider. */
export const PROVIDER_MAP: Record<string, string> = Object.fromEntries(
  [...RESOLVED_PROVIDERS, 'anthropic-vertex', 'vertex-ai', 'openrouter'].map((p) => [p, 'liftoff']),
);

/** Tier map. The canonical tier set is large / medium / small — the same
 *  union as `LLMModelTier` and `ModelTier`.
 *
 *  Lookups go through normalizeTier, because what is branded here is often a
 *  record written under the top tier's retired name (usage rows, audit
 *  payloads) and those are never rewritten. An unrecognised tier yields no
 *  codename rather than leaking a vendor token. */
export const TIER_MAP: Record<string, string> = {
  large:    'hyperion',
  medium:   'apollo',
  small:    'eos',
};

/** Model ID map. Covers IDs that can appear in llm_usage_log rows or in
 *  customer-facing audit payloads. Liftoff has only ever used Claude 4.5+ in
 *  production, plus the canonical Gemini 3.1 set, the GPT-5.x family, and the
 *  OpenAI text-embedding-3 family. */
export const MODEL_ID_MAP: Record<string, string> = {
  // cronus (Frontier: Claude Fable 5.1). No tier maps to it, deliberately: a
  // Frontier model sits above the ladder and is reached only by a pin, so its
  // codename comes from the model id alone. Both spellings, as for Opus 5.5.
  'claude-fable-5-1':          'cronus',
  'claude-fable-5.1':          'cronus',
  // hyperion (large)
  // Both spellings: the dash form is the vendor's, the dotted form is what
  // normalizeModelId produces when it collapses a trailing `-N-N`.
  'claude-opus-5-5':           'hyperion',
  'claude-opus-5.5':           'hyperion',
  'claude-opus-5':             'hyperion',
  'claude-opus-4-8':           'hyperion',
  'claude-opus-4-7':           'hyperion',
  'claude-opus-4-6':           'hyperion',
  'claude-opus-4-5':           'hyperion',
  'claude-opus-4.5':           'hyperion',
  'claude-opus-4.6':           'hyperion',
  'claude-opus-4.7':           'hyperion',
  'claude-opus-4.8':           'hyperion',
  'gpt-5.4':                   'hyperion',
  'gpt-5.4-2026-03-05':        'hyperion',
  'gpt-5.5':                   'hyperion',
  'gpt-5.6-sol':               'hyperion',
  'gpt-6-astra':               'hyperion',
  'gemini-3.1-pro':            'hyperion',
  'gemini-3.1-pro-preview':    'hyperion',
  opus:                        'hyperion',
  // apollo (medium)
  // Both spellings, as for Opus 5.5: the dash form is the vendor's, the dotted
  // form is what normalizeModelId produces when it collapses a trailing `-N-N`.
  'claude-sonnet-5-5':         'apollo',
  'claude-sonnet-5.5':         'apollo',
  'claude-sonnet-5':           'apollo',
  'claude-sonnet-4-6':         'apollo',
  'claude-sonnet-4-5':         'apollo',
  'claude-sonnet-4.5':         'apollo',
  'claude-sonnet-4.6':         'apollo',
  'gpt-5.4-mini':              'apollo',
  'gpt-5.5-mini':              'apollo',
  // GPT-6.1 Sol is the medium slot — same codename as the gpt-6-sol it succeeds.
  'gpt-6.1-sol':               'apollo',
  'gpt-5.6-terra':             'apollo',
  // MEDIUM, and the entry most easily got wrong. `gpt-5.6-sol` above is
  // hyperion; the GPT-6 line reuses the name one slot down.
  'gpt-6-sol':                 'apollo',
  'gemini-3.1-flash':          'apollo',
  'gemini-3.5-flash':          'apollo',
  default:                     'apollo',
  sonnet:                      'apollo',
  // eos (small)
  'claude-haiku-4-5':          'eos',
  'claude-haiku-4-5-20251001': 'eos',
  'claude-haiku-4.5':          'eos',
  'gpt-5.4-nano':              'eos',
  'gpt-5.5-nano':              'eos',
  'gpt-5.6-luna':              'eos',
  'gpt-6-luna':                'eos',
  'gemini-3.1-flash-lite':     'eos',
  haiku:                       'eos',
  // GLM (Z.ai), served over OpenRouter. Bare usage-row / cost-row model form;
  // the coverage test strips the MODEL_PRICING provider prefix via modelOf()
  // first.
  'z-ai/glm-5.3':              'hyperion',
  'z-ai/glm-5.3-flash':        'eos',
  'z-ai/glm-5.3-prime':        'hyperion',
  'z-ai/glm-5.3-flashx':       'eos',
  'z-ai/glm-5.2':              'hyperion',
  'z-ai/glm-5-turbo':          'apollo',
  'z-ai/glm-4.7-flash':        'eos',
  // Qwen / DeepSeek / Kimi, served over the same gateway. Bare
  // usage-row / cost-row model form, same convention as GLM above.
  // qwen3-coder-plus maps to hyperion: it is only ever selected as the
  // large-tier coding override.
  'qwen/qwen3.8-max':          'hyperion',
  'qwen/qwen3.7-plus':         'apollo',
  'qwen/qwen3.8-flash':        'eos',
  'qwen/qwen3.7-flash':        'eos',
  'qwen/qwen3-coder-plus':     'hyperion',
  'deepseek/deepseek-v4-pro':     'hyperion',
  'deepseek/deepseek-v4-flash':   'apollo',
  'deepseek/deepseek-v4.1-flash': 'eos',
  'moonshotai/kimi-k3':        'hyperion',
  'moonshotai/kimi-k2.6':      'eos',
  'xiaomi/mimo-v2.6-pro':              'hyperion',
  'xiaomi/mimo-v2.6-pro-ultraspeed':   'hyperion',
  'xiaomi/mimo-v2.6-flash':            'eos',
  'minimax/minimax-m3':        'hyperion',
  'minimax/minimax-m2.7':      'eos',
  // Grok (SpaceXAI/xAI via OpenRouter). grok-4.20 is the SMALL tier despite the
  // high version number — the tier is the platform's speed/cost slot, not the
  // vendor's ordering.
  // Native ids: Grok executes on xAI's own API. The OpenRouter slugs stay for
  // rows recorded before it moved.
  'grok-4.6':                  'hyperion',
  'grok-4.3':                  'apollo',
  'grok-4.20-0309-non-reasoning': 'eos',
  'grok-4.20-0309-reasoning':  'eos',
  'grok-4.20':                 'eos',
  'x-ai/grok-4.6':             'hyperion',
  'x-ai/grok-4.3':             'apollo',
  'x-ai/grok-4.20':            'eos',
  // embed class — every model name that can appear in usage_ledger / cost rows.
  // MODEL_PRICING is keyed by `${provider}:${model}` (e.g. `voyage:voyage-4`);
  // the test extracts the model portion via modelOf() and translates it here.
  'text-embedding-3-small':         'embed',
  'text-embedding-3-large':         'embed',
  'text-embedding-004':             'embed',
  'text-embedding-005':             'embed',
  'text-multilingual-embedding-002':'embed',
  'gemini-embedding-001':           'embed',
  'voyage-4-large':                 'embed',
  'voyage-4':                       'embed',
  'voyage-4-lite':                  'embed',
  'voyage-3.5':                     'embed',
  'voyage-3.5-lite':                'embed',
  'voyage-3':                       'embed',
  'voyage-3-large':                 'embed',
  'voyage-3-lite':                  'embed',
  'voyage-context-3':               'embed',
  'voyage-code-3':                  'embed',
  'voyage-finance-2':               'embed',
  'voyage-law-2':                   'embed',
  'voyage-code-2':                  'embed',
  'voyage-multilingual-2':          'embed',
};

/** Engine map. Preserves the structural suffix so customers see clear types. */
export const ENGINE_MAP: Record<string, string> = {
  'claude-sdk':       'liftoff-sdk',
  'claude-agent-sdk': 'liftoff-agent-sdk',
  'codex-agent-sdk':  'liftoff-agent-sdk',
};

// Field-name allow-lists. The walker only translates values inside keys listed
// here — arbitrary leaf strings are left alone, preventing collateral damage
// to customer-authored text.
export const TIER_KEYS = new Set([
  'tier', 'defaultTier', 'default_tier', 'modelTier', 'model_tier',
  'taskTierOverrides', 'modelHint', 'model_hint',
]);
export const MODEL_KEYS = new Set([
  'model', 'modelId', 'model_id', 'modelName', 'model_name',
  'llm_model', 'defaultModel', 'default_model',
  'previousModelId', 'previous_model_id', 'taskOverrides',
]);
export const PROVIDER_KEYS = new Set([
  'provider', 'vendor', 'defaultProvider', 'default_provider',
]);
// type translates only inside an engineConfig parent (see liftoffifyJsonValue);
// engineType/engine_type/engine translate unconditionally.
export const ENGINE_KEYS = new Set(['type', 'engineType', 'engine_type', 'engine']);
export const SERVER_TEXT_KEYS = new Set([
  'outputSummary',
  'errorCode', 'error_code',
  'code',
  'message',
  'errorMessage', 'error_message',
  'errorDetail',
  'reason',
]);

// String-replacement patterns. Applied ONLY to values of SERVER_TEXT_KEYS
// and to the leaf strings reached via the engine fast-path (so we never
// accidentally rewrite customer prose like "tell Claude to summarize…").
//
// Order matters: longest-first so substrings don't shadow longer matches.
export const STRING_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
  // Anthropic model substrings. [\w.-] matches both dash-format
  // (claude-opus-4-6) and dot-format (claude-opus-4.6) and dated variants
  // (claude-opus-4-20250514). \w alone would stop at the first dot.
  { pattern: /claude-fable[\w.-]+/gi,  replacement: 'cronus' },
  { pattern: /claude-opus[\w.-]+/gi,   replacement: 'hyperion' },
  { pattern: /claude-sonnet[\w.-]+/gi, replacement: 'apollo' },
  { pattern: /claude-haiku[\w.-]+/gi,  replacement: 'eos' },
  // OpenAI. Every non-large variant BEFORE the generic gpt-5.x rule, which
  // brands whatever it matches as large. 5.6 names its tiers: sol is
  // large (the catch-all is right for it), terra medium, luna small.
  { pattern: /gpt-5\.\d+-nano/gi, replacement: 'eos' },
  { pattern: /gpt-5\.\d+-luna/gi, replacement: 'eos' },
  { pattern: /gpt-5\.\d+-mini/gi, replacement: 'apollo' },
  { pattern: /gpt-5\.\d+-terra/gi, replacement: 'apollo' },
  { pattern: /gpt-5\.\d+(?:-[\w.-]+)?/gi, replacement: 'hyperion' },
  // GPT-6 needs its own rules: the 5.x patterns require a literal `gpt-5.`.
  // The names moved one slot down (sol is medium here), so they are spelled per
  // generation. Same ordering law: non-large variants before the catch-all.
  { pattern: /gpt-6-luna[\w.-]*/gi, replacement: 'eos' },
  { pattern: /gpt-6-sol[\w.-]*/gi, replacement: 'apollo' },
  { pattern: /gpt-6[\w.-]*/gi, replacement: 'hyperion' },
  // OpenAI embeddings
  { pattern: /text-embedding-3-\w+/gi, replacement: 'embed' },
  // Google Vertex AI embeddings (gemini-embedding-001, text-embedding-005,
  // text-embedding-004, text-multilingual-embedding-002)
  { pattern: /gemini-embedding-[\w.-]+/gi, replacement: 'embed' },
  { pattern: /text-embedding-\d+/gi, replacement: 'embed' },
  { pattern: /text-multilingual-embedding-[\w.-]+/gi, replacement: 'embed' },
  // Voyage embeddings (voyage-4, voyage-3.5, voyage-code-3, voyage-finance-2, ...)
  { pattern: /\bvoyage-[\w.-]+/gi, replacement: 'embed' },
  // Gemini patterns. -flash-lite must come BEFORE -flash because the latter
  // is a substring of the former.
  { pattern: /gemini-[\d.]+-flash-lite/gi, replacement: 'eos' },
  { pattern: /gemini-[\d.]+-flash/gi,      replacement: 'apollo' },
  { pattern: /gemini-[\d.]+-pro/gi,        replacement: 'hyperion' },
  // Z.ai GLM open-weights. turbo=medium BEFORE generic glm-5=large (glm-5[\w.-]*
  // would otherwise swallow "glm-5-turbo"); glm-4.x=small. Optional z-ai/ prefix
  // consumes the full OpenRouter slug, not just the version suffix.
  { pattern: /(?:z-ai\/)?glm-5[.-]turbo/gi, replacement: 'apollo' },
  // Both 5.3 flash builds are Haiku-class and must precede the generic glm-5
  // catch-all below, which would otherwise brand them as the flagship and
  // tell a customer their small-tier work ran on the expensive model.
  // flashx BEFORE flash: [\w.-]* would let the flash rule swallow the x.
  { pattern: /(?:z-ai\/)?glm-5\.3-flashx[\w.-]*/gi, replacement: 'eos' },
  { pattern: /(?:z-ai\/)?glm-5\.3-flash[\w.-]*/gi, replacement: 'eos' },
  { pattern: /(?:z-ai\/)?glm-5[\w.-]*/gi,    replacement: 'hyperion' },
  { pattern: /(?:z-ai\/)?glm-4[\w.-]*/gi,    replacement: 'eos' },
  // Qwen open-weights. coder BEFORE -plus (qwen3-coder-plus would otherwise be
  // swallowed by the -plus pattern); -max=large, -plus=medium, -flash=small.
  { pattern: /(?:qwen\/)?qwen3-coder[\w.-]*/gi,   replacement: 'hyperion' },
  { pattern: /(?:qwen\/)?qwen[\d.]*-max[\w.-]*/gi,   replacement: 'hyperion' },
  { pattern: /(?:qwen\/)?qwen[\d.]*-plus[\w.-]*/gi,  replacement: 'apollo' },
  { pattern: /(?:qwen\/)?qwen[\d.]*-flash[\w.-]*/gi, replacement: 'eos' },
  // DeepSeek / Kimi. EXACT families only (v4-pro/v4-flash/v4.1-flash, k3/k2.x)
  // — no vendor-wide catchall, so registry-only ids stay untouched by static
  // patterns and get their codename from the registry-branding overlay.
  //
  // v4.1-flash needs its OWN pattern: the version sits between the family and
  // the variant, so `deepseek-v4-flash` does not reach it and it would fall to
  // the generic vendor pass, which rewrites the vendor token and leaves
  // `-v4.1-flash` in front of a customer.
  { pattern: /(?:deepseek\/)?deepseek-v4-pro[\w.-]*/gi,     replacement: 'hyperion' },
  { pattern: /(?:deepseek\/)?deepseek-v4\.1-flash[\w.-]*/gi, replacement: 'eos' },
  { pattern: /(?:deepseek\/)?deepseek-v4-flash[\w.-]*/gi,   replacement: 'apollo' },
  { pattern: /(?:moonshotai\/)?kimi-k3[\w.-]*/gi, replacement: 'hyperion' },
  { pattern: /(?:moonshotai\/)?kimi-k2[\w.-]*/gi, replacement: 'eos' },
  // MiniMax. m2.7 uses an ESCAPED dot and there is deliberately no looser
  // `minimax-m2` pattern: the rest of the M2.x line is not served here, and an
  // unserved id must not be branded as a tier it does not occupy.
  { pattern: /(?:minimax\/)?minimax-m3[\w.-]*/gi,   replacement: 'hyperion' },
  // MiMo. pro's rule carries [\w.-]* so `-ultraspeed` is consumed rather than
  // left in front of a customer as `hyperion-ultraspeed`.
  { pattern: /(?:xiaomi\/)?mimo-v2\.6-flash[\w.-]*/gi, replacement: 'eos' },
  { pattern: /(?:xiaomi\/)?mimo-v2\.6-pro[\w.-]*/gi,   replacement: 'hyperion' },
  { pattern: /(?:minimax\/)?minimax-m2\.7[\w.-]*/gi, replacement: 'eos' },
  // Grok. EXACT families, longest-first (4.20 before any future 4.2).
  { pattern: /(?:x-ai\/)?grok-4\.20[\w.-]*/gi, replacement: 'eos' },
  { pattern: /(?:x-ai\/)?grok-4\.6[\w.-]*/gi,  replacement: 'hyperion' },
  { pattern: /(?:x-ai\/)?grok-4\.3[\w.-]*/gi,  replacement: 'apollo' },
  // Engine/SDK identifiers (longest-first; -agent-sdk before -sdk)
  { pattern: /\bclaude-agent-sdk\b/gi, replacement: 'liftoff-agent-sdk' },
  { pattern: /\bcodex-agent-sdk\b/gi,  replacement: 'liftoff-agent-sdk' },
  { pattern: /\bclaude-sdk\b/gi,       replacement: 'liftoff-sdk' },
  // Error-class prefixes
  { pattern: /\banthropic\./gi, replacement: 'liftoff.' },
  { pattern: /\bopenai\./gi,    replacement: 'liftoff.' },
  { pattern: /\bgoogle\./gi,    replacement: 'liftoff.' },
  { pattern: /\bvertex-ai\b/gi, replacement: 'liftoff' },
  // Generic vendor pass (last; word-boundary, case-insensitive).
  // `google`, `vertex`, `codex` are included to catch bare brand mentions
  // surfaced in error messages and free-form reason fields. The CI guardrail
  // in src/__tests__/branding-guardrail.test.ts is the authority — any
  // forbidden token that survives translation fails the build.
  { pattern: /\banthropic\b/gi, replacement: 'liftoff' },
  { pattern: /\bopenai\b/gi,    replacement: 'liftoff' },
  { pattern: /\bgoogle\b/gi,    replacement: 'liftoff' },
  { pattern: /\bclaude\b/gi,    replacement: 'liftoff' },
  { pattern: /\bgemini\b/gi,    replacement: 'liftoff' },
  { pattern: /\bvertex\b/gi,    replacement: 'liftoff' },
  { pattern: /\bcodex\b/gi,     replacement: 'liftoff' },
];

const MAX_DEPTH = 6;
const MAX_STRING_SCAN = 16384;

/** Recursively rewrite a JSON-shaped value for customer-facing responses.
 *
 *  `parentKey` is the key under which the current `value` sits in its parent
 *  object. The walker only translates leaf strings whose key matches one of
 *  the allow-list sets. `type` keys translate ONLY inside an `engineConfig`
 *  parent — that is, when their grandparent object lives at key `engineConfig`.
 *  The engineType/engine_type/engine variants translate unconditionally.
 *
 *  Returns a new value; does not mutate the input. */
export function liftoffifyJsonValue(
  value: unknown,
  parentKey?: string,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return value;
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(item =>
      typeof item === 'string'
        ? translateLeafString(item, parentKey, undefined)
        : liftoffifyJsonValue(item, parentKey, depth + 1),
    );
  }

  if (typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const derivedName = deriveLiftoffName(obj);
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (k === 'name' && derivedName !== undefined && typeof v === 'string') {
      out[k] = derivedName;
      continue;
    }
    if (typeof v === 'string') {
      out[k] = translateLeafString(v, k, parentKey);
      continue;
    }
    out[k] = liftoffifyJsonValue(v, k, depth + 1);
  }
  return out;
}

/** Derive a Liftoff-branded display name from sibling tier/model fields.
 *  Used by liftoffifyJsonValue to translate a model-registry row's `name`
 *  column ("Claude Sonnet 4.6", "Claude Opus 4.7", …) into the customer-safe
 *  "Liftoff Cronus" / "Liftoff Hyperion" / "Liftoff Apollo" / "Liftoff Eos". */
function deriveLiftoffName(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.name !== 'string') return undefined;
  let tierKey: string | undefined;

  const tierSibling = obj.tier ?? obj.defaultTier ?? obj.modelTier ?? obj.model_tier;
  if (typeof tierSibling === 'string') {
    tierKey = TIER_MAP[normalizeTier(tierSibling)];
  }
  if (!tierKey) {
    const modelSibling = obj.modelId ?? obj.model_id ?? obj.model;
    if (typeof modelSibling === 'string') {
      tierKey = MODEL_ID_MAP[modelSibling];
    }
  }
  if (tierKey === 'cronus')   return 'Liftoff Cronus';
  if (tierKey === 'hyperion') return 'Liftoff Hyperion';
  if (tierKey === 'apollo')   return 'Liftoff Apollo';
  if (tierKey === 'eos')      return 'Liftoff Eos';
  return undefined;
}

// ── Registry-sourced branding overlay (model→codename derived from tier) ────
// Installed by src/llm/model-registry-loader.ts from platform-backend's
// /api/internal/model-registry snapshot (TR has no direct DB access). Consulted
// FIRST so a model onboarded via a registry row is redacted in the tenant-runtime
// plane too — WITHOUT a static branding-file edit — matching PB. The static
// MODEL_ID_MAP / STRING_REPLACEMENTS below remain the offline / CI-guardrail
// coverage for shipped models. null until the first load (offline / tests).
let registryModelBranding: Map<string, string> | null = null;

/** Install (or clear, with null) the registry-derived model→codename overlay. */
export function setRegistryModelBranding(entries: Map<string, string> | null): void {
  registryModelBranding = entries;
}

/** Apply key-specific translation rules to a single string value.
 *  `parentKey` is the key under which the enclosing object sits — required
 *  to gate `type` to `engineConfig` parents per ENGINE_KEYS contract. */
function translateLeafString(
  value: string,
  keyName: string | undefined,
  parentKey: string | undefined,
): string {
  if (!keyName) return value;

  if (TIER_KEYS.has(keyName)) {
    return TIER_MAP[normalizeTier(value)] ?? value;
  }
  if (MODEL_KEYS.has(keyName)) {
    return registryModelBranding?.get(value) ?? MODEL_ID_MAP[value] ?? liftoffifyString(value);
  }
  if (PROVIDER_KEYS.has(keyName)) {
    return PROVIDER_MAP[value] ?? value;
  }
  if (keyName === 'type') {
    // Only translate `type` inside an engineConfig parent — keeps unrelated
    // type fields (trigger_config.type, citation.type, …) intact.
    if (parentKey === 'engineConfig') {
      return ENGINE_MAP[value] ?? value;
    }
    return value;
  }
  if (keyName === 'engineType' || keyName === 'engine_type' || keyName === 'engine') {
    return ENGINE_MAP[value] ?? value;
  }
  if (SERVER_TEXT_KEYS.has(keyName)) {
    return liftoffifyString(value);
  }
  return value;
}

/** Apply STRING_REPLACEMENTS to a free-text string. Capped at MAX_STRING_SCAN
 *  to avoid pathological cost on adversarial input. */
export function liftoffifyString(value: string): string {
  if (value.length > MAX_STRING_SCAN) {
    return value.slice(0, MAX_STRING_SCAN);
  }
  let out = value;
  for (const { pattern, replacement } of STRING_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  // Registry-sourced model ids not covered by a static pattern above (e.g. a model
  // onboarded via a registry row only) — exact-substring redact to its codename.
  if (registryModelBranding) {
    for (const [modelId, codename] of registryModelBranding) {
      if (out.includes(modelId)) out = out.split(modelId).join(codename);
    }
  }
  return out;
}
