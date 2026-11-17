// Workspace AI vendor selection — the single source for the UI-vendor →
// runtime mapping and the routing-policy builder behind
// PATCH /api/tenants/:id { workspaceAiVendor }.
//
// Layering (strict, by user requirement):
//   BACKGROUND_TASK_ASSIGNMENTS  — task → { vendor, tier }. NO model names.
//   WORKSPACE_AI_VENDORS         — vendor → tier → model. The module's ONLY
//                                  place model names exist.
//   buildWorkspaceAiPolicy       — resolves both through the vendor map and
//                                  stamps model + provider + tier explicitly.
// Switching a background task to another vendor/tier is an assignments edit.
//
// What a tier MEANS for a vendor is not an edit here: the `models` registry is
// the source, applied over this map by workspace-ai-vendor-loader on a 60s
// refresh, so the literals below are the BOOTSTRAP seed — what resolves before
// the first load lands, and what keeps resolving if a load fails. A model name
// written here and nowhere else would be a third source of truth beside the
// registry and each provider's TIER_MODELS, with nothing keeping the three in
// step.
//
// Either way, run scripts/restamp-workspace-ai-policies.ts to propagate to
// existing tenants — assignments are MATERIALIZED into each tenant's
// model_configs row at write time, so neither a constant edit nor a registry
// row reaches tenants already stamped.

import type { RoutingPolicy } from './types';
// Type-only, so it is erased at compile time — internal-agents/types imports the
// WorkspaceAiSelection type from here, and neither direction survives to runtime.
import type { ModelConfig } from '../internal-agents/types';
import { providerOfModelId } from './model-family';

/** UI vendor keys (the wire enum minus 'default'). */
export type WorkspaceAiVendor =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'glm'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'minimax'
  | 'grok'
  | 'xiaomi';

/** The full wire enum for PATCH /api/tenants/:id { workspaceAiVendor }. */
export type WorkspaceAiSelection = WorkspaceAiVendor | 'default';

// `as const` so the literals survive into the type and Zod schemas can be built
// straight off this list (`z.enum([...WORKSPACE_AI_SELECTIONS])`) instead of
// restating the vocabulary. The per-agent override schema in internal-agents
// does exactly that — one list, no second place for 'default' to go missing.
export const WORKSPACE_AI_SELECTIONS = [
  'default', 'anthropic', 'openai', 'google', 'glm', 'qwen', 'deepseek', 'kimi', 'minimax', 'grok',
  'xiaomi',
] as const satisfies readonly WorkspaceAiSelection[];

export type WorkspaceAiTier = 'large' | 'medium' | 'small';

/** How a vendor is REACHED, which is a different question from which vendor it
 *  is. A gateway serves many families, and a family can be reachable more than
 *  one way — so this cannot be folded into `provider` without one of the two
 *  facts going missing. It is the fact that used to be missing. */
export type VendorTransport = 'direct' | 'openrouter';

/** The coding CLI a vendor's code sessions run in, as the Workspace AI card
 *  names it. Mirrors tenant-runtime's code-session runners
 *  (src/agent-execution/adapter/tools/code-session/runners/): anthropic.ts runs
 *  Claude Code, openai.ts runs Codex, gemini.ts runs Gemini CLI, and the
 *  open-weight vendors plus Grok run through openrouter.ts / opencode.ts.
 *
 *  The first three pick their own model, so the card names none for them.
 *  OpenCode is handed one: the vendor's large-tier model, the vendor-large coding
 *  convention openrouter.ts implements (VENDOR_CODE_MODELS for the gateway
 *  vendors, XAI_TIER_MODELS.large for Grok). */
export type WorkspaceAiCodingTool = 'Claude Code' | 'Codex' | 'Gemini CLI' | 'OpenCode';

/** The tools that are given a model rather than choosing one, and so are the
 *  only ones the card names a model beside. */
const CODING_TOOLS_GIVEN_A_MODEL: ReadonlySet<WorkspaceAiCodingTool> = new Set(['OpenCode']);

