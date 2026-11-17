// Which vendor powers the PLATFORM's own LLM work, by area.
//
// A workspace's vendor choice answers what ITS agents run on. It must not
// answer what Liftoff's own assistants run on — those are the platform's
// product, not the customer's configuration, and a workspace switching to Qwen
// should not move the Chief AI Officer with it.
//
// Until now the platform side had no answer at all: `llmClient.complete` takes
// the provider as an argument, 36 of its 37 call sites pass nothing, and the
// fallthrough is `getFirstAvailableProvider()` — Anthropic, by priority order.
// That is a default by accident rather than a decision, and there was no way to
// change it short of editing the priority list.
//
// FOUR AREAS, because two would put team-shaping, safety gates and every
// unregistered purpose in one bucket. They are deliberately NOT the
// `AnthropicPurposeGroup` values: that enum exists to pick a billing key, it has
// no group for safety work, and it sends anything unregistered to
// 'agent-execution' alongside distillation. Reusing it would have made the
// safety lever silently the team-shaping lever.

import {
  WORKSPACE_AI_VENDORS,
  isWorkspaceAiSelection,
  resolveWorkspaceAiVendor,
  type WorkspaceAiSelection,
  type WorkspaceAiTier,
} from './workspace-ai-vendors';
import type { LLMProvider } from '../llm/types';

/** The four levers. */
export type PlatformVendorArea =
  | 'assistants'
  | 'agent_shaping'
  | 'quiet_work'
  | 'safety';

export const PLATFORM_VENDOR_AREAS: readonly PlatformVendorArea[] = [
  'assistants', 'agent_shaping', 'quiet_work', 'safety',
];

/** Area 1 — what a person reads in a reply.
 *
 *  Liftoff, the Chief AI Officer, the Insights Manager and the HRBP, plus the
 *  supporting calls a turn makes (its summarisation, its title, its recall). A
 *  change here is visible to a customer in tone and quality, and this is the
 *  area that most constrains which vendors are eligible: it needs vision for
 *  attachments and the browser pane, tools, and structured outputs. */
const ASSISTANT_PREFIXES = ['liftoff', 'insights', 'caio', 'hrbp', 'workforce'] as const;
const ASSISTANT_PURPOSES = new Set([
  'team_plan', 'brief_echo', 'observations', 'intro', 'route_message_none',
]);

/** Area 2 — work that decides what an agent IS.
 *
 *  Nobody watches these run, and that is the point: a weaker model here does
 *  not produce a worse answer once, it produces a worse TEAM that then runs for
 *  months. Distillation and the capability/template analysis behind it. */
const TEAM_SHAPING_PREFIXES = ['distill', 'capability', 'template'] as const;
const TEAM_SHAPING_PURPOSES = new Set([
  'skill_dedup_calibration', 'manual_capability_analysis', 'brief_restatement',
]);

/** Area 4 — gates, where a wrong answer is a security outcome.
 *
 *  Injection screening, untrusted content, DLP, and the classifications that
 *  decide whether something is sensitive. Its own lever even though it shares a
 *  tier with Area 3, so a cost decision can never silently move a safety
 *  decision. */
const SAFETY_PURPOSES = new Set([
  'injection_guard', 'untrusted_content', 'dlp_deep_scan', 'tool_classification',
  'harvest_classification', 'absorption_classification', 'route_message',
  'output_guard', 'chat_learning_classification',
  'suggestion_response_classification',
]);

/** Area 3 — high-volume, low-stakes, invisible.
 *
 *  Titles, compaction, recall, reflection, consolidation, extraction. Listed
 *  explicitly rather than left to the default, so the default can mean
 *  something. */
const QUIET_PURPOSES = new Set([
  'thread_title_generation', 'title_generation', 'context_absorption',
  'history-compaction', 'rolling_summary', 'conversation_recall',
  'conversation_recall_query', 'retrieval_hyde', 'chat-feedback-extraction',
  'suggestion_generation', 'suggestion_applier', 'preference_aggregation',
  'reflection', 'memory_consolidation', 'workflow_visualization_steps_generation',
  'agent_dataset_extract', 'template_description',
]);

/** WHERE AN UNREGISTERED PURPOSE LANDS, and why it is this one.
 *
 *  `quiet_work`, not `agent_shaping`. A purpose nobody classified is far more
 *  likely to be a new background job than a new distillation rung — but the
 *  decisive argument is the direction of the mistake. Landing an unknown in
 *  agent_shaping would let a cheap-vendor lever silently move work that shapes
 *  an agent; landing it in quiet_work risks only that a new important purpose
 *  runs cheap until somebody names it. The first is invisible and permanent,
 *  the second shows up as quality on a surface someone is watching. */
export const UNREGISTERED_PURPOSE_AREA: PlatformVendorArea = 'quiet_work';

/** The area a purpose belongs to.
 *
 *  Prefix matching for the assistant and team-shaping families because both
 *  spawn per-surface variants (`liftoff_summarization`, `caio_dataset_extract`,
 *  `distill_patch`) that must not each need registering — a variant that fell
 *  through to the default would be the one case this whole map exists to stop.
 *  SAFETY IS CHECKED FIRST, so a purpose that looks like a classification can
 *  never be captured by a broader family prefix. */
