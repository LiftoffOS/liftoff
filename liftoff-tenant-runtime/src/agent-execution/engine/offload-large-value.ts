// Workspace offload for oversized intermediate values.
//
// deer-flow manages long-running work by "offloading intermediate results to the
// filesystem" and passing summaries forward instead of raw payloads; agno pairs
// the same idea with compression. The point is that nothing is lost: the model
// carries a short summary plus a path, and re-reads the full data when it
// actually needs a detail the summary dropped.
//
// Without this, an oversized step output has only lossy options — a positional
// slice or a compressed summary — and whatever was dropped is gone for the rest
// of the run. That is what made a 777-record fetch unworkable: the records could
// not be held in context and could not be recovered once cut.
//
// WHERE it writes is load-bearing, and getting it wrong makes the feature worse
// than useless. The file must land somewhere the AGENT can read, which means the
// sandbox workspace reached through `file_write`/`file_read` — not the
// agent-service container's own filesystem. A path in the service container is
// invisible to `file_read` (which resolves against /workspace inside the
// sandbox), so a note pointing there would tell the model to read a file that
// does not exist for it, replacing truncated data with a dead end.
//
// This is the same target the tool-result spill uses (adapter/tool-result-bound.ts
// `spillToolText`), and the two stay separate deliberately: the spill bounds a
// TOOL RESULT inside the dispatch path, where the MCP client is in scope, while
// this bounds a STEP OUTPUT in the workflow engine, where it is not. Merging
// them would mean threading an MCP client into the engine to serve one call site.
//
// Only an agent with the `file` capability has a workspace, so `writer` is null
// for a connector-only agent and this returns null — the caller then keeps its
// compressed summary, which is the honest fallback.
//
// Nothing here needs to clean up after itself. The workspace lives inside the
// per-session sandbox instance and dies with it, so a parked value lasts exactly
// as long as the run that can read it. Writing to the SERVICE container's /tmp
// instead would have needed its own reaper, because that filesystem outlives
// every run on the instance.
//
// Best-effort by construction: a failed or refused write returns null and the
// caller falls back to compression or the deterministic bound. It never throws.

import { logger } from '../../infrastructure/logging';

export function valueOffloadEnabled(): boolean {
  return process.env.VALUE_OFFLOAD_ENABLED === '1';
}

/** Absolute floor. Below this a file is not worth it whatever the budget says —
 *  the summary alone is enough, and a path the model must read costs it a tool
 *  call. */
const MIN_OFFLOAD_CHARS = 8_000;

/** Subdirectory of the workspace holding this run's parked values. Namespaced so
 *  it cannot collide with the agent's own files, and distinct from the
 *  tool-result spill's directory so the two mechanisms stay legible on disk. */
export const OFFLOAD_DIR = 'run-values';

/** Writes one file into the run's workspace, returning false if it could not.
 *  Supplied by the catalog's `writeWorkspaceFile`; null when the agent has no
 *  filesystem. */
export type WorkspaceWriter = (path: string, content: string) => Promise<boolean>;

export interface OffloadResult {
  /** Workspace-relative path the agent reads with `file_read`. Absent when the
   *  value was parked as a DATASET instead, which is the route for an agent
   *  with no filesystem. */
  path?: string;
  /** The dataset the value was parked in, read with `dataset_query`. Absent
   *  when it went to the workspace. */
  datasetId?: string;
  /** Size of the written payload, for the note shown to the model. */
  bytes: number;
}

/** WHERE a parked value is, as a phrase that drops into a sentence.
 *
 *  A phrase rather than a whole sentence so the three notes that name a parked
 *  value keep their own wording: each is tuned to what its reader has to do
 *  next, and the only thing that varies between destinations is the place. */
export function offloadLocation(r: OffloadResult): string {
  return r.path ? `in your workspace at ${r.path}` : `in dataset ${r.datasetId}`;
}

/**
 * Park an oversized value in the run's workspace.
 *
 * Returns null when offload is disabled, the agent has no filesystem, the value
 * fits the caller's budget, it is too small to be worth a file, or the write
 * failed — in every one of those cases the caller keeps using its in-context
 * summary.
 */
