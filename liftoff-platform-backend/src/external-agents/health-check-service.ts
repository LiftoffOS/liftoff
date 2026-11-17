// External Agent Health Check Service
// Runs periodic health checks on connected external agents
// Called by Cloud Scheduler job

import { createHash } from 'crypto';
import { assertPublicUrl } from '../common/url-guard';
import { pool, withAdminScope } from '../infrastructure/database';
import { MCPClient } from '../mcp/client';
import { externalAgentService } from './service';
import { log } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';
import { discoverExternalAgentWithProgress } from './discover-adapter';
import type { ExternalAgentStatus, CustomHeader } from './types';

// Run health checks for all connected external agents
export async function runHealthChecks(): Promise<void> {
  log.info('Starting external agent health checks');

  const result = await withAdminScope({ caller: 'external-agents.health-check', reason: 'cross-tenant health-check sweep + by-id status updates' }, (client) => client.query(
    // SELECT * already carries transport_type and raw_mcp_tools, which
    // checkAgentHealth now uses to decide whether the tool surface drifted.
    `SELECT * FROM external_agents WHERE status = 'connected' AND deleted_at IS NULL`
  ));

  let successCount = 0;
  let failureCount = 0;

  for (const row of result.rows) {
    const success = await checkAgentHealth(row);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  log.info(
    { checked: result.rows.length, success: successCount, failures: failureCount },
    'External agent health checks complete'
  );
}

/** Re-run discovery and persist the refreshed capability metadata.
 *
 *  Uses reviewPolicy:'live' so the agent stays connected. The manual rediscover
 *  route keeps the pending_review gate — a human who clicked rediscover is
 *  present to approve — but an unattended sweep must not take an integration out
 *  of service just because the vendor renamed or dropped a tool. The changes are
 *  still recorded in capability_changes, which the dashboard already renders.
 *
 *  Non-fatal: a refresh failure must not fail the health check. The agent is
 *  reachable, which is what the health check asserts; the snapshot simply stays
 *  stale until the next sweep. */
async function refreshAgentCapabilities(
  agent: { id: string; tenant_id: string; name: string; endpoint_url: string; auth_type: string },
  credentials: { apiKey?: string; bearerToken?: string; customHeaders?: CustomHeader[] },
): Promise<void> {
  try {
    const discovery = await discoverExternalAgentWithProgress(
      {
        endpointUrl: agent.endpoint_url,
        // The analyzer writes summary + collaborationHints from this; an empty
        // name would quietly degrade both on every automated refresh.
        name: agent.name,
        authType: agent.auth_type as 'none' | 'api_key' | 'bearer_token' | 'custom_headers',
        apiKey: credentials.apiKey,
        bearerToken: credentials.bearerToken,
        customHeaders: credentials.customHeaders,
        tenantId: agent.tenant_id,
        agentId: agent.id,
      },
      () => { /* progress callback noop — this is not an SSE caller */ },
    );

    const { changes } = await externalAgentService.rediscover(
      agent.id,
      agent.tenant_id,
      {
        capabilities: discovery.capabilities,
        resources: discovery.resources,
        toolClassifications: discovery.toolClassifications,
        // The effect class rides beside the categories; the cache upsert
        // writes what it is handed, so a refresh that dropped these would
        // null the class every tool already had.
        toolEffectClasses: discovery.toolEffectClasses,
        toolClassificationVersions: discovery.toolClassificationVersions,
        rawMcpTools: discovery.rawMcpTools,
        rawMcpResources: discovery.rawMcpResources,
        transportType: discovery.transportType,
        summary: discovery.summary,
        collaborationHints: discovery.collaborationHints,
      },
      { reviewPolicy: 'live' },
    );

    log.info(
      {
        agentId: agent.id,
        tenantId: agent.tenant_id,
        added: changes.filter(c => c.type === 'added').length,
        removed: changes.filter(c => c.type === 'removed').length,
        reclassified: changes.filter(c => c.type === 'classification_changed').length,
      },
      'External agent tool surface changed — capabilities refreshed',
    );
  } catch (err) {
    log.warn(
      { agentId: agent.id, tenantId: agent.tenant_id, error: (err as Error).message },
      'External agent capability refresh failed (non-fatal; health check unaffected)',
    );
  }
}

/** Stable fingerprint of a tool surface: name + description + input schema.
 *  Cheap enough to run on every sweep, which is the point — the LLM-backed
 *  capability analyzer only runs when this actually changes. */
function fingerprintTools(tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): string {
  const normalized = tools
    .map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// Check health of a single external agent
async function checkAgentHealth(agent: {
  id: string;
  tenant_id: string;
  name: string;
  endpoint_url: string;
  auth_type: string;
  transport_type: string | null;
  status: ExternalAgentStatus;
  raw_mcp_tools: unknown;
}): Promise<boolean> {
  try {
    // Health checks used to construct MCPClient with NO credentials ("we skip
    // auth since we're just pinging"), which meant an authenticated server was
    // only ever probed anonymously. Resolve them properly — the same call now
    // also refreshes the tool surface, which genuinely needs auth.
    const credentials = await externalAgentService.getCredentialsForDiscovery(
      agent.id,
      agent.tenant_id,
      agent.auth_type as 'none' | 'api_key' | 'bearer_token' | 'custom_headers',
    );

    // E1: the health checker re-dials every registered endpoint on a schedule,
    // which makes a bad registration a RECURRING outbound request rather than a
    // one-off. Re-validated each pass, so a DNS record that changes to point
    // inward stops being reachable at the next check.
    await assertPublicUrl(agent.endpoint_url, { context: 'external-agents.health-check' });

    const client = new MCPClient({
      endpointUrl: agent.endpoint_url,
      authType: agent.auth_type as 'none' | 'api_key' | 'bearer_token' | 'custom_headers',
      apiKey: credentials.apiKey,
      bearerToken: credentials.bearerToken,
      customHeaders: credentials.customHeaders,
      timeout: 10000, // 10s timeout for health check
    });

    // A2A endpoints expose no tools/list, so they keep ping-only semantics.
    const isA2A = agent.transport_type === 'a2a';
    if (isA2A) {
      await client.ping();
    } else {
      // discover() is the connectivity check AND the freshness check: one
      // round-trip, same cost class as ping. MCPClient exposes no standalone
      // tools/list.
      const discovery = await client.discover();

      const storedTools = Array.isArray(agent.raw_mcp_tools)
        ? (agent.raw_mcp_tools as Array<{ name: string; description?: string; inputSchema?: unknown }>)
        : [];
      if (fingerprintTools(discovery.tools) !== fingerprintTools(storedTools)) {
        await refreshAgentCapabilities(agent, credentials);
      }
    }

    // If previously in error state, mark as connected
    if (agent.status === 'error') {
      await externalAgentService.updateStatus(agent.id, agent.tenant_id, 'connected');
      log.info({ agentId: agent.id }, 'External agent recovered');
    }

    // Update last_checked_at
    await withAdminScope({ caller: 'external-agents.health-check', reason: 'cross-tenant health-check sweep + by-id status updates' }, (client) => client.query(
      `UPDATE external_agents SET last_checked_at = NOW() WHERE id = $1`,
      [agent.id]
    ));

    return true;
  } catch (error) {
    const errorMessage = (error as Error).message;
    log.warn(
      { agentId: agent.id, error: errorMessage },
      'External agent health check failed'
    );

    // Mark as error state
    await externalAgentService.updateStatus(agent.id, agent.tenant_id, 'error');

    // Update with error details
    await withAdminScope({ caller: 'external-agents.health-check', reason: 'cross-tenant health-check sweep + by-id status updates' }, (client) => client.query(
      `UPDATE external_agents SET last_error = $1, last_checked_at = NOW() WHERE id = $2`,
      [errorMessage, agent.id]
    ));

    // Notify tenant runtime to clear cache (EA-001)
    await publishEvent({
      eventType: 'external_agent.health_failed',
      entityType: 'external_agent',
      entityId: agent.id,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: agent.tenant_id,
      payload: {
        externalAgentId: agent.id,
        tenantId: agent.tenant_id,
        reason: errorMessage,
        timestamp: new Date().toISOString(),
      },
    });

    return false;
  }
}

// Health check for a specific agent (used by API endpoint)
export async function checkSingleAgentHealth(agentId: string, tenantId: string): Promise<{
  healthy: boolean;
  error?: string;
}> {
  const result = await withAdminScope({ caller: 'external-agents.health-check', reason: 'cross-tenant health-check sweep + by-id status updates' }, (client) => client.query(
    `SELECT * FROM external_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [agentId, tenantId]
  ));

  if (result.rows.length === 0) {
    return { healthy: false, error: 'agent not found' };
  }

  const agent = result.rows[0];
  const success = await checkAgentHealth(agent);

  if (success) {
    return { healthy: true };
  } else {
    // Re-fetch to get the error message
    const updated = await withAdminScope({ caller: 'external-agents.health-check', reason: 'cross-tenant health-check sweep + by-id status updates' }, (client) => client.query(
      `SELECT last_error FROM external_agents WHERE id = $1`,
      [agentId]
    ));
    return { healthy: false, error: updated.rows[0]?.last_error || 'Health check failed' };
  }
}
