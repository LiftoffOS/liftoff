// Starting the agents a plan built, when the person chose to.
//
// The builder ends on Launch Now or Maybe Later and acts at once, because the
// team exists when the person clicks. A plan approved in conversation is built
// minutes later, one Cloud Task per spec, so the person's Launch Now is kept
// on the plan and honoured here by the task that finishes last. Each team is
// started as the person who approved, through the same workspace action the
// dashboard and the Chief AI Officer use (team_status, preview then confirm,
// the confirmation minted and consumed server-side because the consent was
// the approval), so the execution guard, the required-connector guard, the
// activation rate limit, the role rule and the audit row all apply exactly
// as they would to a click.
//
// Nothing is retried and nothing is inferred: a team that cannot start stays a
// draft and its reason, in the workspace's own words, goes into the notice.
// Never throws — provisioning has already succeeded.

import { log } from '../infrastructure/logging.js';
import { dispatchWorkspaceActionAs } from './tools/remote-workspace-actions.js';

export type TeamLaunchOutcome =
  | { started: true }
  | { started: false; reason: string; message: string };

/** The outcome per spec id. */
export type TeamLaunchOutcomes = Map<string, TeamLaunchOutcome>;

interface LaunchableSpec {
  specId?: unknown;
  name?: unknown;
  provisioningStatus?: unknown;
  internalAgentId?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Start one team as the approver. The dispatcher answers a preview with a
 *  confirmation handle on the first call and applies on the second. */
async function startOne(
  caller: { tenantId: string; accountId: string },
  teamId: string,
): Promise<TeamLaunchOutcome> {
  const as = { tenantId: caller.tenantId, accountId: caller.accountId, role: 'member' as const };
  const preview = await dispatchWorkspaceActionAs('team_status', { teamId, status: 'active' }, as);
  if (!isRecord(preview)) {
    return { started: false, reason: 'unavailable', message: 'The workspace could not be reached to start it.' };
  }
  if (preview.refused === true) {
    return { started: false, reason: String(preview.reason ?? 'refused'), message: String(preview.message ?? 'It could not be started.') };
  }
  if (typeof preview.confirmationId !== 'string' || !preview.confirmationId) {
    return { started: false, reason: 'unavailable', message: String(preview.error ?? 'The workspace could not be reached to start it.') };
  }
  const applied = await dispatchWorkspaceActionAs(
    'team_status',
    { teamId, status: 'active', confirmationId: preview.confirmationId },
    as,
  );
  if (!isRecord(applied)) {
    return { started: false, reason: 'unavailable', message: 'The workspace could not be reached to start it.' };
  }
  if (applied.updated === true) return { started: true };
  if (applied.refused === true) {
    return { started: false, reason: String(applied.reason ?? 'refused'), message: String(applied.message ?? 'It could not be started.') };
  }
  return { started: false, reason: 'unavailable', message: String(applied.error ?? 'It could not be started.') };
}

/**
 * Start every team the plan built, as the approver. Specs without a created
 * team (failed, skipped) are not attempted and get no outcome.
 */
export async function startProvisionedTeams(input: {
  tenantId: string;
  planId: string;
  approvedBy: string;
  specs: readonly LaunchableSpec[];
}): Promise<TeamLaunchOutcomes> {
  const outcomes: TeamLaunchOutcomes = new Map();
  for (const spec of input.specs) {
    const specId = typeof spec.specId === 'string' ? spec.specId : null;
    const teamId = typeof spec.internalAgentId === 'string' ? spec.internalAgentId : null;
    if (!specId || !teamId || spec.provisioningStatus !== 'completed') continue;
    let outcome: TeamLaunchOutcome;
    try {
      outcome = await startOne({ tenantId: input.tenantId, accountId: input.approvedBy }, teamId);
    } catch (err) {
      outcome = { started: false, reason: 'unavailable', message: 'The workspace could not be reached to start it.' };
      log.warn(
        { event: 'provisioning_launch_failed', planId: input.planId, tenantId: input.tenantId, teamId, error: (err as Error).message },
        'Could not start a provisioned agent',
      );
    }
    outcomes.set(specId, outcome);
    log.info(
      {
        event: 'provisioning_launch',
        planId: input.planId,
        tenantId: input.tenantId,
        teamId,
        started: outcome.started,
        ...(outcome.started ? {} : { reason: outcome.reason }),
      },
      outcome.started ? 'Started a provisioned agent as the approver' : 'A provisioned agent could not be started',
    );
  }
  return outcomes;
}