export async function offloadLargeValue(
  value: unknown,
  opts: {
    writer: WorkspaceWriter | null;
    /** The run whose datasets an oversized value is parked in when there is no
     *  filesystem to write it to. Omitted by a caller with no run in scope, in
     *  which case the workspace is the only route, as it always was. */
    datasetScope?: { tenantId: string; scopeId: string } | null;
    label: string;
    /** The caller's prompt budget. A value at or under it reaches the model
     *  WHOLE, so parking a copy would attach a note promising detail the model
     *  already has — and spend a workspace write to do it. Offload exists for
     *  what did not fit. */
    budget: number;
  },
): Promise<OffloadResult | null> {
  if (!valueOffloadEnabled()) return null;
  // No filesystem is no longer no parking. A workspace exists only when the
  // agent has a sandbox with the `file` capability, which most do not — so the
  // designed remedy for an oversized value was unavailable to them, and a step
  // that had to read its input WHOLE then had nowhere to go and killed the run.
  // The datasets store is platform-wide and already scoped to the run.
  if (!opts.writer && !opts.datasetScope) return null;

  const serialized = typeof value === 'string' ? value : safeStringify(value);
  if (serialized.length <= opts.budget) return null;
  if (serialized.length < MIN_OFFLOAD_CHARS) return null;

  if (!opts.writer) return parkAsDataset(value, serialized, opts.datasetScope!, opts.label);

  // The label is generated by us (step ids, fixed names), never user input;
  // sanitised anyway so it can only ever be one filename inside the directory.
  // Dots are excluded rather than escaped: this appends its own `.json`, so a dot
  // in the label buys nothing and `..` is the one sequence that would give the
  // path meaning beyond a name.
  const safeLabel = opts.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const path = `${OFFLOAD_DIR}/${safeLabel}.json`;

  try {
    const written = await opts.writer(path, serialized);
    if (!written) {
      logger.warn({ path }, 'value offload write was refused — continuing with the in-context summary');
      return null;
    }
    logger.info(
      {
        metric: 'prompt.value.offloaded',
        label: opts.label,
        bytes: serialized.length,
        path,
      },
      'offloaded an oversized value to the run workspace',
    );
    return { path, bytes: serialized.length };
  } catch (err) {
    // Best-effort: the caller still has a usable in-context summary.
    logger.warn(
      { label: opts.label, err: (err as Error).message },
      'value offload failed — continuing with the in-context summary',
    );
    return null;
  }
}

/** Note appended to a prompt so the model knows the full value exists and how to
 *  reach it. Without this the summary looks like the whole truth. Names the tool
 *  explicitly: a path with no tool named alongside it invites the model to guess
 *  at a shell command it may not have. */
export function offloadNote(result: OffloadResult): string {
  // Two destinations, two tools. A note naming a workspace path for a value
  // parked in a dataset would send the model to `file_read` on a path that does
  // not exist, which reads to it as the value being gone.
  if (!result.path) {
    return (
      `\n[The full value (${result.bytes} characters) is parked as dataset ` +
      `${result.datasetId}. The text above is a summary — call dataset_query with ` +
      `that dataset id if you need a detail it does not contain, and page with ` +
      `limit and cursor rather than asking for all of it at once.]`
    );
  }
  return (
    `\n[The full value (${result.bytes} characters) is saved in your workspace at ` +
    `${result.path}. The text above is a summary — call file_read with that path ` +
    `if you need a detail it does not contain. It was parked because it did not ` +
    `fit, so read it in slices: pass offset and limit, and repeat while hasMore ` +
    `is true. Do not shell out to slice it.]`
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** Park an oversized value in the run's datasets, for an agent with no
 *  filesystem.
 *
 *  Best-effort exactly as the workspace route is: a failure returns null and the
 *  caller keeps its summary, or refuses if the value had to be whole. The store
 *  scopes the row to the run, so it lasts as long as the thing that can read it
 *  and needs no reaper here. */
async function parkAsDataset(
  value: unknown,
  serialized: string,
  scope: { tenantId: string; scopeId: string },
  label: string,
): Promise<OffloadResult | null> {
  try {
    // The BARE-VALUE mode, not the MCP-envelope one. A step output is a value,
    // and sending it as an envelope parked nothing for an object and was refused
    // outright for an array — see parkValueViaBackend for what that cost.
    const { parkValueViaBackend } = await import('../../clients/platform-backend-client');
    const parked = await parkValueViaBackend(
      scope.tenantId,
      value,
      serialized,
      { scopeId: scope.scopeId },
      { label, source: 'step_output', sourceRef: label },
    );
    if (parked.ok !== true) {
      logger.warn({ label, reason: (parked as { reason?: string }).reason ?? 'refused' },
        'value offload to datasets was refused — continuing with the in-context summary');
      return null;
    }
    if (parked.parked.length === 0) {
      // The store accepted the call and parked nothing, which happens when the
      // value holds no records it can shape. Not an error, and not a park.
      logger.warn({ label, reason: 'nothing parked' },
        'value offload to datasets stored no records — continuing with the in-context summary');
      return null;
    }
    const datasetId = parked.parked[0]!.datasetId;
    logger.info(
      { metric: 'prompt.value.offloaded', label, bytes: serialized.length, datasetId, via: 'dataset' },
      'offloaded an oversized value to the run datasets',
    );
    return { datasetId, bytes: serialized.length };
  } catch (err) {
    logger.warn({ label, err: (err as Error).message }, 'value offload to datasets failed — continuing with the in-context summary');
    return null;
  }
}
