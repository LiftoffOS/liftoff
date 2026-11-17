// The output guard, read from platform-backend.
//
// The Chief AI Officer's words reach a person under the same rule as every
// other assistant's: nothing of the platform's inner workings (an
// identifier, a tool or field name, narrated mechanics, the person in the
// third person). The guard is one implementation, in platform-backend
// (common/output-guard.ts), with one rubric, one switch and one audit
// shape; this service reads through its internal route rather than carrying
// a second copy that drifts.
//
// Fail-open, with the local scrub as the floor: a transport error, a slow
// answer or a 5xx leaves this service's own scrubbed text standing, so an
// outage between the two services cannot silence the Chief AI Officer, and
// what has a shape (an id, a connector tool name) never reaches a person
// whatever happened to the call.

import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';
import { scrubIdentifiers } from './identifier-scrub.js';

export interface OutputGuardInput {
  tenantId: string;
  threadId?: string | null;
  /** The exact tool names this turn was offered, removed by the scrub. */
  toolNames?: readonly string[];
}

/** Longer than the reader needs for a whole reply, shorter than a person
 *  waits: past it the scrubbed text goes out. */
const GUARD_TIMEOUT_MS = 12_000;

/**
 * One model text block in, what the person may read out.
 *
 * `text` is whole (the platform-agent loop yields whole blocks), so the
 * guard reads it paragraph by paragraph on its side, fences passed through,
 * the same way a streamed reply is read there.
 */
export async function guardOutgoingText(text: string, input: OutputGuardInput): Promise<string> {
  if (!text.trim()) return text;
  const scrubbed = scrubIdentifiers(text, { toolNames: input.toolNames });
  try {
    const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
    const headers = await getServiceAuthHeaders(baseUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);
    const res = await fetch(`${baseUrl}/api/internal/output-guard`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: input.tenantId,
        speaker: 'caio',
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.toolNames && input.toolNames.length > 0 ? { toolNames: input.toolNames } : {}),
        text: scrubbed,
      }),
      signal: AbortSignal.timeout(GUARD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from platform-backend /api/internal/output-guard`);
    const body = (await res.json()) as { text?: unknown };
    // An empty answer is not a rewrite: the scrubbed text stands.
    return typeof body.text === 'string' && body.text.trim().length > 0 ? body.text : scrubbed;
  } catch (err) {
    log.error(
      { tenantId: input.tenantId, threadId: input.threadId ?? null, error: (err as Error).message },
      'output_guard: read failed, failing open with the scrubbed text',
    );
    return scrubbed;
  }
}
