// A person is never asked to approve an act this run has already completed.
//
// The duplicate-outward-action guard sits at dispatch, after the approval gate.
// A repeated outbound call therefore reaches the gate first and pauses; only an
// approval can carry it on to the guard, so the question the guard exists to
// answer is put to a person instead, and each approval repeats the act. Asked
// here, before a pause is created, the same lookup answers the model directly
// and no approval request is written.
//
// Same key, same ledger, same wording as the dispatch-time guard. This is that
// check moved earlier, for the one case where the next step would cost a
// person's attention rather than a database read.
//
// Two kinds of call are asked about. A connector tool is keyed the way the
// gateway keys it. A write-class capability is keyed on the operation the
// control plane minted into its handle and on the shape of its arguments — the
// same act key the capability handler claims before dispatch — so a send this
// run already made through either route answers a repeat through the other.
// Any other standard tool writes no ledger row; there is nothing to find and
// this says so by returning null, never by guessing.

import {
  actKeyFor,
  capabilityOperation,
  deriveTarget,
  directOperation,
  isWriteAction,
  CAPABILITY_CONNECTOR,
} from '../action-ledger/target-ref';
import { dispatchNameFor } from '../hitl-enforcement/tool-name-resolution';
import {
  capabilityFamilyOf,
  capabilityHandleNeedsApproval,
  capabilityOperationOf,
  readCapabilityArgs,
} from '../tool-gateway/capability-approval-signal';
import { duplicateReplay, findCompletedDuplicate } from '../tool-gateway/duplicate-outward-action';
import { isStandardTool } from '../tools/standard-tools';

export interface CompletedActRun {
  tenantId: string;
  agentId: string;
  traceId: string;
  invocationId?: string;
}

/**
 * The notice to hand the model when this run already completed the act the
 * call names, or null when the call is new (or cannot be keyed) and may pause.
 */
export async function completedActHold(
  run: CompletedActRun,
  toolName: string,
  args: unknown,
): Promise<string | null> {
  const name = dispatchNameFor(toolName);
  const keyed = isStandardTool(name) ? capabilityAct(name, args) : connectorAct(name, args);
  if (!keyed) return null;

  const input = {
    tenantId: run.tenantId,
    agentId: run.agentId,
    traceId: run.traceId,
    invocationId: run.invocationId,
    actionType: keyed.actionType,
    payload: keyed.payload,
  };
  const hit = await findCompletedDuplicate(input, keyed.target, keyed.actKey);
  if (!hit) return null;
  return duplicateReplay(input, keyed.target, hit).notice ?? null;
}

interface KeyedAct {
  actionType: string;
  payload: Record<string, unknown> | undefined;
  target: ReturnType<typeof deriveTarget>;
  actKey: string;
}

function connectorAct(name: string, args: unknown): KeyedAct | null {
  const [connector, ...rest] = name.split('__');
  const actionType = rest.join('__');
  if (!connector || !actionType) return null;
  if (!isWriteAction(actionType)) return null;
  const payload = (args ?? undefined) as Record<string, unknown> | undefined;
  const target = deriveTarget({ connector, actionType, entityType: '', payload });
  const actKey = actKeyFor(directOperation(connector, actionType), target, payload);
  if (!actKey) return null;
  return { actionType, payload, target, actKey };
}

function capabilityAct(name: string, args: unknown): KeyedAct | null {
  if (name !== 'run_capability') return null;
  const input = (args ?? {}) as Record<string, unknown>;
  if (!capabilityHandleNeedsApproval(input.capabilityId)) return null;
  const operation = capabilityOperationOf(input.capabilityId);
  if (!operation) return null;
  const payload = readCapabilityArgs(input);
  const target = deriveTarget({ connector: CAPABILITY_CONNECTOR, actionType: 'run_capability', payload });
  const actKey = actKeyFor(capabilityOperation(operation, capabilityFamilyOf(input.capabilityId)), target);
  if (!actKey) return null;
  return { actionType: 'run_capability', payload, target, actKey };
}
