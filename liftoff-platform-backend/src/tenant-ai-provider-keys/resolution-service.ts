// Does this call run on the customer's key, or on ours?
//
// TWO TESTS. A call uses the customer's key only if it passes both.
//
//   1. Would this call appear on the customer's Liftoff invoice today?
//      classifyChargeability() already answers that for every LLM call, and it
//      stays the only place chargeability is decided.
//
//   2. Did the customer initiate it? Could they look at a line on their
//      Anthropic invoice and connect it to something they did in the product?
//      That is BYOK_ELIGIBLE_PURPOSES below.
//
// Test 1 alone is not enough. It has a deliberate defensive fallthrough: an
// agent-attributed call with an unrecognised purpose returns 'customer' on the
// reasoning that a support ticket teaches us faster than a silent miss. That is
// the right default for billing, where the failure is a missed charge. It is
// the wrong default for BYOK, where the failure is unexplained spend on a third
// party's invoice that we caused and cannot itemise. Test 2 is what stops a new
// background job from quietly reaching a customer's provider account because
// someone tagged it with an agentId.
//
// The input is the RESOLVED provider, never the Workspace AI selection. The
// dropdown is one input of four to the routing chain (an admin pin, then the
// per-agent override, then the workspace policy, then hardcoded 'anthropic'),
// and this runs after all of it and asks only "does this tenant have a key for
// THAT provider". Three consequences fall straight out and are not bugs:
//
//   - Liftoff Managed is Anthropic (LIFTOFF_MANAGED_VENDOR), so a Liftoff
//     Managed workspace holding an Anthropic key has its turns funded by that
//     key. Routing and funding are orthogonal axes and 'default' is not special.
//   - Embeddings never follow the vendor selection (EMBEDDING_DEFAULTS pins
//     Google), so category B retrieval resolves to Google rather than to the
//     chat-model vendor. That is the concrete reason this is per-provider rather
//     than a per-tenant boolean — even though the embedding call sites are out
//     of scope for this change and do not consult it yet (see
//     CATEGORY_B_PURPOSES).
//   - Five background tasks are pinned to Anthropic whatever the workspace
//     picked (BACKGROUND_TASK_ASSIGNMENTS), so a workspace on OpenAI that
//     supplied only an OpenAI key runs three BYOK-eligible ones on our key.

import { classifyChargeability } from '../cost-attribution/event-classification';
import { log } from '../infrastructure/logging';
import { LIFTOFF_MANAGED_VENDOR } from '../model-registry/workspace-ai-vendors';
import { listKeys } from './repository';
import type { AiProviderKeyVendor } from './types';

/**
 * The sentinel purpose the agent adapters carry.
 *
 * The adapter path (`agent-execution/adapter/*`) runs the agent's own turns via
 * a vendor SDK, does not go through llmClient, and has no purpose string of its
 * own. It is category A — the customer's work, the bulk of BYOK-eligible spend
 * — so it needs to be nameable here. Giving it an explicit name rather than
 * treating "no purpose" as eligible is what keeps the default closed: an
 * untagged call from somewhere new fails test 2 instead of silently qualifying.
 */
export const AGENT_INVOCATION_PURPOSE = 'agent_invocation';

/**
 * Category A — the agent invocation itself, plus the llmClient calls that exist
 * ONLY because a turn is running and end when it ends. These are part of the
 * invocation and follow it.
 */
const CATEGORY_A_PURPOSES: readonly string[] = [
  AGENT_INVOCATION_PURPOSE,
  'agent_chat',
  'history-compaction',
  'workflow_step_output_compression',
  'workflow_semantic_validation',
  'hitl_card_summary',
  'chat_closing_reply',
  'agent_recovery',
  'tabular_extract',
  'tabular_enumerate',
  'agent_chat_summarization',
  'context_absorption',
  'thread_title_generation',
  'chat-feedback-extraction',
  // Voice on an AGENT thread only. The platform-surface halves
  // (voice_dictation_platform / voice_speech_platform) are category G and are
  // absorbed today, so they fail test 1 as well as this list.
  'voice_dictation',
  'voice_speech',
];

