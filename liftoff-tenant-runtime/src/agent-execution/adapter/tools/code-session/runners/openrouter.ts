// OpenRouter (open-weights vendors) code_session runner. Reuses the
// OpenAI/Codex runner's event handling verbatim; only points the Codex CLI at
// OpenRouter (OpenAI-wire). (Phase 4 replaces this interim Codex-over-OpenRouter
// with an OpenCode runner; verified codex-sdk CodexOptions.baseUrl/apiKey +
// ThreadOptions.model.)
//
// Five vendors reach this runner (GLM / Qwen / DeepSeek / Kimi / Grok), so the
// coding model is picked from the OUTER agent's resolved model id — each vendor
// codes with its own large model (user decision, matching the original GLM
// large-for-coding convention). Each default is env-overridable so a model
// swap needs no code change.
//
// FOUR OF THE FIVE ARE MATCHED BY PUBLISHER PREFIX; GROK IS NOT. Grok's ids are
// xAI-native (`grok-4.6`) and carry no publisher segment at all, so a prefix
// table cannot see them and every Grok session would fall through to the GLM
// default. It is matched by model instead.
//
// AND GROK DOES NOT RUN HERE. It codes on xAI's own API, managed and
// customer-funded alike — the same host its turns already execute on. Three
// things follow the host and none of them is optional: `x-ai/grok-4.6` is
// OpenRouter's namespace and 404s at api.x.ai, the rate table publishes Grok
// under `xai:` and nothing under `openrouter:x-ai/`, and an xAI key cannot
// settle an OpenRouter invoice. Sending it to OpenRouter instead costs a
// working session, a priced one, or both.
import type { Codex } from '@openai/codex-sdk';
import { esmImport } from '../../../esm-import';
import { childProcessEnv } from '../../../child-process-env';
import { OpenAICodeSessionRunner } from './openai';
import { getOpenRouterApiKey, getXaiApiKey } from '../../../../../infrastructure/secrets';
import { isGrokModel, xaiNativeModelId, XAI_BASE_URL, TIER_MODELS as XAI_TIER_MODELS } from '../../../../../llm/providers/xai';
import type { CodeSessionContext, CodeSessionProvider, RunnerInvocation } from '../types';
import { familyOfModelId, isGatewayServed } from '../../../model-family';
import { resolveModelForTier } from '../../../../../llm/tiers';

export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

/** Where a Grok coding session sends its requests. Env-overridable for the same
 *  reason the models are: a host move should not need a deploy. */
export function xaiCodeSessionBaseUrl(): string {
  return `${(process.env.XAI_BASE_URL ?? XAI_BASE_URL).replace(/\/+$/, '')}/v1`;
}

/**
 * Which CLI the open-weights vendors code with.
 *
 * Read lazily and in ONE place, because two things have to agree about it: the
 * runner that gets selected, and the engine id stamped on the session's
 * provenance. Derived separately they drift, and the drift is invisible —
 * provenance is only ever read long after the run, by someone with no way to
 * tell what actually executed.
 *
 * Defaults to Codex, the path with production history. opencode is the
 * intended destination and turning it on is this one variable, per-environment,
 * the way ADR-004 turns on every other engine.
 */
export function openWeightsRunnerKind(): 'codex' | 'opencode' {
  return process.env.CODE_SESSION_OPEN_WEIGHTS_RUNNER === 'opencode' ? 'opencode' : 'codex';
}

/** Coding model per OpenRouter vendor, keyed by the outer model id's publisher
 *  prefix. Env read lazily so overrides apply without module reload. Fallback
 *  (no/unknown prefix) is the GLM default — the pre-Qwen behavior, preserved
 *  for existing GLM workspaces and prefix-less callers. */
const VENDOR_CODE_MODELS: ReadonlyArray<{ prefix: string; model: () => string }> = [
  // The DATED slug. OpenRouter serves `qwen/qwen3.8-max-0902` and publishes no
  // bare `qwen/qwen3.8-max` for it to resolve to, so the undated form is a
  // request for a model that does not exist.
  { prefix: 'qwen/', model: () => process.env.OPENROUTER_QWEN_CODE_MODEL ?? 'qwen/qwen3.8-max-0902' },
  { prefix: 'deepseek/', model: () => process.env.OPENROUTER_DEEPSEEK_CODE_MODEL ?? 'deepseek/deepseek-v4-pro' },
  { prefix: 'moonshotai/', model: () => process.env.OPENROUTER_KIMI_CODE_MODEL ?? 'moonshotai/kimi-k3' },
  { prefix: 'minimax/', model: () => process.env.OPENROUTER_MINIMAX_CODE_MODEL ?? 'minimax/minimax-m3' },
  // Xiaomi codes with MiMo-V2.6-Pro, its Sonnet-class model. That id holds the
  // vendor's large AND medium tiers — Xiaomi publishes nothing Opus-class — so
  // the vendor-large convention and the vendor's best model are the same
  // choice here. NOT `mimo-v2.6-pro-ultraspeed`: same checkpoint, same answers,
  // ten times the rate.
  { prefix: 'xiaomi/', model: () => process.env.OPENROUTER_XIAOMI_CODE_MODEL ?? 'xiaomi/mimo-v2.6-pro' },
];

// The `z-ai/` prefix and any caller without one. Follows GLM's own large
// tier, which moved to the 5.3 line; left on 5.2 this would keep every GLM
// code session a generation behind the model the workspace is set to.
const defaultCodeModel = (): string => process.env.OPENROUTER_CODE_MODEL ?? 'z-ai/glm-5.3';