export function areaForPurpose(purpose: string | undefined): PlatformVendorArea {
  if (!purpose) return UNREGISTERED_PURPOSE_AREA;
  if (SAFETY_PURPOSES.has(purpose)) return 'safety';
  if (TEAM_SHAPING_PURPOSES.has(purpose)) return 'agent_shaping';
  if (TEAM_SHAPING_PREFIXES.some((p) => purpose.startsWith(p))) return 'agent_shaping';
  if (ASSISTANT_PURPOSES.has(purpose)) return 'assistants';
  if (ASSISTANT_PREFIXES.some((p) => purpose.startsWith(p))) return 'assistants';
  if (QUIET_PURPOSES.has(purpose)) return 'quiet_work';
  return UNREGISTERED_PURPOSE_AREA;
}

/** THE FALLBACK, and it is load-bearing rather than a placeholder.
 *
 *  This is what resolves before the policy row is read, and what keeps
 *  resolving if the read fails — so it is the answer during a database blip,
 *  on first boot, and in every test. 'default' means "whatever the platform
 *  would have done anyway", which is the pre-existing behaviour, so shipping
 *  this module changes no routing until somebody moves a lever. */
export const PLATFORM_VENDOR_FALLBACK: Readonly<Record<PlatformVendorArea, WorkspaceAiSelection>> = {
  assistants: 'default',
  agent_shaping: 'default',
  quiet_work: 'default',
  safety: 'default',
};

/** The live policy, replaced wholesale by the loader. Kept module-level and
 *  synchronous for the reason the pricing and branding overlays are: this is
 *  read on a request path and must not become per-call I/O. */
let policy: Record<PlatformVendorArea, WorkspaceAiSelection> = { ...PLATFORM_VENDOR_FALLBACK };

/** Install a policy. A partial map fills the rest from the fallback, so a row
 *  that names only one area cannot leave the others undefined. */
export function setPlatformVendorPolicy(
  next: Partial<Record<PlatformVendorArea, WorkspaceAiSelection>>,
): void {
  const merged = { ...PLATFORM_VENDOR_FALLBACK };
  for (const area of PLATFORM_VENDOR_AREAS) {
    const v = next[area];
    // An unrecognised vendor is IGNORED rather than written through. A policy
    // row naming a vendor this build does not have would otherwise route an
    // area to nothing and take the fallback's place while looking configured.
    if (v !== undefined && isWorkspaceAiSelection(v)) merged[area] = v;
  }
  policy = merged;
}

/** Restore the fallback. TEST-ONLY — underscored so the reachability ratchet
 *  can see that, rather than reading it as a feature nothing calls. */
export function _resetPlatformVendorPolicy(): void {
  policy = { ...PLATFORM_VENDOR_FALLBACK };
}

/** The vendor an area is currently set to. */
export function platformVendorForArea(area: PlatformVendorArea): WorkspaceAiSelection {
  return policy[area];
}

/** The whole policy, for the admin read and the runtime snapshot. */
export function platformVendorPolicy(): Readonly<Record<PlatformVendorArea, WorkspaceAiSelection>> {
  return { ...policy };
}

/** What a lever resolves to on THIS plane, or null to leave the call alone.
 *
 *  Null for 'default', and null for a vendor this process cannot reach — which
 *  is a real case and not defensive padding. The control plane registers four
 *  provider clients (anthropic, google, openai, openrouter). The six
 *  open-weight families are reachable, but only THROUGH the gateway client and
 *  only with the model named explicitly, because that client's own tier map is
 *  GLM's: asking it for tier 'small' would answer with GLM's small whatever
 *  vendor the lever names. Grok is not reachable at all here — it left the
 *  gateway for api.x.ai, and this plane has no xAI client — so a lever set to
 *  Grok must fall back rather than silently run GLM.
 */
export function resolvePlatformVendorTarget(
  selection: WorkspaceAiSelection,
  tier: WorkspaceAiTier | undefined,
): { provider: LLMProvider; model?: string } | null {
  if (selection === 'default') return null;
  const vendor = resolveWorkspaceAiVendor(selection);
  const spec = WORKSPACE_AI_VENDORS[vendor];
  if (!spec) return null;

  if (spec.transport === 'openrouter') {
    // The model is NOT optional here — see the note above.
    const model = spec.tiers[tier ?? 'medium'];
    return model ? { provider: 'openrouter', model } : null;
  }

  // Direct transports. Only the three this plane holds a client for; anything
  // else (Grok on xAI) resolves to null and keeps the platform default.
  if (spec.provider === 'anthropic' || spec.provider === 'openai' || spec.provider === 'google') {
    return { provider: spec.provider };
  }
  return null;
}

/** The vendors a platform area may actually be set to on this plane.
 *
 *  Exported so the admin surface can refuse a vendor rather than accept it and
 *  quietly do nothing — a lever that reads as configured and routes nowhere is
 *  worse than a rejected edit. */
export function selectablePlatformVendors(): WorkspaceAiSelection[] {
  const out: WorkspaceAiSelection[] = ['default'];
  for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as Array<keyof typeof WORKSPACE_AI_VENDORS>) {
    if (resolvePlatformVendorTarget(vendor as WorkspaceAiSelection, 'medium')) {
      out.push(vendor as WorkspaceAiSelection);
    }
  }
  return out;
}
