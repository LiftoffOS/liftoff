
/** Provider map: every LLM provider collapses to 'liftoff'.
 *
 *  A MISS HERE IS A LEAK, not a gap: the lookup is `PROVIDER_MAP[value] ??
 *  value`, so a provider nobody added returns the vendor's own name to the
 *  customer. It was missing five — xai, glm, qwen, deepseek and kimi had all
 *  become providers while this held the six it was born with. Covered against
 *  the vendor record by branding-covers-every-provider.test.ts, which is in
 *  platform-backend only: this file is mirrored byte-for-byte into
 *  @liftoffos/shared-types and cannot import from src/.
 *
 *  'openrouter' stays. It is not a family — it is the gateway the four
 *  open-weight vendors are reached through, and rows written before migration
 *  448 still name it. */
export const PROVIDER_MAP: Record<string, string> = {
  anthropic:          'liftoff',
  'anthropic-vertex': 'liftoff',
  'vertex-ai':        'liftoff',
  google:             'liftoff',
  openai:             'liftoff',
  openrouter:         'liftoff',
  xai:                'liftoff',
  glm:                'liftoff',
  qwen:               'liftoff',
  deepseek:           'liftoff',
  kimi:               'liftoff',
  minimax:            'liftoff',
  xiaomi:             'liftoff',
  // The Jev classifier's vendor. Only ever a usage-row provider (LLMUsageProvider);
  // listed so no vendor identifier can reach a customer surface through a row.
  typesafe:           'liftoff',
};

