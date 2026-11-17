// Which vendor powers the PLATFORM's own LLM work, in this plane.
//
// The control plane owns the decision and serves it on the registry snapshot;
// this is the runtime's copy and the resolution that reads it. The runtime
// makes its own platform-side calls — semantic compression of oversized tool
// results, memory DLP scanning, HITL card text — and those must land on the
// same vendor the control plane's equivalent work lands on. Two planes reading
// two sources is how they come to disagree.
//
// The AREA MAP IS MIRRORED, deliberately and not shared: this repo cannot
// import from the control plane's src/. The parity that matters is which area a
// purpose belongs to, and `__tests__/platform-vendor-policy-parity.test.ts`
// pins this file's answers against the purposes the control plane classifies.

import type { LLMProvider } from './types';
import { TIER_MODELS as GLM_TIERS } from './providers/glm';
import { TIER_MODELS as QWEN_TIERS } from './providers/qwen';
import { TIER_MODELS as DEEPSEEK_TIERS } from './providers/deepseek';
import { TIER_MODELS as KIMI_TIERS } from './providers/kimi';
import { TIER_MODELS as MINIMAX_TIERS } from './providers/minimax';
import { TIER_MODELS as XIAOMI_TIERS } from './providers/xiaomi';

export type PlatformVendorArea =
  | 'assistants'
  | 'team_shaping'
  | 'quiet_work'
  | 'safety';

export const PLATFORM_VENDOR_AREAS: readonly PlatformVendorArea[] = [
  'assistants', 'team_shaping', 'quiet_work', 'safety',
];

const ASSISTANT_PREFIXES = ['liftoff', 'insights', 'caio', 'hrbp', 'workforce'] as const;
const ASSISTANT_PURPOSES = new Set([
  'team_plan', 'brief_echo', 'observations', 'intro', 'route_message_none',
]);
const TEAM_SHAPING_PREFIXES = ['distill', 'capability', 'template'] as const;
const TEAM_SHAPING_PURPOSES = new Set([
  'skill_dedup_calibration', 'manual_capability_analysis', 'brief_restatement',
]);
const SAFETY_PURPOSES = new Set([
  'injection_guard', 'untrusted_content', 'dlp_deep_scan', 'tool_classification',
  'harvest_classification', 'absorption_classification', 'route_message',
  'output_guard', 'chat_learning_classification',
  'suggestion_response_classification',
]);
const QUIET_PURPOSES = new Set([
  'thread_title_generation', 'title_generation', 'context_absorption',
  'history-compaction', 'rolling_summary', 'conversation_recall',
  'conversation_recall_query', 'retrieval_hyde', 'chat-feedback-extraction',
  'suggestion_generation', 'suggestion_applier', 'preference_aggregation',
  'reflection', 'memory_consolidation', 'workflow_visualization_steps_generation',
  'agent_dataset_extract', 'template_description',
]);

/** An unregistered purpose goes to quiet_work — see the control plane's copy
 *  for the argument. The short version: an unknown running cheap surfaces as
 *  quality on a watched surface, where an unknown silently riding the
 *  team-shaping lever would not surface at all. */
export const UNREGISTERED_PURPOSE_AREA: PlatformVendorArea = 'quiet_work';

/** Safety first, so a classification cannot be captured by a family prefix. */
export function areaForPurpose(purpose: string | undefined): PlatformVendorArea {
  if (!purpose) return UNREGISTERED_PURPOSE_AREA;
  if (SAFETY_PURPOSES.has(purpose)) return 'safety';
  if (TEAM_SHAPING_PURPOSES.has(purpose)) return 'team_shaping';
  if (TEAM_SHAPING_PREFIXES.some((p) => purpose.startsWith(p))) return 'team_shaping';
  if (ASSISTANT_PURPOSES.has(purpose)) return 'assistants';
  if (ASSISTANT_PREFIXES.some((p) => purpose.startsWith(p))) return 'assistants';
  if (QUIET_PURPOSES.has(purpose)) return 'quiet_work';
  return UNREGISTERED_PURPOSE_AREA;
}

/** Every area on the platform default until the overlay lands, so a runtime
 *  that has never reached the control plane behaves exactly as it does today. */
const FALLBACK: Record<PlatformVendorArea, string> = {
  assistants: 'default',
  team_shaping: 'default',
  quiet_work: 'default',
  safety: 'default',
};

let policy: Record<PlatformVendorArea, string> = { ...FALLBACK };

/** Install the overlay from the registry snapshot. */
export function setPlatformVendorPolicy(next: Record<string, string> | undefined): void {
  const merged = { ...FALLBACK };
  if (next) {
    for (const area of PLATFORM_VENDOR_AREAS) {
      const v = next[area];
      if (typeof v === 'string' && v.length > 0) merged[area] = v;
    }
  }
  policy = merged;
}

/** Restore the fallback. TEST-ONLY — underscored so the reachability ratchet
 *  can see that, rather than reading it as a feature nothing calls. */
export function _resetPlatformVendorPolicy(): void {
  policy = { ...FALLBACK };
}

export function platformVendorForArea(area: PlatformVendorArea): string {
  return policy[area];
}

/** The whole policy. TEST-ONLY here — this plane reads one area at a time on a
 *  request path; the admin surface that needs all four lives on the control
 *  plane, which has its own copy. */
export function _platformVendorPolicy(): Readonly<Record<PlatformVendorArea, string>> {
  return { ...policy };
}

/** vendor → its tier map, for the gateway-served families. The runtime holds
 *  one map per family precisely so a gateway cannot answer for all of them. */
const GATEWAY_TIERS: Record<string, Record<string, string>> = {
  glm: GLM_TIERS,
  qwen: QWEN_TIERS,
  deepseek: DEEPSEEK_TIERS,
  kimi: KIMI_TIERS,
  minimax: MINIMAX_TIERS,
  xiaomi: XIAOMI_TIERS,
};

/** What a lever resolves to HERE, or null to leave the call alone.
 *
 *  Null for 'default' and for a vendor this plane cannot reach. The runtime
 *  registers anthropic, openai and google clients; the gateway families are
 *  reachable only with the model named, because each has its own tier map and
 *  the provider alone would not say which. Grok resolves to null: it runs on
 *  api.x.ai through the adapter layer, not through this client. */
export function resolvePlatformVendorTarget(
  selection: string,
  tier: string | undefined,
): { provider: LLMProvider; model?: string } | null {
  if (!selection || selection === 'default') return null;

  const tiers = GATEWAY_TIERS[selection];
  if (tiers) {
    const model = tiers[tier ?? 'medium'] ?? tiers.medium;
    return model ? { provider: selection as LLMProvider, model } : null;
  }

  if (selection === 'anthropic' || selection === 'openai' || selection === 'google') {
    return { provider: selection };
  }
  return null;
}