interface VendorSpec {
  /** RUNTIME execution provider — `invocations.provider`, the `createAdapter`
   *  input, the `models` registry key and the pricing key prefix, which are the
   *  same value and are meant to be.
   *
   *  It names the model FAMILY. It named the gateway for the four open-weight
   *  vendors, and a gateway cannot say which family was chosen: all four
   *  resolved to 'openrouter', the runtime read its one tier map, and a
   *  workspace set to Qwen ran GLM. Grok hit exactly this and left. */
  provider: string;
  transport: VendorTransport;
  tiers: Record<WorkspaceAiTier, string>;
  /** The vendor's Frontier model, by model id: a DESIGNATION, not a routing
   *  tier. Nothing resolves to it — it is in no tier map, no `LLMModelTier`,
   *  no `models.tier` value and no routing policy — and it exists so the
   *  Workspace AI card can show it above the tiers.
   *
   *  It may repeat a tier's model (OpenAI's Frontier model is also its
   *  large-tier model); the card lists a name once. A Frontier model that holds no
   *  tier is registered with a NULL tier (migration 529), which every tier
   *  reader skips, so registering it cannot displace a tier's model.
   *
   *  Code-owned: the registry overlay (applyRegistryVendorModels) replaces
   *  tier models only and never reads or writes this. */
  frontier?: string;
  /** The coding CLI this vendor's code sessions run in. */
  codingTool: WorkspaceAiCodingTool;
}

/** Vendor → tier → model. The BOOTSTRAP seed for the registry overlay above:
 *  applyRegistryVendorModels replaces each (vendor, tier) the `models` table
 *  carries, and a pair it does not carry keeps the value written here.
 *
 *  Tier values verified against the live OpenRouter catalog for the
 *  OpenRouter-served vendors; Anthropic/OpenAI/Google mirror tenant-runtime's
 *  provider tier tables.
 *
 *  A TIER IS AN ABSOLUTE CAPABILITY CLASS: large is Opus-class, medium is
 *  Sonnet-class, small is Haiku-class. It is NOT a ranking of a vendor's own
 *  models against each other — read that way, `large` means a different thing
 *  per vendor and a Sonnet-class model is sold as an Opus-class one.
 *
 *  So a vendor that publishes nothing at the Opus class repeats its
 *  Sonnet-class model UPWARD into large (GLM, MiniMax, Xiaomi, DeepSeek,
 *  Moonshot), rather than promoting it. A vendor missing the Haiku class would
 *  repeat downward for the same reason; none currently does. */
