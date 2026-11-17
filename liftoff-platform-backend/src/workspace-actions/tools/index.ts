// The workspace-action tool registry and its dispatcher.
//
//   toolsForActor(actor)          the definitions this person may call
//   isWorkspaceActionTool(name)   whether a tool call is ours
//   dispatchWorkspaceAction(...)  run one, and hand the model a string
//   workspaceActionPermits(...)   the role rule for a caller with its own
//                                 matrix (the Insights Manager, the CAIO)
//
// Every write goes through the same three gates before it runs:
//   1. the actor is re-resolved — membership and role read NOW, not at turn
//      start, so a person removed or demoted while a long turn ran cannot
//      complete a write with the authority they had when it began;
//   2. the confirmation handle is verified against this person, this tool
//      and this exact payload (confirmations.ts);
//   3. the handle is consumed on first use, durably, without holding a
//      transaction across the action: claim on idempotency_keys, run with no
//      connection held, settle. A replay returns the first result; a claim
//      that never settled (a crash mid-apply) is refused, not re-run.

import { createHash } from 'crypto';
import { log } from '../../infrastructure/logging';
import { claimIdempotencyKey, settleIdempotencyKey } from '../../infrastructure/idempotency';
import { sanitizeToolResult } from '../../insights/tools/sanitize';
import { PermissionDenied, resolveActor, type Actor } from '../actor';
import { canonicalJson, mintConfirmation, verifyConfirmation } from '../confirmations';
import { hasPermission } from '../permissions';
import { PreviewRefused, type WorkspaceActionRefusal, type WorkspaceActionTool } from './types';
import { reviewTools } from './review';
import { teamsTools } from './teams';
import { activityTools } from './activity';
import { teamTools } from './team';
import { collaboratorTools } from './collaborator';
import { connectionsTools } from './connections';
import { workspaceAdminTools } from './workspace-admin';

export type { WorkspaceActionTool } from './types';

export const WORKSPACE_ACTION_TOOLS: WorkspaceActionTool[] = [
  ...reviewTools,
  ...teamsTools,
  ...activityTools,
  ...teamTools,
  ...collaboratorTools,
  ...connectionsTools,
  ...workspaceAdminTools,
];

const BY_NAME: ReadonlyMap<string, WorkspaceActionTool> = new Map(
  WORKSPACE_ACTION_TOOLS.map((t) => [t.definition.name, t]),
);

export function isWorkspaceActionTool(name: string): boolean {
  return BY_NAME.has(name);
}

/** The role rule for one tool, for callers that keep their own access matrix
 *  and fall through to this for names they do not know. */
export function workspaceActionPermits(toolName: string, role: string): boolean {
  const tool = BY_NAME.get(toolName);
  if (!tool) return false;
  return tool.permission === null || hasPermission(role, tool.permission);
}

/** The tools this actor is offered. A steward tool (a change to an agent)
 *  is listed for the Chief AI Officer's surface alone; an answer-only turn (a
 *  colleague a team brought in for a question) is offered no mutating tool at
 *  all. Both are enforced again at dispatch. */
export function toolsForActor(actor: Actor, opts: { answerOnly?: boolean } = {}): WorkspaceActionTool[] {
  return WORKSPACE_ACTION_TOOLS.filter((t) =>
    (t.permission === null || hasPermission(actor.role, t.permission))
    && stewardAllows(t, actor)
    && !(opts.answerOnly && t.mutating),
  );
}

/** Whether this actor may run this tool as far as its steward is concerned. */
export function stewardAllows(tool: Pick<WorkspaceActionTool, 'steward'>, actor: Pick<Actor, 'surface'>): boolean {
  return tool.steward === undefined || actor.surface === tool.steward;
}

export const STEWARD_REFUSAL = 'A change to an agent is the Chief AI Officer\'s to make. Bring the Chief AI Officer in for it, with the person\'s own words.';

function refusal(reason: string, message: string): WorkspaceActionRefusal {
  return { refused: true, reason, message };
}

/** `maxStringLength` is the tool's own bound. A refusal is a platform string
 *  and takes the default; only a tool's OWN output carries its bound. */
function toModelString(value: unknown, maxStringLength?: number): string {
  const sanitized = sanitizeToolResult(value, maxStringLength);
  return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
}

const CONFIRMATION_NOTE =
  'Show the person exactly what is in preview and ask whether to go ahead. Only when they say yes, call this tool again with the same arguments plus this confirmationId. The handle is good for ten minutes and for this exact change.';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Run one workspace-action tool for the model. Never throws: every failure
 *  is a string the model can read and relay. */
