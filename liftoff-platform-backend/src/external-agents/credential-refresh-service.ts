// External Agent Credential Refresh Service (EA-002)
// Refreshes OAuth tokens for external agents before expiry
// Called by Cloud Scheduler job (every hour)

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { pool, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const secretClient = new SecretManagerServiceClient();

interface OAuthCredentials {
  access_token: string;
  refresh_token?: string;
  token_url: string;
  client_id: string;
  client_secret: string;
  expires_in?: number;
}

interface AgentWithCredentials {
  id: string;
  tenant_id: string;
  endpoint_url: string;
  name: string;
  secret_name: string;
  token_expires_at: Date;
}

// Refresh OAuth tokens for external agents before expiry
export async function refreshExpiringTokens(): Promise<void> {
  log.info('Starting external agent token refresh');

  // Find agents with OAuth auth and tokens expiring within 1 hour
  const result = await withAdminScope({ caller: 'external-agents.credential-refresh', reason: 'hourly cross-tenant OAuth token refresh + by-id status update' }, (client) => client.query<AgentWithCredentials>(
    `SELECT ea.id, ea.tenant_id, ea.endpoint_url, ea.name,
            eac.secret_name, eac.token_expires_at
     FROM external_agents ea
     JOIN external_agent_credentials eac ON ea.id = eac.external_agent_id
     WHERE ea.auth_type = 'oauth'
       AND ea.status = 'connected'
       AND ea.deleted_at IS NULL
       AND eac.token_expires_at < NOW() + INTERVAL '1 hour'`
  ));

  let refreshed = 0;
  let failed = 0;

  for (const agent of result.rows) {
    const success = await refreshToken(agent);
    if (success) {
      refreshed++;
    } else {
      failed++;
    }
  }

  log.info(
    { total: result.rows.length, refreshed, failed },
    'External agent token refresh complete'
  );
}

async function refreshToken(agent: AgentWithCredentials): Promise<boolean> {
  try {
    // Fetch current credentials from Secret Manager
    const [version] = await secretClient.accessSecretVersion({
      name: agent.secret_name,
    });

    const credentials: OAuthCredentials = JSON.parse(
      version.payload?.data?.toString() || '{}'
    );

    if (!credentials.refresh_token) {
      log.warn(
        { externalAgentId: agent.id, tenantId: agent.tenant_id },
        'No refresh token available for external agent'
      );
      return false;
    }

    // Call OAuth token endpoint to refresh
    const response = await fetch(credentials.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refresh_token,
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const newTokens = await response.json();

    // Calculate new expiry time
    const expiresInSeconds = newTokens.expires_in || 3600; // Default 1 hour
    const newExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // Update Secret Manager with new tokens
    const updatedCredentials: OAuthCredentials = {
      ...credentials,
      access_token: newTokens.access_token,
      refresh_token: newTokens.refresh_token || credentials.refresh_token,
    };

    // Extract parent secret name (remove version suffix)
    const parentSecretName = agent.secret_name.replace(/\/versions\/\d+$/, '');

    await secretClient.addSecretVersion({
      parent: parentSecretName,
      payload: {
        data: Buffer.from(JSON.stringify(updatedCredentials)),
      },
    });

    // Update expiry tracking in database
    await pool.query(
      `UPDATE external_agent_credentials
       SET token_expires_at = $1, refreshed_at = NOW()
       WHERE external_agent_id = $2`,
      [newExpiresAt.toISOString(), agent.id]
    );

    log.info(
      {
        externalAgentId: agent.id,
        tenantId: agent.tenant_id,
        name: agent.name,
        newExpiry: newExpiresAt.toISOString(),
      },
      'Refreshed OAuth token for external agent'
    );

    return true;
  } catch (error) {
    log.error(
      {
        externalAgentId: agent.id,
        tenantId: agent.tenant_id,
        error: (error as Error).message,
      },
      'Failed to refresh OAuth token for external agent'
    );

    // Mark agent as needing re-authentication
    await withAdminScope({ caller: 'external-agents.credential-refresh', reason: 'hourly cross-tenant OAuth token refresh + by-id status update' }, (client) => client.query(
      `UPDATE external_agents SET status = 'error',
       last_error = 'OAuth token refresh failed'
       WHERE id = $1`,
      [agent.id]
    ));

    return false;
  }
}

// Refresh token for a specific agent (used by API endpoint)
export async function refreshSingleAgentToken(
  agentId: string,
  tenantId: string
): Promise<{ success: boolean; error?: string }> {
  const result = await withAdminScope({ caller: 'external-agents.credential-refresh', reason: 'hourly cross-tenant OAuth token refresh + by-id status update' }, (client) => client.query<AgentWithCredentials>(
    `SELECT ea.id, ea.tenant_id, ea.endpoint_url, ea.name,
            eac.secret_name, eac.token_expires_at
     FROM external_agents ea
     JOIN external_agent_credentials eac ON ea.id = eac.external_agent_id
     WHERE ea.id = $1 AND ea.tenant_id = $2 AND ea.deleted_at IS NULL`,
    [agentId, tenantId]
  ));

  if (result.rows.length === 0) {
    return { success: false, error: 'agent not found, or it has no connected account' };
  }

  const success = await refreshToken(result.rows[0]);
  if (success) {
    return { success: true };
  } else {
    return { success: false, error: 'Token refresh failed' };
  }
}