/** Tier map. The canonical tier set is large / medium / small — the same
 *  union as `LLMModelTier` and `ModelTier`.
 *
 *  The top tier carried another name from migration 196 until migration 534
 *  restored 'large'. No alias for the old name is kept: 534 rewrites every
 *  stored tier value, a sweep of dev and prod before it found the old name
 *  only in `models.tier`, and an unrecognised tier here yields no codename rather than
 *  leaking a vendor token. */
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
  // cronus (Frontier). A VENDOR DESIGNATION above the large tier, not a tier: it
  // has no TIER_MAP entry because no tier routes to it, and its registry row
  // carries a NULL tier (migration 529), so the registry overlay cannot brand
  // it — this entry is what does. Both spellings, as for Opus 5.5 below.
  // GPT-6 Astra is OpenAI's Frontier model AND its large-tier model, one id with
  // one codename, and stays hyperion.
  'claude-fable-5-2':          'cronus',
  'claude-fable-5.2':          'cronus',
  'claude-fable-5-1':          'cronus',
  'claude-fable-5.1':          'cronus',
  // hyperion (large)
  // Opus 5.5 in both spellings: the dash form is the vendor's and this repo's,
  // the dotted form is what the tenant runtime's normalizeModelId produces when
  // it collapses a trailing `-N-N`. A usage row can arrive in either.
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
  // form is what the tenant runtime's normalizeModelId produces when it
  // collapses a trailing `-N-N` — so both are real ids on the wire between the
  // services, and an unmapped one returns the VENDOR'S OWN NAME to a customer.
  'claude-sonnet-5-5':         'apollo',
  'claude-sonnet-5.5':         'apollo',
  'claude-sonnet-5':           'apollo',
  'claude-sonnet-4-6':         'apollo',
  'claude-sonnet-4-5':         'apollo',
  'claude-sonnet-4.5':         'apollo',
  'claude-sonnet-4.6':         'apollo',
  'gpt-5.4-mini':              'apollo',
  // GPT-6.1 Sol is the medium slot — same codename as the gpt-6-sol it succeeds.
  'gpt-6.1-sol':               'apollo',
  'gpt-5.6-terra':             'apollo',
  // GPT-6.1 Terra has NO TIER (see llm/pricing.ts): at $1 / $5 it falls between
  // the medium and small classes and routes from nothing. The codename is the
  // class it is nearest, which is what this map is for — a label a customer can
  // read instead of a vendor id — and `apollo` is also what the `gpt-5.6-terra`
  // above carries. What must NOT follow from either is that it holds the medium
  // slot: in the GPT-5.6 line terra WAS the medium tier, and in this one
  // gpt-6.1-sol is.
  'gpt-6.1-terra':             'apollo',
  // MEDIUM, and the entry most easily got wrong. `gpt-5.6-sol` above is
  // hyperion; the GPT-6 line reuses the name one slot down, so a reader
  // pattern-matching on "sol" brands a customer's medium-tier work as the
  // large tier — which tells them their cheap work ran on the expensive model.
  'gpt-6-sol':                 'apollo',
  'gemini-3.1-flash':          'apollo',
  'gemini-3.5-flash':          'apollo',
  default:                     'apollo',
  sonnet:                      'apollo',
  // eos (small)
  'claude-haiku-5-5':          'eos',
  'claude-haiku-5.5':          'eos',
  'claude-haiku-4-5':          'eos',
  'claude-haiku-4-5-20251001': 'eos',
  'claude-haiku-4.5':          'eos',
  'gpt-5.4-nano':              'eos',
  'gpt-5.6-luna':              'eos',
  'gpt-6-luna':                'eos',
  'gemini-3.1-flash-lite':     'eos',
  haiku:                       'eos',
  // GLM (Z.ai via OpenRouter/Vertex). Bare llm_usage_log.model form only: the
  // provider-prefixed forms are derived below, for every gateway-served vendor
  // at once.
  // glm-5.3 holds large AND medium (Z.ai publishes nothing Opus-class), and
  // takes the higher tier's codename, as every dual-tier model here does.
  'z-ai/glm-5.3':              'hyperion',
  'z-ai/glm-5.3-flash':        'eos',
  // In no tier, but recorded: a stray mention must still redact, and both
  // are same-size faster builds of the id above them.
  'z-ai/glm-5.3-prime':        'hyperion',
  'z-ai/glm-5.3-flashx':       'eos',
  'z-ai/glm-5.2':              'hyperion',
  'z-ai/glm-5-turbo':          'apollo',
  'z-ai/glm-4.7-flash':        'eos',
  // Qwen / DeepSeek / Kimi (OpenRouter-served Workspace AI vendors, migration
  // 322). Bare form here, prefixed forms derived below. qwen3-coder-plus maps
  // to hyperion because it is only ever selected as the vendor-large coding
  // override.
  'qwen/qwen3.8-max-0902':              'hyperion',
  // The undated form is kept as an ALIAS, unlike in the rate and registry
  // tables. Those name a model to REQUEST, so a dead id there is an unroutable
  // call; this one names a model already RECORDED, and rows written under the
  // old id still have to render as a codename rather than fall back to raw.
  'qwen/qwen3.8-max':                   'hyperion',
  'qwen/qwen3.7-plus':                  'apollo',
  'qwen/qwen3.8-flash':                 'eos',
  'qwen/qwen3.7-flash':                 'eos',
  'qwen/qwen3-coder-plus':              'hyperion',
  'deepseek/deepseek-v4-pro':              'hyperion',
  'deepseek/deepseek-v4-flash':            'apollo',
  'deepseek/deepseek-v4.1-flash':          'eos',
  'moonshotai/kimi-k3':                    'hyperion',
  'moonshotai/kimi-k2.6':                  'eos',
  // MiniMax. Two models, because the small tier resolves to the medium one.
  // Xiaomi MiMo. mimo-v2.6-pro holds large AND medium; ultraspeed is the same
  // checkpoint and shares its codename.
  'xiaomi/mimo-v2.6-pro':                  'hyperion',
  'xiaomi/mimo-v2.6-pro-ultraspeed':       'hyperion',
  'xiaomi/mimo-v2.6-flash':                'eos',
  'minimax/minimax-m3':                    'hyperion',
  'minimax/minimax-m2.7':                  'eos',
  // Grok (SpaceXAI/xAI via OpenRouter, migration 380). Same dual-form
  // convention. grok-4.20 is the SMALL tier despite its high version number —
  // the tier is the platform's speed/cost slot, not the vendor's ordering.
  // Native ids first: Grok runs on xAI's own API, so `xai:grok-4.6` is what a
  // live row carries. The OpenRouter-slug forms are kept because historical
  // usage rows, trajectories and invocations recorded under them are still read
  // — dropping them would leave older runs unbranded.
  'xai:grok-4.6':                          'hyperion',
  'grok-4.6':                              'hyperion',
  'xai:grok-4.3':                          'apollo',
  'grok-4.3':                              'apollo',
  'xai:grok-4.20-0309-non-reasoning':      'eos',
  'xai:grok-4.20-0309-reasoning':          'eos',
  'grok-4.20-0309-non-reasoning':          'eos',
  'grok-4.20-0309-reasoning':              'eos',
  'xai:grok-4.20':                         'eos',
  'grok-4.20':                             'eos',
  'x-ai/grok-4.6':                         'hyperion',
  'x-ai/grok-4.3':                         'apollo',
  'x-ai/grok-4.20':                        'eos',
  // embed class — every model name that can appear in llm_usage_log.model.
  // For Voyage rows, MODEL_PRICING is keyed by `voyage:<model>` (provider-aware
  // lookup), but llm_usage_log.model carries just `<model>` — so we register
  // both the prefixed and unprefixed forms here to keep PR 1.1 coverage clean
  // (the branding-guardrail test iterates MODEL_PRICING keys verbatim).
  'text-embedding-3-small':         'embed',
  'text-embedding-3-large':         'embed',
  'text-embedding-004':             'embed',
  'text-embedding-005':             'embed',
  'text-multilingual-embedding-002':'embed',
  'gemini-embedding-001':           'embed',
  'voyage:voyage-4-large':          'embed',
  'voyage:voyage-4':                'embed',
  'voyage:voyage-4-lite':           'embed',
  'voyage:voyage-3.5':              'embed',
  'voyage:voyage-3.5-lite':         'embed',
  'voyage:voyage-3':                'embed',
  'voyage:voyage-3-large':          'embed',
  'voyage:voyage-3-lite':           'embed',
  'voyage:voyage-context-3':        'embed',
  'voyage:voyage-code-3':           'embed',
  'voyage:voyage-finance-2':        'embed',
  'voyage:voyage-law-2':            'embed',
  'voyage:voyage-code-2':           'embed',
  'voyage:voyage-multilingual-2':   'embed',
  // Unprefixed Voyage IDs (as they would land in llm_usage_log.model)
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
  // TypeSafe Jev, the pinned id from src/typesafe/questions.ts, bare and under
  // its pricing key. Customer-neutral.
  'jev-1.13.0':                     'classify',
  'typesafe:jev-1.13.0':            'classify',
};