export async function dispatchWorkspaceAction(
  name: string,
  input: Record<string, unknown>,
  actor: Actor,
): Promise<string> {
  const tool = BY_NAME.get(name);
  if (!tool) return toModelString(refusal('unknown_tool', `Unknown tool: ${name}`));

  if (tool.permission !== null && !hasPermission(actor.role, tool.permission)) {
    return toModelString(refusal('forbidden', `This action is not available to the ${actor.role} role.`));
  }
  if (!stewardAllows(tool, actor)) {
    return toModelString(refusal('caio_only', STEWARD_REFUSAL));
  }

  // Writes and review decisions run as the person the workspace knows NOW.
  let effective: Actor = actor;
  if (tool.mutating || tool.reResolveActor) {
    const fresh = await resolveActor({
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      surface: actor.surface,
      via: actor.via,
      client: actor.client,
      credentialId: actor.credentialId,
      // Whether anybody is PRESENT is a property of the turn, not of the
      // membership this re-reads, so it is carried rather than looked up. A
      // tool that refuses when nobody is there reads it off the effective
      // actor, which is this one.
      unattended: actor.unattended,
      // A caller that did not know the person's name (the Insights context
      // carries none) gets it looked up here, so the decision posted back
      // into a thread names who decided.
      displayName: actor.displayName || undefined,
    });
    if (!fresh) {
      return toModelString(refusal('not_a_member', 'This person is no longer a member of the workspace, so nothing was changed.'));
    }
    effective = fresh;
    if (tool.permission !== null && !hasPermission(effective.role, tool.permission)) {
      return toModelString(refusal('forbidden', `This action is not available to the ${effective.role} role.`));
    }
  }

  try {
    if (!tool.mutating) {
      return toModelString(await tool.execute(input, effective), tool.maxResultStringLength);
    }

    const { confirmationId, ...payload } = input;
    if (confirmationId === undefined || confirmationId === null || confirmationId === '') {
      let preview: unknown = payload;
      if (tool.preview) {
        try {
          preview = await tool.preview(payload, effective);
        } catch (err) {
          if (err instanceof PreviewRefused) {
            return toModelString({ ...refusal(err.reason, err.message), ...(err.context !== undefined ? { context: err.context } : {}) });
          }
          throw err;
        }
      }
      return toModelString({
        preview,
        confirmationId: mintConfirmation(effective, name, payload),
        note: CONFIRMATION_NOTE,
      }, tool.maxResultStringLength);
    }

    const verdict = verifyConfirmation(effective, name, payload, String(confirmationId));
    if (!verdict.ok) {
      const messages: Record<typeof verdict.reason, string> = {
        malformed: 'That confirmation is not one this workspace issued. Preview the change again.',
        expired: 'That confirmation has expired. Preview the change again and confirm within ten minutes.',
        wrong_person: 'That confirmation was issued to someone else. Preview the change again.',
        wrong_action: 'That confirmation was issued for a different action. Preview the change again.',
        payload_changed: 'The change differs from what was confirmed. Preview it again so the person sees what will be applied.',
      };
      return toModelString(refusal(`confirmation_${verdict.reason}`, messages[verdict.reason]));
    }

    // Consume the handle on first use, durably, without a transaction across
    // the apply.
    const key = sha256(String(confirmationId));
    const endpoint = `workspace-action:${name}`;
    const requestHash = sha256(canonicalJson(payload));
    const claim = await claimIdempotencyKey(effective.tenantId, key, endpoint, requestHash);
    if (claim === 'conflict') {
      return toModelString(refusal('confirmation_conflict', 'This confirmation was already used for a different change. Preview the change again.'));
    }
    if (claim === 'unresolved') {
      return toModelString(refusal('confirmation_unresolved', 'An earlier attempt to apply this confirmation did not finish. Check the current state of the workspace before trying again; the change is not applied twice.'));
    }
    if (claim !== 'claimed') {
      return toModelString(claim.replay.body);
    }

    let result: unknown;
    try {
      result = await tool.execute(payload, effective);
    } catch (err) {
      const failed = err instanceof PermissionDenied
        ? refusal('forbidden', err.message)
        : refusal('failed', (err as Error).message);
      await settleIdempotencyKey(effective.tenantId, key, endpoint, 500, failed);
      return toModelString(failed);
    }
    await settleIdempotencyKey(effective.tenantId, key, endpoint, 200, result);
    return toModelString(result, tool.maxResultStringLength);
  } catch (err) {
    if (err instanceof PermissionDenied) {
      return toModelString(refusal('forbidden', err.message));
    }
    log.error({ tool: name, tenantId: actor.tenantId, error: (err as Error).message }, 'workspace action failed');
    return toModelString(refusal('failed', (err as Error).message));
  }
}
