// Whether a team could start right now, read before anyone is asked to decide.
//
// The dashboard's build wizard and the template gallery end on one choice,
// Launch Now or Maybe Later, and raise the payment gate off the server's 402
// when Launch Now cannot be honoured. A conversation that ends with the same
// choice has to know the answer BEFORE it asks, because its teams do not exist
// yet when the person decides: the plan is approved first and the teams are
// built minutes later. This read gives that surface the same three facts the
// wizard learns from its 402 and its 409: can the workspace run teams at all
// (in the guard's own words), how many teams are already active (starting
// adds to the subscription's count), and which of the connectors the plan
// needs are not connected.
//
// A read, not a promise: the facts are checked again by setTeamStatus when
// each team actually starts.

import { checkExecutionAllowed } from '../billing/execution-guard';
import { listConnectorsForTenant } from '../connectors/connector-service-client';
import { isConnectedStatus } from '../capability-discovery/credential-scope';
import { internalAgentService } from '../internal-agents/service';
import { getInstalledWorkspaceInstall } from '../agent-chat/slack-adapter/workspace-repository';
import { getInstalledTeamsCount } from '../agent-chat/teams-adapter/repository';
import { log } from '../infrastructure/logging';
import type { Actor } from './actor';

export interface TeamStartReadiness {
  /** Whether a team could start now, as far as the workspace's plan and
   *  balance are concerned. */
  canRun: boolean;
  /** The execution guard's own sentence when it cannot: the same words the
   *  payment gate shows. Absent when it can. */
  reason?: string;
  /** Teams already active in the workspace. */
  activeTeams: number;
  /** Of the connector types asked about, the ones no positively connected
   *  connector exists for. Empty when none were asked about. */
  notConnected: string[];
  /** The chat workspaces the Liftoff app is installed in. A team can post
   *  into one of these, and a person reads a team there, only when it is. */
  chatWorkspaces: { slack: boolean; teams: boolean };
}

export async function teamStartReadiness(
  actor: Actor,
  connectorTypes: readonly string[] = [],
): Promise<TeamStartReadiness> {
  const [guard, teams, connectors, slackInstall, teamsInstalled] = await Promise.all([
    checkExecutionAllowed(actor.tenantId),
    internalAgentService.listAllByTenant(actor.tenantId),
    connectorTypes.length > 0
      ? listConnectorsForTenant(actor.tenantId, actor.accountId).catch((err: Error) => {
          // A connections read that fails answers "not connected" for
          // nothing rather than for everything: the person is told what is
          // known, and the connector guard decides again at start time.
          log.warn({ tenantId: actor.tenantId, error: err.message }, 'team start readiness: connections read failed');
          return null;
        })
      : Promise.resolve([]),
    getInstalledWorkspaceInstall(actor.tenantId).catch(() => null),
    getInstalledTeamsCount(actor.tenantId).catch(() => 0),
  ]);
  const connected = new Set(
    (connectors ?? []).filter((c) => isConnectedStatus(c.status)).map((c) => (c.type ?? '').toLowerCase()),
  );
  const notConnected = connectors === null
    ? []
    : [...new Set(connectorTypes.map((t) => t.toLowerCase()))].filter((t) => !connected.has(t));
  return {
    canRun: guard.allowed,
    ...(guard.allowed ? {} : { reason: guard.reason }),
    activeTeams: teams.filter((t) => t.status === 'active').length,
    notConnected,
    chatWorkspaces: { slack: slackInstall !== null, teams: teamsInstalled > 0 },
  };
}
