// Correction Capture
// When a human rejects a tool call via HITL, saves the correction as agent memory.
// The agent won't make the same mistake twice.
//
// Corrections get a 180-day TTL (2x auto-reflections), renewable on successful
// injection via usefulness tracking. Stale corrections that stop being retrieved
// age out naturally rather than accumulating indefinitely.

import { randomUUID } from 'crypto';
import { memoryService } from '../memory/service';
import { sanitizeMemoryContent } from '../memory/content-sanitizer';
import { logger } from '../infrastructure/logging';
import type { SourceEventInput } from '../memory/types';

const CORRECTION_TTL_DAYS = 180;

// Private implementation — shared by both public entry points. Each caller
// is responsible for building the correct SourceEventInput for its context.
async function applyRejection(
  tenantId: string,
  agentId: string,
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  reason: string | undefined,
  category: string | undefined,
  source: SourceEventInput,
): Promise<void> {
  try {
    const toolSummary = toolCalls
      .map(tc => tc.name)
      .join(', ');

    // P2: Sanitize rejection reason to prevent injection via HITL path
    // TE-007: treat empty string as no reason
    const sanitizedReason = reason && reason.trim() ? sanitizeMemoryContent(reason) : undefined;
    if (sanitizedReason && sanitizedReason.strippedPatterns.length > 0) {
      logger.info({
        tenantId, agentId,
        strippedPatterns: sanitizedReason.strippedPatterns,
      }, 'content-sanitizer: stripped patterns from HITL rejection reason');
    }

    const effectiveReason = sanitizedReason?.sanitized;

    const content = effectiveReason
      ? [
          `**Rule:** ${effectiveReason}`,
          `**Why:** Human rejected ${toolSummary}`,
          `**Applies when:** Using ${toolSummary}`,
        ].join('\n')
      : [
          `**Rule:** Avoid ${toolSummary}`,
          `**Why:** Human rejected this action`,
          `**Applies when:** Agent considers using ${toolSummary}`,
        ].join('\n');

    await memoryService.saveMemory({
      tenantId,
      layer: 'individual',
      scopeKey: `correction-${toolCalls[0]?.name || 'unknown'}`,
      content,
      agentId,
      tags: ['correction', 'hitl-rejection', ...(category ? [category] : [])],
      contentClassification: 'internal',
      expiresAt: new Date(Date.now() + CORRECTION_TTL_DAYS * 24 * 60 * 60 * 1000),
      source,
    });

    logger.info({ tenantId, agentId, toolName: toolCalls[0]?.name }, 'HITL correction saved to memory');
  } catch (error) {
    logger.warn({ error, tenantId, agentId }, 'Non-fatal: correction capture failed');
  }
}

export async function captureCorrection(
  tenantId: string,
  agentId: string,
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  decision: 'approved' | 'rejected',
  reason?: string,
  category?: string,
): Promise<void> {
  if (decision !== 'rejected') return;

  await applyRejection(tenantId, agentId, toolCalls, reason, category, {
    nodeType: 'hitl_event',
    refId: toolCalls[0]?.id ?? randomUUID(),
    agentId,
    metadata: { correctionType: 'hitl-rejection' },
  });
}

/** Why a person approved something, kept as memory.
 *
 *  `captureCorrection` returns early on 'approved' by design — it exists to
 *  record what an agent must not do again, and an approval is not a
 *  correction. But it left the loop one-sided: an agent learned only from
 *  refusals, and a standing "always allow" set through alwaysApply carried no
 *  record of the reasoning behind it.
 *
 *  Stored as permission rather than prohibition, under its own scope key, so
 *  retrieval cannot confuse "you may do this, here is why" with "avoid this".
 */
export async function captureApprovalNote(
  tenantId: string,
  agentId: string,
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  note: string,
): Promise<void> {
  try {
    if (!note.trim()) return;
    const sanitized = sanitizeMemoryContent(note);
    if (sanitized.strippedPatterns.length > 0) {
      logger.info({
        tenantId, agentId,
        strippedPatterns: sanitized.strippedPatterns,
      }, 'content-sanitizer: stripped patterns from HITL approval note');
    }

    const toolSummary = toolCalls.map((tc) => tc.name).join(', ') || 'this action';

    const content = [
      `**Rule:** ${sanitized.sanitized}`,
      `**Why:** A person approved ${toolSummary} and gave this reason`,
      `**Applies when:** Considering ${toolSummary} again`,
    ].join('\n');

    await memoryService.saveMemory({
      tenantId,
      layer: 'individual',
      scopeKey: `approval-${toolCalls[0]?.name || 'unknown'}`,
      content,
      agentId,
      tags: ['approval', 'hitl-approval'],
      contentClassification: 'internal',
      expiresAt: new Date(Date.now() + CORRECTION_TTL_DAYS * 24 * 60 * 60 * 1000),
      source: {
        nodeType: 'hitl_event',
        refId: toolCalls[0]?.id ?? randomUUID(),
        agentId,
        metadata: { correctionType: 'hitl-approval-note' },
      },
    });

    logger.info({ tenantId, agentId, toolName: toolCalls[0]?.name }, 'HITL approval note saved to memory');
  } catch (error) {
    logger.warn({ error, tenantId, agentId }, 'Non-fatal: approval note capture failed');
  }
}

