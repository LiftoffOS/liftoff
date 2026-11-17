// Values a tool returned that were lifted out of the model's copy and belong to
// the person instead.
//
// `extractEgressOnly` has always computed these — a signed download URL, a
// payment link, a one-time token — replaced them with a placeholder in what the
// model sees, and then DROPPED them. The guardrail logged the paths and threw
// the values away, so the renderer built for them (`HostDeliveredFields`) had
// nothing to render and no producer to render it from. Lifting a value nobody
// can deliver is not a side channel, it is deletion with extra steps.
//
// WHY AN IN-PROCESS STORE AND NOT `_meta` ON THE RESULT. `_meta` is the
// MCP-sanctioned place for out-of-band fields, and `result-completeness.ts`
// uses it correctly — but completeness is a FACT ABOUT the result and safe for
// the model to read, while these are values the model must never see. A result
// object carrying them is one `JSON.stringify(result)` away from the context it
// was lifted out of, and the bridge already has such a fallback in
// `extractToolErrorText`. So they travel beside the result, never inside it.
//
// WHY THE GATEWAY AND NOT AN ADAPTER. The same reason the provenance gate lives
// here: `claude-agent-sdk` reaches tools through the in-process MCP server and
// never touches `mcp-bridge`, so anything implemented in the bridge covers every
// engine but that one. Recorded where `applyOutputGuardrails` runs, this is
// engine-neutral by construction rather than by a list somebody maintains.

/** Per invocation, so one runaway turn cannot grow this without bound. A turn
 *  that lifted more than this many fields is not a turn whose remaining fields
 *  a person was going to read. */
const MAX_ENTRIES_PER_INVOCATION = 50;

/** Invocations are evicted after this long without a write, so a process that
 *  serves thousands of runs does not accumulate their values forever. Shorter
 *  than the provenance store's window on purpose: these are secret-shaped by
 *  definition, so holding them longer than the turn that produced them is a
 *  cost with no benefit. */
const INVOCATION_TTL_MS = 5 * 60 * 1000;

/** One tool call's worth of lifted values. */
export interface HostDeliveredEntry {
  /** The tool as the model named it, so the surface can say where it came from. */
  toolName: string;
  /** Result path → value, exactly as `extractEgressOnly` lifted them. */
  fields: Record<string, unknown>;
}

interface InvocationEntry {
  entries: HostDeliveredEntry[];
  lastTouchedAt: number;
}

const byInvocation = new Map<string, InvocationEntry>();

function sweep(now: number): void {
  for (const [id, entry] of byInvocation) {
    if (now - entry.lastTouchedAt > INVOCATION_TTL_MS) byInvocation.delete(id);
  }
}

/**
 * Record what a tool call delivered to the surface.
 *
 * A no-op without an invocation id: a call with nowhere to deliver to has no
 * surface waiting on it, and keying an entry under `undefined` would pool
 * unrelated runs' values into one bucket that the wrong turn could drain.
 */
export function recordHostDelivered(args: {
  invocationId: string | undefined;
  toolName: string;
  fields: Record<string, unknown>;
}): void {
  const { invocationId, toolName, fields } = args;
  if (!invocationId || Object.keys(fields).length === 0) return;

  const now = Date.now();
  sweep(now);
  const entry = byInvocation.get(invocationId) ?? { entries: [], lastTouchedAt: now };
  entry.lastTouchedAt = now;
  if (entry.entries.length < MAX_ENTRIES_PER_INVOCATION) {
    entry.entries.push({ toolName, fields });
  }
  byInvocation.set(invocationId, entry);
}

/**
 * Take everything waiting for this invocation, leaving nothing behind.
 *
 * DRAINING, not reading. These are delivered exactly once — the surface either
 * receives them on this frame or they are gone, which is the right failure for
 * a value that should not sit in memory. It also means a turn that emits a
 * frame per tool call cannot re-send an earlier call's values on a later one.
 */
export function drainHostDelivered(invocationId: string | undefined): HostDeliveredEntry[] {
  if (!invocationId) return [];
  const entry = byInvocation.get(invocationId);
  if (!entry) return [];
  byInvocation.delete(invocationId);
  return entry.entries;
}

/** Test seam: the store is process-global. */
export function _resetHostDeliveredForTesting(): void {
  byInvocation.clear();
}