// The same codename under the provider-qualified form, derived rather than
// listed twice.
//
// A pricing key (`glm:z-ai/glm-5.2`) reaches this map wherever a cost surface
// puts one in a payload, and it has to redact exactly as the bare id does. The
// pairs were hand-kept, so every gateway-served model was written here twice
// and the halves could disagree — and after migration 450 they would have had
// to be written a THIRD time, once per family, while the `openrouter:` forms
// still had to stay for rows already recorded under the gateway.
//
// Every provider crossed with every namespaced id, rather than each id with the
// one provider that publishes it. The codename is a property of the MODEL, so a
// pairing that can never occur (`openai:z-ai/glm-5.2`) resolves to the same
// answer it would if it did, and the cross product needs no table saying which
// publisher belongs to which provider — one less list to leave stale.
for (const modelId of Object.keys({ ...MODEL_ID_MAP })) {
  if (!modelId.includes('/') || modelId.includes(':')) continue;
  for (const provider of Object.keys(PROVIDER_MAP)) {
    MODEL_ID_MAP[`${provider}:${modelId}`] = MODEL_ID_MAP[modelId];
  }
}
// Liftoff brand registry — single source of truth for vendor → Liftoff
// translation. Imported by all customer-facing response paths.
//
// Adding a new provider / model / tier / engine requires a one-line edit to
// the relevant map. The CI guardrail (src/__tests__/branding-guardrail.test.ts)
// fails until coverage assertions are updated.