export const WORKSPACE_AI_VENDORS: Record<WorkspaceAiVendor, VendorSpec> = {
  anthropic: {
    provider: 'anthropic',
    transport: 'direct',
    // Claude Fable 5.2, above the Opus large tier. Frontier only: the large
    // tier stays Opus 5.5 and nothing routes to Fable.
    frontier: 'claude-fable-5-2',
    codingTool: 'Claude Code',
    tiers: {
      large: 'claude-opus-5-5',
      medium: 'claude-sonnet-5-5',
      small: 'claude-haiku-5-5',
    },
  },
  openai: {
    provider: 'openai',
    transport: 'direct',
    // Astra is BOTH: OpenAI's Frontier model and its large tier.
    frontier: 'gpt-6-astra',
    codingTool: 'Codex',
    // The GPT-6 line. Its tier names are NOT the GPT-5.6 names shifted across:
    // `gpt-6.1-sol` is the medium slot here, where `gpt-5.6-sol` was the large tier.
    // The ladder follows the vendor's price list ($10 / $2 / $0.10 per million
    // input), not the family name.
    tiers: {
      large: 'gpt-6-astra',
      medium: 'gpt-6.1-sol',
      small: 'gpt-6-luna',
    },
  },
  google: {
    provider: 'google',
    transport: 'direct',
    codingTool: 'Gemini CLI',
    tiers: {
      large: 'gemini-3.1-pro-preview',
      medium: 'gemini-3.5-flash',
      small: 'gemini-3.1-flash-lite',
    },
  },
  // The GLM-5.3 line.
  //
  // A TIER IS AN ABSOLUTE CAPABILITY CLASS, not a ranking within the vendor:
  // large is Opus-class, medium is Sonnet-class, small is Haiku-class. Z.ai
  // publishes nothing at the Opus class, so `glm-5.3` — which is Sonnet-class —
  // is repeated into large rather than promoted to it. The alternative, ranking
  // each vendor's own models against each other, makes `large` mean a different
  // thing per vendor and silently sells a Sonnet-class model as an Opus-class
  // one.
  //
  // The four ids are TWO sizes: `glm-5.3` and `glm-5.3-prime` are one model
  // (prime "inherits its full capabilities" and adds 1.5-2x throughput), and
  // `glm-5.3-flash` and `glm-5.3-flashx` are the other. Both flash builds are
  // Haiku-class, which is why neither belongs in medium; small takes `flash`
  // as the cheaper of the two, the small tier being savings and speed together.
  //
  // `glm-5.3-prime` gets no tier: it is the same model as `glm-5.3` and at
  // endpoint-max costs exactly the same, so it would buy throughput at the top
  // of the ladder and nothing else.
  //
  // Small gains VISION here (4.7-flash was text-only). Large and medium do not:
  // `glm-5.3` is text-only, as `glm-5.2` was.
  glm: {
    provider: 'glm',
    transport: 'openrouter',
    codingTool: 'OpenCode',
    tiers: {
      large: 'z-ai/glm-5.3',
      medium: 'z-ai/glm-5.3',
      small: 'z-ai/glm-5.3-flash',
    },
  },
  qwen: {
    provider: 'qwen',
    transport: 'openrouter',
    codingTool: 'OpenCode',
    tiers: {
      // The DATED slug, and it is not cosmetic: OpenRouter publishes this model
      // only as `qwen/qwen3.8-max-0902` and serves no bare `qwen/qwen3.8-max`
      // for an undated form to resolve to, so the short id is a request for a
      // model that does not exist. The other two tiers are undated because Qwen
      // publishes THEM that way; each id is the vendor's own, not a pattern.
      large: 'qwen/qwen3.8-max-0902',
      // Medium stays on 3.7: Qwen publishes no 3.8 Plus. The 3.8 line is
      // max / 2.4t-a95b / 27b / flash / omni-flash, and none of those is the
      // Plus class — 27b is a dense 27B vision-language model, which is a step
      // DOWN in size, and 2.4t-a95b is the open-weight variant of Max.
      medium: 'qwen/qwen3.7-plus',
      // Small moves to 3.8 Flash. Its headline rate is dearer than 3.7 Flash's
      // (0.15/0.47 against 0.03/0.13) and that comparison is misleading: 3.7
      // Flash carries conditional bands from 32,000 prompt tokens — a routine
      // turn once skills and tool results are injected — where it bills
      // 0.10/0.40, and from 256,000 where it bills 0.20/0.80. So on real
      // traffic 3.8 Flash is about 1.5x on input rather than 5x, and CHEAPER
      // above 256k. It is also flat, which retires a band this estate has
      // under-attributed once before.
      small: 'qwen/qwen3.8-flash',
    },
  },
  // DeepSeek publishes two classes: V4 Pro (1.6T total / 49B activated) is
  // Sonnet-class and V4.1 Flash (8B activated on input, 16B on output, on the
  // CED architecture) is Haiku-class. Pro is therefore medium and is repeated
  // into large — DeepSeek publishes nothing at the Opus class — and Flash takes
  // small on its own.
  //
  // This is the correction of a ladder that repeated the WRONG WAY: Pro sat in
  // large alone and Flash was duplicated across medium and small, which sold a
  // Sonnet-class model as Opus-class and gave the Sonnet slot a Haiku-class
  // model. V4.1 Flash rather than V4 Flash because it is the current revision
  // and the one that reads images.
  deepseek: {
    provider: 'deepseek',
    transport: 'openrouter',
    codingTool: 'OpenCode',
    tiers: {
      large: 'deepseek/deepseek-v4-pro',
      medium: 'deepseek/deepseek-v4-pro',
      small: 'deepseek/deepseek-v4.1-flash',
    },
  },
  // Moonshot publishes two classes: K3 (2.8T parameters, text/image/video, a
  // 1M window) is Sonnet-class, and the K2 family is Haiku-class. K3 is
  // therefore medium and is repeated into large, and K2.6 — the CURRENT
  // revision of the K2 family, an older revision being not a smaller model —
  // takes small.
  //
  // Same correction as DeepSeek above: K3 sat in large alone while K2.6 was
  // duplicated across medium and small.
  kimi: {
    provider: 'kimi',
    transport: 'openrouter',
    codingTool: 'OpenCode',
    tiers: {
      large: 'moonshotai/kimi-k3',
      medium: 'moonshotai/kimi-k3',
      small: 'moonshotai/kimi-k2.6',
    },
  },
  // MiniMax publishes TWO models, and they sit at the Sonnet and Haiku classes
  // rather than at the top of a within-vendor ranking.
  //
  // M3 is ~428B total / ~23B activated at a 1M window and is the only one that
  // accepts an image or a video — Sonnet-class, so it is medium and is repeated
  // into large, MiniMax publishing nothing at the Opus class. The whole M2.x
  // line — M2, M2.1, M2.5, M2.7 — is one ~229B / 10B-activated model revised
  // four times at a 204,800 window, so an older revision is not a smaller
  // model; M2.7 is the current revision and takes small.
  //
  // M2 in particular looks like a small tier at half the rate and is not one:
  // same activated size, so it buys cost and not speed, while scoring
  // measurably worse. A cheaper model that is no faster is the wrong thing to
  // put in the slot that exists for speed.
  minimax: {
    provider: 'minimax',
    transport: 'openrouter',
    codingTool: 'OpenCode',
    tiers: {
      large: 'minimax/minimax-m3',
      medium: 'minimax/minimax-m3',
      small: 'minimax/minimax-m2.7',
    },
  },
  // Grok's small tier is NOT cheaper than its medium — grok-4.20 and grok-4.3
  // are listed at the same rate. Small here buys SPEED (grok-4.20 is the
  // speed-optimised model, with a 2M window) rather than savings, which is a
  // deliberate product choice and not an oversight to "correct" by duplicating
  // medium down. Two models are deliberately absent: grok-4.20-multi-agent
  // supports neither `tools` nor `tool_choice`, which breaks dispatch and the
  // forced-tool responseSchema path; and ~x-ai/grok-latest is a moving alias
  // that would desync pricing, context windows and branding on every release.
  // Grok EXECUTES on xAI's own API, not through OpenRouter, so its ids are
  // NATIVE: `grok-4.6`, not OpenRouter's `x-ai/grok-4.6` slug. Sending the slug
  // to api.x.ai is a 404.
  //
  // It is the one vendor here with an account a CUSTOMER can hold, which is why
  // it left OpenRouter: an OpenRouter invoice is Liftoff's, so a customer's xAI
  // key could never settle it. Keeping it on OpenRouter meant a Grok agent
  // silently ran GLM (the shared tier map) and a customer-funded turn had to
  // swap adapters mid-run.
  grok: {
    provider: 'xai',
    // Direct TODAY. OpenRouter also serves Grok, so this is a value that could
    // change without the family changing — which is the whole reason the two
    // are separate fields.
    transport: 'direct',
    codingTool: 'OpenCode',
    tiers: {
      large: 'grok-4.6',
      medium: 'grok-4.3',
      // The FULL id: there is no bare `grok-4.20` on api.x.ai. It serves
      // `-0309-reasoning`, `-0309-non-reasoning` and `-multi-agent-0309`, and
      // the bare id 404s. Non-reasoning is what a SPEED tier wants, and it
      // dispatches tools correctly (multi-agent does not, which is why it is
      // excluded above).
      small: 'grok-4.20-0309-non-reasoning',
    },
  },
  // Xiaomi's MiMo line, over the gateway.
  //
  // MiMo-V2.6-Pro is Sonnet-class, so it is medium AND repeated into large:
  // Xiaomi publishes nothing at the Opus class, and the tiers are absolute
  // capability classes rather than a within-vendor ranking (see the GLM note).
  // MiMo-V2.6-Flash is the Haiku-class model and takes small.
  //
  // `mimo-v2.6-pro-ultraspeed` is deliberately absent and is the trap in this
  // line. It is not a third model: the vendor's own description says it is
  // built "from the same 1T MiMo-V2.6-Pro checkpoint" and "matches the original
  // model in quality", delivering roughly 10x the speed — for 10x the rate
  // ($4.35 against $0.435 per million input). Nothing should route to a model
  // that is its neighbour at ten times the price for the same answers.
  //
  // The v2.5 line is absent for the reason the MiniMax note gives: an older
  // revision is not a smaller model.
  //
  // `tool_choice: "none"` is SUPPORTED — verified live against both models
  // through the gateway — so Xiaomi is deliberately NOT in
  // OPENROUTER_VENDORS_WITHOUT_TOOL_CHOICE_NONE. Neither model's catalog entry
  // could have settled that: GLM and MiniMax both advertise `tool_choice` in
  // supported_parameters and neither takes `none`.
  xiaomi: {
    provider: 'xiaomi',
    transport: 'openrouter',
    codingTool: 'OpenCode',
    tiers: {
      large: 'xiaomi/mimo-v2.6-pro',
      medium: 'xiaomi/mimo-v2.6-pro',
      small: 'xiaomi/mimo-v2.6-flash',
    },
  },
};

