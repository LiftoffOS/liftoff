// The heuristic identifier floor: provenance coverage for every connector, on
// day one, without a single hand-written declaration.
//
// WHY THE HAND-WRITTEN APPROACH WAS REJECTED. Precision declarations
// (`idArgs` / `returnsIds`) are good signal and they do not scale. Three
// connectors were declared by hand in a full session; there are ~147. Worse,
// hand-declaration structurally CANNOT cover the connectors that matter most:
// `github` has zero registry functions because it is a vendor-hosted MCP server
// whose tools are enumerated at runtime, so there is no row to hang a
// declaration on — and github is the connector the code-reviewer pilot actually
// uses. A coverage model that omits the pilot's own connector is not a coverage
// model.
//
// So the read side takes the same two-tier shape as the rest of this estate:
//
//   FLOOR      a heuristic that runs at the ONE gateway door. Every connector
//              passes through it — Composio, native, vendor-hosted MCP, custom
//              MCP — because the door is where results and arguments actually
//              are, rather than where a catalog happens to describe them.
//   PRECISION  declarations, GENERATED from schemas and observed traffic rather
//              than written by hand, layered on top where they exist.
//
// The two are kept apart in the telemetry on purpose. A shadow metric that
// mixes a precise signal with a noisy one is worse than either alone: the
// precise number stops being trustworthy and the noisy number stops being
// actionable. `provenance.would_block` remains declarations-only;
// `provenance.floor_would_block` is this.
//
// CONSERVATIVE IN WHAT IT FLAGS, GENEROUS IN WHAT IT REMEMBERS. Recording an
// extra identifier from a read costs a set entry and can only ever prevent a
// false flag. Flagging an extra write argument costs somebody's attention, and
// a floor that cries wolf is one that gets switched off — which would take the
// precision layer with it.

/** Keys whose VALUE is plausibly a record identifier.
 *
 *  BOTH spellings, and the camelCase half is not an afterthought: `threadId`,
 *  `messageId`, `fileId` and `documentId` are how most vendors name an identity,
 *  and a pattern anchored only on `_id` or a word boundary matches none of them
 *  — there is no boundary between `d` and `I`. Written that way first, this
 *  missed every camelCase identity in the estate while looking correct, and the
 *  test that caught it is the one that pasted a real Gmail response shape in.
 *
 *  Matched on the key NAME because that is the one signal available across
 *  every vendor's response. A value-only heuristic would have to call every
 *  short string an id, which is most strings. */
const ID_KEY = /(^|_)(id|ids|iid|gid|uid|uuid|guid|key|number|num|sha|slug|ref|ts|pk)$|(Id|Ids|Iid|Gid|Uid|Uuid|Guid|Key|Number|Num|Sha|Slug|Ref|Ts)$/;

/** Values that can be an identifier. Deliberately narrow: an identifier is
 *  short, has no whitespace, and is not prose. A 400-character string keyed
 *  `id` is a body somebody named badly. */
function looksLikeIdentifier(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && Number.isInteger(value);
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > 128) return false;
  if (/\s/.test(v)) return false;
  // A URL is a locator, not an identity, and treating one as an id means a
  // link in a result vouches for a write to whatever it points at.
  if (/^https?:\/\//i.test(v)) return false;
  return true;
}

/** Bound on how much of a result to walk. A listing of ten thousand rows should
 *  cost a bounded amount of work, and the identifiers that matter are near the
 *  top of it. */
const MAX_NODES = 5_000;
const MAX_DEPTH = 8;

/**
 * Every identifier-shaped value in a payload, keyed by an id-ish name.
 *
 * Used both ways round: on a READ result it is what the run has now seen, and
 * on a WRITE payload it is what the call is about to act on. One function so
 * the two sides cannot disagree about what counts as an identifier — a
 * mismatch there would flag writes against a set built by different rules.
 */
export function spotIdentifiers(payload: unknown): string[] {
  const found = new Set<string>();
  let nodes = 0;

  const walk = (node: unknown, depth: number, keyName: string | null): void => {
    if (nodes >= MAX_NODES || depth > MAX_DEPTH) return;
    nodes++;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, keyName);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, depth + 1, k);
      }
      return;
    }
    if (keyName && ID_KEY.test(keyName) && looksLikeIdentifier(node)) {
      found.add(String(node).trim());
    }
  };

  walk(payload, 0, null);
  return [...found];
}

/**
 * Identifier-shaped write arguments this run has not seen.
 *
 * Returns `[]` when the payload names no identifier at all — a create, most
 * often, and a call that names nothing cannot be acting on the wrong thing.
 *
 * Note what is NOT done here: no attempt to decide whether an unseen identifier
 * is WRONG. The floor reports that a write named something the run never read,
 * which is a fact. Whether that is a defect depends on the trigger payload, the
 * connector and the shape of the job, and a heuristic that guessed at it would
 * be asserting more than it knows.
 */
export function unseenWriteIdentifiers(
  payload: unknown,
  seen: ReadonlySet<string>,
): string[] {
  return spotIdentifiers(payload).filter((id) => !seen.has(id));
}
