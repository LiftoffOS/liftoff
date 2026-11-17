/**
 * Approve-with-edits: the reviewer's version of a tool call, applied.
 *
 * The HITL gate answers approve or deny on the call the agent proposed. That is
 * the whole of it, and it is less than the work asks for: a rep who reviews a
 * quote adjusts the price and sends, a manager who reviews a post finalizes the
 * wording and publishes. Approving the agent's draft unchanged and then fixing
 * it somewhere else means the thing that shipped was never the thing that was
 * approved.
 *
 * An edit REPLACES a call's input rather than merging into it. A merge can only
 * add and overwrite, and the edit that matters most is often a removal — a
 * recipient taken off a thread, a paragraph cut, an attachment dropped. A merge
 * cannot express any of those, and would silently keep them.
 */

/** Tool inputs the reviewer rewrote, keyed by the id of the pending tool call
 *  each one replaces. */
export type ApprovedEdits = Record<string, Record<string, unknown>>;

interface CallLike {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The calls to dispatch, with the reviewer's inputs in place of the agent's.
 *
 *  An edit keyed to no pending call is dropped, not dispatched. The key names a
 *  call that is not happening, and there is nothing to send it to; running it
 *  anyway would invent a tool call nobody reviewed. */
export function applyApprovedEdits<T extends CallLike>(
  calls: readonly T[],
  edits: ApprovedEdits | null | undefined,
): T[] {
  if (!edits || Object.keys(edits).length === 0) return [...calls];
  return calls.map((call) => {
    const edited = edits[call.id];
    return edited && typeof edited === 'object' ? { ...call, input: edited } : call;
  });
}

/** Whether an edit actually changes a call, used for logging and for the
 *  ledger. A reviewer who opens the editor and changes nothing has approved,
 *  and recording that as an override would misreport the review. */
export function editedCallIds<T extends CallLike>(
  calls: readonly T[],
  edits: ApprovedEdits | null | undefined,
): string[] {
  if (!edits) return [];
  return calls
    .filter((call) => {
      const edited = edits[call.id];
      if (!edited || typeof edited !== 'object') return false;
      return JSON.stringify(sortKeys(edited)) !== JSON.stringify(sortKeys(call.input));
    })
    .map((call) => call.id);
}

/** Key-order-independent comparison, so a reviewer's editor rewriting the same
 *  values in a different order does not read as an edit. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Reject an edit payload that cannot be an input map, before it reaches
 *  storage. A string or an array here would survive JSONB and fail much later,
 *  at dispatch, with nothing to point at. */
export function parseApprovedEdits(raw: unknown): ApprovedEdits | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: ApprovedEdits = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[id] = value as Record<string, unknown>;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
