/**
 * truncate-for-prompt — JSON-aware shape-preserving truncation for unknown
 * runtime values embedded in LLM prompts (recovery, llm_reason context,
 * semantic-validation). Pure module — no service / DB / LLM dependencies
 * (workspace/frame-balance is itself pure: the delimiter grammar and nothing
 * else).
 *
 * Without bounds, recovery prompts that interpolate `stepOutput` from a tool
 * that returned an N-row result set blow the model's context window. This
 * helper recursively shortens long strings, large arrays, and wide objects
 * before falling back to a hard byte-cap, preserving as much structural
 * signal as possible for the LLM.
 *
 * Suffix conventions:
 *   strings → "…[truncated:N more chars]"
 *   arrays  → "[…N more items truncated]"
 *   objects → "[…N more keys truncated]"
 *   final fallback → "…[output truncated to NB]"
 *
 * Every cut here is frame-aware. A value reaching this module can carry text
 * the framer wrapped — a fetched page, a file read, a browser extraction — and
 * a cut that keeps the opening delimiter and drops the closing one leaves the
 * model with an untrusted region that never ends. See workspace/frame-balance.
 */
import { sealFrames, truncateWithinFrames } from '../../workspace/frame-balance';

export function truncateForPrompt(value: unknown, maxBytes: number): string {
  const full = serializeForPrompt(value);
  if (full.length <= maxBytes) return full;

  // Recursive shape-preserving shrink. Bounded depth so adversarial nested
  // structures cannot OOM the truncator itself.
  const shrunk = shrinkValue(
    value,
    /* maxStringChars */ 200,
    /* maxArrayItems */ 10,
    /* maxObjectKeys */ 20,
    /* depth */ 0,
    /* maxDepth */ 8,
  );
  const shrunkStr = serializeForPrompt(shrunk);
  if (shrunkStr.length <= maxBytes) return shrunkStr;

  // Last-resort hard cap. Sealed afterwards rather than cut frame-aware: this
  // slice is through the SERIALISED form, so a closer belongs after the whole
  // thing, and the JSON is already past saving at this point.
  return sealFrames(shrunkStr.slice(0, maxBytes - 32) + `…[output truncated to ${maxBytes}B]`);
}

function shrinkValue(
  v: unknown,
  maxStr: number,
  maxArr: number,
  maxObj: number,
  depth: number,
  maxDepth: number,
): unknown {
  if (depth >= maxDepth) return '[…depth cap]';
  if (typeof v === 'string') {
    if (v.length <= maxStr) return v;
    // The one place a string LEAF is cut, and so the one place a frame framed
    // in place is cut. Closing it here — inside the leaf, before the value is
    // re-serialised — keeps the result valid JSON with a balanced frame in it;
    // appending the closer to the serialised form would put it outside the
    // string it belongs to.
    return truncateWithinFrames(v, maxStr, (dropped) => `…[truncated:${dropped} more chars]`);
  }
  if (Array.isArray(v)) {
    if (v.length <= maxArr) {
      return v.map(x => shrinkValue(x, maxStr, maxArr, maxObj, depth + 1, maxDepth));
    }
    return [
      ...v.slice(0, maxArr).map(x => shrinkValue(x, maxStr, maxArr, maxObj, depth + 1, maxDepth)),
      `[…${v.length - maxArr} more items truncated]`,
    ];
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object);
    const kept = keys.slice(0, maxObj);
    const out: Record<string, unknown> = {};
    for (const k of kept) {
      out[k] = shrinkValue(
        (v as Record<string, unknown>)[k],
        maxStr,
        maxArr,
        maxObj,
        depth + 1,
        maxDepth,
      );
    }
    if (keys.length > maxObj) {
      out['__truncated__'] = `[…${keys.length - maxObj} more keys truncated]`;
    }
    return out;
  }
  // number, boolean, null, undefined — already small
  return v;
}

/**
 * The one way a runtime value becomes prompt text.
 *
 * Exported because any caller deciding "does this value fit the budget?" must use
 * the SAME serialization the bound itself uses. A second, separately written
 * stringify — even one differing only in indentation — puts the two answers on
 * opposite sides of the budget for values near it, so a caller can conclude a
 * value fits while this module has already truncated it.
 */
export function serializeForPrompt(v: unknown): string {
  if (v === undefined) return 'undefined';
  try {
    const out = JSON.stringify(v);
    return out === undefined ? 'undefined' : out;
  } catch {
    return '"[unserializable]"';
  }
}
