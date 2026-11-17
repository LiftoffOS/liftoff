// The usage record every TypeSafe call produces (INV-PB-013).
//
// One row per logical call, written by `ask` before it returns: success (the
// response's counts), drift (the response's counts, success false), or no
// response after every attempt (zero counts, success false). Both reported
// token counts are recorded — output is priced at $0 today and the count is
// still the record.
//
// `provider` is `typesafe`, a value that exists ONLY on usage rows:
// `LLMUsageProvider` widens the row's type without touching `LLMProvider`,
// which also selects provider clients and routing.

import { writeUsageEvent } from '../llm/usage-tracker';
import type { LLMUsageEvent } from '../llm/types';
import { log } from '../infrastructure/logging';

export type TypeSafeUsageOutcome = 'success' | 'drift' | 'no_response';

export interface TypeSafeUsageRecord {
  callId: string;
  attempts: number;
  setId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  outcome: TypeSafeUsageOutcome;
  error?: string;
  vendorRequestId?: string;
  context: { purpose: string; tenantId?: string; agentId?: string; sessionId?: string; invocationId?: string };
}

/** Write the row. Returns false when the write failed: the caller then
 *  returns null rather than using an unrecorded answer. Stricter than the
 *  providers' streaming path on purpose — those calls have already streamed
 *  their answer to a person; a Jev answer has not yet been used. */
export async function recordTypeSafeUsage(record: TypeSafeUsageRecord): Promise<boolean> {
  const event: LLMUsageEvent = {
    timestamp: new Date(),
    provider: 'typesafe',
    model: record.model,
    inputTokens: Math.max(0, Math.floor(record.inputTokens)),
    outputTokens: Math.max(0, Math.floor(record.outputTokens)),
    success: record.outcome === 'success',
    ...(record.error ? { error: record.error } : {}),
    context: Object.fromEntries(
      Object.entries(record.context).filter(([, v]) => typeof v === 'string' && v.length > 0),
    ) as Record<string, string>,
    callId: record.callId,
    attempts: record.attempts,
    ...(record.vendorRequestId ? { vendorRequestId: record.vendorRequestId } : {}),
  };
  try {
    await writeUsageEvent(event);
    return true;
  } catch (err) {
    log.error(
      { err: (err as Error).message, callId: record.callId, setId: record.setId, attempts: record.attempts },
      'TypeSafe usage write failed',
    );
    return false;
  }
}
