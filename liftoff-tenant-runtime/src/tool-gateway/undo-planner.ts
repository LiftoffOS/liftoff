// Turning ledger history into an executable revert.
//
// The pieces have existed separately for a while: conflict policies declare an
// `undoSupportMode`, the action ledger captures a pre-action snapshot, and the
// state fetcher can read an entity's current remote state. Nothing joined them,
// so "undo that" was a thing an operator did by hand in the vendor's UI.
//
// This plans the revert. It does not perform it — planning and applying are
// separated so the plan can be read, and so the honest answer "this cannot be
// undone" arrives before anything is attempted rather than halfway through.
//
// COMPARE-AND-SET IS THE WHOLE SAFETY ARGUMENT. A revert is only safe while the
// remote entity still looks the way the agent left it. If someone edited the
// record afterwards, restoring the pre-action snapshot would silently discard
// their edit — turning an undo into a second, unreviewed write. So every
// operation carries `expectedCurrent`, and an operation whose remote state has
// moved is refused rather than reconciled.
//
// NEVER AN AGENT TOOL. Operator surfaces only, for the same reason the sandbox
// checkpoint verbs are operator-only: a model that can see its own rollback
// treats destructive actions as cheap and loops on them.

import { logger } from '../infrastructure/logging';
import { getAuditLog } from '../audit/service';
import { ConflictPolicyRegistry } from './conflict-policy-registry';
import { stateFetcherRegistry } from './state-fetcher';
import type { UndoSupportMode } from './types';

/** What an undo would do to one entity. */
export interface UndoOperation {
  connector: string;
  entityType: string;
  entityId: string;
  /** The write to issue. `restore_fields` puts the pre-action values back;
   *  `delete_created` removes a record the action created. */
  kind: 'restore_fields' | 'delete_created';
  /** Field values to write back. Empty for `delete_created`. */
  payload: Record<string, unknown>;
  /** The remote state this operation is valid against — the post-action
   *  snapshot. If the live entity no longer matches, the operation is refused,
   *  because the difference is somebody else's work. */
  expectedCurrent: Record<string, unknown> | null;
  /** The policy's version field, when it declares one. A vendor that exposes a
   *  version token gives a cheaper and more reliable check than field
   *  comparison. */
  versionTokenField: string | null;
}

/** An entity that cannot be reverted, and why. Carried alongside the operations
 *  rather than thrown, so a partial plan reports both halves. */
export interface UndoBlocker {
  entityId: string | null;
  reason: string;
}

export type UndoStatus = 'Complete' | 'Partial' | 'Blocked';

export interface UndoPlan {
  auditLogId: string;
  status: UndoStatus;
  operations: UndoOperation[];
  blockers: UndoBlocker[];
  /** The policy's declared ceiling on what undo can achieve here, surfaced so
   *  an operator reading a `Partial` knows whether it is partial because of
   *  drift or because the vendor cannot express the inverse. */
  undoSupportMode: UndoSupportMode;
}

const registry = new ConflictPolicyRegistry();

/** Look up the policy for this action, falling back to the connector's
 *  wildcard entity policy.
 *
 *  The registry matches entity type exactly and returns a restrictive default
 *  on a miss, so its `entityType: '*'` rows — which is how every connector
 *  declares its create policy — are only reachable by asking for `'*'`
 *  literally. Asking twice here keeps that lookup correct without changing
 *  `ConflictPolicyRegistry.get`, whose exact-match behaviour every existing
 *  conflict-detection path depends on. */
function policyFor(connectorType: string, entityType: string, actionType: 'create' | 'update') {
  const specific = registry.get(connectorType, entityType, actionType);
  if (specific.undoSupportMode !== 'none' || entityType === '*') return specific;
  return registry.get(connectorType, '*', actionType);
}

/** Split an aliased tool name (`crm__update_deal`, `mcp__github-a1b2__…`) into
 *  the connector alias and the action. The ledger stores the aliased name; the
 *  policy registry and the state fetcher both key on connector type, which the
 *  caller resolves. */
export function splitLedgerAction(action: string): { alias: string | null; actionType: string } {
  let name = action;
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep < 0) return { alias: null, actionType: rest };
    // Composio/sandbox append a short id to the server key: `github-a1b2`.
    return { alias: rest.slice(0, sep).split('-')[0], actionType: rest.slice(sep + 2) };
  }
  const sep = name.indexOf('__');
  if (sep < 0) return { alias: null, actionType: name };
  return { alias: name.slice(0, sep), actionType: name.slice(sep + 2) };
}

const ID_KEYS = [
  'id', 'entity_id', 'entityId', 'record_id', 'recordId',
  'message_id', 'messageId', 'issue_id', 'issueId', 'object_id', 'objectId',
];

/** Arguments that route the call rather than describe the entity. They are not
 *  fields of the record, so comparing them says nothing about whether the
 *  record drifted — and comparing `undefined` to `undefined` would say it did
 *  not, which is worse than having no basis at all. */
const CONTROL_KEYS = ['entityType', 'entity_type', 'connector', 'actionType', 'action_type'];