/** The vendors reached through the OpenRouter gateway.
 *
 *  Derived, because it is a restatement of `transport` and every hand-written
 *  copy of this list has gone stale: it was `['openrouter','qwen','deepseek',
 *  'kimi']` — the gateway's own name standing in for GLM — and it is read by
 *  the pricing sync to decide which catalog a rate comes from.
 */
export const OPENROUTER_HOSTED_PROVIDERS: readonly string[] = Object.values(WORKSPACE_AI_VENDORS)
  .filter((v) => v.transport === 'openrouter')
  .map((v) => v.provider);

// ── Registry overlay (the `models` table is the source for tier→model) ───────
//
// There is no separate registry-key map any more, and its absence is the point.
// `models.provider`, `invocations.provider` and the pricing key prefix are one
// value — the family — so a vendor's rows are read under the same key its runs
// execute under and its rates are written under.
//
// They were three vocabularies. GLM's rows sat under 'openrouter' (the runtime
// key, seeded by migration 284 before per-vendor keys existed) while Qwen,
// DeepSeek and Kimi sat under their own names and all four EXECUTED as
// 'openrouter'; Grok's rows sat under 'grok' while it executed as 'xai'. Each
// mismatch is silent in the same way — a registry lookup keyed one way and a
// runtime lookup keyed the other simply miss, so the seed in this file keeps
// answering and the registry row that was supposed to override it never does.
// Grok's context windows, which exist only in the registry, reached the runtime
// under a key nothing read. Migration 450 moves the rows.