export const REBRAND_VERSION = 1;

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
  // Fable is the Frontier model (MODEL_ID_MAP above), and its own codename.
  { pattern: /claude-fable[\w.-]+/gi,  replacement: 'cronus' },
  { pattern: /claude-opus[\w.-]+/gi,   replacement: 'hyperion' },
  { pattern: /claude-sonnet[\w.-]+/gi, replacement: 'apollo' },
  { pattern: /claude-haiku[\w.-]+/gi,  replacement: 'eos' },
  // OpenAI. Every non-large variant must be listed BEFORE the generic
  // gpt-5.x rule, which is a catch-all that maps whatever it matches to the
  // large-tier codename. A tier variant missing from this list is not merely
  // unhandled — it is silently branded as the large tier, which tells a customer
  // their small-tier work ran on the expensive model.
  //
  // 5.6 names its tiers rather than numbering them: sol is large (and needs
  // no rule of its own, the catch-all is correct for it), terra is medium,
  // luna is small.
  { pattern: /gpt-5\.\d+-nano/gi, replacement: 'eos' },
  { pattern: /gpt-5\.\d+-luna/gi, replacement: 'eos' },
  { pattern: /gpt-5\.\d+-mini/gi, replacement: 'apollo' },
  { pattern: /gpt-5\.\d+-terra/gi, replacement: 'apollo' },
  { pattern: /gpt-5\.\d+(?:-[\w.-]+)?/gi, replacement: 'hyperion' },
  // GPT-6 needs its OWN rules: the 5.x patterns above all require a literal
  // `gpt-5.` and match nothing here, so without these a raw `gpt-6-sol` in an
  // error string reaches the customer untouched.
  //
  // The generation numbers its tiers by NAME and moved the names one slot down
  // — sol is medium here, where gpt-5.6-sol was large — so `sol` and `luna`
  // are spelled per generation rather than folded into a shared `-sol` rule.
  // Same ordering law as above: every non-large variant BEFORE the
  // catch-all, which brands whatever is left as the large tier. A variant missing
  // from this list is not merely unhandled, it is silently branded hyperion.
  { pattern: /gpt-6-luna[\w.-]*/gi, replacement: 'eos' },
  { pattern: /gpt-6-sol[\w.-]*/gi, replacement: 'apollo' },
  // The trailing [\w.-]* consumes the whole id, the same way the Claude, Grok
  // and Gemini patterns do. An optional `(?:-…)?` group instead would stop at
  // the first dot — a later `gpt-6.1-astra` would render as `hyperion.1-astra`,
  // which leaks no vendor token, so the guardrail scan passes, while still
  // showing a customer half of a model id.
  { pattern: /gpt-6[\w.-]*/gi, replacement: 'hyperion' },
  // OpenAI embeddings
  { pattern: /text-embedding-3-\w+/gi, replacement: 'embed' },
  // Gemini patterns. -flash-lite must come BEFORE -flash because the latter
  // is a substring of the former.
  //
  // The trailing [\w.-]* consumes the variant suffix, the same way the Claude,
  // Grok and Qwen patterns do. Without it a suffixed id is redacted only up to
  // the family name and the rest survives into customer-facing text:
  // `gemini-3.1-pro-preview` became `hyperion-preview`, which leaks no vendor
  // token — so the guardrail scan passed — while still showing a customer half
  // of a model id we do not use in front of them.
  { pattern: /gemini-[\d.]+-flash-lite[\w.-]*/gi, replacement: 'eos' },
  { pattern: /gemini-[\d.]+-flash[\w.-]*/gi,      replacement: 'apollo' },
  { pattern: /gemini-[\d.]+-pro[\w.-]*/gi,        replacement: 'hyperion' },
  // Z.ai GLM open-weights. turbo=medium BEFORE generic glm-5=large (glm-5[\w.-]*
  // would otherwise swallow "glm-5-turbo"); glm-4.x=small. Optional z-ai/ prefix
  // consumes the full OpenRouter slug, not just the version suffix.
  { pattern: /(?:z-ai\/)?glm-5[.-]turbo/gi, replacement: 'apollo' },
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
  // — no vendor-wide catchall, so registry-only ids (e.g. a future deepseek-v5)
  // stay untouched by static patterns and get their codename from the
  // registry-branding overlay, which knows the real tier.
  //
  // v4.1-flash needs its OWN pattern: the version sits between the family and
  // the variant, so `deepseek-v4-flash` does not match it and it would fall
  // through to the generic vendor pass, which rewrites the vendor token and
  // leaves `-v4.1-flash` in front of a customer.
  { pattern: /(?:deepseek\/)?deepseek-v4-pro[\w.-]*/gi,     replacement: 'hyperion' },
  { pattern: /(?:deepseek\/)?deepseek-v4\.1-flash[\w.-]*/gi, replacement: 'eos' },
  { pattern: /(?:deepseek\/)?deepseek-v4-flash[\w.-]*/gi,   replacement: 'apollo' },
  { pattern: /(?:moonshotai\/)?kimi-k3[\w.-]*/gi, replacement: 'hyperion' },
  { pattern: /(?:moonshotai\/)?kimi-k2[\w.-]*/gi, replacement: 'eos' },
  // MiniMax. Same exact-family rule. m2.7 is spelled with an ESCAPED dot and
  // no trailing wildcard before it, so it cannot be reached by a looser
  // `minimax-m2` pattern — there is deliberately no such pattern, because the
  // rest of the M2.x line (m2, m2.1, m2.5) is not registered and an unserved
  // id must not be branded as a tier it does not occupy.
  // MiMo. flash BEFORE pro is not required (disjoint), but pro's rule must
  // carry [\w.-]* so `-ultraspeed` is consumed rather than left in front of
  // a customer as `hyperion-ultraspeed`.
  { pattern: /(?:xiaomi\/)?mimo-v2\.6-flash[\w.-]*/gi, replacement: 'eos' },
  { pattern: /(?:xiaomi\/)?mimo-v2\.6-pro[\w.-]*/gi,   replacement: 'hyperion' },
  { pattern: /(?:minimax\/)?minimax-m3[\w.-]*/gi,   replacement: 'hyperion' },
  { pattern: /(?:minimax\/)?minimax-m2\.7[\w.-]*/gi, replacement: 'eos' },
  // Grok. EXACT families, longest-first: grok-4.20 before grok-4.2 would
  // otherwise be at risk if a 4.2 ever ships, and 4.6/4.3 are unambiguous.
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
/**
 * Plain object detector. Returns true only for object literals or
 * `Object.create(null)` shapes; returns false for built-in instances we must
 * pass through to JSON.stringify unchanged: Date (uses Date.prototype.toJSON),
 * Buffer, Map, Set, class instances, etc.
 *
 * Without this guard, the walk-and-rebuild below would call `Object.entries`
 * on a Date, get back `[]` (Dates have no own enumerable properties), and
 * emit `{}` for that field on the wire. This caused
 *   {"receivedAt":{}}
 * for any TIMESTAMPTZ column returned through the branding middleware and
 * triggered React #31 (object-as-child) in the deliveries list renderer.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

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

  // Date / Buffer / Map / Set / class instances pass through untouched so
  // their downstream JSON serialization (or framework handling) is preserved.
  if (!isPlainObject(value)) return value;

  const obj = value;
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
 *  "Liftoff Hyperion" / "Liftoff Apollo" / "Liftoff Eos". A Frontier row has a
 *  NULL tier, so it is named from its model id: "Liftoff Cronus". */
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
  if (tierKey === 'cronus')   return 'Liftoff Cronus';
  if (tierKey === 'hyperion') return 'Liftoff Hyperion';
  if (tierKey === 'apollo')   return 'Liftoff Apollo';
  if (tierKey === 'eos')      return 'Liftoff Eos';
  return undefined;
}

// ── Registry-sourced branding overlay (Phase 3: branding derived from tier) ──
// model_id → codename, where codename = TIER_MAP[model.tier]. Populated from the
// `models` registry by src/branding/registry-branding-loader.ts on a 60s refresh,
// so a model onboarded via a registry row is redacted WITHOUT hand-editing this
// file. Consulted FIRST (registry is the source of truth); the static MODEL_ID_MAP
// / STRING_REPLACEMENTS below remain the offline / CI-guardrail coverage for the
// shipped models. null until the first load (offline / tests).
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
    return TIER_MAP[value] ?? value;
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
