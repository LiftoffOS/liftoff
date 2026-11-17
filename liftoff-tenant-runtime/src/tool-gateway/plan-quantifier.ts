// Blast-radius quantifier.
//
// Oversight decides whether a call needs a human by asking what KIND of thing
// it is: a destructive marker in the description, a sensitive-work category, a
// HITL level, a trust classification. Nothing anywhere asks HOW MUCH it
// changes. An agent deleting four hundred records and an agent deleting one
// are indistinguishable to the gate.
//
// This module measures the size. It is pure — no I/O, no clock, no config
// reads — so the whole policy can be read and tested in one place, and so the
// caller can run it in shadow mode without any risk of a side effect.
//
// TWO THINGS IT DELIBERATELY DOES NOT DO:
//
//   * It does not compute a percentage of the population. There is no census
//     of what a tenant HAS. `connector_entity_state` is a subscription
//     watch-list, not an inventory, so an agent watching three deals would
//     read "deleting 1 = 33% of everything". `populationPercent` is therefore
//     always null, and the field exists so the shape does not change when a
//     real denominator arrives.
//   * It does not decide what happens next. It returns a decision and the
//     counts behind it; the caller owns gating, logging and rollout mode.

/** Cutoffs at which a plan stops being routine.
 *
 *  PLACEHOLDERS. They are the starting point for a shadow-mode observation
 *  window, not calibrated values — the target is that the gate fires on under
 *  1% of write batches, which cannot be known until the distribution has been
 *  observed. */
export interface QuantifierThresholds {
  /** Cumulative distinct entities a run may touch before a human is asked. */
  maxEntitiesTouched: number;
  /** Cumulative destructive operations (delete / archive / remove /
   *  deactivate) a run may perform. */
  maxDestructiveOps: number;
  /** Cumulative fields set to empty where the pre-action snapshot had content.
   *  Clearing a field is not flagged as destructive by any name-based rule,
   *  and it is how data disappears without a delete. */
  maxClearedFields: number;
  /** Entities a SINGLE batch may touch. Separate from the cumulative bound
   *  because one call carrying 300 ids is a different shape of mistake from
   *  300 calls carrying one. */
  maxEntitiesPerBatch: number;
}

export const DEFAULT_QUANTIFIER_THRESHOLDS: QuantifierThresholds = {
  maxEntitiesTouched: 25,
  maxDestructiveOps: 10,
  maxClearedFields: 20,
  maxEntitiesPerBatch: 15,
};

/** Totals a run has accumulated so far. Blast radius is cumulative: the
 *  realistic failure is 400 deletes one call at a time, and per-call
 *  inspection can never see it. */
export interface RunningTotals {
  entitiesTouched: number;
  destructiveOps: number;
  clearedFields: number;
}

export interface QuantifiedCall {
  name: string;
  input: Record<string, unknown>;
  /** State captured before the action, when the gateway path captured one.
   *  Absent on every other path — which is a limit on what can be measured,
   *  not a reason to guess. */
  preActionSnapshot?: Record<string, unknown> | null;
  /** What the call does, as the catalog resolved it. A read changes nothing
   *  and so has no blast radius; the gate leaves it out of the measure. A
   *  call whose effect could not be resolved is measured, because a bound
   *  that skips what it cannot classify is not a bound. */
  effect?: 'read' | 'write' | 'spawn';
}

export interface PlanQuantification {
  decision: 'proceed' | 'confirm_required';
  /** Human-readable statements of what was measured and which bound it
   *  crossed. Empty on `proceed`. */
  reasons: string[];
  /** What THIS batch adds. */
  batch: {
    entitiesTouched: number;
    destructiveOps: number;
    clearedFields: number;
  };
  /** Running totals INCLUDING this batch. */
  cumulative: RunningTotals;
  /** Always null: no population census exists. */
  populationPercent: null;
  /** True when no pre-action snapshot was available, so cleared fields could
   *  not be counted and the measurement is a floor rather than a total. */
  snapshotUnavailable: boolean;
}

/** Verbs that destroy or withdraw. Matched against the ACTION portion of the
 *  tool name so a connector prefix cannot mask it. */
const DESTRUCTIVE_VERBS = ['delete', 'archive', 'remove', 'deactivate'];

/** Argument keys that carry entity identifiers. A call naming many of them is
 *  a bulk operation regardless of how the tool describes itself. */
const ID_ARRAY_KEYS = [
  'ids', 'id_list', 'idlist', 'entity_ids', 'entityids', 'record_ids', 'recordids',
  'message_ids', 'messageids', 'issue_ids', 'issueids', 'object_ids', 'objectids',
  'items', 'records', 'entities', 'rows', 'targets', 'keys',
];

const SINGLE_ID_KEYS = [
  'id', 'entity_id', 'entityid', 'record_id', 'recordid', 'message_id', 'messageid',
  'issue_id', 'issueid', 'object_id', 'objectid', 'key', 'target', 'ticket_id', 'ticketid',
];

/** Strip every prefix this platform puts in front of a tool's action, so
 *  matching sees the verb the tool actually performs.
 *
 *  THREE separator conventions exist and all three have to be handled:
 *    `mcp__<server>__<action>`   SDK-prefixed vendor MCP tools
 *    `<connectorAlias>__<action>` our own connector catalog
 *    `<externalAgentName>:<action>` external-agent (A2A) calls
 *
 *  Getting this wrong fails in BOTH directions and both are silent. A raw-name
 *  match leaves the gate inert against every connector tool; a partial match
 *  leaves the prefix in the string, so an agent or alias whose NAME contains
 *  "archive" makes every one of its reads look destructive. */