/** Overlay registry-sourced tier→model ids onto WORKSPACE_AI_VENDORS. Returns
 *  the number of (vendor, tier) pairs replaced.
 *
 *  `byRegistryProvider` is keyed by each vendor's provider.
 *  A (vendor, tier) the registry does not carry keeps its seed value — that is
 *  what leaves DeepSeek and Moonshot with medium duplicated into small, since
 *  neither registers a small row.
 *
 *  Tiers only. A spec's `frontier` is not a tier, has no registry tier to be
 *  overlaid from, and is left exactly as written.
 *
 *  Mutates in place rather than replacing the constant: buildWorkspaceAiPolicy
 *  and effectiveModelConfig read it synchronously on a request path, and every
 *  caller holds the same object. */
export function applyRegistryVendorModels(
  byRegistryProvider: ReadonlyMap<string, Partial<Record<WorkspaceAiTier, string>>>,
): number {
  const TIERS: WorkspaceAiTier[] = ['large', 'medium', 'small'];
  let applied = 0;
  for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[]) {
    const tiers = byRegistryProvider.get(WORKSPACE_AI_VENDORS[vendor].provider);
    if (!tiers) continue;
    for (const tier of TIERS) {
      const modelId = tiers[tier];
      if (!modelId) continue;
      WORKSPACE_AI_VENDORS[vendor].tiers[tier] = modelId;
      applied++;
    }
  }
  return applied;
}

/** Every model id the Workspace AI card can name: each vendor's tier models
 *  and its Frontier model. The set the name cache loads. */
export function workspaceAiDisplayedModelIds(): string[] {
  const ids = Object.values(WORKSPACE_AI_VENDORS).flatMap((spec) => [
    ...(spec.frontier ? [spec.frontier] : []),
    ...Object.values(spec.tiers),
  ]);
  return [...new Set(ids)];
}

/** Each named vendor's models as display names, for the Workspace AI card.
 *
 *  Reads the LIVE map (seed plus registry overlay): the Frontier model first,
 *  then tiers large → medium → small, one entry per name. OpenAI's Frontier
 *  model is also its large-tier model and shows once; DeepSeek, Kimi and MiniMax repeat
 *  medium in the small slot and show it once. A model `nameOf` cannot name is
 *  left out rather than shown as a raw id, so a vendor can come back empty.
 *
 *  Keyed by vendor only. There is deliberately no 'default' key: Liftoff
 *  Managed shows no models, and naming them would say what it routes to. */
export function workspaceAiVendorModelNames(
  nameOf: (modelId: string) => string | undefined,
): Record<WorkspaceAiVendor, string[]> {
  const TIERS: WorkspaceAiTier[] = ['large', 'medium', 'small'];
  const out = {} as Record<WorkspaceAiVendor, string[]>;
  for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[]) {
    const spec = WORKSPACE_AI_VENDORS[vendor];
    const ids = [...(spec.frontier ? [spec.frontier] : []), ...TIERS.map((t) => spec.tiers[t])];
    const names: string[] = [];
    for (const id of ids) {
      const name = nameOf(id)?.trim();
      if (name && !names.includes(name)) names.push(name);
    }
    out[vendor] = names;
  }
  return out;
}

