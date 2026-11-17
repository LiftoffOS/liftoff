// Custom MCP Server service.
//
// Each create call:
//   1. Resolves the endpoint URL (tunneled mode reads it from the route's public_url).
//   2. Inserts a connectors row with type='custom_mcp_server'.
//   3. Inserts a custom_mcp_servers row paired by connector_id.
//   4. Persists any auth credential into Secret Manager.
//   5. Runs MCP discovery to populate raw_mcp_tools.
//
// The internal-agent → tool binding flows through the existing
// connectors → IntegrationPermission[] machinery; no special-casing here.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { assertPublicUrl } from '../common/url-guard';
import { pool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import type { AuthType, CustomHeader, DiscoverOutput, MCPToolDefinition } from '../mcp/types';
import { toolClassifier } from '../mcp/tool-classifier';
import { tunnelsService } from '../tunnels/service';
import {
  createConnectorForTenant,
  deleteConnectorForTenant,
} from '../connectors/connector-service-client';
import {
  getConnectorSecretName,
  resolveSecretProjectId,
} from '../connectors/canonical-secret-storage';
import {
  customMcpClassificationIntegrationType,
  discoverCustomMcpServerWithProgress,
  persistCustomMcpServerTools,
  type ProgressCallback,
} from './discover-adapter';
import { isTypeSafeClassifierEnabled } from '../typesafe/flags';
import { CLASSIFICATION_VERSION } from '../typesafe/questions';
import type {
  CreateCustomMcpServerInput,
  CustomMcpServer,
  CustomMcpServerDeliveryMode,
  UpdateCustomMcpServerInput,
} from './types';

export const CUSTOM_MCP_SERVER_CONNECTOR_TYPE = 'custom_mcp_server';

/** See CustomMcpServerService.cacheVersion. One helper, both endpoints. */
export function customMcpCacheVersion(server: Pick<CustomMcpServer, 'updatedAt'>): string {
  const classifier = isTypeSafeClassifierEnabled() ? String(CLASSIFICATION_VERSION) : 'off';
  return `${server.updatedAt.toISOString()}|${classifier}`;
}

const secretManagerClient = new SecretManagerServiceClient();

function mapRow(row: any): CustomMcpServer {
  // Migration 268 dropped the redundant `id` column. The canonical identity
  // is now `connector_id` (also the PK), which equals `connectors.id` — the
  // same identifier agent bindings, /connections URLs, and secret names
  // all use. `id` on the mapped type stays as an alias for `connector_id`
  // so the public API response shape is unchanged; there is exactly one
  // identifier with two field names that always carry the same value.
  return {
    id: row.connector_id,
    tenantId: row.tenant_id,
    name: row.name,
    deliveryMode: row.delivery_mode as CustomMcpServerDeliveryMode,
    endpointUrl: row.endpoint_url,
    authType: row.auth_type as AuthType,
    authSecretName: row.auth_secret_name,
    tunnelRouteId: row.tunnel_route_id,
    rawMcpTools: (row.raw_mcp_tools as MCPToolDefinition[]) || [],
    connectorId: row.connector_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class CustomMcpServerService {
  async list(tenantId: string): Promise<CustomMcpServer[]> {
    const result = await pool.query(
      `SELECT * FROM custom_mcp_servers WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  async get(tenantId: string, connectorId: string): Promise<CustomMcpServer | null> {
    const result = await pool.query(
      `SELECT * FROM custom_mcp_servers WHERE connector_id = $1 AND tenant_id = $2`,
      [connectorId, tenantId],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  async listEndpointUrls(tenantId: string): Promise<string[]> {
    const result = await pool.query(
      `SELECT endpoint_url FROM custom_mcp_servers WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows.map((r) => r.endpoint_url);
  }

  async create(
    tenantId: string,
    accountId: string,
    input: CreateCustomMcpServerInput,
  ): Promise<CustomMcpServer> {
    let endpointUrl: string;
    let tunnelRouteId: string | null = null;

    if (input.deliveryMode === 'public_url') {
      if (!input.endpointUrl) {
        throw new Error('endpointUrl is required for public_url delivery mode');
      }
      if (input.tunnelRouteId) {
        throw new Error('tunnelRouteId is not allowed for public_url delivery mode');
      }
      // E1: this URL is stored AND published into the runtime's tenant
      // allowlist, so an unvalidated one is trusted twice over. Validate at the
      // point of registration, where the person can still fix it.
      await assertPublicUrl(input.endpointUrl, { context: 'custom-mcp-servers.create' });
      endpointUrl = input.endpointUrl;
    } else {
      if (!input.tunnelRouteId) {
        throw new Error('tunnelRouteId is required for tunneled delivery mode');
      }
      const route = await tunnelsService.getRoute(tenantId, input.tunnelRouteId);
      if (!route) {
        throw new Error('Tunnel route not found for this tenant');
      }
      endpointUrl = route.publicUrl;
      tunnelRouteId = route.id;
    }

    // 1. Create the connector row in connector-service first. connector-service
    //    owns the canonical /api/connectors listing the frontend reads, so the
    //    row must exist there for the new connector to show up in the
    //    Connections UI. If this fails, abort before any local writes — no
    //    orphaned local state.
    //
    //    Pass status='active' because custom_mcp_server has no OAuth callback
    //    to flip it later — the credentials are supplied directly in this
    //    call, and the server is immediately usable. Default 'pending' would
    //    leave it permanently hidden from the UI's status filter.
    //
    //    The returned `connectorId` IS the row's identity in custom_mcp_servers
    //    (PK = connector_id post migration 268). Auth secrets are also keyed
    //    off it so the canonical id flows through every persisted artifact.
    const config = { deliveryMode: input.deliveryMode, endpointUrl };
    const remoteConnector = await createConnectorForTenant(
      tenantId,
      CUSTOM_MCP_SERVER_CONNECTOR_TYPE,
      input.name,
      config,
      accountId,
      'active',
    );
    const connectorId = remoteConnector.id;

    // Persist any auth credential BEFORE opening a DB transaction. Secret
    // Manager calls are slow (hundreds of ms, occasional retries) and must
    // not live inside BEGIN/COMMIT — a slow secret write that times out the
    // Postgres connection leaves the txn in an undefined state and widens
    // the window for orphaned connector-service rows.
    let authSecretName: string | null = null;
    if (input.authType !== 'none') {
      authSecretName = await this.persistAuthSecret(tenantId, connectorId, {
        authType: input.authType,
        apiKey: input.apiKey,
        bearerToken: input.bearerToken,
        customHeaders: input.customHeaders,
      });
    }

    const client = await pool.connect();
    let server: CustomMcpServer;
    try {
      await client.query('BEGIN');
      // RLS: scope this own-transaction to the tenant before the connectors
      // (RLS-enabled) INSERT. FORCE-safe; set_config is transaction-local.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

      // 2. Mirror the connector row into platform-backend's local DB. The
      //    existing FK on custom_mcp_servers.connector_id and other
      //    in-process consumers (operator-dashboard, integration-enrichment,
      //    harvest-router) read from this local table, so keeping the row
      //    here avoids changing every read-side. The id is the same UUID
      //    connector-service issued so the two are always paired.
      await client.query(
        `INSERT INTO connectors (id, tenant_id, type, name, status, config)
         VALUES ($1, $2, $3, $4, 'active', $5::jsonb)`,
        [
          connectorId,
          tenantId,
          CUSTOM_MCP_SERVER_CONNECTOR_TYPE,
          input.name,
          JSON.stringify(config),
        ],
      );

      const serverResult = await client.query(
        `INSERT INTO custom_mcp_servers
           (tenant_id, name, delivery_mode, endpoint_url, auth_type, auth_secret_name, tunnel_route_id, raw_mcp_tools, connector_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, $8)
         RETURNING *`,
        [
          tenantId,
          input.name,
          input.deliveryMode,
          endpointUrl,
          input.authType,
          authSecretName,
          tunnelRouteId,
          connectorId,
        ],
      );

      server = mapRow(serverResult.rows[0]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      // Compensate: roll back the connector-service row too so we don't leak
      // an orphan connector — one that shows up in the UI but has no paired
      // custom_mcp_servers row, so the delete button silently no-ops in
      // ManageCustomMcpServerModal. Retry with backoff because a single
      // transient failure here was the original root cause of duplicate tiles.
      await this.compensateConnectorCreate(connectorId, accountId, tenantId);
      throw error;
    } finally {
      client.release();
    }

    // Run discovery outside the transaction so a transient MCP failure
    // doesn't roll back the connector + server row. A failed discovery
    // leaves raw_mcp_tools empty; the customer can re-run rediscover.
    try {
      await this.runDiscovery(server, input);
    } catch (error) {
      log.warn(
        { error, serverId: server.id },
        'Initial discovery failed; raw_mcp_tools left empty. Customer can retry via rediscover.',
      );
    }

    const refreshed = await this.get(tenantId, server.id);
    return refreshed ?? server;
  }

  async update(
    tenantId: string,
    connectorId: string,
    patch: UpdateCustomMcpServerInput,
  ): Promise<CustomMcpServer | null> {
    const existing = await this.get(tenantId, connectorId);
    if (!existing) return null;

    const name = patch.name ?? existing.name;

    // A tunnel owns its endpoint (it is resolved from the tunnel route), so an
    // endpointUrl sent for a tunneled server is ignored rather than rejected —
    // the editor disables the field, and a client that sends it anyway should
    // not have its name change fail with it.
    const endpointUrl =
      existing.deliveryMode === 'public_url' && patch.endpointUrl
        ? patch.endpointUrl
        : existing.endpointUrl;

    const authType = patch.authType ?? existing.authType;

    // Rewrite the secret only when this call actually carries a credential.
    // The editor renders the stored value masked and cannot read it back, so
    // "changed the URL, left auth alone" arrives with no credential fields and
    // must keep the existing secret rather than blank it.
    const carriesCredential =
      patch.apiKey !== undefined
      || patch.bearerToken !== undefined
      || (patch.customHeaders !== undefined && patch.customHeaders.length > 0);

    let authSecretName = existing.authSecretName;
    if (authType === 'none') {
      // Dropping auth entirely: forget the pointer. The secret version itself
      // is left in Secret Manager rather than destroyed — a customer who flips
      // this by mistake can be restored by re-entering the value, and secret
      // deletion is the one step of this that cannot be undone.
      authSecretName = null;
    } else if (carriesCredential) {
      authSecretName = await this.persistAuthSecret(tenantId, connectorId, {
        authType,
        apiKey: patch.apiKey,
        bearerToken: patch.bearerToken,
        customHeaders: patch.customHeaders,
      });
    }

    const result = await pool.query(
      `UPDATE custom_mcp_servers
          SET name = $1,
              endpoint_url = $2,
              auth_type = $3,
              auth_secret_name = $4,
              updated_at = NOW()
        WHERE connector_id = $5
        RETURNING *`,
      [name, endpointUrl, authType, authSecretName, connectorId],
    );

    // The Connections page reads the connector row's name, not this one, so a
    // rename that stops here shows the old label until a hard refresh.
    if (patch.name && patch.name !== existing.name) {
      await withTenantScope(tenantId, (client) => client.query(
        `UPDATE connectors SET name = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
        [patch.name, connectorId, tenantId],
      ));
    }

    // An edit is the user asserting the server is reachable again. Clearing
    // the error lets the probe re-confirm it rather than leaving a Reconnect
    // card up next to a server the customer just fixed. If they were wrong,
    // the next probe puts it straight back.
    await withTenantScope(tenantId, (client) => client.query(
      `UPDATE connectors SET status = 'active', updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = 'error'`,
      [connectorId, tenantId],
    ));

    return mapRow(result.rows[0]);
  }

  async delete(tenantId: string, accountId: string, connectorId: string): Promise<boolean> {
    const existing = await this.get(tenantId, connectorId);
    if (!existing) return false;
    // The FK custom_mcp_servers.connector_id → connectors(id) cascades from
    // connectors → custom_mcp_servers, not the reverse. Delete the local
    // connectors row first so the cascade removes the paired custom_mcp_servers
    // row in one shot; otherwise the local connectors row leaks (not
    // user-visible — the UI reads connector-service — but adds drift).
    const result = await withTenantScope(tenantId, (client) => client.query(
      `DELETE FROM connectors WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [existing.connectorId, tenantId],
    ));
    if ((result.rowCount ?? 0) === 0) {
      // Local connectors row already gone; ensure custom_mcp_servers is too.
      await pool.query(
        `DELETE FROM custom_mcp_servers WHERE connector_id = $1 AND tenant_id = $2`,
        [connectorId, tenantId],
      );
    }
    // Delete the canonical row in connector-service. Retry on transient
    // failure so a network blip can't leave an orphan tile that the UI
    // can't dismiss.
    await this.compensateConnectorCreate(existing.connectorId, accountId, tenantId);
    return true;
  }

  async rediscover(
    tenantId: string,
    id: string,
    onProgress: ProgressCallback,
  ): Promise<CustomMcpServer | null> {
    const existing = await this.get(tenantId, id);
    if (!existing) return null;

    const credentials = await this.readAuthSecret(existing);
    const output = await discoverCustomMcpServerWithProgress(
      {
        endpointUrl: existing.endpointUrl,
        name: existing.name,
        authType: existing.authType,
        apiKey: credentials?.apiKey,
        bearerToken: credentials?.bearerToken,
        customHeaders: credentials?.customHeaders,
        tenantId,
        // The server has classifications under its own identity already;
        // the pipeline reuses the current ones and classifies the rest.
        rediscoverServerId: existing.id,
      },
      onProgress,
    );

    await persistCustomMcpServerTools(existing.id, output);
    await this.cacheToolClassifications(existing, output);
    return this.get(tenantId, id);
  }

  /**
   * The version string the runtime stores per custom-MCP cache entry and
   * compares on every refresh tick, returned by BOTH internal endpoints
   * (1b). `<updatedAt>|<classifier>` where `classifier` is `off` while the
   * classifier kill is off and otherwise the classification version. The
   * runtime never parses it. A flag flip or a version bump therefore changes
   * the version for every server on the next tick with no row written.
   */
  cacheVersion(server: Pick<CustomMcpServer, 'updatedAt'>): string {
    return customMcpCacheVersion(server);
  }

  /**
   * The effect classes stored for this server's tools (1b), keyed by bare
   * tool name. Empty while the classifier kill is off: the runtime then maps
   * the payload with no effect class appended and every custom tool returns
   * to UNSPECIFIED, while the stored values are kept for when the flag
   * returns.
   */
  async effectClassesFor(server: CustomMcpServer): Promise<Record<string, string>> {
    if (!isTypeSafeClassifierEnabled()) return {};
    const names = server.rawMcpTools.map((t) => t.name);
    try {
      return await toolClassifier.getEffectClasses(
        names,
        customMcpClassificationIntegrationType(server.id),
        server.tenantId,
      );
    } catch (err) {
      log.warn({ err: (err as Error).message, serverId: server.id }, 'effect class read failed; none carried');
      return {};
    }
  }

  // ---- Helpers --------------------------------------------------------

  /**
   * Soft-delete a connector-service row after a failed create. Retries with
   * exponential backoff up to ~14s total so a transient connector-service
   * blip doesn't strand an orphan that shows up in the UI but cannot be
   * deleted (no paired custom_mcp_servers row → ManageCustomMcpServerModal
   * can't resolve a server id → delete button no-ops).
   *
   * If every retry fails, logs at error level. The UI delete-button
   * fallback in ManageCustomMcpServerModal still lets the user clear the
   * orphan manually via DELETE /api/connectors/:id.
   */
  private async compensateConnectorCreate(
    connectorId: string,
    accountId: string,
    tenantId: string,
  ): Promise<void> {
    const delaysMs = [0, 500, 2_000, 5_000, 7_000];
    for (let attempt = 0; attempt < delaysMs.length; attempt++) {
      if (delaysMs[attempt] > 0) {
        await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      }
      try {
        await deleteConnectorForTenant(connectorId, accountId);
        return;
      } catch (cleanupErr) {
        const isLast = attempt === delaysMs.length - 1;
        log[isLast ? 'error' : 'warn'](
          { cleanupErr, connectorId, tenantId, attempt: attempt + 1 },
          isLast
            ? 'Failed to roll back connector-service row after all retries; orphan tile is now visible but user-deletable via DELETE /api/connectors fallback'
            : 'Compensation soft-delete attempt failed; retrying',
        );
      }
    }
  }

  private async runDiscovery(
    server: CustomMcpServer,
    input: CreateCustomMcpServerInput,
  ): Promise<void> {
    const output = await discoverCustomMcpServerWithProgress(
      {
        endpointUrl: server.endpointUrl,
        name: server.name,
        authType: server.authType,
        apiKey: input.apiKey,
        bearerToken: input.bearerToken,
        customHeaders: input.customHeaders,
        tenantId: server.tenantId,
      },
      () => {
        /* noop — non-streaming create path */
      },
    );
    await persistCustomMcpServerTools(server.id, output);
    await this.cacheToolClassifications(server, output);
  }

  /**
   * Cache the discovery-time tool classifications into
   * tool_classification_cache under the per-instance namespace
   * `custom_mcp_server:{serverId}`. Without this, every first tool call
   * triggers a runtime classification (slow + LLM cost) and meanwhile
   * falls back to FAIL_SECURE_DEFAULT_CATEGORIES — every action HITLs.
   *
   * Mirrors the cacheClassification loop in external-agents/service.ts.
   */
  private async cacheToolClassifications(
    server: CustomMcpServer,
    output: DiscoverOutput,
  ): Promise<void> {
    const integrationType = customMcpClassificationIntegrationType(server.id);
    for (const [toolName, categories] of Object.entries(output.toolClassifications || {})) {
      const tool = output.rawMcpTools.find((t) => t.name === toolName);
      const description = tool?.description ?? '';
      const effectClass = output.toolEffectClasses?.[toolName] ?? null;
      try {
        await toolClassifier.cacheClassification(
          toolName,
          integrationType,
          toolClassifier.hashDescription(description),
          categories,
          undefined,
          {
            tenantId: server.tenantId,
            // 1b: persisted beside the classification; the internal endpoint
            // returns it per tool. A classification with no confident class
            // writes NULL, and a reused cached row re-writes the class it had.
            effectClass,
            classificationVersion: output.toolClassificationVersions?.[toolName] ?? null,
          },
        );
      } catch (err) {
        log.warn(
          { err, serverId: server.id, toolName },
          'Failed to cache custom MCP server tool classification',
        );
      }
    }
  }

  private async persistAuthSecret(
    tenantId: string,
    connectorId: string,
    credentials: {
      authType: AuthType;
      apiKey?: string;
      bearerToken?: string;
      customHeaders?: CustomHeader[];
    },
  ): Promise<string> {
    // Use the canonical per-tenant connector secret name + project
    // (`connector-{tenantId}-{connectorId}` in the project resolved by
    // TENANT_HOSTING_MODE). Same shape every OAuth / API-key connector
    // uses via liftoff-connector-service/src/secrets/client.ts.
    // Previously this used a bespoke `custom-mcp-server-{serverId}-{tenantId}`
    // pattern in PB's own project, which meant tenant-runtime — running
    // in a different project — had no way to locate the secret.
    const secretName = getConnectorSecretName(tenantId, connectorId);
    const projectId = resolveSecretProjectId(tenantId);

    try {
      await secretManagerClient.createSecret({
        parent: `projects/${projectId}`,
        secretId: secretName,
        secret: { replication: { automatic: {} } },
      });
    } catch (error) {
      if (!(error as Error).message?.includes('ALREADY_EXISTS')) throw error;
    }

    await secretManagerClient.addSecretVersion({
      parent: `projects/${projectId}/secrets/${secretName}`,
      payload: {
        data: Buffer.from(
          JSON.stringify({
            authType: credentials.authType,
            apiKey: credentials.apiKey,
            bearerToken: credentials.bearerToken,
            customHeaders: credentials.customHeaders,
          }),
        ),
      },
    });

    return secretName;
  }

  /**
   * The server's credential, resolved HERE and handed to the execution plane.
   *
   * tenant-runtime used to read this secret itself. It cannot: the secret lives
   * in the control-plane project (this service's own), and the tenant runtime's
   * service account holds `roles/cloudsql.client` there and nothing else — no
   * `secretmanager.secretAccessor`, and no secret-level binding either. So the
   * read fails for every custom MCP server, the handler refuses to connect
   * unauthenticated, and the server contributes NO tools while looking
   * correctly configured on the connections page.
   *
   * Granting the runtime access per secret would work once and then need doing
   * again for every server any customer ever connects — a step nobody would
   * remember, failing silently when missed. This service already owns the
   * secret and already answers an authenticated service-to-service call for the
   * rest of the config, so the credential travels with it.
   */
  async resolveRuntimeCredentials(
    tenantId: string,
    connectorId: string,
  ): Promise<{ apiKey?: string; bearerToken?: string; customHeaders?: CustomHeader[] } | null> {
    const server = await this.get(tenantId, connectorId);
    if (!server || server.authType === 'none') return null;
    return this.readAuthSecret(server);
  }

  private async readAuthSecret(server: CustomMcpServer): Promise<{
    apiKey?: string;
    bearerToken?: string;
    customHeaders?: CustomHeader[];
  } | null> {
    if (!server.authSecretName) return null;
    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) return null;

    try {
      const [version] = await secretManagerClient.accessSecretVersion({
        name: `projects/${projectId}/secrets/${server.authSecretName}/versions/latest`,
      });
      const payload = version.payload?.data?.toString();
      if (!payload) return null;
      return JSON.parse(payload);
    } catch (error) {
      log.error({ error, serverId: server.id }, 'Failed to read custom MCP server credentials');
      return null;
    }
  }
}

export const customMcpServerService = new CustomMcpServerService();