/**
 * Category B — retrieval at query time. Fires because a turn is running and is
 * charged to the customer today.
 *
 * These usually resolve to a DIFFERENT provider from the chat model, because
 * embeddings are pinned to Google whatever the workspace picked. A workspace
 * that supplied only an Anthropic key has nothing to embed with, so those fall
 * back to managed — handled by the per-provider lookup below, not by an
 * exception here.
 *
 * WHAT ACTS ON THIS TODAY: `retrieval_hyde` only. It is the one member that is
 * an LLM completion, so it rides the llmClient seam like everything in category
 * A. The four EMBEDDING purposes are eligible by this list and nothing consults
 * it for them, because the embedding path is deliberately out of scope for this
 * change — the shared `@liftoffos/embedding` client is untouched and every
 * embed still runs on Liftoff's own credential.
 *
 * They stay listed rather than being removed. The eligibility question is
 * settled and this is where the answer belongs; what is missing is a call site,
 * and deleting the entries would hide that a decision was already made. Wiring
 * them later is a change to the embedding client, not to this list.
 */
const CATEGORY_B_PURPOSES: readonly string[] = [
  'embedding_retrieval',
  'retrieval_hyde',
  'knowledge_embedding_query',
  'capability_embedding_query',
  'conversation_recall_query',
];

/**
 * The whole of test 2. Everything not named here runs on Liftoff's managed
 * keys, which is what it does today.
 *
 * Deliberately absent, and each for a stated reason:
 *   C  distillation and capability analysis — Liftoff absorbs the cost of
 *      BUILDING an agent and charges for running it. That bargain does not
 *      change because the customer supplied a key.
 *   D  memory and self-improvement loops — they run on Liftoff's schedule and
 *      are invisible in the product. A customer looking at a 3am spike on their
 *      Anthropic invoice would have nothing to reconcile it against.
 *   E  harvest — same reasoning as D.
 *   F  batch and backfill embeddings — absorbed to amortise across the corpus.
 *   G  platform surfaces (CAIO, HRBP, Insights, Liftoff) — the product talking
 *      about itself.
 *   H  injection_guard and dlp_deep_scan — and this one is NON-NEGOTIABLE. They
 *      protect the platform, not the customer's workload, and they must never
 *      be skippable by a customer whose key is dead or out of credit. dlp_deep_scan
 *      in particular PASSES test 1 (it originates in the runtime, so it is
 *      'customer' unconditionally); this list is the only thing keeping it off a
 *      customer key, which is exactly why test 2 exists.
 *   I  diagnostics judges — Liftoff evaluating quality for its own purposes.
 *   J  absorption_classification and chat_learning_classification — managed
 *      keys, charged as customer usage (see event-classification.ts).
 */
const BYOK_ELIGIBLE_PURPOSES: ReadonlySet<string> = new Set([
  ...CATEGORY_A_PURPOSES,
  ...CATEGORY_B_PURPOSES,
]);

/** True when a purpose is customer-initiated work in the sense of test 2.
 *  Exported so the runtime can ask the same question without importing the set,
 *  and so a test can assert category H is not in it. */
export function isByokEligiblePurpose(purpose: string | null | undefined): boolean {
  return purpose != null && BYOK_ELIGIBLE_PURPOSES.has(purpose);
}

/**
 * Which key vendor could fund a call that resolved to this execution provider.
 *
 * Null means "no customer key can pay this invoice", and every entry that
 * returns null is a deliberate statement rather than a gap:
 *
 *   anthropic-vertex — Vertex bills Liftoff's GCP account over ADC. There is no
 *     API key in the path to substitute, and a customer's Anthropic key cannot
 *     settle a Google Cloud bill.
 *   openrouter — an OpenRouter invoice is ours. glm, qwen, deepseek and kimi all
 *     execute here and the card offers no key for any of them, so a workspace on
 *     one of those four gets no BYOK on its agent turns whatever it pastes. The
 *     ONE exception is Grok, which executes as openrouter but has a customer-key
 *     vendor of its own — see resolveByokCredential's model check.
 */