/** What the Workspace AI card says a vendor codes with. */
export interface WorkspaceAiVendorCoding {
  tool: WorkspaceAiCodingTool;
  /** The model the tool is given, by display name. Only for a tool that is
   *  given one (OpenCode); absent when `nameOf` cannot name it. */
  model?: string;
}

/** Each named vendor's coding tool, for the Workspace AI card.
 *
 *  The model is the vendor's LIVE large-tier model (seed plus registry overlay), so it
 *  follows a registry change the way tenant-runtime's vendor-large coding
 *  convention does. Named only for a tool that is given a model; Claude Code,
 *  Codex and Gemini CLI choose their own and are named alone.
 *
 *  Keyed by vendor only, no 'default' key, for the same reason as
 *  workspaceAiVendorModelNames. */
export function workspaceAiVendorCoding(
  nameOf: (modelId: string) => string | undefined,
): Record<WorkspaceAiVendor, WorkspaceAiVendorCoding> {
  const out = {} as Record<WorkspaceAiVendor, WorkspaceAiVendorCoding>;
  for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[]) {
    const spec = WORKSPACE_AI_VENDORS[vendor];
    const model = CODING_TOOLS_GIVEN_A_MODEL.has(spec.codingTool)
      ? nameOf(spec.tiers.large)?.trim()
      : undefined;
    out[vendor] = model ? { tool: spec.codingTool, model } : { tool: spec.codingTool };
  }
  return out;
}

/** Platform-managed background LLM tasks (user decision: these do NOT follow
 *  the workspace vendor selection). Values are convention references only —
 *  resolution goes through WORKSPACE_AI_VENDORS. The five task keys mirror
 *  migration 187's small-task set. */
export const BACKGROUND_TASK_ASSIGNMENTS: Record<
  string,
  { vendor: WorkspaceAiVendor; tier: WorkspaceAiTier }
> = {
  retrieval_hyde: { vendor: 'anthropic', tier: 'small' },
  memory_consolidation: { vendor: 'anthropic', tier: 'small' },
  suggestion_applier: { vendor: 'anthropic', tier: 'small' },
  'chat-feedback-extraction': { vendor: 'anthropic', tier: 'small' },
  tabular_extract: { vendor: 'anthropic', tier: 'small' },
};

/** Embedding defaults (migration 188). Used only when the tenant's current
 *  policy is missing the embedding keys — normally they are preserved verbatim.
 *  Embeddings NEVER follow the vendor selection (destructive to re-embed; no
 *  dropdown vendor offers the embedding stack). */
export const EMBEDDING_DEFAULTS = { provider: 'google', model: 'text-embedding-004' } as const;

export function isWorkspaceAiSelection(v: unknown): v is WorkspaceAiSelection {
  return typeof v === 'string' && (WORKSPACE_AI_SELECTIONS as readonly string[]).includes(v);
}

/** What "Liftoff Managed" ('default') actually routes to. Concrete, because
 *  WORKSPACE_AI_VENDORS is keyed by vendor and has no 'default' entry. */
export const LIFTOFF_MANAGED_VENDOR: WorkspaceAiVendor = 'anthropic';

/** Collapse a selection onto the concrete vendor whose spec serves it.
 *
 *  The single place 'default' → Liftoff Managed is decided. Both callers need
 *  the SAME answer: buildWorkspaceAiPolicy below, and effectiveModelConfig for
 *  the per-agent override. Re-deriving it in the second is how the two would
 *  drift the day managed routing moves off Anthropic. */
export function resolveWorkspaceAiVendor(selection: WorkspaceAiSelection): WorkspaceAiVendor {
  return selection === 'default' ? LIFTOFF_MANAGED_VENDOR : selection;
}

// ── Per-agent override (ADR-044) ─────────────────────────────────────────────
//
// The same vendor→tier→model map, applied to ONE agent instead of the whole
// workspace. It lives here rather than in internal-agents so the two resolutions
// cannot drift, and so nothing in the agent module has to know a model name.

/** True when an agent's modelConfig pins the route itself — an admin-authored
 *  modelId/provider. Such a pin is an explicit routing decision and the vendor
 *  dropdown must not silently overwrite it.
 *
 *  The predicate is modelId/provider PRESENCE, never object presence: every
 *  agent's column holds at least `{tier:'medium'}` (the create INSERT stamps it),
 *  so "has a modelConfig" would lock every agent out of the feature. */
function hasPinnedModel(modelConfig: ModelConfig | null | undefined): boolean {
  return Boolean(modelConfig?.modelId) || Boolean(modelConfig?.provider);
}

