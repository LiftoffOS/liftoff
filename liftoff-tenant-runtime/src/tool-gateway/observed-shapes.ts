// Response shapes, learned from real traffic rather than guessed.
//
// `returnsIds` cannot be generated from an input schema — a response shape is
// not in there — and a guessed path is worse than no declaration at all,
// because the connector then LOOKS covered while every write it judges has
// nothing able to provenance it. That is the failure mode the whole two-tier
// design exists to avoid, so the precision layer has to come from somewhere
// real.
//
// It comes from here. Every successful read that passes the gateway door
// contributes the SHAPE of what it returned — the id-bearing paths, never the
// values — and those paths become proposals a person reviews.
//
// WHAT IS RECORDED AND WHAT IS NOT. Paths and nothing else: `items[].id`,
// `data.thread.id`. Never a value, never a count, never a fragment of content.
// A shape store that held values would be a second copy of customer data with
// none of the retention, scoping or deletion the first copy has, built for the
// convenience of a code generator. The paths alone are what a declaration
// needs.
//
// It observes on the same door the heuristic floor runs at, so it sees every
// connector — Composio, native, vendor-hosted MCP, custom MCP. The Google trio
// is the case that motivated it: their reads have no canonical shape, no
// translateOutput, and therefore nothing anybody can honestly declare against
// until a real response has been looked at.

/** How many distinct paths to keep per tool. A response with more id-bearing
 *  paths than this is a response nobody is going to declare by hand anyway. */
const MAX_PATHS_PER_TOOL = 40;

/** Bounded walk, same reasoning as the identifier floor: a ten-thousand-row
 *  listing must cost a bounded amount of work. */
const MAX_NODES = 5_000;
const MAX_DEPTH = 8;

/** Above this, a key is data. Field names in real vendor responses are short;
 *  the identifiers that get used as map keys are not. */
const MAX_FIELD_NAME_LENGTH = 40;

const ID_KEY = /(^|_)(id|ids|iid|gid|uid|uuid|guid|key|number|num|sha|slug|ref|ts|pk)$|(Id|Ids|Iid|Gid|Uid|Uuid|Guid|Key|Number|Num|Sha|Slug|Ref|Ts)$/;

/** toolName -> the id-bearing paths seen in its results, each with how many
 *  reads returned it since the last drain. A count, not a set: the table's
 *  `observed_count` is meant to say how many reads returned a path, and a set
 *  collapsed a hundred reads in one interval into one while a drain that
 *  never cleared re-wrote the same observation every interval forever. */
const observed = new Map<string, Map<string, number>>();

/** toolName -> what a record at this tool's paths IS, from the read tool's
 *  own catalog entry (`get_thread` → `thread`). Kept beside the counts so
 *  the persisted shape carries the type the gate matches on, and no person
 *  has to name it afterwards. */
const entityTypes = new Map<string, string>();

/**
 * The id-bearing paths in a response, in `returnsIds` path syntax.
 *
 * `[]` marks an array hop, so the path reads the way a declaration is written
 * and can be pasted into one without translation. A path that has to be
 * rewritten before it can be used is a path somebody will rewrite wrongly.
 */
/** A key a declaration could name, as opposed to one that is itself data.
 *
 *  Deliberately syntactic and slightly strict. The reader splits paths on '.',
 *  so a key containing one is unaddressable no matter what it means; a key that
 *  does not start like an identifier, or that is longer than any field name in
 *  practice, is an id far more often than it is a field.
 *
 *  It does not catch everything: a document id that happens to look like a word
 *  passes, and the per-tool path cap remains the backstop for that. What it does
 *  is stop a map keyed by identity from being mistaken for a shape. */
function isFieldName(key: string): boolean {
  return key.length <= MAX_FIELD_NAME_LENGTH && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key);
}

