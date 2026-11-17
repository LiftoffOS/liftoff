// Where a voice session's cost lands.
//
// Split out from the transport so the ledger write is stated once and reads the
// same whichever surface produced the audio, and in whichever direction it went.

import { log } from '../infrastructure/logging';
import { ingestEventWithBuckets, resolveAccountIdForTenant } from '../cost-attribution/repository';
import {
  VOICE_DICTATION_PURPOSE,
  VOICE_DICTATION_PLATFORM_PURPOSE,
  VOICE_SPEECH_PURPOSE,
  VOICE_SPEECH_PLATFORM_PURPOSE,
} from '../cost-attribution/event-classification';
import type { VoiceUsage } from './types';

/**
 * Which composer the audio was spoken into.
 *
 * Declared by the caller rather than inferred from whether an agent id is
 * present, because the two are not the same question: the Chief AI Officer chat
 * HAS an agent row (migration 194) and is still a platform surface whose cost is
 * absorbed. Inferring billing from payload shape is how a surface silently
 * changes sides.
 */
export type DictationSurface = 'agent_chat' | 'team_plan' | 'insights' | 'slack' | 'teams';

/**
 * Surfaces where voice is the person's own workload, and therefore charged.
 *
 * Slack and Teams belong here for the same reason `agent_chat` does: somebody is
 * talking to their own team member, and it happens to be through a chat client.
 * The two platform surfaces are absorbed instead — see below.
 */
const CHARGED_SURFACES = new Set<DictationSurface>(['agent_chat', 'slack', 'teams']);

/**
 * Write the ledger row for one dictation session.
 *
 * Never throws into a caller: losing a billing row is a revenue bug worth an
 * alert, but it must not take down a transcript the person is already reading.
 *
 * Cost notes:
 *  - `agentId`, when present, is the internal_agents.id. The tenant runtime's
 *    agents.id is a disjoint space (ADR-039) and would match zero rows here with
 *    no error at all.
 *  - Zero cost means the vendor billed nothing, and ingestEventWithBuckets
 *    treats a zero amount as a no-op. No row is correct in that case rather than
 *    a row dropped.
 */
export async function recordDictationCost(params: {
  tenantId: string;
  surface: DictationSurface;
  agentId: string | undefined;
  provider: string;
  usage: VoiceUsage;
  sourceId: string;
  occurredAt: Date;
}): Promise<void> {
  await recordVoiceCost({
    ...params,
    eventType: 'voice_stt',
    // Talking to your own team member is your workload. The Chief AI Officer and
    // workspace insights are platform surfaces whose own model calls are already
    // absorbed (`caio_workforce_planning`, `insights_chat`, ...), so the
    // dictation feeding them is absorbed too rather than becoming the one charged
    // line on an otherwise free page.
    purpose: CHARGED_SURFACES.has(params.surface)
      ? VOICE_DICTATION_PURPOSE
      : VOICE_DICTATION_PLATFORM_PURPOSE,
    what: 'dictation',
  });
}

/**
 * Write the ledger row for one spoken reply.
 *
 * Split by surface on exactly the rule dictation uses, so that a thread cannot
 * bill for listening and not for speaking, or the reverse.
 */
export async function recordSynthesisCost(params: {
  tenantId: string;
  surface: DictationSurface;
  agentId: string | undefined;
  provider: string;
  usage: VoiceUsage;
  sourceId: string;
  occurredAt: Date;
}): Promise<void> {
  await recordVoiceCost({
    ...params,
    eventType: 'voice_tts',
    purpose: CHARGED_SURFACES.has(params.surface)
      ? VOICE_SPEECH_PURPOSE
      : VOICE_SPEECH_PLATFORM_PURPOSE,
    what: 'speech',
  });
}

async function recordVoiceCost(params: {
  tenantId: string;
  surface: DictationSurface;
  agentId: string | undefined;
  provider: string;
  usage: VoiceUsage;
  sourceId: string;
  occurredAt: Date;
  eventType: 'voice_stt' | 'voice_tts';
  purpose: string;
  what: string;
}): Promise<void> {
  const {
    tenantId, surface, agentId, provider, usage, sourceId, occurredAt, eventType, purpose, what,
  } = params;
  try {
    const accountId = await resolveAccountIdForTenant(tenantId);
    if (!accountId) {
      log.error({ tenantId, what }, 'Voice: no account for tenant, cost not attributed');
      return;
    }
    await ingestEventWithBuckets(accountId, sourceId, usage.costUsd, {
      tenantId,
      agentId: agentId ?? null,
      eventType,
      source: 'platform_llm',
      provider,
      model: usage.model,
      purpose,
      usageQuantity: usage.quantity,
      usageUnit: usage.unit,
      correlationConfidence: 'direct',
      occurredAt,
    });
  } catch (err) {
    log.error(
      { error: (err as Error).message, tenantId, surface, what },
      'Voice succeeded but cost attribution failed',
    );
  }
}