export function keyVendorForProvider(provider: string): AiProviderKeyVendor | null {
  switch (provider) {
    case 'anthropic': return 'anthropic';
    case 'openai':    return 'openai';
    case 'google':    return 'google';
    case 'xai':       return 'xai';
    default:          return null;
  }
}

/** Grok models that predate its own provider.
 *
 *  Grok is `xai` now, so `keyVendorForProvider` answers for it directly and no
 *  model inspection is needed. This stays for rows written while Grok still
 *  executed as `openrouter`: an agent whose config was not migrated, or a
 *  request replayed from before migration 415. Both are funded correctly rather
 *  than silently dropping to managed keys.
 *
 *  Delete once no caller can present an `x-ai/` id. */
export function isLegacyOpenRouterGrokModel(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && modelId.startsWith('x-ai/');
}

export type ByokDeclineReason =
  /** Test 1: the platform absorbs this call today. Charging a customer's
   *  provider account for it would newly cost them money we do not bill for. */
  | 'not_customer_chargeable'
  /** Test 2: the customer did not initiate it. */
  | 'purpose_not_eligible'
  /** No customer key can settle this provider's invoice. */
  | 'provider_not_fundable'
  /** The tenant has not supplied a key for that provider. */
  | 'no_key'
  /** The tenant's key for that provider was declined and has not been replaced.
   *  Deliberately distinct from 'no_key': this is the state that must NOT be
   *  retried on every turn. */
  | 'key_revoked';

export interface ByokCredential {
  mode: 'byok';
  /** The key's vendor, which is not always the execution provider: a Grok turn
   *  resolves to provider 'openrouter' and vendor 'xai'. */
  vendor: AiProviderKeyVendor;
  /** Secret Manager pointer. The raw key is read by the gateway and by nothing
   *  else. */
  secretName: string;
  /** True when the call must be re-routed off its resolved provider to reach
   *  the key's own API — today only Grok, which executes as OpenRouter but must
   *  go direct to xAI to be fundable by an xAI key. */
  rerouteToVendorApi: boolean;
}

export interface ManagedCredential {
  mode: 'managed';
  reason: ByokDeclineReason;
}

export type ByokResolution = ByokCredential | ManagedCredential;

export interface ByokResolutionInput {
  tenantId: string;
  /** The provider the routing chain actually landed on, NOT the workspace
   *  selection. See the module header. */
  resolvedProvider: string;
  /** The model the routing chain landed on. Only read to recognise Grok. */
  resolvedModelId?: string | null;
  purpose: string | null;
  agentId: string | null;
  /** The ingestion source classifyChargeability keys off. 'tenant_runtime' for
   *  everything the runtime does, 'platform_llm' for platform-backend's own
   *  calls. Both callers name it; the default exists only so the parameter can
   *  be optional.
   *
   *  Be clear about what the default does: 'tenant_runtime' makes test 1 pass
   *  unconditionally, so a caller that forgot its source would be held ONLY by
   *  test 2. That is safe today because every purpose on the eligibility list is
   *  'customer' under both sources — but it is safe by coincidence, not by
   *  construction, and a purpose added to that list without checking would break
   *  it. Name the source. */
  source?: string;
}

// ── Cache ───────────────────────────────────────────────────────────────────
//
// The whole per-tenant key set, not per (tenant, vendor): the read is one query
// either way, and caching the set means a turn that resolves a chat key and an
// embedding key pays for one lookup rather than two. Invalidated explicitly on
// write and on revocation rather than by TTL, so a rotated key takes effect on
// the next call instead of up to a TTL later — the customer just pasted it and
// is watching.

interface CachedEntry {
  byVendor: Map<AiProviderKeyVendor, { secretName: string; status: 'valid' | 'revoked' }>;
  cachedAt: number;
}