/** The tier an override translates at: the agent's own, else 'medium'. */
function tierForAgent(modelConfig: ModelConfig | null | undefined): WorkspaceAiTier {
  const tier = modelConfig?.tier;
  return tier === 'large' || tier === 'small' ? tier : 'medium';
}

/** A config still naming the gateway, moved to the family its model belongs to.
 *
 *  Migration 450 moved every stored row, but a row can arrive after it — an
 *  older client, a restored backup, an import. The runtime resolves its adapter
 *  and its tier map from `provider`, and 'openrouter' is not one it resolves any
 *  more: left alone such a config falls back to Anthropic, which is a working
 *  vendor nobody chose and therefore the quietest possible failure.
 *
 *  GLM when the id names no publisher we serve, because GLM is what the gateway
 *  name resolved to before the split — the same default the migration applies,
 *  for the same reason.
 */
function normalizeGatewayProvider(config: ModelConfig): ModelConfig {
  if (config.provider !== 'openrouter') return config;
  return { ...config, provider: providerOfModelId(config.modelId) ?? 'glm' };
}

/**
 * The modelConfig an agent's events should carry.
 *
 * `internal_agents.ai_vendor_override` stores the user's CHOICE ('default' /
 * vendor / NULL); events carry the RESOLUTION. Translating at publish time
 * rather than materializing model ids into the column means a
 * WORKSPACE_AI_VENDORS bump propagates on the next publish, so the
 * restamp-workspace-ai-policies problem does not extend to agents.
 *
 * Used at BOTH sites that stamp modelConfig into events the runtime consumes —
 * `buildInternalAgentEventPayload` (the primary envelope) and the inline
 * runtime_config_updated payload in `service.update`. Both write TR's
 * `agents.model_config` and both fire on the same save, so translating at only
 * one of them would have the two events carry different configs and race.
 *
 *   1. An admin-pinned modelId or provider wins unchanged.
 *   2. An override resolves to a PROVIDER and a TIER. Not a model id: the
 *      dropdown offers a vendor, and which model that vendor's tier means is
 *      the runtime's to resolve, from the registry, at the moment it runs.
 *   3. NULL leaves the config untouched, so the runtime falls through to
 *      entitlements (the workspace vendor) exactly as it does today.
 *
 * NO MODEL ID, and the omission is the point. Writing one made the override
 * indistinguishable from a deliberate model pin, and `code_session` reads
 * `model_config.modelId` as exactly that — so choosing a vendor silently
 * pinned the CODING model to the agent's chat tier, and the vendor-large
 * convention every coding runner implements never applied to an agent that
 * had used the dropdown. A resolved id also freezes the answer: a registry
 * change reaches an agent only when someone edits it.
 *
 * The runtime resolves provider + tier on its own (`resolveInvocationModelId`,
 * falling through to the provider's tier table). That fallthrough is only safe
 * because it refuses a workspace-policy model whose provider disagrees with
 * the agent's — without that guard, dropping the id here would hand an
 * Anthropic model id to a GLM agent in an Anthropic workspace.
 */
export function effectiveModelConfig(agent: {
  modelConfig?: ModelConfig | null;
  aiVendorOverride?: WorkspaceAiSelection | null;
}): ModelConfig {
  const current = normalizeGatewayProvider(agent.modelConfig ?? {});
  if (hasPinnedModel(current)) return current;

  const selection = agent.aiVendorOverride;
  if (!selection) return current;

  const spec = WORKSPACE_AI_VENDORS[resolveWorkspaceAiVendor(selection)];
  return { ...current, tier: tierForAgent(current), provider: spec.provider };
}

