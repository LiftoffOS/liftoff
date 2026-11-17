// Whether a tool result is all of the result, carried as a field.
//
// Both parking mechanisms — the connector dataset (result-dataset.ts) and the
// text spill (adapter/tool-result-bound.ts) — used to state this only in English
// inside the text they handed back. Everything downstream then had to recover it
// by reading prose: observe-result-size searched the text for a directory name,
// and the model had to notice a sentence in the middle of a large blob.
//
// A decision that is only correct over the whole result cannot be made from a
// view of it, and must be able to tell the difference. So the fact travels as
// structure on the result, next to the text rather than inside it.
//
// `_meta` is the MCP-sanctioned place for out-of-band fields on a result: a
// client that does not know the key ignores it, so attaching this cannot change
// how any existing consumer reads content blocks.

import type { ParkedResult } from './result-dataset';

/** Key under `_meta`. Namespaced so it cannot collide with a vendor's own. */
export const COMPLETENESS_META_KEY = 'liftoff/completeness';

export interface ResultCompletenessMeta {
  /** False when the content blocks carry a view and the whole result is parked. */
  complete: boolean;
  /** Where the whole result is, when there is a recoverable copy of it. Absent
   *  on an incomplete result that could not be parked — the remainder is gone,
   *  which is a different and worse state than "parked elsewhere". */
  full?: ParkedResult;
}

type WithMeta = { _meta?: Record<string, unknown> };

/**
 * Attach completeness to a tool result, preserving any `_meta` already present.
 *
 * Returns the same object identity when there is nothing to say (a complete
 * result with no parked copy), so the common path adds no allocation and no
 * field: absence of the key means nobody measured, which is honest, whereas
 * writing `complete: true` everywhere would make an unmeasured result
 * indistinguishable from a verified one.
 */
export function withCompleteness<T>(result: T, meta: ResultCompletenessMeta): T {
  if (meta.complete && !meta.full) return result;
  if (result === null || typeof result !== 'object') return result;
  const target = result as T & WithMeta;
  return {
    ...target,
    _meta: { ...(target._meta ?? {}), [COMPLETENESS_META_KEY]: meta },
  };
}

/** Read completeness off a result. `undefined` means unmeasured — NOT complete. */
export function readCompleteness(result: unknown): ResultCompletenessMeta | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const meta = (result as WithMeta)._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const raw = (meta as Record<string, unknown>)[COMPLETENESS_META_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as { complete?: unknown; full?: unknown };
  if (typeof candidate.complete !== 'boolean') return undefined;
  const full = candidate.full as ParkedResult | undefined;
  return {
    complete: candidate.complete,
    ...(full && typeof full.path === 'string' ? { full } : {}),
  };
}
