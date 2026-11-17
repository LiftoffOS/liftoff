// Generated provenance declarations, after a person has read them.
//
// The generator proposes `idArgs` from each write's own schema, and its output
// is a PROPOSAL: a generator that wrote into the registry directly would put
// its mistakes into production without anybody reading them. This is the
// other half. `scripts/propose-id-args.ts` writes the proposals into
// `generated/reviewed-id-args.json`; the diff is what gets reviewed; and what
// is committed there is what the registry serves. An entry can be narrowed or
// removed by hand, and the script never puts back what a person took out —
// a key it finds is left as it is, and a function under `rejected` is skipped.
//
// Applied at the point the registry serves functions, never written into the
// source: a hand-written `idArgs` on a function always wins, so the generator
// cannot undo a human's correction on the next regeneration.
//
// JSON on disk beside the other generated sets, read the same way, for the
// same reason: it is data, and it ships with the build through the same copy
// step (scripts/copy-generated-assets.js).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConnectorFunction } from '../types.js';

export interface ReviewedIdArgsFile {
  /** connectorType -> functionName -> the reviewed argument names. */
  declarations: Record<string, Record<string, string[]>>;
  /** connectorType -> function names a reviewer said NOT to declare, so the
   *  proposal script does not raise them again. */
  rejected?: Record<string, string[]>;
}

export const REVIEWED_ID_ARGS_PATH = join(__dirname, 'generated', 'reviewed-id-args.json');

let cached: ReviewedIdArgsFile | null = null;

/** The reviewed file, read once. Absent means nothing reviewed — an empty
 *  set, not an error, so a checkout without the file still serves every
 *  hand-written declaration. */
export function loadReviewedIdArgs(): ReviewedIdArgsFile {
  if (cached) return cached;
  cached = existsSync(REVIEWED_ID_ARGS_PATH)
    ? (JSON.parse(readFileSync(REVIEWED_ID_ARGS_PATH, 'utf8')) as ReviewedIdArgsFile)
    : { declarations: {} };
  return cached;
}

/**
 * The registry's functions for one connector, with the reviewed declarations
 * on the writes that have none of their own.
 *
 * Only where a function declares nothing: a hand-written `idArgs` is a
 * person's statement about the tool and outranks anything derived. And only
 * arguments the function actually takes — a reviewed name the schema has since
 * dropped would be a declaration naming nothing, which reads downstream as
 * "undeclared" and hides the drift.
 */
export function applyReviewedIdArgs(connectorType: string, fns: ConnectorFunction[]): ConnectorFunction[] {
  const forType = loadReviewedIdArgs().declarations[connectorType];
  if (!forType) return fns;
  const validated = validatedFor(connectorType, forType, fns);
  if (validated.size === 0) return fns;
  return fns.map((fn) => {
    if ((fn.idArgs ?? []).length > 0) return fn;
    const idArgs = validated.get(fn.name);
    return idArgs ? { ...fn, idArgs } : fn;
  });
}

/** The reviewed names each function actually takes, checked once per
 *  connector. `getConnectorFunctions` is on the execute path and the tool
 *  sets are static per process, so the schema check runs the first time a
 *  connector is served and the per-call work is one lookup per function. */
const validatedByType = new Map<string, Map<string, string[]>>();
function validatedFor(
  connectorType: string,
  forType: Record<string, string[]>,
  fns: ConnectorFunction[],
): Map<string, string[]> {
  const hit = validatedByType.get(connectorType);
  if (hit) return hit;
  const out = new Map<string, string[]>();
  for (const fn of fns) {
    const reviewed = forType[fn.name];
    if (!reviewed || reviewed.length === 0 || (fn.idArgs ?? []).length > 0) continue;
    const accepted = new Set(Object.keys(fn.inputSchema?.properties ?? {}));
    const idArgs = reviewed.filter((a) => accepted.has(a));
    if (idArgs.length > 0) out.set(fn.name, idArgs);
  }
  validatedByType.set(connectorType, out);
  return out;
}

/** Test seam: forget the file and what was validated against it. */
export function _resetReviewedIdArgsForTesting(): void {
  cached = null;
  validatedByType.clear();
}