export function actionPortion(toolName: string): string {
  let name = toolName;
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    name = sep >= 0 ? rest.slice(sep + 2) : rest;
  }
  const underscoreSep = name.lastIndexOf('__');
  if (underscoreSep >= 0) name = name.slice(underscoreSep + 2);
  // External-agent names are `<agentName>:<toolName>`. Take the LAST colon so
  // the whole prefix goes, whatever the agent was called.
  const colonSep = name.lastIndexOf(':');
  if (colonSep >= 0) name = name.slice(colonSep + 1);
  return name.toLowerCase();
}

/** True when the action destroys or withdraws something. */
export function isDestructiveAction(toolName: string): boolean {
  const action = actionPortion(toolName);
  return DESTRUCTIVE_VERBS.some((verb) => action.includes(verb));
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function hasContent(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** How many distinct entities one call names.
 *
 *  Floors at 1: a call with no recognisable identifier still acts on
 *  something, and counting it as zero would make an unbounded loop of
 *  unrecognised calls invisible to a cumulative bound. */
export function countEntities(input: Record<string, unknown>): number {
  let count = 0;
  for (const [rawKey, value] of Object.entries(input ?? {})) {
    const key = rawKey.toLowerCase();
    if (ID_ARRAY_KEYS.includes(key) && Array.isArray(value)) {
      count += value.length;
    } else if (SINGLE_ID_KEYS.includes(key) && value !== undefined && value !== null) {
      count += 1;
    }
  }
  return Math.max(1, count);
}

/** Fields this call sets to empty where the snapshot had content.
 *
 *  Returns 0 when there is no snapshot. That is an honest zero, not an
 *  assertion that nothing is being cleared — `snapshotUnavailable` on the
 *  result says which one it is. */
export function countClearedFields(
  input: Record<string, unknown>,
  snapshot: Record<string, unknown> | null | undefined,
): number {
  if (!snapshot) return 0;
  let cleared = 0;
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!isEmptyValue(value)) continue;
    if (hasContent(snapshot[key])) cleared += 1;
  }
  return cleared;
}

/**
 * Measure a batch of tool calls against the run's totals so far.
 *
 * `calls` is a batch, not a single call: the batched dispatch path is the only
 * place a genuinely multi-entity plan is visible at once, and the per-call path
 * simply passes an array of one.
 */
export function quantifyPlan(
  calls: QuantifiedCall[],
  runningTotals: RunningTotals,
  thresholds: QuantifierThresholds = DEFAULT_QUANTIFIER_THRESHOLDS,
): PlanQuantification {
  let batchEntities = 0;
  let batchDestructive = 0;
  let batchCleared = 0;
  let anySnapshotMissing = false;

  for (const call of calls) {
    const entities = countEntities(call.input);
    batchEntities += entities;
    if (isDestructiveAction(call.name)) {
      // A destructive call against N entities is N destructive operations.
      batchDestructive += entities;
    }
    if (call.preActionSnapshot === undefined || call.preActionSnapshot === null) {
      anySnapshotMissing = true;
    } else {
      batchCleared += countClearedFields(call.input, call.preActionSnapshot);
    }
  }

  const cumulative: RunningTotals = {
    entitiesTouched: runningTotals.entitiesTouched + batchEntities,
    destructiveOps: runningTotals.destructiveOps + batchDestructive,
    clearedFields: runningTotals.clearedFields + batchCleared,
  };

  const reasons: string[] = [];

  if (batchEntities > thresholds.maxEntitiesPerBatch) {
    reasons.push(
      `This single action would affect ${batchEntities} items (limit ${thresholds.maxEntitiesPerBatch}).`,
    );
  }
  if (cumulative.entitiesTouched > thresholds.maxEntitiesTouched) {
    reasons.push(
      `This run would have affected ${cumulative.entitiesTouched} items in total ` +
      `(limit ${thresholds.maxEntitiesTouched}).`,
    );
  }
  if (cumulative.destructiveOps > thresholds.maxDestructiveOps) {
    reasons.push(
      `This run would have deleted or archived ${cumulative.destructiveOps} items in total ` +
      `(limit ${thresholds.maxDestructiveOps}).`,
    );
  }
  if (cumulative.clearedFields > thresholds.maxClearedFields) {
    reasons.push(
      `This run would have emptied ${cumulative.clearedFields} fields that had content ` +
      `(limit ${thresholds.maxClearedFields}).`,
    );
  }

  if (reasons.length > 0 && anySnapshotMissing) {
    // Say so on the card. Otherwise "0 fields emptied" reads as a measurement
    // when it is really an absence of one.
    reasons.push(
      'Emptied fields could not be counted for every action in this batch — no before-state was captured.',
    );
  }

  return {
    decision: reasons.length > 0 ? 'confirm_required' : 'proceed',
    reasons,
    batch: {
      entitiesTouched: batchEntities,
      destructiveOps: batchDestructive,
      clearedFields: batchCleared,
    },
    cumulative,
    populationPercent: null,
    snapshotUnavailable: anySnapshotMissing,
  };
}