export function idBearingPaths(result: unknown): string[] {
  const paths = new Set<string>();
  let nodes = 0;

  const walk = (node: unknown, depth: number, path: string): void => {
    if (nodes >= MAX_NODES || depth > MAX_DEPTH || paths.size >= MAX_PATHS_PER_TOOL) return;
    nodes++;

    if (Array.isArray(node)) {
      // One element is enough: the shape of a list is the shape of its members,
      // and walking ten thousand of them learns the same thing ten thousand
      // times.
      if (node.length > 0) walk(node[0], depth + 1, `${path}[]`);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // A key that is DATA rather than a field name ends the walk.
        //
        // This store proposes `returnsIds` paths, and `readIdPath` resolves them
        // by splitting on '.' and matching literal keys, with `[]` as its only
        // wildcard. So a path through a map keyed by identity is not a path it
        // can ever read: the key is different in the next response, and a key
        // containing a '.' cannot be addressed at all because the reader splits
        // there. Recording one produces a proposal nobody can declare.
        //
        // Google Docs is the case that showed it. `lists` is keyed by
        // `kix.<random>` per document, and one document contributed twenty paths
        // like `lists.kix.105io4v78wa9.listProperties.nestingLevels[].startNumber`
        // — undeclarable, different every time, and enough to fill this tool's
        // whole path budget while `documentId`, the one real proposal, waited
        // behind them. They also put a fragment of the customer's document into
        // a store whose entire contract is paths and never values.
        if (!isFieldName(k)) continue;
        walk(v, depth + 1, path ? `${path}.${k}` : k);
      }
      return;
    }
    const leaf = path.split('.').pop() ?? '';
    const key = leaf.replace(/\[\]$/, '');
    if (ID_KEY.test(key) && (typeof node === 'string' || typeof node === 'number')) {
      paths.add(path);
    }
  };

  walk(result, 0, '');
  return [...paths].sort();
}

/**
 * Record what a read returned, as paths.
 *
 * In-process and unbounded in time but bounded in size, because this is a
 * proposal generator rather than a store of record: a runtime that restarts
 * loses nothing that matters, since the next read observes the same shape
 * again.
 */
export function observeReadShape(
  toolName: string,
  result: unknown,
  tenantId?: string,
  /** The entity the read tool is declared to return, when its catalog entry
   *  says. An observed path under a typed read is a typed declaration; one
   *  under an untyped read is recorded as `record`, which is what the floor
   *  already gives it. */
  entityType?: string,
): void {
  const paths = idBearingPaths(result);
  if (paths.length === 0) return;
  // Keyed by tenant as well as tool. A response shape is a fact about the
  // tool, but a CUSTOM MCP server's tools belong to the workspace that
  // connected it — nobody else can see them, and a path learned in one tenant
  // must not be proposed as another's. Without the tenant this store cannot
  // say which workspace a proposal belongs to, and the table it drains into is
  // tenant-scoped.
  const key = tenantId ? `${tenantId}\u0000${toolName}` : toolName;
  if (entityType && !entityTypes.has(key)) entityTypes.set(key, entityType);
  const counts = observed.get(key) ?? new Map<string, number>();
  for (const p of paths) {
    const seen = counts.get(p);
    if (seen === undefined && counts.size >= MAX_PATHS_PER_TOOL) continue;
    counts.set(p, (seen ?? 0) + 1);
  }
  observed.set(key, counts);
}

/** Everything observed so far, for the proposal report.
 *
 *  Keys are `tool` for an unattributed observation and `tenant\u0000tool` for
 *  an attributed one; `observedShapesByTenant` splits them. */
export function observedShapes(): Record<string, string[]> {
  return Object.fromEntries([...observed].map(([k, v]) => [k, [...v.keys()].sort()]));
}

/** How many reads returned each path since the last drain, per tool, for
 *  the flush that persists them. A snapshot: what arrives while the flush is
 *  in flight is counted on top and survives the drain. */
export function pendingShapeCountsForTenant(tenantId: string): Record<string, Record<string, number>> {
  const prefix = `${tenantId}\u0000`;
  const out: Record<string, Record<string, number>> = {};
  for (const [k, v] of observed) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = Object.fromEntries(v);
  }
  return out;
}

/** The entity type each observed tool returns, where its catalog entry said. */
export function observedEntityTypesForTenant(tenantId: string): Record<string, string> {
  const prefix = `${tenantId}\u0000`;
  const out: Record<string, string> = {};
  for (const [k, v] of entityTypes) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/** Take a persisted snapshot back out of the pending counts — by the amounts
 *  persisted, never by clearing, so a read observed during the flush is not
 *  lost with it. A path drained to zero is forgotten until the next read. */
export function drainObservedShapes(tenantId: string, persisted: Record<string, Record<string, number>>): void {
  for (const [tool, paths] of Object.entries(persisted)) {
    const key = `${tenantId}\u0000${tool}`;
    const counts = observed.get(key);
    if (!counts) continue;
    for (const [path, n] of Object.entries(paths)) {
      const left = (counts.get(path) ?? 0) - n;
      if (left > 0) counts.set(path, left);
      else counts.delete(path);
    }
    if (counts.size === 0) observed.delete(key);
  }
}

/** Every tenant with observations waiting. */
export function observedTenants(): string[] {
  const out = new Set<string>();
  for (const k of observed.keys()) {
    const sep = k.indexOf('\u0000');
    if (sep > 0) out.add(k.slice(0, sep));
  }
  return [...out];
}

/** Test seam: the store is process-global. */
export function _resetObservedShapesForTesting(): void {
  observed.clear();
  entityTypes.clear();
}
