// External Agents Service
// Manages external AI agent configurations for A2A collaboration
// Follows internal-agents/service.ts patterns

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import type { PoolClient } from 'pg';
import { pool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { publishEvent as publishOutboxEvent } from '../events/publisher';
import { toolClassifier, type StoredEffectClass } from '../mcp/tool-classifier';
import { isTypeSafeClassifierEnabled } from '../typesafe/flags';
import {
  EXTERNAL_AGENT_CLASSIFICATION_INTEGRATION_TYPE,
  externalAgentClassificationToolName,
} from './discover-adapter';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import type {
  ExternalAgent,
  ExternalAgentVersion,
  ExternalAgentWithContext,
  CreateExternalAgentInput,
  UpdateExternalAgentInput,
  PaginatedExternalAgentsResponse,
  ExternalAgentStatus,
  VersionSource,
  DetectedCapability,
  DetectedResource,
  MCPToolDefinition,
  MCPResourceDefinition,
  InternalAgentRequestRule,
  CapabilityChange,
  CustomHeader,
  CollaborationMode,
  CapabilitySource,
  TransportType,
} from './types';
import type { SensitivityCategory } from '../mcp/tool-classifier';

const secretManagerClient = new SecretManagerServiceClient();

/** Qualify a bare Secret Manager name against a project.
 *  Already-qualified values and unresolvable projects pass through unchanged,
 *  so this is safe to apply to every row without checking first. */
function qualifySecretName(stored: string | null, projectId: string | null): string | null {
  if (!stored) return null;
  if (stored.startsWith('projects/')) return stored;
  if (!projectId) return stored;
  return `projects/${projectId}/secrets/${stored}`;
}

export class ExternalAgentService {
  // List external agents with pagination
  async list(
    tenantId: string,
    options?: { cursor?: string; limit?: number; status?: ExternalAgentStatus }
  ): Promise<PaginatedExternalAgentsResponse> {
    const limit = Math.min(options?.limit || 20, 100);
    const status = options?.status;

    let query = `
      SELECT *, COUNT(*) OVER() as total_count
      FROM external_agents
      WHERE tenant_id = $1 AND deleted_at IS NULL
    `;
    const params: (string | number)[] = [tenantId];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (options?.cursor) {
      query += ` AND created_at < $${paramIndex}`;
      params.push(options.cursor);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(limit + 1); // Fetch one extra to check if there are more

    const result = await withTenantScope(tenantId, (client) => client.query(query, params));
    const rows = result.rows;

    const hasMore = rows.length > limit;
    const agents = rows.slice(0, limit).map(row => this.mapRow(row));
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

    // Compute monthlyCost from costType, costAmount, and trailing 30-day task counts
    const trailingEnd = new Date();
    const trailingStart = new Date(trailingEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const taskCounts = await tenantRuntimeClient.getExternalAgentTaskCounts(tenantId, trailingStart, trailingEnd);
    for (const agent of agents) {
      const tasks30d = taskCounts[agent.id]?.taskCount ?? 0;
      agent.tasks30d = tasks30d;
      agent.monthlyCost = this.computeMonthlyCost(agent, tasks30d);
    }

    return {
      agents,
      cursor: hasMore && agents.length > 0 ? agents[agents.length - 1].createdAt.toISOString() : null,
      hasMore,
      total,
    };
  }

  /** Unpaginated variant for internal aggregation — do not expose on the public paginated API. Hard cap 500. */
  async listAllByTenant(tenantId: string): Promise<ExternalAgent[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM external_agents
       WHERE tenant_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 500`,
      [tenantId],
    ));
    const agents = result.rows.map(row => this.mapRow(row));

    const trailingEnd = new Date();
    const trailingStart = new Date(trailingEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const taskCounts = await tenantRuntimeClient.getExternalAgentTaskCounts(tenantId, trailingStart, trailingEnd);
    for (const agent of agents) {
      const tasks30d = taskCounts[agent.id]?.taskCount ?? 0;
      agent.tasks30d = tasks30d;
      agent.monthlyCost = this.computeMonthlyCost(agent, tasks30d);
    }
    return agents;
  }

  // Get a single external agent by ID
  /**
   * The effect classes stored for this agent's tools (1b), keyed by bare tool
   * name, for the runtime's config payload. Empty while the classifier kill
   * is off: the runtime then appends nothing and the agent's tools keep
   * today's categories, while the stored values are kept for when the flag
   * returns.
   */
  async effectClassesFor(agent: Pick<ExternalAgent, 'id' | 'rawMcpTools'>): Promise<Record<string, string>> {
    if (!isTypeSafeClassifierEnabled()) return {};
    const names = (agent.rawMcpTools ?? []).map((t) => t.name);
    if (names.length === 0) return {};
    try {
      const byKey = await toolClassifier.getEffectClasses(
        names.map((n) => externalAgentClassificationToolName(agent.id, n)),
        EXTERNAL_AGENT_CLASSIFICATION_INTEGRATION_TYPE,
      );
      const prefix = `${agent.id}:`;
      const out: Record<string, string> = {};
      for (const [key, klass] of Object.entries(byKey)) {
        if (key.startsWith(prefix)) out[key.slice(prefix.length)] = klass;
      }
      return out;
    } catch (err) {
      log.warn({ err: (err as Error).message, externalAgentId: agent.id }, 'effect class read failed; none carried');
      return {};
    }
  }

  async get(id: string, tenantId: string): Promise<ExternalAgent | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM external_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId]
    ));

    if (result.rows.length === 0) {
      return null;
    }

    const agent = this.mapRow(result.rows[0]);

    // The tenant runtime consumes this row through /api/external-agents/by-id
    // and reads the credential secret directly, so hand it a path it can
    // actually open regardless of which project the secret was written to.
    agent.credentialSecretName = await this.resolveCredentialSecretResourceName(
      tenantId,
      agent.credentialSecretName,
    );

    // Compute monthlyCost from costType, costAmount, and trailing 30-day task counts
    const trailingEnd = new Date();
    const trailingStart = new Date(trailingEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const taskCounts = await tenantRuntimeClient.getExternalAgentTaskCounts(tenantId, trailingStart, trailingEnd);
    const tasks30d = taskCounts[agent.id]?.taskCount ?? 0;
    agent.tasks30d = tasks30d;
    agent.monthlyCost = this.computeMonthlyCost(agent, tasks30d);

    return agent;
  }

  // Get external agents for an internal agent (for runtime tool schema injection)
  async getForInternalAgent(tenantId: string, internalAgentId: string): Promise<ExternalAgentWithContext[]> {
    // Step 1: Get internal agent's selected external agents
    const internalAgentResult = await withTenantScope(tenantId, (client) => client.query(`
      SELECT integrations FROM internal_agents WHERE id = $1 AND tenant_id = $2
    `, [internalAgentId, tenantId]));

    if (internalAgentResult.rows.length === 0) return [];

    const integrations = internalAgentResult.rows[0].integrations || [];
    // IntegrationPermission has { id, selectedObjects } with no type field,
    // so we can't filter by type. External agent IDs are UUIDs while
    // connector IDs (e.g. "sheets", "gmail") are not. Filter to valid UUIDs
    // to safely pass to the external_agents query.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const externalAgentIds = integrations
      .map((i: { id: string }) => i.id)
      .filter((id: string) => UUID_RE.test(id));

    if (externalAgentIds.length === 0) return [];

    // Step 2: Get external agents that match:
    //   - ID in internal agent's external_agent selections
    //   - Internal agent ID in agent's allowed_internal_agent_ids
    //   - Collaboration mode allows outbound (internal → external)
    const result = await withTenantScope(tenantId, (client) => client.query(`
      SELECT id, name, summary, collaboration_hints,
             raw_mcp_tools, tool_classifications,
             collaboration_mode, request_rules, status, transport_type,
             endpoint_url, auth_type, credential_secret_name
      FROM external_agents
      WHERE tenant_id = $1
        AND deleted_at IS NULL
        AND status = 'connected'
        AND id = ANY($2::uuid[])
        AND $3 = ANY(allowed_internal_agent_ids)
        AND collaboration_mode IN ('receive_delegated', 'two_way')
    `, [tenantId, externalAgentIds, internalAgentId]));

    // Resolve the credential path for the whole batch with ONE tenant lookup.
    // This endpoint feeds the runtime's per-run catalog build, so a bare name
    // here would send the runtime looking in the wrong project — the same
    // silent-unauthenticated failure the by-id path already avoids.
    const agents = result.rows.map(row => this.mapRowToExternalAgentWithContext(row));
    const projectId = await this.resolveTenantSecretProject(tenantId);
    for (const agent of agents) {
      agent.credentialSecretName = qualifySecretName(agent.credentialSecretName, projectId);
    }
    return agents;
  }

  // Create a new external agent with idempotency
  async create(
    tenantId: string,
    input: CreateExternalAgentInput,
    idempotencyKey: string
  ): Promise<ExternalAgent> {
    // Check for existing idempotency key
    const existingResult = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM external_agents WHERE idempotency_key = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [idempotencyKey, tenantId]
    ));

    if (existingResult.rows.length > 0) {
      log.info({ idempotencyKey }, 'Returning existing external agent from idempotency key');
      return this.mapRow(existingResult.rows[0]);
    }

    // Begin transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant (all writes below carry
      // tenant_id = $tenantId; FORCE-safe, transaction-local).
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      // Insert the external agent
      const result = await client.query(
        `INSERT INTO external_agents (
          tenant_id, name, endpoint_url, transport_type, description, connection_type, auth_type,
          collaboration_mode, summary, collaboration_hints, detected_capabilities,
          detected_resources, tool_classifications, raw_mcp_tools, raw_mcp_resources,
          allowed_internal_agent_ids, request_rules, status, capability_source, current_version,
          idempotency_key, tunnel_route_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 1, $20, $21
        ) RETURNING *`,
        [
          tenantId,
          input.name,
          input.endpointUrl,
          input.transportType || 'streamable-http',
          input.description || null,
          input.connectionType,
          input.authType,
          input.collaborationMode,
          input.summary || null,
          input.collaborationHints || null,
          JSON.stringify(input.detectedCapabilities || []),
          JSON.stringify(input.detectedResources || []),
          JSON.stringify(input.toolClassifications || {}),
          JSON.stringify(input.rawMcpTools || []),
          JSON.stringify(input.rawMcpResources || []),
          input.allowedInternalAgentIds || [],
          JSON.stringify(input.requestRules || []),
          'connected', // Auto-connect on create (discovery succeeded)
          input.capabilitySource || 'mcp_discovery',
          idempotencyKey,
          input.tunnelRouteId || null,
        ]
      );

      const agent = this.mapRow(result.rows[0]);

      // Create initial version
      await this.createVersion(client, agent, 'create');

      // Store credentials in tenant's Secret Manager if provided
      if (input.authType !== 'none') {
        // Extract credential hints (last 4 chars) before storing full secrets
        const apiKeyHint = input.apiKey ? `•••${input.apiKey.slice(-4)}` : null;
        const bearerTokenHint = input.bearerToken ? `•••${input.bearerToken.slice(-4)}` : null;
        const customHeaderKeys = input.customHeaders?.map(h => h.key) || null;

        const secretName = await this.storeCredentials(
          tenantId,
          agent.id,
          {
            authType: input.authType,
            apiKey: input.apiKey,
            bearerToken: input.bearerToken,
            customHeaders: input.customHeaders,
          }
        );

        // Update credential_secret_name reference and credential hints
        await client.query(
          `UPDATE external_agents SET
            credential_secret_name = $1,
            api_key_hint = $2,
            bearer_token_hint = $3,
            custom_header_keys = $4
          WHERE id = $5`,
          [secretName, apiKeyHint, bearerTokenHint, customHeaderKeys, agent.id]
        );
        agent.credentialSecretName = secretName;
        agent.apiKeyHint = apiKeyHint;
        agent.bearerTokenHint = bearerTokenHint;
        agent.customHeaderKeys = customHeaderKeys;
      }

      // Cache tool classifications with proper namespace (agent ID).
      // Fail-soft, per the custom-MCP path (cacheToolClassifications): the cache is
      // a warm-start optimisation — a miss falls back to FAIL_SECURE_DEFAULT_CATEGORIES
      // (every action HITLs) until it is re-cached, which is a safe degradation, not
      // a reason to abort registering the collaborator. It also insulates this write
      // from a transient ON CONFLICT arbiter mismatch during an identity-migration
      // deploy window (migration 458): a failed cache write must never roll back the
      // registration.
      for (const [toolName, categories] of Object.entries(input.toolClassifications || {})) {
        try {
          await toolClassifier.cacheClassification(
            externalAgentClassificationToolName(agent.id, toolName), // Proper namespace with agent ID
            EXTERNAL_AGENT_CLASSIFICATION_INTEGRATION_TYPE,
            toolClassifier.hashDescription(
              input.rawMcpTools?.find(t => t.name === toolName)?.description || ''
            ),
            categories as SensitivityCategory[],
            undefined,
            {
              // 1b: the effect class and the version that produced it ride
              // beside the categories; absent on results without them.
              effectClass: (input.toolEffectClasses?.[toolName] as StoredEffectClass | undefined) ?? null,
              classificationVersion: input.toolClassificationVersions?.[toolName] ?? null,
            },
          );
        } catch (err) {
          log.warn({ err, agentId: agent.id, toolName }, 'Failed to cache external-agent tool classification');
        }
      }

      await client.query('COMMIT');

      // Back-attribute the initial discovery LLM call to this agent.
      // The discovery ran before the agent existed, so llm_usage_log.agent_id was NULL.
      // The frontend echoes the correlationId (stored as thread_id on the log row) back
      // in the save payload so we can attribute it now that we have an agent ID.
      if (input.discoveryCorrelationId) {
        withTenantScope(tenantId, (client) => client.query(
          `UPDATE llm_usage_log
           SET agent_id = $1
           WHERE thread_id = $2
             AND tenant_id = $3
             AND agent_id IS NULL`,
          [agent.id, input.discoveryCorrelationId, tenantId]
        )).catch(err => {
          log.warn({ err, externalAgentId: agent.id, correlationId: input.discoveryCorrelationId },
            'Non-fatal: failed to back-attribute discovery LLM cost to external agent');
        });
      }

      // Publish event for tenant runtime
      await this.publishEvent('external_agent.created', {
        externalAgentId: agent.id,
        tenantId,
        entityVersion: agent.currentVersion,
      });

      log.info({ externalAgentId: agent.id, tenantId }, 'External agent created');

      return agent;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Update an external agent
  async update(
    id: string,
    tenantId: string,
    input: UpdateExternalAgentInput
  ): Promise<ExternalAgent | null> {
    const current = await this.get(id, tenantId);
    if (!current) {
      return null;
    }

    const updates: string[] = [];
    const params: (string | number | string[] | null)[] = [];
    let paramIndex = 1;

    // Track if versioned fields changed
    const versionedFieldsChanged =
      (input.name !== undefined && input.name !== current.name) ||
      (input.description !== undefined && input.description !== current.description) ||
      (input.collaborationMode !== undefined && input.collaborationMode !== current.collaborationMode) ||
      (input.allowedInternalAgentIds !== undefined && JSON.stringify(input.allowedInternalAgentIds) !== JSON.stringify(current.allowedInternalAgentIds)) ||
      (input.requestRules !== undefined && JSON.stringify(input.requestRules) !== JSON.stringify(current.requestRules));

    if (input.name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      params.push(input.name);
      paramIndex++;
    }
    if (input.description !== undefined) {
      updates.push(`description = $${paramIndex}`);
      params.push(input.description);
      paramIndex++;
    }
    if (input.collaborationMode !== undefined) {
      updates.push(`collaboration_mode = $${paramIndex}`);
      params.push(input.collaborationMode);
      paramIndex++;
    }
    if (input.allowedInternalAgentIds !== undefined) {
      updates.push(`allowed_internal_agent_ids = $${paramIndex}`);
      params.push(input.allowedInternalAgentIds);
      paramIndex++;
    }
    if (input.requestRules !== undefined) {
      updates.push(`request_rules = $${paramIndex}`);
      params.push(JSON.stringify(input.requestRules));
      paramIndex++;
    }
    if (input.costAmount !== undefined) {
      updates.push(`cost_amount = $${paramIndex}`);
      params.push(input.costAmount);
      paramIndex++;
    }
    if (input.costType !== undefined) {
      updates.push(`cost_type = $${paramIndex}`);
      params.push(input.costType);
      paramIndex++;
    }

    if (updates.length === 0) {
      return current;
    }

    // Increment version if versioned fields changed
    let newVersion = current.currentVersion;
    if (versionedFieldsChanged) {
      newVersion = current.currentVersion + 1;
      updates.push(`current_version = $${paramIndex}`);
      params.push(newVersion);
      paramIndex++;
    }

    updates.push(`updated_at = NOW()`);

    const result = await withTenantScope(tenantId, (client) => client.query(
      `UPDATE external_agents SET ${updates.join(', ')} WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1} AND deleted_at IS NULL RETURNING *`,
      [...params, id, tenantId]
    ));

    if (result.rows.length === 0) {
      return null;
    }

    const agent = this.mapRow(result.rows[0]);

    // Create new version if versioned fields changed
    if (versionedFieldsChanged) {
      const client = await pool.connect();
      try {
        await this.createVersion(client, agent, 'manual');
      } finally {
        client.release();
      }
    }

    // Publish event for tenant runtime
    await this.publishEvent('external_agent.updated', {
      externalAgentId: agent.id,
      tenantId,
      entityVersion: agent.currentVersion,
    });

    log.info({ externalAgentId: id, tenantId, version: agent.currentVersion }, 'External agent updated');

    return agent;
  }

  // Update external agent status
  async updateStatus(
    id: string,
    tenantId: string,
    status: ExternalAgentStatus
  ): Promise<ExternalAgent | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `UPDATE external_agents SET status = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [status, id, tenantId]
    ));

    if (result.rows.length === 0) {
      return null;
    }

    const agent = this.mapRow(result.rows[0]);

    // The runtime caches a collaborator's row for 60 seconds and clears it on
    // this event (handleExternalAgentUpdated); without it a pause lags a
    // minute on the runtime's side.
    await this.publishEvent('external_agent.updated', {
      externalAgentId: agent.id,
      tenantId,
      entityVersion: agent.currentVersion,
      status,
    });

    log.info({ externalAgentId: id, tenantId, status }, 'External agent status updated');

    return agent;
  }

  /**
   * Move a collaborator to a new endpoint. A new version is cut the way
   * update() cuts one, and the runtime is told, because the endpoint is what
   * every delegation dials. The caller rediscovers afterwards so the stored
   * capabilities describe what the new endpoint serves.
   */
  async updateEndpoint(id: string, tenantId: string, endpointUrl: string): Promise<ExternalAgent | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `UPDATE external_agents
       SET endpoint_url = $1, current_version = current_version + 1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [endpointUrl, id, tenantId]
    ));
    if (result.rows.length === 0) {
      return null;
    }
    const agent = this.mapRow(result.rows[0]);

    const client = await pool.connect();
    try {
      await this.createVersion(client, agent, 'manual');
    } finally {
      client.release();
    }

    await this.publishEvent('external_agent.updated', {
      externalAgentId: agent.id,
      tenantId,
      entityVersion: agent.currentVersion,
    });

    log.info({ externalAgentId: id, tenantId, version: agent.currentVersion }, 'External agent endpoint updated');
    return agent;
  }

  // Soft delete an external agent
  async delete(id: string, tenantId: string): Promise<boolean> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `UPDATE external_agents SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId]
    ));

    if (result.rowCount === 0) {
      return false;
    }

    // Clean up person-agent assignments referencing this agent
    await withTenantScope(tenantId, (client) => client.query(
      `UPDATE person_agent_assignments SET deleted_at = NOW()
       WHERE agent_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId]
    ));

    // Publish event for tenant runtime
    await this.publishEvent('external_agent.deleted', {
      externalAgentId: id,
      tenantId,
    });

    log.info({ externalAgentId: id, tenantId }, 'External agent deleted (soft)');

    return true;
  }

  // Get all versions for an external agent
  async getVersions(id: string, tenantId: string): Promise<ExternalAgentVersion[]> {
    // First verify the agent belongs to this tenant
    const agent = await this.get(id, tenantId);
    if (!agent) {
      return [];
    }

    const result = await pool.query(
      `SELECT * FROM external_agent_versions WHERE external_agent_id = $1 ORDER BY version DESC`,
      [id]
    );

    return result.rows.map(row => this.mapVersionRow(row));
  }

  // Rollback to a specific version
  async rollback(
    id: string,
    tenantId: string,
    targetVersion: number
  ): Promise<ExternalAgent | null> {
    const versions = await this.getVersions(id, tenantId);
    const targetVersionData = versions.find(v => v.version === targetVersion);

    if (!targetVersionData) {
      return null;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant (all writes below carry
      // tenant_id = $tenantId; FORCE-safe, transaction-local).
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      // Get current agent
      const current = await this.get(id, tenantId);
      if (!current) {
        await client.query('ROLLBACK');
        return null;
      }

      const newVersion = current.currentVersion + 1;

      // Apply the version's values
      const result = await client.query(
        `UPDATE external_agents SET
          name = $1, description = $2, summary = $3, collaboration_hints = $4,
          detected_capabilities = $5, detected_resources = $6, tool_classifications = $7,
          allowed_internal_agent_ids = $8, request_rules = $9, collaboration_mode = $10,
          current_version = $11, updated_at = NOW()
         WHERE id = $12 AND tenant_id = $13 AND deleted_at IS NULL
         RETURNING *`,
        [
          targetVersionData.name,
          targetVersionData.description,
          targetVersionData.summary,
          targetVersionData.collaborationHints,
          JSON.stringify(targetVersionData.detectedCapabilities),
          JSON.stringify(targetVersionData.detectedResources),
          JSON.stringify(targetVersionData.toolClassifications),
          targetVersionData.allowedInternalAgentIds,
          JSON.stringify(targetVersionData.requestRules),
          targetVersionData.collaborationMode,
          newVersion,
          id,
          tenantId,
        ]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const agent = this.mapRow(result.rows[0]);

      // Create new version for the rollback
      await this.createVersion(client, agent, 'manual');

      await client.query('COMMIT');

      // Publish event
      await this.publishEvent('external_agent.updated', {
        externalAgentId: agent.id,
        tenantId,
        entityVersion: agent.currentVersion,
      });

      log.info({ externalAgentId: id, tenantId, fromVersion: targetVersion, toVersion: newVersion }, 'External agent rolled back');

      return agent;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Re-discover capabilities (updates agent with fresh MCP data)
  async rediscover(
    id: string,
    tenantId: string,
    discoveryResult: {
      capabilities: DetectedCapability[];
      resources: DetectedResource[];
      toolClassifications: Record<string, SensitivityCategory[]>;
      toolEffectClasses?: Record<string, string>;
      toolClassificationVersions?: Record<string, number>;
      rawMcpTools: MCPToolDefinition[];
      rawMcpResources: MCPResourceDefinition[];
      transportType: TransportType;
      summary: string;
      collaborationHints: string;
    },
    opts?: {
      /** How to treat a change that would normally require review.
       *
       *  'gate' (default) keeps the existing behaviour for the operator-driven
       *  rediscover route: removed or reclassified tools flip the agent to
       *  pending_review and it stops serving until a human approves.
       *
       *  'live' is for the automated sweep. It records the same
       *  capability_changes and cuts the same version, but leaves the agent
       *  connected — an unattended sweep must not silently take an integration
       *  out of service because the vendor renamed a tool. */
      reviewPolicy?: 'gate' | 'live';
    }
  ): Promise<{ agent: ExternalAgent; requiresReview: boolean; changes: CapabilityChange[] }> {
    const existing = await this.get(id, tenantId);
    if (!existing) {
      throw new Error('External agent not found');
    }

    // Compare old vs new capabilities
    const changes = this.compareCapabilities(
      existing.detectedCapabilities,
      discoveryResult.capabilities,
      existing.toolClassifications,
      discoveryResult.toolClassifications
    );

    // Determine if review is required
    const requiresReview = changes.some(c =>
      c.type === 'removed' ||
      c.type === 'classification_changed'
    );

    // If review required, set status to 'pending_review' instead of 'connected'
    const newStatus = requiresReview && (opts?.reviewPolicy ?? 'gate') === 'gate'
      ? 'pending_review'
      : 'connected';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant (all writes below carry
      // tenant_id = $tenantId; FORCE-safe, transaction-local).
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      const result = await client.query(
        `UPDATE external_agents
         SET detected_capabilities = $1, detected_resources = $2, tool_classifications = $3,
             raw_mcp_tools = $4, raw_mcp_resources = $5, transport_type = $6,
             summary = $7, collaboration_hints = $8,
             status = $9, capability_changes = $10,
             current_version = current_version + 1, updated_at = NOW(),
             last_discovery_at = NOW()
         WHERE id = $11 AND tenant_id = $12 AND deleted_at IS NULL
         RETURNING *`,
        [
          JSON.stringify(discoveryResult.capabilities),
          JSON.stringify(discoveryResult.resources),
          JSON.stringify(discoveryResult.toolClassifications),
          JSON.stringify(discoveryResult.rawMcpTools),
          JSON.stringify(discoveryResult.rawMcpResources),
          discoveryResult.transportType,
          discoveryResult.summary,
          discoveryResult.collaborationHints,
          newStatus,
          JSON.stringify(changes),
          id,
          tenantId,
        ]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('External agent not found');
      }

      const agent = this.mapRow(result.rows[0]);

      // Create version for rediscovery
      await this.createVersion(client, agent, 'discover');

      // Update tool classification cache with new namespace. Fail-soft (see the
      // register path above and the custom-MCP cacheToolClassifications): a failed
      // cache write degrades to fail-secure HITL until re-cached and must never roll
      // back a rediscovery, nor be tripped by a transient ON CONFLICT arbiter
      // mismatch during an identity-migration deploy window (migration 458).
      for (const [toolName, categories] of Object.entries(discoveryResult.toolClassifications)) {
        try {
          await toolClassifier.cacheClassification(
            externalAgentClassificationToolName(agent.id, toolName),
            EXTERNAL_AGENT_CLASSIFICATION_INTEGRATION_TYPE,
            toolClassifier.hashDescription(
              discoveryResult.rawMcpTools.find(t => t.name === toolName)?.description || ''
            ),
            categories,
            undefined,
            {
              effectClass: (discoveryResult.toolEffectClasses?.[toolName] as StoredEffectClass | undefined) ?? null,
              classificationVersion: discoveryResult.toolClassificationVersions?.[toolName] ?? null,
            },
          );
        } catch (err) {
          log.warn({ err, agentId: agent.id, toolName }, 'Failed to cache external-agent tool classification');
        }
      }

      // Delete stale cache entries for removed tools
      const removedTools = changes.filter(c => c.type === 'removed');
      for (const removed of removedTools) {
        await toolClassifier.invalidateCache(externalAgentClassificationToolName(agent.id, removed.toolName));
      }

      await client.query('COMMIT');

      // Publish event
      await this.publishEvent('external_agent.rediscovered', {
        externalAgentId: agent.id,
        tenantId,
        entityVersion: agent.currentVersion,
        requiresReview,
      });

      log.info({ externalAgentId: id, tenantId, version: agent.currentVersion, requiresReview }, 'External agent rediscovered');

      return { agent, requiresReview, changes };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Compare old vs new capabilities to detect changes
  private compareCapabilities(
    oldCapabilities: DetectedCapability[],
    newCapabilities: DetectedCapability[],
    oldClassifications: Record<string, SensitivityCategory[]>,
    newClassifications: Record<string, SensitivityCategory[]>
  ): CapabilityChange[] {
    const changes: CapabilityChange[] = [];
    const oldToolNames = new Set(oldCapabilities.map(c => c.rawToolName));
    const newToolNames = new Set(newCapabilities.map(c => c.rawToolName));

    // Check for removed tools
    for (const toolName of oldToolNames) {
      if (!newToolNames.has(toolName)) {
        changes.push({
          type: 'removed',
          toolName,
          oldClassifications: oldClassifications[toolName],
        });
      }
    }

    // Check for added tools
    for (const toolName of newToolNames) {
      if (!oldToolNames.has(toolName)) {
        changes.push({
          type: 'added',
          toolName,
          newClassifications: newClassifications[toolName],
        });
      }
    }

    // Check for classification changes on existing tools
    for (const toolName of oldToolNames) {
      if (newToolNames.has(toolName)) {
        const oldCats = oldClassifications[toolName] || [];
        const newCats = newClassifications[toolName] || [];
        if (JSON.stringify(oldCats.sort()) !== JSON.stringify(newCats.sort())) {
          changes.push({
            type: 'classification_changed',
            toolName,
            oldClassifications: oldCats,
            newClassifications: newCats,
          });
        }
      }
    }

    return changes;
  }

  // Store credentials in tenant's Secret Manager
  private async storeCredentials(
    tenantId: string,
    externalAgentId: string,
    credentials: {
      authType: string;
      apiKey?: string;
      bearerToken?: string;
      customHeaders?: CustomHeader[];
    }
  ): Promise<string> {
    // Secret name format: external-agent-{id}-{tenantId}
    const secretName = `external-agent-${externalAgentId}-${tenantId}`;

    // Get tenant's GCP project ID (stored on tenant record)
    const tenantResult = await pool.query(
      `SELECT gcp_project_id FROM tenants WHERE id = $1`,
      [tenantId]
    );

    const tenantProjectId = tenantResult.rows[0]?.gcp_project_id;

    if (!tenantProjectId) {
      // If no tenant project, use control plane project (for dev/testing)
      const controlPlaneProjectId = process.env.GCP_PROJECT_ID;
      log.warn({ tenantId }, 'No tenant GCP project, using control plane project for credentials');

      // Store in control plane project
      try {
        // Create secret
        await secretManagerClient.createSecret({
          parent: `projects/${controlPlaneProjectId}`,
          secretId: secretName,
          secret: {
            replication: { automatic: {} },
          },
        });
      } catch (error) {
        // Secret might already exist
        if (!(error as Error).message?.includes('ALREADY_EXISTS')) {
          throw error;
        }
      }

      // Add secret version
      await secretManagerClient.addSecretVersion({
        parent: `projects/${controlPlaneProjectId}/secrets/${secretName}`,
        payload: {
          data: Buffer.from(JSON.stringify({
            authType: credentials.authType,
            apiKey: credentials.apiKey,
            bearerToken: credentials.bearerToken,
            customHeaders: credentials.customHeaders,
          })),
        },
      });

      // Return the FULLY QUALIFIED resource name, not the bare one. The tenant
      // runtime reads this secret and cannot know we chose the control-plane
      // project here — it used to reconstruct the path against its own project,
      // miss, and silently fall back to an unauthenticated call.
      return `projects/${controlPlaneProjectId}/secrets/${secretName}`;
    }

    // Store in tenant's project using cross-project IAM
    try {
      await secretManagerClient.createSecret({
        parent: `projects/${tenantProjectId}`,
        secretId: secretName,
        secret: {
          replication: { automatic: {} },
        },
      });
    } catch (error) {
      // Secret might already exist
      if (!(error as Error).message?.includes('ALREADY_EXISTS')) {
        throw error;
      }
    }

    // Add secret version
    await secretManagerClient.addSecretVersion({
      parent: `projects/${tenantProjectId}/secrets/${secretName}`,
      payload: {
        data: Buffer.from(JSON.stringify({
          authType: credentials.authType,
          apiKey: credentials.apiKey,
          bearerToken: credentials.bearerToken,
          customHeaders: credentials.customHeaders,
        })),
      },
    });

    // Fully qualified for the same reason as the control-plane branch above:
    // the reader cannot infer which project we wrote to.
    const resourceName = `projects/${tenantProjectId}/secrets/${secretName}`;

    // Publish event that credentials are stored
    await this.publishEvent('external_agent.credentials_stored', {
      externalAgentId,
      tenantId,
      secretName: resourceName,
    });

    return resourceName;
  }

  /** Read an agent's stored credentials for DISCOVERY (health sweep, refresh).
   *
   *  The health check previously built its MCPClient with no credentials at all
   *  — it only pinged, and the comment said as much — so an authenticated
   *  server was probed anonymously. Refreshing the tool surface genuinely needs
   *  auth, otherwise a private server returns an anonymous (or empty) tool list
   *  and we would happily persist it over the real one.
   *
   *  Returns no-auth on any failure: this path only READS a tool list, so
   *  degrading to an unauthenticated attempt is safe (it fails, the snapshot is
   *  left alone). Dispatch does the opposite and refuses outright. */
  async getCredentialsForDiscovery(
    externalAgentId: string,
    tenantId: string,
    authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers',
  ): Promise<{ apiKey?: string; bearerToken?: string; customHeaders?: CustomHeader[] }> {
    if (authType === 'none') return {};
    try {
      const row = await withTenantScope(tenantId, (client) => client.query(
        `SELECT credential_secret_name FROM external_agents WHERE id = $1 AND tenant_id = $2`,
        [externalAgentId, tenantId],
      ));
      const resourceName = await this.resolveCredentialSecretResourceName(
        tenantId,
        (row.rows[0]?.credential_secret_name as string | null) ?? null,
      );
      if (!resourceName) return {};

      const [version] = await secretManagerClient.accessSecretVersion({
        name: resourceName.includes('/versions/') ? resourceName : `${resourceName}/versions/latest`,
      });
      const parsed = JSON.parse(version.payload?.data?.toString() || '{}') as {
        apiKey?: string; bearerToken?: string; customHeaders?: CustomHeader[];
      };
      return {
        apiKey: parsed.apiKey,
        bearerToken: parsed.bearerToken,
        customHeaders: parsed.customHeaders,
      };
    } catch (err) {
      log.warn(
        { externalAgentId, tenantId, error: (err as Error).message },
        'Could not read external agent credentials for discovery — probing unauthenticated',
      );
      return {};
    }
  }

  /** Which project holds this tenant's external-agent secrets.
   *
   *  The same branch storeCredentials uses: the tenant's own project when
   *  tenants.gcp_project_id is set, this control-plane project otherwise.
   *  Deterministic, so a legacy bare name can be qualified exactly rather than
   *  guessed. Split out so a list endpoint pays one lookup, not one per row. */
  private async resolveTenantSecretProject(tenantId: string): Promise<string | null> {
    const tenantResult = await pool.query(
      `SELECT gcp_project_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const projectId = tenantResult.rows[0]?.gcp_project_id || process.env.GCP_PROJECT_ID || null;
    if (!projectId) {
      log.warn({ tenantId }, 'Cannot resolve credential secret project — no tenant or control-plane project id');
    }
    return projectId;
  }

  /** Fully-qualified Secret Manager resource name for an agent's credentials.
   *
   *  Rows written before migration 312 hold a BARE name. Resolving at read time
   *  rather than by one-shot backfill is deliberate: every migration in this
   *  repo is plain .sql run by node-pg-migrate, and the control-plane project id
   *  lives in the process environment where SQL cannot reach it — and read-time
   *  resolution additionally covers rows an older instance writes mid-rollout.
   *  Applied on BOTH runtime-facing paths (get / getForInternalAgent), so no
   *  consumer sees an unqualified name. */
  private async resolveCredentialSecretResourceName(
    tenantId: string,
    stored: string | null,
  ): Promise<string | null> {
    if (!stored) return null;
    if (stored.startsWith('projects/')) return stored;
    return qualifySecretName(stored, await this.resolveTenantSecretProject(tenantId));
  }

  // Create a version snapshot
  private async createVersion(
    client: PoolClient | typeof pool,
    agent: ExternalAgent,
    source: VersionSource
  ): Promise<void> {
    await client.query(
      `INSERT INTO external_agent_versions (
        external_agent_id, version, name, description, summary, collaboration_hints,
        detected_capabilities, detected_resources, tool_classifications,
        allowed_internal_agent_ids, request_rules, collaboration_mode, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        agent.id,
        agent.currentVersion,
        agent.name,
        agent.description,
        agent.summary,
        agent.collaborationHints,
        JSON.stringify(agent.detectedCapabilities),
        JSON.stringify(agent.detectedResources),
        JSON.stringify(agent.toolClassifications),
        agent.allowedInternalAgentIds,
        JSON.stringify(agent.requestRules),
        agent.collaborationMode,
        source,
      ]
    );
  }

  // Publish event to Pub/Sub
  /** Publish an external_agent.* event through the OUTBOX.
   *
   *  These used to go out via the legacy raw publisher as
   *  `{ type, externalAgentId, tenantId, ... }`. The tenant runtime's
   *  validateEventSchema requires snake_case `event_type`, `entity_type` and
   *  `entity_id` (plus `tenant_id` for anything external_agent.*), so EVERY one
   *  of these events failed validation on arrival and the runtime's
   *  cache-clearing handlers — handleExternalAgentUpdated /
   *  handleExternalAgentDeleted / handleExternalAgentCredentialsStored — never
   *  ran. Routing through publishEvent builds the envelope the subscriber
   *  actually validates, and gets outbox durability with it.
   *
   *  Errors propagate: per docs/EVENT_PUBLISHING_CHECKLIST.md only
   *  internal_agent.* swallows. A failed enqueue means the runtime will never
   *  learn about this change, which is not something to log and move past. */
  private async publishEvent(
    eventType: string,
    data: { externalAgentId: string; tenantId: string; entityVersion?: number } & Record<string, unknown>,
  ): Promise<void> {
    const { externalAgentId, tenantId, entityVersion, ...rest } = data;
    await publishOutboxEvent({
      entityType: 'external_agent',
      entityId: externalAgentId,
      eventType,
      entityVersion: entityVersion ?? 1,
      eventVersion: 1,
      tenantId,
      payload: {
        externalAgentId,
        tenantId,
        ...rest,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // Map database row to ExternalAgent
  private mapRow(row: Record<string, unknown>): ExternalAgent {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      name: row.name as string,
      endpointUrl: row.endpoint_url as string,
      transportType: (row.transport_type as TransportType) || 'streamable-http',
      description: row.description as string | null,
      connectionType: row.connection_type as 'automatic' | 'custom',
      authType: row.auth_type as 'none' | 'api_key' | 'bearer_token' | 'custom_headers',
      credentialSecretName: row.credential_secret_name as string | null,
      // Credential hints for UI display (never retrieve actual secrets)
      apiKeyHint: row.api_key_hint as string | null,
      bearerTokenHint: row.bearer_token_hint as string | null,
      customHeaderKeys: row.custom_header_keys as string[] | null,
      collaborationMode: row.collaboration_mode as CollaborationMode,
      summary: row.summary as string | null,
      collaborationHints: row.collaboration_hints as string | null,
      detectedCapabilities: this.parseJsonb<DetectedCapability[]>(row.detected_capabilities, []),
      detectedResources: this.parseJsonb<DetectedResource[]>(row.detected_resources, []),
      toolClassifications: this.parseJsonb<Record<string, SensitivityCategory[]>>(row.tool_classifications, {}),
      rawMcpTools: this.parseJsonb<MCPToolDefinition[]>(row.raw_mcp_tools, []),
      rawMcpResources: this.parseJsonb<MCPResourceDefinition[]>(row.raw_mcp_resources, []),
      allowedInternalAgentIds: (row.allowed_internal_agent_ids as string[]) || [],
      requestRules: this.parseJsonb<InternalAgentRequestRule[]>(row.request_rules, []),
      status: row.status as ExternalAgentStatus,
      capabilityChanges: this.parseJsonb<CapabilityChange[] | null>(row.capability_changes, null),
      capabilitySource: (row.capability_source as CapabilitySource) || 'mcp_discovery',
      lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at as string) : null,
      lastError: row.last_error as string | null,
      costAmount: row.cost_amount != null ? Number(row.cost_amount) : null,
      costType: (row.cost_type as 'per_task' | 'per_month') || null,
      monthlyCost: null, // Computed at read time from costType, costAmount, and task counts
      tasks30d: 0, // Computed at read time from audit_logs (trailing 30 days)
      currentVersion: (row.current_version as number) || 1,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      lastActivity: null, // Populated by workforce endpoint via getLatestActivityByAgent
      lastActivityAction: null, // Populated by workforce endpoint via getLatestActivityByAgent
      tunnelRouteId: (row.tunnel_route_id as string | null) ?? null,
    };
  }

  // Map database row to ExternalAgentWithContext (for runtime tool schema injection)
  private mapRowToExternalAgentWithContext(row: Record<string, unknown>): ExternalAgentWithContext {
    return {
      id: row.id as string,
      name: row.name as string,
      summary: row.summary as string | null,
      collaborationHints: row.collaboration_hints as string | null,
      rawMcpTools: this.parseJsonb<MCPToolDefinition[]>(row.raw_mcp_tools, []),
      toolClassifications: this.parseJsonb<Record<string, SensitivityCategory[]>>(row.tool_classifications, {}),
      collaborationMode: row.collaboration_mode as CollaborationMode,
      requestRules: this.parseJsonb<InternalAgentRequestRule[]>(row.request_rules, []),
      status: row.status as ExternalAgentStatus,
      transportType: (row.transport_type as TransportType) || 'streamable-http',
      // Connection details for the runtime's live tool enumeration. Omitting
      // these is what would have left the runtime unable to reach the server
      // and silently serving the stale snapshot instead.
      endpointUrl: row.endpoint_url as string,
      authType: row.auth_type as ExternalAgentWithContext['authType'],
      credentialSecretName: (row.credential_secret_name as string | null) ?? null,
    };
  }

  // Map database row to ExternalAgentVersion
  private mapVersionRow(row: Record<string, unknown>): ExternalAgentVersion {
    return {
      id: row.id as string,
      externalAgentId: row.external_agent_id as string,
      version: row.version as number,
      name: row.name as string,
      description: row.description as string | null,
      summary: row.summary as string | null,
      collaborationHints: row.collaboration_hints as string | null,
      detectedCapabilities: this.parseJsonb<DetectedCapability[]>(row.detected_capabilities, []),
      detectedResources: this.parseJsonb<DetectedResource[]>(row.detected_resources, []),
      toolClassifications: this.parseJsonb<Record<string, SensitivityCategory[]>>(row.tool_classifications, {}),
      allowedInternalAgentIds: (row.allowed_internal_agent_ids as string[]) || [],
      requestRules: this.parseJsonb<InternalAgentRequestRule[]>(row.request_rules, []),
      collaborationMode: row.collaboration_mode as CollaborationMode,
      source: row.source as VersionSource,
      createdBy: row.created_by as string | null,
      createdAt: new Date(row.created_at as string),
    };
  }

  // Compute monthly cost based on cost type and task counts
  private computeMonthlyCost(agent: ExternalAgent, taskCount: number): number | null {
    if (agent.costAmount == null || agent.costType == null) {
      return null;
    }
    if (agent.costType === 'per_month') {
      return agent.costAmount;
    }
    // per_task: costAmount × tasks this month
    return agent.costAmount * taskCount;
  }

  // Parse JSONB fields with default fallback
  private parseJsonb<T>(raw: unknown, defaultValue: T): T {
    if (raw === null || raw === undefined) {
      return defaultValue;
    }
    if (typeof raw === 'object') {
      return raw as T;
    }
    try {
      return JSON.parse(raw as string) as T;
    } catch {
      return defaultValue;
    }
  }
}

export const externalAgentService = new ExternalAgentService();
