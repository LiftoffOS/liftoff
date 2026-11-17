import { withTenantScope } from '../infrastructure/database';
import { internalAgentService } from '../internal-agents/service';
import { externalAgentService } from '../external-agents/service';
import { listMcpTokens } from '../claude-code-proxy/service';
import { listOauthConnectedTools } from '../oauth/connected-tools';
import { listConnectionProfiles } from './connection-profiles';
import { isDevProxyEnabled, listCredentials as listDevProxyCredentials, type DeveloperProxyCredential } from '../claude-code-proxy/developer-proxy-client';
import { personAssignmentsService } from '../person-assignments/service';
import { getHoursSaved30d } from './hours-saved';
import { assembleWorkforce } from './assembly';
import type { WorkforceResponse } from './assembly';

export type { WorkforceClaudeCodeKey, WorkforceResponse } from './assembly';

interface AgentActivityEntry {
  timestamp: string;
  action: string;
}

async function getLatestActivityByAgent(tenantId: string): Promise<Record<string, AgentActivityEntry>> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT DISTINCT ON (entity_id) entity_id, created_at AS last_activity, action
     FROM (
       SELECT internal_agent_id AS entity_id, created_at, action
       FROM agent_audit_logs
       WHERE tenant_id = $1 AND internal_agent_id IS NOT NULL
         AND action NOT IN (
           -- lifecycle wrappers: too generic, surface the specific tool call instead
           'agent_invocation_started', 'agent_invocation_completed',
           'agent_execution',
           -- internal infrastructure: not user-facing
           'runtime_status_changed', 'sdk_pre_compact', 'sdk_post_compact',
           'cleanup_completed', 'created_from_internal_agent',
           'retried', 'compensated', 'escalated', 'discarded',
           'correction_failed', 'correction_timeout'
         )
       UNION ALL
       SELECT external_agent_id AS entity_id, created_at, action
       FROM agent_audit_logs
       WHERE tenant_id = $1 AND external_agent_id IS NOT NULL
         AND action NOT IN (
           'agent_invocation_started', 'agent_invocation_completed',
           'agent_execution',
           'runtime_status_changed', 'sdk_pre_compact', 'sdk_post_compact',
           'cleanup_completed', 'created_from_internal_agent',
           'retried', 'compensated', 'escalated', 'discarded',
           'correction_failed', 'correction_timeout'
         )
     ) sub
     ORDER BY entity_id, created_at DESC`,
    [tenantId],
  ));
  return Object.fromEntries(
    result.rows.map(r => [
      r.entity_id as string,
      { timestamp: (r.last_activity as Date).toISOString(), action: r.action as string },
    ])
  );
}

export async function getWorkforce(tenantId: string, actorAccountId?: string): Promise<WorkforceResponse> {
  const [internalAgents, externalAgents, mcpTokens, personnel, activityMap, devProxyCredentials, hoursSavedLast30Days, oauthTools, profiles] =
    await Promise.all([
      internalAgentService.listAllByTenant(tenantId),
      externalAgentService.listAllByTenant(tenantId),
      listMcpTokens(tenantId),
      personAssignmentsService.listPersonnelWithAssignments(tenantId),
      getLatestActivityByAgent(tenantId),
      isDevProxyEnabled()
        // userId is required by developer-proxy's service-call auth (x-user-id);
        // with all=true it does not filter the result, it only names the actor.
        ? listDevProxyCredentials({ tenantId, all: true, userId: actorAccountId }).catch(() => [] as DeveloperProxyCredential[])
        : Promise.resolve([] as DeveloperProxyCredential[]),
      getHoursSaved30d(tenantId).catch(() => 0),
      listOauthConnectedTools(tenantId),
      listConnectionProfiles(tenantId),
    ]);

  return assembleWorkforce(internalAgents, externalAgents, mcpTokens, personnel, activityMap, devProxyCredentials, {
    hoursSavedLast30Days,
  }, oauthTools, profiles);
}
