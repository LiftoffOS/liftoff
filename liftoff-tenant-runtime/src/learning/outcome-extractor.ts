// Outcome Extractor
// Analyzes invocation outcomes and extracts learnings to save as agent memories.
// Runs after invocation completion when there's signal (errors, escalations, retries).
//
// GAP 8.5A FIX: Auto-generated memories have 30-day expiry.
// REVIEW FIX DE-011: Don't store raw tool input (PII risk) — store only tool name + error.

import { memoryService } from '../memory/service';
import { logger } from '../infrastructure/logging';
import type { InvocationOutcome } from '../invocations/types';

const MEMORY_EXPIRY_DAYS = 30;

interface CompletedInvocationData {
  invocationId: string;
  agentId: string;
  objective: string;
  outcome: InvocationOutcome;
  errorMessage?: string | null;
  toolCalls: Array<{ id: string; name: string; input: unknown; output?: unknown; error?: string }>;
}

interface MemoryToSave {
  layer: 'individual';
  scopeKey: string;
  content: string;
  tags: string[];
  ttlDays?: number;
}

const SUCCESS_MEMORY_EXPIRY_DAYS = 30;

// Tool names for persisted invocations are resolved from the trajectory
// recorder buffer (see agent-execution/service.ts#toolCallsForPersistence).
// When that buffer is unavailable at completion time every name falls back to
// the literal 'unknown'. A memory keyed on 'unknown' ("When calling unknown: …",
// "Use this tool sequence: unknown → unknown → unknown") carries no signal and
// reads as noise in the dashboard's Learned Context — so we skip minting one
// rather than store a placeholder.
function isKnownToolName(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && name !== 'unknown';
}

export async function extractAndSaveLearnings(
  tenantId: string,
  agentId: string,
  invocationData: CompletedInvocationData
): Promise<void> {
  try {
    const memories = extractLearnings(invocationData);

    const provenanceSource = {
      nodeType: 'system_event' as const,
      refId: invocationData.invocationId,
      agentId,
      metadata: {
        triggerType: 'outcome_extract',
        outcome: invocationData.outcome,
      },
    };

    for (const mem of memories) {
      const expiresAt = new Date(Date.now() + (mem.ttlDays || MEMORY_EXPIRY_DAYS) * 24 * 60 * 60 * 1000);
      await memoryService.saveMemory({
        tenantId,
        layer: mem.layer,
        scopeKey: mem.scopeKey,
        content: mem.content,
        agentId,
        tags: mem.tags,
        contentClassification: 'internal',
        expiresAt,
        semanticDedup: true, // Improvement 4: increment usage_count when >0.9 similar memory exists
        dedupScopeHint: {
          scopeKeyPrefix: mem.scopeKey.split('-').slice(0, 2).join('-') + '-',
          requireTags: mem.tags.filter(t => ['error-pattern', 'escalation', 'retry-success', 'success-pattern'].includes(t)),
        },
        source: provenanceSource,
      });
    }

    if (memories.length > 0) {
      logger.info({ tenantId, agentId, memoriesSaved: memories.length }, 'Outcome learnings saved to memory');
    }
  } catch (error) {
    logger.warn({ error, tenantId, agentId }, 'Non-fatal: outcome extraction failed');
  }
}

function extractLearnings(invocation: CompletedInvocationData): MemoryToSave[] {
  const memories: MemoryToSave[] = [];

  // Extract error patterns
  // REVIEW FIX DE-011: Don't store raw tool input (PII risk) — store only tool name + error
  // Skip calls whose name is unresolved ('unknown') — see isKnownToolName.
  const failedCalls = invocation.toolCalls.filter(tc => tc.error && isKnownToolName(tc.name));
  if (failedCalls.length > 0) {
    for (const call of failedCalls) {
      memories.push({
        layer: 'individual',
        scopeKey: `error-pattern-${call.name}`,
        content: `When calling ${call.name}: ${call.error}`,
        tags: ['error-pattern', 'auto-extracted', call.name],
      });
    }
  }

  // Extract escalation context
  if (invocation.outcome === 'escalated') {
    memories.push({
      layer: 'individual',
      scopeKey: `escalation-${invocation.invocationId.slice(0, 8)}`,
      content: `Escalated to human during "${invocation.objective.slice(0, 200)}". Reason: ${invocation.errorMessage || 'unknown'}. Consider alternative approaches for similar tasks.`,
      tags: ['escalation', 'auto-extracted'],
    });
  }

  // Extract retry-success patterns (tool failed then succeeded with different params)
  const toolAttempts = new Map<string, { failed: boolean; succeeded: boolean }>();
  for (const call of invocation.toolCalls) {
    const key = call.name;
    if (!toolAttempts.has(key)) {
      toolAttempts.set(key, { failed: false, succeeded: false });
    }
    const entry = toolAttempts.get(key)!;
    if (call.error) {
      entry.failed = true;
    } else {
      entry.succeeded = true;
    }
  }

  for (const [toolName, attempts] of toolAttempts) {
    if (attempts.failed && attempts.succeeded && isKnownToolName(toolName)) {
      memories.push({
        layer: 'individual',
        scopeKey: `retry-success-${toolName}`,
        content: `For ${toolName}: initial attempts failed but a subsequent attempt succeeded. Adjust parameters if first attempt fails.`,
        tags: ['retry-success', 'auto-extracted', toolName],
      });
    }
  }

  // Improvement 3: Learn from successful tool sequences.
  // Only when every tool name resolved — a sequence containing 'unknown' is
  // both meaningless and confusing to display (see isKnownToolName).
  if (invocation.outcome === 'success') {
    const successfulCalls = invocation.toolCalls.filter(tc => !tc.error);
    if (
      successfulCalls.length >= 3 &&
      invocation.toolCalls.every(tc => !tc.error) &&
      successfulCalls.every(tc => isKnownToolName(tc.name))
    ) {
      const toolSequence = successfulCalls.map(tc => tc.name).join(' → ');
      memories.push({
        layer: 'individual',
        scopeKey: `success-sequence-${successfulCalls[0].name}`,
        content: `**Rule:** Use this tool sequence: ${toolSequence}\n**Why:** Completed task without errors\n**Applies when:** Similar tasks requiring ${successfulCalls[0].name}`,
        tags: ['success-pattern', 'auto-extracted', successfulCalls[0].name],
        ttlDays: SUCCESS_MEMORY_EXPIRY_DAYS,
      });
    }
  }

  return memories;
}
