// Every model a run can resolve has a rate under the provider it resolves AS.
//
// `computeRowCost` builds `${provider}:${model}`. Qwen, DeepSeek and Kimi became
// providers in their own right — the control-plane registry had approved them at
// tier level while nothing could route one, and the vendor record now can — so a
// rate left under the old `openrouter:` key is read by nothing: the lookup
// misses, falls through to the conservative default, and every call bills at
// another model's price without erroring.
//
// That is the failure mode this file guards, and it is the same move Grok needed
// when it split out. `computeRowCost` never bills zero, which is exactly why an
// unpriced model is invisible: it is charged at some other model's rate, on every
// row, indefinitely.
import { MODEL_PRICING } from '../pricing';

const REGISTRY_TIERS: Record<string, string[]> = {
  qwen: ['qwen/qwen3.8-max-0902', 'qwen/qwen3.7-plus', 'qwen/qwen3.7-flash'],
  // v4-flash stays listed alongside v4.1-flash: it is still served, still
  // pinned by agents, and rows recorded under it still have to price.
  deepseek: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4.1-flash'],
  kimi: ['moonshotai/kimi-k3', 'moonshotai/kimi-k2.6'],
  // Two ids, not three: MiniMax's small tier resolves to the medium model.
  minimax: ['minimax/minimax-m3', 'minimax/minimax-m2.7'],
};

describe('a family that is its own provider', () => {
  it('has a published rate under that provider for every approved tier', () => {
    const missing: string[] = [];
    for (const [provider, models] of Object.entries(REGISTRY_TIERS)) {
      for (const model of models) {
        if (!MODEL_PRICING[`${provider}:${model}`]) missing.push(`${provider}:${model}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('charges the same rate whichever provider name reached it', () => {
    // The models still execute on OpenRouter and bill to that account, so a run
    // that resolved as `openrouter` and one that resolved as `qwen` are the same
    // call. Two keys disagreeing about the price would make the bill depend on
    // which name the router happened to use.
    for (const [provider, models] of Object.entries(REGISTRY_TIERS)) {
      for (const model of models) {
        const own = MODEL_PRICING[`${provider}:${model}`];
        const viaGateway = MODEL_PRICING[`openrouter:${model}`];
        if (viaGateway) expect(own).toEqual(viaGateway);
      }
    }
  });
});
