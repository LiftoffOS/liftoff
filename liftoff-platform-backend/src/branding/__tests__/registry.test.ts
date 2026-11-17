import {
  liftoffifyJsonValue,
  liftoffifyString,
  PROVIDER_MAP,
  TIER_MAP,
  MODEL_ID_MAP,
  ENGINE_MAP,
  TIER_KEYS,
  MODEL_KEYS,
  PROVIDER_KEYS,
  ENGINE_KEYS,
  SERVER_TEXT_KEYS,
  REBRAND_VERSION,
} from '../registry';

describe('brand registry', () => {
  describe('REBRAND_VERSION', () => {
    it('starts at 1', () => {
      expect(REBRAND_VERSION).toBe(1);
    });
  });

  describe('liftoffifyJsonValue: tier key', () => {
    it('rewrites large → hyperion', () => {
      expect(liftoffifyJsonValue({ tier: 'large' })).toEqual({ tier: 'hyperion' });
    });
    it('rewrites medium → apollo', () => {
      expect(liftoffifyJsonValue({ tier: 'medium' })).toEqual({ tier: 'apollo' });
    });
    it('rewrites small → eos', () => {
      expect(liftoffifyJsonValue({ tier: 'small' })).toEqual({ tier: 'eos' });
    });
    it('leaves unmapped tier values untouched', () => {
      expect(liftoffifyJsonValue({ subscriptionTier: 'enterprise' })).toEqual({
        subscriptionTier: 'enterprise',
      });
    });
    it('covers every plan-specified tier alias key', () => {
      const aliases = [
        'tier', 'defaultTier', 'default_tier', 'modelTier', 'model_tier',
        'taskTierOverrides', 'modelHint', 'model_hint',
      ];
      for (const k of aliases) {
        expect(liftoffifyJsonValue({ [k]: 'large' })).toEqual({ [k]: 'hyperion' });
      }
    });
  });

  describe('liftoffifyJsonValue: model key', () => {
    it('rewrites claude-sonnet-4-6 → apollo', () => {
      expect(liftoffifyJsonValue({ modelId: 'claude-sonnet-4-6' })).toEqual({ modelId: 'apollo' });
    });
    it('rewrites claude-opus-4-7 → hyperion', () => {
      expect(liftoffifyJsonValue({ model: 'claude-opus-4-7' })).toEqual({ model: 'hyperion' });
    });
    it('rewrites gemini-3.1-pro → hyperion', () => {
      expect(liftoffifyJsonValue({ modelId: 'gemini-3.1-pro' })).toEqual({ modelId: 'hyperion' });
    });
    it('rewrites text-embedding-3-large → embed', () => {
      expect(liftoffifyJsonValue({ modelId: 'text-embedding-3-large' })).toEqual({
        modelId: 'embed',
      });
    });
    // The ids migration 395 registers. Each is what a tier now resolves to, so
    // each reaches a customer-facing `model` / `modelId` field.
    it('rewrites gpt-5.5 → hyperion', () => {
      expect(liftoffifyJsonValue({ modelId: 'gpt-5.5' })).toEqual({ modelId: 'hyperion' });
    });
    it('rewrites gemini-3.1-pro-preview → hyperion', () => {
      expect(liftoffifyJsonValue({ modelId: 'gemini-3.1-pro-preview' })).toEqual({
        modelId: 'hyperion',
      });
    });
    it('rewrites gemini-3.5-flash → apollo', () => {
      expect(liftoffifyJsonValue({ modelId: 'gemini-3.5-flash' })).toEqual({ modelId: 'apollo' });
    });
    // The GPT-5.6 ladder names its tiers instead of numbering them, so each one
    // needs its own mapping: without it the generic gpt-5.x catch-all brands
    // every tier as the large one, telling a customer their small-tier work ran
    // on the expensive model.
    it('rewrites the gpt-5.6 ladder to its own tier codenames', () => {
      expect(liftoffifyJsonValue({ modelId: 'gpt-5.6-sol' })).toEqual({ modelId: 'hyperion' });
      expect(liftoffifyJsonValue({ modelId: 'gpt-5.6-terra' })).toEqual({ modelId: 'apollo' });
      expect(liftoffifyJsonValue({ modelId: 'gpt-5.6-luna' })).toEqual({ modelId: 'eos' });
    });
    // GPT-6 reuses two of those names ONE SLOT DOWN: sol is the medium tier
    // here, where gpt-5.6-sol was the large tier. Asserted beside the 5.6 case
    // above so the pair reads as the trap it is — the two generations must give
    // DIFFERENT codenames for the same word, and a map keyed on the family name
    // would tell a customer their medium-tier work ran on the large tier.
    // The Frontier model has its own codename, not the large tier's, in both
    // spellings and as free text.
    it('rewrites claude-fable-5-1 → cronus', () => {
      expect(liftoffifyJsonValue({ modelId: 'claude-fable-5-1' })).toEqual({ modelId: 'cronus' });
      expect(liftoffifyJsonValue({ modelId: 'claude-fable-5.1' })).toEqual({ modelId: 'cronus' });
      expect(liftoffifyJsonValue({ message: 'claude-fable-5-1 overloaded' }))
        .toEqual({ message: 'cronus overloaded' });
    });
    it('gives gpt-6 its own codenames, one slot down from the same 5.6 names', () => {
      expect(liftoffifyJsonValue({ modelId: 'gpt-6-astra' })).toEqual({ modelId: 'hyperion' });
      expect(liftoffifyJsonValue({ modelId: 'gpt-6-sol' })).toEqual({ modelId: 'apollo' });
      expect(liftoffifyJsonValue({ modelId: 'gpt-6-luna' })).toEqual({ modelId: 'eos' });
    });
    // The version sits BETWEEN the family and the variant here, so the
    // `deepseek-v4-flash` pattern does not reach it. Asserted on the whole
    // string rather than on the absence of a vendor token, because the leak
    // this guards against is the surviving `-v4.1-flash`: the vendor name gets
    // rewritten by the generic pass and the scan comes back clean while a
    // customer is still shown half a model id.
    it('rewrites the DeepSeek v4.1 flash id whole, in all three key forms', () => {
      expect(liftoffifyJsonValue({ modelId: 'deepseek/deepseek-v4.1-flash' })).toEqual({ modelId: 'eos' });
      expect(liftoffifyJsonValue({ modelId: 'openrouter:deepseek/deepseek-v4.1-flash' })).toEqual({ modelId: 'eos' });
      expect(liftoffifyJsonValue({ modelId: 'deepseek:deepseek/deepseek-v4.1-flash' })).toEqual({ modelId: 'eos' });
    });
    it('still brands v4-flash, which is served and pinned alongside it', () => {
      expect(liftoffifyJsonValue({ modelId: 'deepseek/deepseek-v4-flash' })).toEqual({ modelId: 'apollo' });
      expect(liftoffifyJsonValue({ modelId: 'deepseek/deepseek-v4-pro' })).toEqual({ modelId: 'hyperion' });
    });
    // Free text is where the exact-key map cannot help and the static PATTERN
    // is the only thing standing between the id and a customer.
    it('rewrites the v4.1 flash id inside free text, leaving no version behind', () => {
      expect(liftoffifyString('routed to deepseek/deepseek-v4.1-flash today')).toBe('routed to eos today');
      expect(liftoffifyString('deepseek-v4.1-flash returned 429')).toBe('eos returned 429');
    });
    it('brands both MiniMax tiers, by key and in free text', () => {
      expect(liftoffifyJsonValue({ modelId: 'minimax/minimax-m3' })).toEqual({ modelId: 'hyperion' });
      expect(liftoffifyJsonValue({ modelId: 'minimax/minimax-m2.7' })).toEqual({ modelId: 'eos' });
      expect(liftoffifyJsonValue({ modelId: 'minimax:minimax/minimax-m3' })).toEqual({ modelId: 'hyperion' });
      expect(liftoffifyString('routed to minimax/minimax-m2.7 today')).toBe('routed to eos today');
      expect(liftoffifyString('minimax-m3 returned 429')).toBe('hyperion returned 429');
    });
    it('falls through unknown dated Claude IDs via liftoffifyString', () => {
      expect(liftoffifyJsonValue({ model: 'claude-opus-4-20250514' })).toEqual({ model: 'hyperion' });
    });
    it('covers every plan-specified model alias key', () => {
      const aliases = [
        'model', 'modelId', 'model_id', 'modelName', 'model_name',
        'llm_model', 'defaultModel', 'default_model',
        'previousModelId', 'previous_model_id', 'taskOverrides',
      ];
      for (const k of aliases) {
        expect(liftoffifyJsonValue({ [k]: 'claude-opus-4-6' })).toEqual({ [k]: 'hyperion' });
      }
    });
  });

  describe('liftoffifyJsonValue: provider key', () => {
    it('rewrites anthropic → liftoff under provider', () => {
      expect(liftoffifyJsonValue({ provider: 'anthropic' })).toEqual({ provider: 'liftoff' });
    });
    it('covers every plan-specified provider alias key', () => {
      for (const k of ['provider', 'vendor', 'defaultProvider', 'default_provider']) {
        expect(liftoffifyJsonValue({ [k]: 'openai' })).toEqual({ [k]: 'liftoff' });
      }
    });
  });

  describe('liftoffifyJsonValue: engine key parent-key gating', () => {
    it('translates type inside an engineConfig parent', () => {
      expect(liftoffifyJsonValue({ engineConfig: { type: 'claude-agent-sdk' } })).toEqual({
        engineConfig: { type: 'liftoff-agent-sdk' },
      });
    });
    it('translates claude-sdk inside an engineConfig parent', () => {
      expect(liftoffifyJsonValue({ engineConfig: { type: 'claude-sdk' } })).toEqual({
        engineConfig: { type: 'liftoff-sdk' },
      });
    });
    it('leaves a type value alone when parent is NOT engineConfig', () => {
      // citation.type, trigger_config.type, etc. must not be rewritten.
      expect(liftoffifyJsonValue({ trigger_config: { type: 'cron' } })).toEqual({
        trigger_config: { type: 'cron' },
      });
      expect(liftoffifyJsonValue({ citation: { type: 'claude-sdk' } })).toEqual({
        citation: { type: 'claude-sdk' },
      });
    });
    it('translates engineType / engine_type / engine unconditionally', () => {
      expect(liftoffifyJsonValue({ engineType: 'claude-sdk' })).toEqual({ engineType: 'liftoff-sdk' });
      expect(liftoffifyJsonValue({ engine_type: 'claude-sdk' })).toEqual({ engine_type: 'liftoff-sdk' });
      expect(liftoffifyJsonValue({ engine: 'claude-sdk' })).toEqual({ engine: 'liftoff-sdk' });
    });
  });

  describe('liftoffifyJsonValue: server-text keys', () => {
    it('rewrites claude in outputSummary', () => {
      expect(liftoffifyJsonValue({ outputSummary: 'claude-opus-4-6 returned error' })).toEqual({
        outputSummary: 'hyperion returned error',
      });
    });
    it('rewrites anthropic. prefix to liftoff. in errorCode', () => {
      expect(liftoffifyJsonValue({ errorCode: 'anthropic.RateLimitError' })).toEqual({
        errorCode: 'liftoff.RateLimitError',
      });
    });
    it('rewrites openai. prefix to liftoff. in error_code', () => {
      expect(liftoffifyJsonValue({ error_code: 'openai.InvalidRequest' })).toEqual({
        error_code: 'liftoff.InvalidRequest',
      });
    });
    it('rewrites google. prefix to liftoff. in errorMessage', () => {
      expect(liftoffifyJsonValue({ errorMessage: 'google.ResourceExhausted' })).toEqual({
        errorMessage: 'liftoff.ResourceExhausted',
      });
    });
    it('rewrites every plan-specified server-text key', () => {
      for (const k of [
        'outputSummary', 'errorCode', 'error_code', 'code', 'message',
        'errorMessage', 'error_message', 'errorDetail', 'reason',
      ]) {
        expect(liftoffifyJsonValue({ [k]: 'Claude failed' })).toEqual({ [k]: 'liftoff failed' });
      }
    });
    it('leaves non-server-text keys alone', () => {
      expect(liftoffifyJsonValue({ userMessage: 'tell Claude to summarize' })).toEqual({
        userMessage: 'tell Claude to summarize',
      });
    });
  });

  describe('liftoffifyJsonValue: name derivation', () => {
    it('derives Liftoff Hyperion from a large tier sibling', () => {
      expect(liftoffifyJsonValue({ name: 'Claude Opus 4.7', tier: 'large', modelId: 'claude-opus-4-7' })).toEqual({
        name: 'Liftoff Hyperion',
        tier: 'hyperion',
        modelId: 'hyperion',
      });
    });
    it('derives Liftoff Apollo from a medium tier sibling', () => {
      expect(liftoffifyJsonValue({ name: 'Claude Sonnet 4.6', tier: 'medium' })).toEqual({
        name: 'Liftoff Apollo',
        tier: 'apollo',
      });
    });
    it('derives Liftoff Eos from a modelId sibling when tier absent', () => {
      expect(liftoffifyJsonValue({ name: 'Claude Haiku 4.5', modelId: 'claude-haiku-4-5' })).toEqual({
        name: 'Liftoff Eos',
        modelId: 'eos',
      });
    });
    // A Frontier registry row carries a NULL tier (migration 529), so its name
    // is derived from the model id.
    it('derives Liftoff Cronus for a NULL-tier Frontier row', () => {
      expect(liftoffifyJsonValue({ name: 'Claude Fable 5.1', tier: null, model_id: 'claude-fable-5-1' })).toEqual({
        name: 'Liftoff Cronus',
        tier: null,
        model_id: 'cronus',
      });
    });
    it('leaves name alone when no recognized tier/model sibling exists', () => {
      expect(liftoffifyJsonValue({ name: 'Customer Success Agent' })).toEqual({
        name: 'Customer Success Agent',
      });
    });
  });

  describe('liftoffifyJsonValue: idempotency', () => {
    it('f(f(x)) === f(x) for a complex payload', () => {
      const input = {
        inputArgs: { model: 'claude-opus-4-6', source: 'claude-sdk' },
        engineConfig: { type: 'claude-agent-sdk' },
        outputSummary: 'anthropic.OverloadedError on claude-sonnet-4-6',
        tier: 'large',
        provider: 'anthropic',
        name: 'Claude Opus 4.7',
      };
      const once = liftoffifyJsonValue(input);
      const twice = liftoffifyJsonValue(once);
      expect(twice).toEqual(once);
    });
  });

  describe('liftoffifyString', () => {
    it('rewrites bare claude → liftoff', () => {
      expect(liftoffifyString('Claude returned an error')).toBe('liftoff returned an error');
    });
    it('rewrites dot-format model IDs', () => {
      expect(liftoffifyString('claude-opus-4.6 timed out')).toBe('hyperion timed out');
    });
    it('rewrites gemini variants longest-first', () => {
      expect(liftoffifyString('gemini-3.1-flash-lite is small')).toBe('eos is small');
    });
    // The free-text patterns are the half that reaches consumers of the
    // published @liftoffos/shared-types copy without waiting for a version
    // bump: MODEL_ID_MAP is an exact-match short-circuit and translateLeafString
    // falls through to these for anything it does not carry. So a newly
    // registered id is redacted downstream on the day it ships, and the map
    // entry is a refinement rather than the thing that prevents a leak.
    it('rewrites the ids migrations 395 and 396 register, with no exact-match entry needed', () => {
      expect(liftoffifyString('gpt-5.5 timed out')).toBe('hyperion timed out');
      expect(liftoffifyString('gemini-3.1-pro-preview timed out')).toBe('hyperion timed out');
      expect(liftoffifyString('gemini-3.5-flash timed out')).toBe('apollo timed out');
      // Free text is the half consumers see without a package bump, so the
      // per-tier rules have to live in the patterns and not only in the map.
      expect(liftoffifyString('gpt-5.6-sol timed out')).toBe('hyperion timed out');
      expect(liftoffifyString('gpt-5.6-terra timed out')).toBe('apollo timed out');
      expect(liftoffifyString('gpt-5.6-luna timed out')).toBe('eos timed out');
    });
    // The gpt-5.x patterns all require a literal `gpt-5.`, so they match none
    // of this generation. The whole string is asserted, not just the absence of
    // a vendor token: a catch-all that stops at the wrong character leaves an
    // id FRAGMENT behind, which passes a forbidden-token scan while still
    // showing a customer half a model id.
    it('rewrites the gpt-6 ladder migration 527 registers, in free text', () => {
      expect(liftoffifyString('gpt-6-astra timed out')).toBe('hyperion timed out');
      expect(liftoffifyString('gpt-6-sol timed out')).toBe('apollo timed out');
      expect(liftoffifyString('gpt-6-luna timed out')).toBe('eos timed out');
    });
    it('rewrites bare gemini → liftoff in free text', () => {
      expect(liftoffifyString('Gemini is unavailable')).toBe('liftoff is unavailable');
    });
    it('rewrites text-embedding-3-* → embed', () => {
      expect(liftoffifyString('text-embedding-3-small is the cheap one'))
        .toBe('embed is the cheap one');
    });
    it('rewrites anthropic./openai./google. error prefixes to liftoff.', () => {
      expect(liftoffifyString('anthropic.RateLimitError')).toBe('liftoff.RateLimitError');
      expect(liftoffifyString('openai.InvalidRequest')).toBe('liftoff.InvalidRequest');
      expect(liftoffifyString('google.ResourceExhausted')).toBe('liftoff.ResourceExhausted');
    });
    it('caps very long input at 16384 chars', () => {
      const long = 'x'.repeat(20000);
      expect(liftoffifyString(long).length).toBe(16384);
    });
  });

  describe('map coverage', () => {
    it('provider map has all known providers', () => {
      expect(PROVIDER_MAP.anthropic).toBe('liftoff');
      expect(PROVIDER_MAP['anthropic-vertex']).toBe('liftoff');
      expect(PROVIDER_MAP['vertex-ai']).toBe('liftoff');
      expect(PROVIDER_MAP.google).toBe('liftoff');
      expect(PROVIDER_MAP.openai).toBe('liftoff');
    });
    it('tier map has the three canonical tiers and nothing else', () => {
      expect(TIER_MAP.large).toBe('hyperion');
      expect(TIER_MAP.medium).toBe('apollo');
      expect(TIER_MAP.small).toBe('eos');
      // Exactly these keys: the top tier's name from 196 to 534 is retired, and
      // this is what stops it quietly coming back as a fourth tier.
      expect(Object.keys(TIER_MAP).sort()).toEqual(['large', 'medium', 'small']);
    });
    it('model id map includes the canonical Claude 4.5+ set and embed class', () => {
      expect(MODEL_ID_MAP['claude-opus-4-7']).toBe('hyperion');
      expect(MODEL_ID_MAP['claude-opus-4-6']).toBe('hyperion');
      expect(MODEL_ID_MAP['claude-sonnet-5']).toBe('apollo');
      expect(MODEL_ID_MAP['claude-sonnet-4-6']).toBe('apollo');
      expect(MODEL_ID_MAP['claude-haiku-4-5-20251001']).toBe('eos');
      expect(MODEL_ID_MAP['text-embedding-3-small']).toBe('embed');
      expect(MODEL_ID_MAP['text-embedding-3-large']).toBe('embed');
    });
    it('engine map covers all three vendor SDK variants', () => {
      expect(ENGINE_MAP['claude-sdk']).toBe('liftoff-sdk');
      expect(ENGINE_MAP['claude-agent-sdk']).toBe('liftoff-agent-sdk');
      expect(ENGINE_MAP['codex-agent-sdk']).toBe('liftoff-agent-sdk');
    });
    it('allow-lists match the plan key sets', () => {
      for (const k of ['tier', 'defaultTier', 'default_tier', 'modelTier', 'model_tier',
                       'taskTierOverrides', 'modelHint', 'model_hint']) {
        expect(TIER_KEYS.has(k)).toBe(true);
      }
      for (const k of ['model', 'modelId', 'model_id', 'modelName', 'model_name',
                       'llm_model', 'defaultModel', 'default_model',
                       'previousModelId', 'previous_model_id', 'taskOverrides']) {
        expect(MODEL_KEYS.has(k)).toBe(true);
      }
      for (const k of ['provider', 'vendor', 'defaultProvider', 'default_provider']) {
        expect(PROVIDER_KEYS.has(k)).toBe(true);
      }
      for (const k of ['type', 'engineType', 'engine_type', 'engine']) {
        expect(ENGINE_KEYS.has(k)).toBe(true);
      }
      for (const k of ['outputSummary', 'errorCode', 'error_code', 'code',
                       'message', 'errorMessage', 'error_message',
                       'errorDetail', 'reason']) {
        expect(SERVER_TEXT_KEYS.has(k)).toBe(true);
      }
    });
  });

  describe('liftoffifyJsonValue: non-plain-object pass-through', () => {
    // Regression: pre-fix, the walker called Object.entries on every typeof
    // 'object' value, which destroyed Date / Buffer / Map / Set by replacing
    // them with `{}` (they have no own enumerable properties). The deliveries
    // endpoint shipped `{"receivedAt":{}}` to the browser and the React
    // renderer crashed with "Objects are not valid as a React child (found:
    // object with keys {})".
    it('preserves a top-level Date instance unchanged', () => {
      const d = new Date('2026-05-17T18:38:44.730Z');
      const result = liftoffifyJsonValue(d);
      expect(result).toBe(d);
    });
    it('preserves a nested Date field on an object response', () => {
      const d = new Date('2026-05-17T18:38:44.730Z');
      const result = liftoffifyJsonValue({ receivedAt: d, status: 'accepted' }) as Record<string, unknown>;
      expect(result.receivedAt).toBe(d);
      // The JSON path: a Date with .toJSON() serializes to an ISO string,
      // NOT to `{}`. Failing this assertion means the walker is rebuilding
      // the Date as a plain object.
      expect(JSON.stringify(result)).toContain('"receivedAt":"2026-05-17T18:38:44.730Z"');
    });
    it('preserves Date objects inside arrays', () => {
      const d = new Date('2026-05-17T18:38:44.730Z');
      const result = liftoffifyJsonValue({
        deliveries: [{ receivedAt: d, status: 'accepted' }],
      }) as { deliveries: Array<{ receivedAt: unknown }> };
      expect(result.deliveries[0].receivedAt).toBe(d);
    });
    it('preserves Buffer instances unchanged', () => {
      const buf = Buffer.from('hello');
      const result = liftoffifyJsonValue({ payload: buf }) as Record<string, unknown>;
      expect(result.payload).toBe(buf);
    });
    it('preserves Map and Set instances unchanged', () => {
      const m = new Map([['k', 'v']]);
      const s = new Set([1, 2]);
      const result = liftoffifyJsonValue({ m, s }) as Record<string, unknown>;
      expect(result.m).toBe(m);
      expect(result.s).toBe(s);
    });
    it('still walks plain objects (must not pass through everything)', () => {
      // Sanity: the new pass-through guard must not short-circuit ordinary
      // plain-object responses, or no string translation would happen.
      const result = liftoffifyJsonValue({ tier: 'large', nested: { tier: 'medium' } });
      expect(result).toEqual({ tier: 'hyperion', nested: { tier: 'apollo' } });
    });
    it('still walks Object.create(null) responses', () => {
      const o = Object.create(null) as Record<string, unknown>;
      o.tier = 'large';
      const result = liftoffifyJsonValue(o) as Record<string, unknown>;
      expect(result.tier).toBe('hyperion');
    });
  });
});
