// How an engine that runs in another process learns that a call was remembered.
//
// The Codex CLI and the opencode server reach the governed tool seam over
// localhost HTTP as a remote MCP server. Their MCP client carries no model
// call id, and the finished event each engine later emits carries the engine's
// own id, which nothing on the bridge can match. So the bridge cannot tell the
// stream which calls it already remembered — and the stream, unable to tell a
// record that landed from one that failed, remembers every call again.
//
// MCP lets a server attach `_meta` to any tool result, and Codex hands it
// back on the item's `result._meta`. opencode does not: its session wrapper
// flattens the result's text content into the completed state's `output` and
// carries the result's top-level `metadata` key — not `_meta` — into the
// state's `metadata` (packages/opencode/src/session/tools.ts, 1.18.7 and
// main alike). The MCP result schema passes extra top-level keys through, so
// the proxy stamps BOTH places with the same fields, and each adapter reads
// the one its engine forwards. The stamp carries the id the bridge recorded
// under — ALWAYS, so a record the stream does redo lands under the same
// ledger key and stays one row — and the outcome ONLY when the bridge's
// observer answered true. A result without the outcome (a record that failed
// or timed out, a transport failure) reads as unmarked, and the stream
// remembers the call, late. The id alone would not do: it says the call was
// seen, not that its record exists.

/** The id the bridge dispatched and recorded the call under. */
export const DISPATCH_CALL_ID_META = 'liftoff/callId';
/** Present, and true, only when the record existed before the model saw the result. */
export const RECORDED_AT_DISPATCH_META = 'liftoff/recordedAtDispatch';

export interface RememberedStamp {
  dispatchCallId?: string;
  recordedAtDispatch: boolean;
}

/** The stamp to attach to a result's `_meta` (or `metadata`), preserving
 *  whatever a vendor put there EXCEPT the two reserved keys. Those are the
 *  proxy's alone: the id is always its own, and the outcome is written from
 *  the observer's answer and from nothing else. A vendor result that arrived
 *  carrying `liftoff/recordedAtDispatch: true` would otherwise have survived
 *  an observer that answered false — a forged "remembered", and a stream that
 *  skipped a call whose ledger row was never written. */
export function stampRemembered(
  meta: unknown,
  callId: string,
  recordedAtDispatch: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      if (k !== DISPATCH_CALL_ID_META && k !== RECORDED_AT_DISPATCH_META) base[k] = v;
    }
  }
  return {
    ...base,
    [DISPATCH_CALL_ID_META]: callId,
    ...(recordedAtDispatch ? { [RECORDED_AT_DISPATCH_META]: true } : {}),
  };
}

/** Read the stamp off a result's `_meta`, however the engine carried it. */
export function readRememberedStamp(meta: unknown): RememberedStamp {
  if (!meta || typeof meta !== 'object') return { recordedAtDispatch: false };
  const m = meta as Record<string, unknown>;
  const id = m[DISPATCH_CALL_ID_META];
  return {
    ...(typeof id === 'string' && id.length > 0 ? { dispatchCallId: id } : {}),
    recordedAtDispatch: m[RECORDED_AT_DISPATCH_META] === true,
  };
}

/** The stamp's fields on a finished event, when the stamp carries them. */
export function rememberedEventFields(meta: unknown): { dispatchCallId?: string; recordedAtDispatch?: true } {
  const stamp = readRememberedStamp(meta);
  return {
    ...(stamp.dispatchCallId ? { dispatchCallId: stamp.dispatchCallId } : {}),
    ...(stamp.recordedAtDispatch ? { recordedAtDispatch: true as const } : {}),
  };
}