/** Build the FULL routing policy for a workspace vendor selection.
 *
 *  A WORKSPACE SELECTS AN AI PROVIDER. It does not select a model. What a tier
 *  resolves to is decided centrally, in the `models` registry, and resolved at
 *  the moment of the call — so this function writes DECISIONS and no model ids.
 *
 *  WHY IT USED TO WRITE ONE, AND WHY THAT WAS THE DEFECT. It stamped
 *  `defaultModel` and a model id per background task, both derived from
 *  (vendor, tier) at the instant of the write. A derived value stored beside the
 *  inputs that derive it is a cache with no invalidation: the registry moved and
 *  the policies did not. Nothing in the request path noticed, because the stored
 *  id was preferred over the tier. It took a job re-stamping every tenant on
 *  every deploy to keep them approximately current, and when the OpenAI ladder
 *  moved to GPT-6 that job had not been run — so every existing workspace was a
 *  generation behind, and the default-vendor ones two Anthropic generations
 *  behind that. This is the same shape as `effectiveModelConfig` above, which
 *  already records a provider and never a model id, for the same reason.
 *
 *  What changes with the selection: `defaultProvider`. `defaultTier` is the
 *  platform's decision and is always `medium`.
 *
 *  What is written regardless of selection:
 *   - The five background tasks, as a TIER and a PROVIDER per task, from
 *     BACKGROUND_TASK_ASSIGNMENTS. The explicit provider is load-bearing: the
 *     runtime resolves `providerOverrides[task] || defaultProvider`, and these
 *     tasks once carried only a model — correct only while defaultProvider was
 *     always 'anthropic'. A vendor switch breaks that inheritance, and without
 *     the explicit provider a Qwen workspace would ask OpenRouter for a Claude
 *     model and every background task would error. The tier is what keeps each
 *     task on the size it was assigned rather than the workspace default, which
 *     is a tier up and priced like one.
 *   - Embedding keys, preserved verbatim (see the note at the assignment).
 *   - selectedVendor marker ('default' → omitted), so the read path can
 *     distinguish an explicit Anthropic choice from the untouched default. This
 *     is the one thing here the workspace actually chose.
 */
export function buildWorkspaceAiPolicy(
  selection: WorkspaceAiSelection,
  currentPolicy: RoutingPolicy | undefined,
): RoutingPolicy {
  const vendor = resolveWorkspaceAiVendor(selection);
  const spec = WORKSPACE_AI_VENDORS[vendor];

  const taskTierOverrides: Record<string, WorkspaceAiTier> = {};
  const taskOverrides: Record<string, string> = {};
  const providerOverrides: Record<string, string> = {};

  for (const [task, assignment] of Object.entries(BACKGROUND_TASK_ASSIGNMENTS)) {
    const assignedSpec = WORKSPACE_AI_VENDORS[assignment.vendor];
    taskTierOverrides[task] = assignment.tier;
    providerOverrides[task] = assignedSpec.provider;
  }

  // The embedding model is the ONE model id a policy still carries, and it is
  // not a routing choice — it is a record of which model produced the vectors
  // already stored. Vectors from two embedding models do not share a space, so
  // resolving this at call time would silently start mixing spaces and corrupt
  // retrieval with no error. Changing it means re-embedding, which is a
  // migration, not a lookup. Preserved verbatim, defaulted only when absent.
  taskOverrides.embedding =
    currentPolicy?.taskOverrides?.embedding ?? EMBEDDING_DEFAULTS.model;
  providerOverrides.embedding =
    currentPolicy?.providerOverrides?.embedding ?? EMBEDDING_DEFAULTS.provider;

  return {
    defaultProvider: spec.provider,
    defaultTier: 'medium',
    taskTierOverrides,
    taskOverrides,
    providerOverrides,
    ...(selection === 'default' ? {} : { selectedVendor: selection }),
  };
}

/** Canonical JSON for a routing policy: object keys sorted at every depth, so
 *  two policies that differ only in key order compare equal.
 *
 *  Key order is not cosmetic here. A policy is round-tripped through `jsonb`,
 *  and Postgres stores jsonb with its OWN key ordering (length, then byte
 *  order) rather than the order it was written in — so the object that comes
 *  back out of the database is almost never keyed the way
 *  buildWorkspaceAiPolicy wrote it. A plain JSON.stringify comparison would
 *  therefore report EVERY tenant as changed, on every run, which is precisely
 *  the false positive that would make the re-stamp unsafe to run on a deploy:
 *  it would bump every tenant's config version and publish an event per tenant
 *  per release, and the version column would stop meaning "something changed".
 *
 *  Arrays keep their order, because order IS meaning in an array. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      // An absent key and a key holding `undefined` are the same policy —
      // `undefined` cannot survive a jsonb round trip, so treating them as
      // different would report a change the database cannot even represent.
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Whether two routing policies say the same thing.
 *
 *  Used by scripts/restamp-workspace-ai-policies.ts to skip a tenant whose
 *  rebuilt policy is identical to the stored one. That skip is what makes the
 *  re-stamp safe to run on EVERY deploy, which is what makes a model upgrade
 *  sweep existing tenants instead of only new ones: without it the lever has
 *  to be pulled by hand, and the drift this function exists to close is what
 *  happens when nobody remembers to pull it. */
export function routingPolicyEquals(
  a: RoutingPolicy | undefined,
  b: RoutingPolicy | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