/** What a person said when an agent asked them a question, kept as memory.
 *
 *  A rejected tool call already teaches the agent something. Being *answered*
 *  taught it nothing, so the same question came back the next time the same
 *  work ran, and the queue filled with asks a person had already settled.
 *
 *  The two outcomes teach different things and are stored as different rules.
 *  An answer is a fact to reuse. A decline is the more valuable one: it says
 *  this particular question has nobody who can settle it, so asking again
 *  spends a person's attention to reach the same dead end.
 *
 *  Deliberately not routed through applyRejection: that builds its content and
 *  its scope key out of a tool name, and a clarification has no tool call. It
 *  would have written "Avoid " under the scope key `correction-unknown`.
 */
export async function captureClarificationOutcome(input: {
  tenantId: string;
  agentId: string;
  clarificationId: string;
  question: string;
  outcome: 'answered' | 'declined';
  response?: string;
}): Promise<void> {
  try {
    const question = sanitizeMemoryContent(input.question).sanitized;
    // One line is what identifies the ask; the body can be long and the rule
    // has to stay readable where it is injected.
    const asked = question.split('\n')[0].slice(0, 200);
    const answered = input.response && input.response.trim()
      ? sanitizeMemoryContent(input.response).sanitized
      : undefined;

    const content = input.outcome === 'answered'
      ? [
          `**Rule:** ${answered}`,
          `**Why:** A person answered "${asked}"`,
          `**Applies when:** The same question would otherwise be asked again`,
        ].join('\n')
      : [
          `**Rule:** Do not ask "${asked}". Proceed on your own judgement or close the work out.`,
          answered
            ? `**Why:** A person could not answer it: ${answered}`
            : `**Why:** A person was asked and could not answer it`,
          `**Applies when:** The same detail is missing again`,
        ].join('\n');

    await memoryService.saveMemory({
      tenantId: input.tenantId,
      layer: 'individual',
      scopeKey: `clarification-${input.outcome}`,
      content,
      agentId: input.agentId,
      tags: ['correction', 'clarification', `clarification-${input.outcome}`],
      contentClassification: 'internal',
      expiresAt: new Date(Date.now() + CORRECTION_TTL_DAYS * 24 * 60 * 60 * 1000),
      source: {
        nodeType: 'hitl_event',
        refId: input.clarificationId,
        agentId: input.agentId,
        metadata: { correctionType: `clarification-${input.outcome}` },
      },
    });

    logger.info(
      { tenantId: input.tenantId, agentId: input.agentId, outcome: input.outcome },
      'clarification outcome saved to memory',
    );
  } catch (error) {
    logger.warn(
      { error, tenantId: input.tenantId, agentId: input.agentId },
      'Non-fatal: clarification outcome capture failed',
    );
  }
}

// Governance-event flavored wrapper. The governance-engine publishes
// `governance.correction_captured` when a HITL override reveals a correction
// (e.g. human approved the action but edited the tool input). The payload
// shape comes from the Pub/Sub envelope — this adapter narrows it to the
// applyRejection() signature.
//
// Payload fields (all optional on the wire — we defensively validate):
//   tenantId          — required
//   agentId           — required
//   actionId          — optional; used as the provenance refId for this governance action
//   correctionType    — optional; mapped into the `category` tag
//   correctionPayload — structured correction body, one of:
//     {
//       toolCalls?:   [{ id, name, input }]   // original rejected calls
//       reason?:      string                  // human rationale
//     }
//
// This always produces a "rejected" decision — the correction event is only
// emitted when governance classifies the override as a correction (the
// captured form is "what the agent did that the human overrode"). Approvals
// without corrections do not fire this event.
export interface GovernanceCorrectionPayload {
  tenantId?: string;
  agentId?: string;
  actionId?: string;
  correctionType?: string;
  correctionPayload?: unknown;
}

interface CorrectionPayloadShape {
  toolCalls?: Array<{ id?: string; name?: string; input?: Record<string, unknown> }>;
  reason?: string;
}

export async function captureFromGovernanceEvent(
  payload: GovernanceCorrectionPayload,
): Promise<void> {
  if (!payload.tenantId || !payload.agentId) {
    logger.warn(
      { tenantId: payload.tenantId, agentId: payload.agentId, actionId: payload.actionId },
      'governance correction_captured: missing tenantId or agentId; skipping',
    );
    return;
  }

  const body: CorrectionPayloadShape =
    payload.correctionPayload && typeof payload.correctionPayload === 'object'
      ? (payload.correctionPayload as CorrectionPayloadShape)
      : {};

  // Normalize toolCalls — applyRejection requires id/name/input on each.
  const rawToolCalls = Array.isArray(body.toolCalls) ? body.toolCalls : [];
  const toolCalls = rawToolCalls.map((tc, idx) => ({
    id: typeof tc?.id === 'string' ? tc.id : `correction-${idx}`,
    name: typeof tc?.name === 'string' ? tc.name : 'unknown',
    input: tc?.input && typeof tc.input === 'object' ? tc.input : {},
  }));

  await applyRejection(
    payload.tenantId,
    payload.agentId,
    toolCalls,
    typeof body.reason === 'string' ? body.reason : undefined,
    typeof payload.correctionType === 'string' ? payload.correctionType : undefined,
    {
      nodeType: 'hitl_event',
      refId: payload.actionId ?? randomUUID(),
      agentId: payload.agentId,
      metadata: { correctionType: payload.correctionType },
    },
  );
}
