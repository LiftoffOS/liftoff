// Liftoff brand registry — single source of truth for vendor → Liftoff
// translation. Imported by all customer-facing response paths.
//
// Adding a new provider / model / tier / engine requires a one-line edit to
// the relevant map. The CI guardrail (src/__tests__/branding-guardrail.test.ts)
// fails until coverage assertions are updated.

export const REBRAND_VERSION = 1;

/** Provider map: every LLM provider collapses to 'liftoff'. */
export const PROVIDER_MAP: Record<string, string> = {
  anthropic:          'liftoff',
  'anthropic-vertex': 'liftoff',
  'vertex-ai':        'liftoff',
  google:             'liftoff',
  openai:             'liftoff',
};

/** Tier map. 'large' is a defensive alias for any residual rows where the
 *  models.tier column has not yet been normalized by migration 196. */
export const TIER_MAP: Record<string, string> = {
  flagship: 'hyperion',
  medium:   'apollo',
  small:    'eos',
  large:    'hyperion',
};

/** Model ID map. Covers IDs that can appear in llm_usage_log rows or in
 *  customer-facing audit payloads. Liftoff has only ever used Claude 4.5+ in
 *  production, plus the canonical Gemini 3.1 set, the GPT-5.x family, and the
 *  OpenAI text-embedding-3 family. */
export const MODEL_ID_MAP: Record<string, string> = {
  // hyperion (flagship)
  'claude-opus-4-7':           'hyperion',
  'claude-opus-4-6':           'hyperion',
  'claude-opus-4-5':           'hyperion',
  'claude-opus-4.5':           'hyperion',
  'claude-opus-4.6':           'hyperion',
  'claude-opus-4.7':           'hyperion',
  'gpt-5.4':                   'hyperion',
  'gpt-5.4-2026-03-05':        'hyperion',
  'gemini-3.1-pro':            'hyperion',
  opus:                        'hyperion',
  // apollo (medium)
  'claude-sonnet-4-6':         'apollo',
  'claude-sonnet-4-5':         'apollo',
  'claude-sonnet-4.5':         'apollo',
  'claude-sonnet-4.6':         'apollo',
  'gpt-5.4-mini':              'apollo',
  'gemini-3.1-flash':          'apollo',
  default:                     'apollo',
  sonnet:                      'apollo',
  // eos (small)
  'claude-haiku-4-5':          'eos',
  'claude-haiku-4-5-20251001': 'eos',
  'claude-haiku-4.5':          'eos',
  'gpt-5.4-nano':              'eos',
  'gemini-3.1-flash-lite':     'eos',
  haiku:                       'eos',
  // embed class
  'text-embedding-3-small':    'embed',
  'text-embedding-3-large':    'embed',
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
  { pattern: /claude-opus[\w.-]+/gi,   replacement: 'hyperion' },
  { pattern: /claude-sonnet[\w.-]+/gi, replacement: 'apollo' },
  { pattern: /claude-haiku[\w.-]+/gi,  replacement: 'eos' },
  // OpenAI
  { pattern: /gpt-5\.\d+-nano/gi, replacement: 'eos' },
  { pattern: /gpt-5\.\d+-mini/gi, replacement: 'apollo' },
  { pattern: /gpt-5\.\d+(?:-[\w.-]+)?/gi, replacement: 'hyperion' },
  // OpenAI embeddings
  { pattern: /text-embedding-3-\w+/gi, replacement: 'embed' },
  // Gemini patterns. -flash-lite must come BEFORE -flash because the latter
  // is a substring of the former.
  { pattern: /gemini-[\d.]+-flash-lite/gi, replacement: 'eos' },
  { pattern: /gemini-[\d.]+-flash/gi,      replacement: 'apollo' },
  { pattern: /gemini-[\d.]+-pro/gi,        replacement: 'hyperion' },
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
 *  "Liftoff Hyperion" / "Liftoff Apollo" / "Liftoff Eos". */
function deriveLiftoffName(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.name !== 'string') return undefined;
  let tierKey: string | undefined;

  const tierSibling = obj.tier ?? obj.defaultTier ?? obj.modelTier ?? obj.model_tier;
  if (typeof tierSibling === 'string') {
    tierKey = TIER_MAP[tierSibling];
  }
  if (!tierKey) {
    const modelSibling = obj.modelId ?? obj.model_id ?? obj.model;
    if (typeof modelSibling === 'string') {
      tierKey = MODEL_ID_MAP[modelSibling];
    }
  }
  if (tierKey === 'hyperion') return 'Liftoff Hyperion';
  if (tierKey === 'apollo')   return 'Liftoff Apollo';
  if (tierKey === 'eos')      return 'Liftoff Eos';
  return undefined;
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
    return TIER_MAP[value] ?? value;
  }
  if (MODEL_KEYS.has(keyName)) {
    return MODEL_ID_MAP[value] ?? liftoffifyString(value);
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
  return out;
}