/** The entity an action names. Null when the arguments carry no identifier —
 *  a bulk action or a create — which is a blocker, not a guess. */
export function entityIdFromArgs(args: Record<string, unknown>): string | null {
  for (const key of ID_KEYS) {
    const v = args?.[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function isCreate(actionType: string): boolean {
  return /(^|_)(create|add|insert|new)($|_)/.test(actionType.toLowerCase());
}

function isUpdate(actionType: string): boolean {
  return /(^|_)(update|patch|edit|modify|set)($|_)/.test(actionType.toLowerCase());
}

/** Fields the action changed, restored to what they were.
 *
 *  Only the keys the action actually WROTE are restored. Writing the whole
 *  snapshot back would revert fields the action never touched, which is a
 *  bigger change than the one being undone. */
export function buildRestorePayload(
  args: Record<string, unknown>,
  preActionSnapshot: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(args ?? {})) {
    if (ID_KEYS.includes(key)) continue;
    if (!(key in preActionSnapshot)) continue;
    payload[key] = preActionSnapshot[key];
  }
  return payload;
}

/** The fields whose drift decides whether an undo is safe.
 *
 *  The policy's declared set when it has one. Otherwise the fields the action
 *  itself WROTE, which is a real basis rather than a fallback: the question an
 *  undo has to answer is "has anyone touched what we touched", and the action's
 *  own arguments name exactly that. Several policies — every `create` among
 *  them — declare neither a version token nor a comparison set, and without
 *  this they could never be verified and so could never be undone. */
export function comparisonFieldsFor(args: {
  policyFieldComparisonSet: string[];
  writtenFields: string[];
}): string[] {
  if (args.policyFieldComparisonSet.length > 0) return args.policyFieldComparisonSet;
  return args.writtenFields.filter((f) => !ID_KEYS.includes(f) && !CONTROL_KEYS.includes(f));
}

/** True when the live entity still matches the state the action left behind.
 *
 *  Compared over the version token when the vendor exposes one, else over the
 *  comparison fields. With neither, there is no basis for the comparison and
 *  the answer is false — refusing an undo we cannot prove is safe. */
export function remoteStillMatches(args: {
  live: Record<string, unknown>;
  postActionSnapshot: Record<string, unknown> | null;
  versionTokenField: string | null;
  fieldComparisonSet: string[];
  liveVersionToken?: string | undefined;
}): boolean {
  if (!args.postActionSnapshot) return false;

  if (args.versionTokenField) {
    const expected = args.postActionSnapshot[args.versionTokenField];
    const actual = args.live[args.versionTokenField] ?? args.liveVersionToken;
    if (expected === undefined || actual === undefined) return false;
    return String(expected) === String(actual);
  }

  // Every declared field absent from the snapshot means there is nothing to
  // compare against. Left unchecked, `undefined === undefined` would report a
  // match and turn "no evidence" into "verified safe".
  const comparable = args.fieldComparisonSet.filter((f) => f in args.postActionSnapshot!);
  if (comparable.length === 0) return false;

  return comparable.every(
    (f) => JSON.stringify(args.live[f]) === JSON.stringify(args.postActionSnapshot![f]),
  );
}

function statusFor(operations: UndoOperation[], blockers: UndoBlocker[]): UndoStatus {
  if (operations.length === 0) return 'Blocked';
  return blockers.length === 0 ? 'Complete' : 'Partial';
}

/**
 * Plan the revert of one ledger entry.
 *
 * `resolveConnectorType` maps the ledger's connector alias to a connector type.
 * Injected because the mapping lives in the tenant's connector manifests, which
 * this module has no business loading.
 */
export async function planUndo(args: {
  tenantId: string;
  auditLogId: string;
  resolveConnectorType: (alias: string) => Promise<string | null> | string | null;
}): Promise<UndoPlan> {
  const entry = await getAuditLog(args.auditLogId, args.tenantId);
  if (!entry) {
    return {
      auditLogId: args.auditLogId,
      status: 'Blocked',
      operations: [],
      blockers: [{ entityId: null, reason: 'No ledger entry with that id in this workspace.' }],
      undoSupportMode: 'none',
    };
  }

  const blockers: UndoBlocker[] = [];
  const blocked = (reason: string, mode: UndoSupportMode = 'none'): UndoPlan => ({
    auditLogId: args.auditLogId,
    status: 'Blocked',
    operations: [],
    blockers: [{ entityId: entityIdFromArgs(entry.inputArgs ?? {}), reason }, ...blockers],
    undoSupportMode: mode,
  });

  // An action that did not succeed changed nothing to revert. A gated one never
  // ran at all.
  if (entry.outcome !== 'success') {
    return blocked(`The action did not succeed (recorded as "${entry.outcome}") — there is nothing to revert.`);
  }

  const { alias, actionType } = splitLedgerAction(entry.action);
  if (!alias) {
    return blocked(`"${entry.action}" is not a connector action, so it has no external state to restore.`);
  }

  const connectorType = await args.resolveConnectorType(alias);
  if (!connectorType) {
    return blocked(`No connector is bound to "${alias}" in this workspace any more.`);
  }

  const entityId = entityIdFromArgs(entry.inputArgs ?? {});
  if (!entityId) {
    return blocked(
      'The recorded arguments name no single entity, so the inverse cannot be addressed. ' +
      'Bulk actions need a per-entity ledger to be revertible.',
    );
  }

  // The ledger does not store the entity type; the policy registry falls back
  // to its restrictive default when it does not recognise one, which is the
  // behaviour we want for an unknown shape.
  const entityType = (entry.inputArgs?.entityType as string | undefined) ?? '*';
  const policy = policyFor(connectorType, entityType, isCreate(actionType) ? 'create' : 'update');

  if (policy.undoSupportMode === 'none') {
    return blocked(
      `${connectorType} declares no supported undo for this action, so restoring it is not something ` +
      'this platform can do safely.',
      'none',
    );
  }

  // A create is undone by deleting what it made; an update by restoring the
  // fields it changed. Anything else has no inverse we can express.
  let kind: UndoOperation['kind'];
  let payload: Record<string, unknown> = {};
  if (isCreate(actionType)) {
    kind = 'delete_created';
  } else if (isUpdate(actionType)) {
    if (!entry.preActionSnapshot) {
      return blocked(
        'No before-state was captured for this action, so there is nothing to restore it to.',
        policy.undoSupportMode,
      );
    }
    kind = 'restore_fields';
    payload = buildRestorePayload(entry.inputArgs ?? {}, entry.preActionSnapshot);
    if (Object.keys(payload).length === 0) {
      return blocked(
        'None of the fields this action wrote appear in the captured before-state, ' +
        'so there is nothing to put back.',
        policy.undoSupportMode,
      );
    }
  } else {
    return blocked(
      `"${actionType}" has no inverse this platform can express — a delete cannot be undone by writing.`,
      policy.undoSupportMode,
    );
  }

  // Compare-and-set against the LIVE entity. This read is the point of the
  // whole exercise: a plan built from the ledger alone would happily overwrite
  // somebody else's later edit.
  let live: Record<string, unknown>;
  let liveVersionToken: string | undefined;
  try {
    const state = await stateFetcherRegistry.fetchState(
      connectorType,
      async () => ({ accessToken: '' }),
      entityType,
      entityId,
    );
    live = (state.data ?? {}) as Record<string, unknown>;
    liveVersionToken = state.versionToken;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: args.tenantId, connectorType, entityId },
      'undo_planner_state_fetch_failed',
    );
    return blocked(
      `The current state of ${connectorType}/${entityId} could not be read, so it cannot be confirmed ` +
      'that reverting would not overwrite a later change.',
      policy.undoSupportMode,
    );
  }

  const comparisonFields = comparisonFieldsFor({
    policyFieldComparisonSet: policy.fieldComparisonSet,
    writtenFields: Object.keys(entry.inputArgs ?? {}),
  });

  // Say which of the two it is. "It changed" and "we cannot tell whether it
  // changed" are different situations for the operator: the first is a real
  // conflict to reconcile, the second is a gap in what the vendor exposes.
  const comparableFields = comparisonFields.filter(
    (f) => entry.postActionSnapshot != null && f in entry.postActionSnapshot,
  );
  if (!policy.versionTokenField && comparableFields.length === 0) {
    return blocked(
      `Whether ${connectorType}/${entityId} still matches what this action left cannot be established — ` +
      `${connectorType} exposes no version token and the action recorded no comparable fields. ` +
      'Reverting blind could discard a later change.',
      policy.undoSupportMode,
    );
  }

  const matches = remoteStillMatches({
    live,
    postActionSnapshot: entry.postActionSnapshot,
    versionTokenField: policy.versionTokenField,
    fieldComparisonSet: comparisonFields,
    liveVersionToken,
  });

  if (!matches) {
    return blocked(
      `${connectorType}/${entityId} has changed since this action ran. Reverting now would discard ` +
      'whatever changed it. Reconcile by hand.',
      policy.undoSupportMode,
    );
  }

  const operation: UndoOperation = {
    connector: connectorType,
    entityType,
    entityId,
    kind,
    payload,
    expectedCurrent: entry.postActionSnapshot,
    versionTokenField: policy.versionTokenField,
  };

  // `partial` means the vendor cannot fully express the inverse — a restored
  // record keeps a new modified-at, a recreated one gets a new id. Say so
  // rather than reporting a clean Complete the operator would over-trust.
  if (policy.undoSupportMode === 'partial') {
    blockers.push({
      entityId,
      reason:
        `${connectorType} supports only a partial undo: the values are restored, but side effects of ` +
        'the original action (notifications sent, timestamps, audit entries at the vendor) are not.',
    });
  }

  return {
    auditLogId: args.auditLogId,
    status: statusFor([operation], blockers),
    operations: [operation],
    blockers,
    undoSupportMode: policy.undoSupportMode,
  };
}
