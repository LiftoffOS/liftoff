// resolveOpenRouterCodeModel — coding-model selection for the OpenRouter
// code_session runner. Five vendors reach it (GLM / Qwen / DeepSeek / Kimi /
// Grok); the outer agent's resolved model id is the only vendor signal, and
// everything unrecognised falls back to the GLM default (pre-Qwen behavior).
//
// FOUR ARE MATCHED BY PUBLISHER PREFIX AND GROK IS NOT — its ids are xAI-native
// (`grok-4.6`) and carry no publisher segment for a prefix table to match, so
// it is matched by model instead. Left on a prefix, every Grok session resolved
// to the GLM default: a working session on another vendor's model.
//
// The slugs are the vendor's own published ids, verified against OpenRouter's
// live catalog. A plausible-looking id that the vendor does not serve is not a
// near miss, it is an unroutable request.

import { resolveOpenRouterCodeModel } from '../tools/code-session/runners/openrouter';

const ENV_KEYS = [
  'OPENROUTER_CODE_MODEL',
  'OPENROUTER_QWEN_CODE_MODEL',
  'OPENROUTER_DEEPSEEK_CODE_MODEL',
  'OPENROUTER_KIMI_CODE_MODEL',
  'OPENROUTER_GROK_CODE_MODEL',
] as const;

describe('resolveOpenRouterCodeModel', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('picks the large coding model of each vendor by outer-model prefix', () => {
    // The DATED Qwen slug: OpenRouter serves `qwen/qwen3.8-max-0902` and
    // publishes no bare `qwen/qwen3.8-max` for the undated form to resolve to.
    expect(resolveOpenRouterCodeModel('qwen/qwen3.7-plus')).toBe('qwen/qwen3.8-max-0902');
    expect(resolveOpenRouterCodeModel('deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-pro');
    expect(resolveOpenRouterCodeModel('moonshotai/kimi-k2.6')).toBe('moonshotai/kimi-k3');
  });

  it('matches Grok by model, since its ids carry no publisher prefix', () => {
    expect(resolveOpenRouterCodeModel('grok-4.6')).toBe('grok-4.6');
    expect(resolveOpenRouterCodeModel('grok-4.3')).toBe('grok-4.6');
    expect(resolveOpenRouterCodeModel('grok-4.20-0309-non-reasoning')).toBe('grok-4.6');
  });

  it('answers natively for a Grok id still written in OpenRouter\'s namespace', () => {
    // Configs predating the provider move carry `x-ai/...`; the host that now
    // serves every Grok session 404s that spelling.
    expect(resolveOpenRouterCodeModel('x-ai/grok-4.6')).toBe('grok-4.6');
  });

  it('honors the Grok env override, and still answers natively', () => {
    process.env.OPENROUTER_GROK_CODE_MODEL = 'x-ai/grok-build-0.1';
    expect(resolveOpenRouterCodeModel('grok-4.6')).toBe('grok-build-0.1');
  });

  it('keeps the GLM default for GLM outer models (pre-Qwen behavior unchanged)', () => {
    expect(resolveOpenRouterCodeModel('z-ai/glm-5-turbo')).toBe('z-ai/glm-5.3');
  });

  it('falls back to the GLM default when the outer model is absent or unknown', () => {
    expect(resolveOpenRouterCodeModel(undefined)).toBe('z-ai/glm-5.3');
    expect(resolveOpenRouterCodeModel('mistralai/mistral-large')).toBe('z-ai/glm-5.3');
  });

  it('honors the per-vendor env overrides', () => {
    process.env.OPENROUTER_QWEN_CODE_MODEL = 'qwen/qwen3-coder-plus';
    process.env.OPENROUTER_DEEPSEEK_CODE_MODEL = 'deepseek/custom';
    process.env.OPENROUTER_KIMI_CODE_MODEL = 'moonshotai/kimi-k2.7-code';
    process.env.OPENROUTER_CODE_MODEL = 'z-ai/glm-override';
    expect(resolveOpenRouterCodeModel('qwen/qwen3.7-flash')).toBe('qwen/qwen3-coder-plus');
    expect(resolveOpenRouterCodeModel('deepseek/deepseek-v4-pro')).toBe('deepseek/custom');
    expect(resolveOpenRouterCodeModel('moonshotai/kimi-k3')).toBe('moonshotai/kimi-k2.7-code');
    expect(resolveOpenRouterCodeModel('z-ai/glm-5.2')).toBe('z-ai/glm-override');
    expect(resolveOpenRouterCodeModel(undefined)).toBe('z-ai/glm-override');
  });
});