/** Grok's coder: its own large model, the same vendor-large convention as the
 *  four above, named natively because that is what its host answers to. Note
 *  the vendor also ships grok-build-0.1, a cheaper coding specialist; the
 *  convention deliberately wins over that (user decision), and the env override
 *  is how to change it without a deploy. */
const grokCodeModel = (): string =>
  xaiNativeModelId(process.env.OPENROUTER_GROK_CODE_MODEL ?? XAI_TIER_MODELS.large);

/** Whether this coding session belongs to Grok, and so runs on xAI's host.
 *
 *  Reads the PROVIDER as well as the model because the model id can be absent
 *  while the provider never is, and a Grok session that fell through to the GLM
 *  default would be a working session on the wrong vendor's model — the quiet
 *  failure migration 417 removed from the main engine. */
export function isGrokCodeSession(
  context: Pick<CodeSessionContext, 'outerProvider' | 'outerModelId'>,
): boolean {
  return context.outerProvider === 'xai' || isGrokModel(context.outerModelId);
}

/** Exported for tests: resolve the coding model for an outer model id. */
export function resolveOpenRouterCodeModel(outerModelId: string | undefined): string {
  // Grok first, and by model rather than by prefix — see the header.
  if (isGrokModel(outerModelId)) return grokCodeModel();
  if (outerModelId) {
    for (const v of VENDOR_CODE_MODELS) {
      if (outerModelId.startsWith(v.prefix)) return v.model();
    }
  }
  return defaultCodeModel();
}

/** The coding model for a whole session, which is what a runner needs: it can
 *  tell a Grok session with no model id from a prefix-less GLM one. */
export function codeModelForSession(
  context: Pick<CodeSessionContext, 'outerProvider' | 'outerModelId'>,
): string {
  return isGrokCodeSession(context) ? grokCodeModel() : resolveOpenRouterCodeModel(outerModelOfOuterFamily(context));
}

/** The outer model id, when it belongs to the outer provider's family.
 *
 *  The session is BILLED under the outer provider (billingProviderFor), so the
 *  coding model has to come from that family too. An id from another gateway
 *  family, or none, is replaced by the provider's own large model, which keys
 *  the table above to the right vendor: a Qwen agent handed a GLM id must not
 *  code on GLM and be rated as Qwen. */
function outerModelOfOuterFamily(
  context: Pick<CodeSessionContext, 'outerProvider' | 'outerModelId'>,
): string | undefined {
  const { outerProvider, outerModelId } = context;
  if (!isGatewayServed(outerProvider) || familyOfModelId(outerModelId) === outerProvider) return outerModelId;
  return resolveModelForTier(outerProvider, 'large');
}

/** Whether this invocation talks to xAI rather than OpenRouter. A customer's
 *  own xAI key forces it; so does Grok on Liftoff's key. */
export function usesXaiHost(inv: RunnerInvocation): boolean {
  return inv.byok?.vendor === 'xai' || isGrokCodeSession(inv.context);
}

export class OpenRouterCodeSessionRunner extends OpenAICodeSessionRunner {
  readonly provider: CodeSessionProvider = 'openrouter';

  protected override async makeCodex(inv: RunnerInvocation): Promise<Codex> {
    const { Codex } = await esmImport<typeof import('@openai/codex-sdk')>('@openai/codex-sdk');
    const codexPathOverride = process.env.CODEX_CLI_PATH || '/usr/local/bin/codex';
    // A customer-funded Grok session reaches xAI through Liftoff's gateway,
    // which holds the real key; the token here is the per-run credential for
    // that gateway, never the customer's own.
    if (inv.byok?.vendor === 'xai') {
      return new Codex({
        baseUrl: `${inv.byok.baseUrl.replace(/\/+$/, '')}/v1`,
        apiKey: inv.byok.token,
        codexPathOverride,
        env: childProcessEnv(),
      });
    }
    // Managed Grok: Liftoff's own xAI account, direct. Refused rather than
    // quietly downgraded to OpenRouter — OpenRouter would answer, on a model
    // nobody chose and at a rate nothing publishes.
    if (isGrokCodeSession(inv.context)) {
      const xaiKey = await getXaiApiKey();
      if (!xaiKey) {
        throw new Error(
          'code_session: no XAI_API_KEY is configured for this runtime, so a managed Grok coding session cannot run.',
        );
      }
      return new Codex({
        baseUrl: xaiCodeSessionBaseUrl(),
        apiKey: xaiKey,
        codexPathOverride,
        env: childProcessEnv(),
      });
    }
    const apiKey = await getOpenRouterApiKey();
    return new Codex({
      baseUrl: OPENROUTER_BASE_URL,
      codexPathOverride,
      ...(apiKey ? { apiKey } : {}),
      env: childProcessEnv(),
    });
  }

  /** On xAI's own host the id is native: `x-ai/grok-4.6` is OpenRouter's
   *  namespace for the model and api.x.ai 404s it. Applied to a PINNED model
   *  too, because a pin written before the provider move still carries the
   *  publisher segment. */
  protected override threadModel(inv: RunnerInvocation): string {
    const model = inv.model ?? codeModelForSession(inv.context);
    return usesXaiHost(inv) ? xaiNativeModelId(model) : model;
  }

}