/** A ceiling, not the invalidation mechanism. It exists so a write that lands on
 *  another Cloud Run instance still propagates, and so a process that has been
 *  up for days is not serving a set it read at boot. */
const CACHE_CEILING_MS = 60_000;

const cache = new Map<string, CachedEntry>();

export function invalidateResolutionCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

async function loadKeys(tenantId: string): Promise<CachedEntry> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.cachedAt < CACHE_CEILING_MS) return cached;

  const rows = await listKeys(tenantId);
  const entry: CachedEntry = {
    byVendor: new Map(
      rows.map((r) => [r.vendor, { secretName: r.secretName, status: r.status }] as const),
    ),
    cachedAt: Date.now(),
  };
  cache.set(tenantId, entry);
  return entry;
}

/**
 * The one function that answers "whose key pays for this call".
 *
 * Everything upstream of it — the routing chain, the purpose tag, the source —
 * is input. Nothing downstream re-decides it: the gateway serves whatever this
 * returns and the ledger books the bucket that follows from it, which is the
 * property that keeps the two from drifting apart.
 */
export async function resolveByokCredential(
  input: ByokResolutionInput,
): Promise<ByokResolution> {
  // ── Test 1 ────────────────────────────────────────────────────────────────
  const chargeability = classifyChargeability({
    source: input.source ?? 'tenant_runtime',
    purpose: input.purpose,
    agentId: input.agentId,
  });
  if (chargeability !== 'customer') {
    return { mode: 'managed', reason: 'not_customer_chargeable' };
  }

  // ── Test 2 ────────────────────────────────────────────────────────────────
  if (!isByokEligiblePurpose(input.purpose)) {
    return { mode: 'managed', reason: 'purpose_not_eligible' };
  }

  // ── Which key could pay ───────────────────────────────────────────────────
  let vendor = keyVendorForProvider(input.resolvedProvider);
  let reroute = false;
  if (
    !vendor
    && input.resolvedProvider === 'openrouter'
    && isLegacyOpenRouterGrokModel(input.resolvedModelId)
  ) {
    // A pre-migration-415 caller: Grok used to execute as OpenRouter, where a
    // customer's xAI key could not settle the invoice, so funding it meant
    // leaving OpenRouter mid-run. Grok resolves as `xai` now and takes the
    // branch above; this one only catches configurations not yet migrated.
    vendor = 'xai';
    reroute = true;
  }
  if (!vendor) return { mode: 'managed', reason: 'provider_not_fundable' };

  const keys = await loadKeys(input.tenantId);
  const key = keys.byVendor.get(vendor);
  if (!key) return { mode: 'managed', reason: 'no_key' };
  if (key.status !== 'valid') return { mode: 'managed', reason: 'key_revoked' };

  return { mode: 'byok', vendor, secretName: key.secretName, rerouteToVendorApi: reroute };
}

/**
 * Say out loud, once at boot, which vendor 'Liftoff Managed' funds.
 *
 * The binding is invisible and consequential. LIFTOFF_MANAGED_VENDOR is an
 * internal constant, so if managed routing ever moves off Anthropic, every
 * Liftoff Managed tenant's Anthropic key stops being used and their spend
 * returns to Liftoff — silently, with nothing in any surface saying so. That
 * makes changing the constant a BILLING change, and a billing change has to
 * emit something.
 *
 * This is the something. The pairing is `managed-vendor-binding.test.ts`, which
 * pins the value so it cannot move without someone stating the consequence.
 */
export function logByokManagedVendorBinding(): void {
  log.info(
    {
      event: 'byok_managed_vendor_binding',
      managedVendor: LIFTOFF_MANAGED_VENDOR,
    },
    `BYOK: a Liftoff Managed workspace routes to '${LIFTOFF_MANAGED_VENDOR}', so a stored `
    + `'${LIFTOFF_MANAGED_VENDOR}' key funds its agent turns. Changing LIFTOFF_MANAGED_VENDOR `
    + 'moves that funding back to Liftoff for every Liftoff Managed tenant.',
  );
}
