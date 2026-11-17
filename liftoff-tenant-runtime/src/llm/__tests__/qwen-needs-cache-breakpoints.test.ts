// Qwen is the one family through OpenRouter that does NOT cache on its own —
// and explicit caching is available on the models Alibaba LISTS, not on
// every Qwen id.
//
// Verified on openrouter.ai's prompt-caching guide, 2026-09-16: DeepSeek,
// Grok, Groq/Kimi, Moonshot and Z.AI all cache automatically with no
// configuration, and "Alibaba explicit caching is available on
// deepseek/deepseek-v3.2, qwen/qwen3-max, qwen/qwen-plus, qwen/qwen3.6-plus,
// qwen/qwen3-coder-plus, and qwen/qwen3-coder-flash. Snapshot endpoints,
// including qwen/qwen3.5-plus-02-15 and qwen/qwen3.5-flash-02-23, do not
// support explicit caching."
//
// The rule used to be a regex over the family name, which marked every Qwen
// model — the snapshots the page excludes, and ids nobody had checked. A mark
// on a model that ignores it is a claim about caching that is not true; the
// field is omitted for an unlisted model rather than sent hopefully. The tier
// map this runtime resolves Qwen to is not on the list today, and the test
// says so rather than asserting the marks it would like to see.
import {
  needsExplicitCacheBreakpoints,
  isSnapshotEndpoint,
  ALIBABA_EXPLICIT_CACHE_MODELS,
  TIER_MODELS as QWEN_TIERS,
} from '../providers/qwen';
import { TIER_MODELS as OPENROUTER_TIERS } from '../providers/glm';
import { TIER_MODELS as DEEPSEEK_TIERS } from '../providers/deepseek';
import { TIER_MODELS as KIMI_TIERS } from '../providers/kimi';
import { RESOLVED_PROVIDERS } from '../../agent-execution/adapter/types';

describe('the family that needs explicit cache breakpoints', () => {
  it('is reachable, so the breakpoint is required rather than hypothetical', () => {
    expect([...RESOLVED_PROVIDERS]).toContain('qwen');
  });

  it('a listed model gets the marks', () => {
    for (const model of ALIBABA_EXPLICIT_CACHE_MODELS) {
      expect(needsExplicitCacheBreakpoints(model)).toBe(true);
    }
    // Through the openrouter provider too: matched on the MODEL ID, because
    // the requirement is Alibaba's, not ours.
    expect(needsExplicitCacheBreakpoints('qwen/qwen3-coder-plus')).toBe(true);
  });

  it('an unlisted Qwen model does not — including the ids this runtime resolves the tiers to', () => {
    // None of the three tier ids is on the vendor's list as of the read
    // above. So a Qwen tier run caches nothing today, and that is a fact the
    // fixed-prompt trace measures, not one a broader match should hide.
    for (const model of Object.values(QWEN_TIERS)) {
      expect(ALIBABA_EXPLICIT_CACHE_MODELS.has(model)).toBe(false);
      expect(needsExplicitCacheBreakpoints(model)).toBe(false);
    }
    expect(needsExplicitCacheBreakpoints('qwen/qwen3-turbo')).toBe(false);
  });

  it('a snapshot endpoint does not, even for a listed family', () => {
    for (const snapshot of ['qwen/qwen3.5-plus-02-15', 'qwen/qwen3.5-flash-02-23', 'qwen/qwen3.8-max-0902']) {
      expect(isSnapshotEndpoint(snapshot)).toBe(true);
      expect(needsExplicitCacheBreakpoints(snapshot)).toBe(false);
    }
    for (const listed of ALIBABA_EXPLICIT_CACHE_MODELS) expect(isSnapshotEndpoint(listed)).toBe(false);
  });

  it('does not mark the families that cache automatically', () => {
    // Marking one of these would send a breakpoint to a provider that did not
    // ask for one — at best ignored, at worst a rejected request, and either way
    // a claim about caching that is not true.
    for (const model of [
      ...Object.values(OPENROUTER_TIERS),
      ...Object.values(DEEPSEEK_TIERS),
      ...Object.values(KIMI_TIERS),
      'grok-4.6',
    ]) {
      expect(needsExplicitCacheBreakpoints(model)).toBe(false);
    }
  });

  it('the list is exactly what the vendor published on the day it was read', () => {
    expect([...ALIBABA_EXPLICIT_CACHE_MODELS].sort()).toEqual([
      'deepseek/deepseek-v3.2',
      'qwen/qwen-plus',
      'qwen/qwen3-coder-flash',
      'qwen/qwen3-coder-plus',
      'qwen/qwen3-max',
      'qwen/qwen3.6-plus',
    ]);
  });
});
