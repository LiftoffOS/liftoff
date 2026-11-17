// Custom MCP Server tool dispatch.
//
// Mirrors external-agent-handler.ts but resolves config from platform-backend's
// unified connection runtime-config door:
//   GET /api/internal/connections/:connectorId/runtime-config?tenantId=
// which dispatches on connector type and returns a discriminated union; for a
// custom_mcp_server it returns { type: 'custom_mcp_server', config: <row> }.
// (Replaces the legacy per-type /api/internal/custom-mcp-servers/by-id call —
// every runtime lookup now goes through the one door.) The transport
// instantiation uses the same createTransportSync() pattern as MCP external
// agents.
//
// HITL / connector allowlist enforcement happens upstream in service.ts via
// the standard connector machinery — custom_mcp_servers are first-class
// connectors row entries, so existing IntegrationPermission[] gates apply.

import { logger } from '../infrastructure/logging';
import { createTransportSync } from './transports';
import type { MCPTransport, TransportType } from './transports';
import { assertMcpUrlAllowed, assertAllowlistMatchesTenant } from '../security/mcp-url-guard';
import type { TenantAllowlistContext } from '../security/mcp-url-guard';
import { getTenantAllowlistProvider } from '../security/tenant-allowlist-provider';
import { interpretMcpToolCallResult, inputRequiredError } from './mcp-result';
import { getManagedSecret } from '../infrastructure/secret-store';

interface CustomMcpServerConfig {
  id: string;
  tenantId: string;
  name: string;
  deliveryMode: 'public_url' | 'tunneled';
  endpointUrl: string;
  authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers';
  authSecretName: string | null;
  /**
   * Full Secret Manager resource path returned by PB
   * (`projects/{project}/secrets/{name}/versions/latest`). PB writes
   * secrets in its own project, not the tenant project we run in, so
   * this is the only safe way to find the secret. Falls back to the
   * legacy name-only path for older PB responses.
   */
  authSecretResourceName?: string | null;
  rawMcpTools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

interface CustomMcpServerCredentials {
  authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers';
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: Array<{ key: string; value: string }>;
}

interface ExecuteInput {
  tenantId: string;
  customMcpServerId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  traceId: string;
}

interface ExecuteResult {
  success: boolean;
  data: unknown;
  traceId: string;
  error?: string;
}

const CONFIG_CACHE_TTL_MS = 30_000;
/** PB-supplied credential, cached with the config it arrived alongside. */
interface CachedConnection {
  config: CustomMcpServerConfig;
  credentials?: { apiKey?: string; bearerToken?: string; customHeaders?: Array<{ key: string; value: string }> };
  fetchedAt: number;
}
const configCache = new Map<string, CachedConnection>();

export class CustomMcpServerHandler {
  private readonly controlPlaneUrl: string;
  private readonly controlPlaneToken: string;

  constructor() {
    this.controlPlaneUrl = process.env.PLATFORM_BACKEND_URL || '';
    // PB's custom-mcp internal endpoints use verifyServiceAuth() with the
    // default env var, which is TENANT_RUNTIME_SERVICE_TOKEN. The previous
    // fallback chain (PLATFORM_BACKEND_SERVICE_TOKEN || CONNECTOR_SERVICE_TOKEN)
    // sent the connector-service shared secret, which PB rejects with 401 —
    // every custom_mcp_server config fetch has been silently failing across
    // every tenant since this feature shipped. Use the same env var every
    // other TR -> PB caller already uses (platform-backend-client.ts,
    // entitlements-client/service.ts, reflection-engine/http-client.ts,
    // coordinator/http-client.ts).
    this.controlPlaneToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN') || '';
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const { tenantId, customMcpServerId, toolName, toolInput, traceId } = input;

    const config = await this.getConfig(tenantId, customMcpServerId);
    if (!config) {
      throw new Error(`Custom MCP server ${customMcpServerId} not found for tenant ${tenantId}`);
    }

    // Credentials live under the canonical per-tenant secret name
    // (`connector-{tenantId}-{connectorId}`) in the project resolved by
    // TENANT_HOSTING_MODE. customMcpServerId IS the connectorId post
    // migration 268 (= connectors.id). getCredentials builds the
    // canonical path from those two values.
    const credentials: CustomMcpServerCredentials =
      config.authType === 'none'
        ? { authType: 'none' }
        // `config.authSecretName` for the same reason resolveVendorEntry passes
        // it: deriving the name looks for one no custom MCP server has ever had.
        : await this.getCredentials(tenantId, customMcpServerId, config.authType, config.authSecretName ?? undefined);

    const tenantAllowlist = await getTenantAllowlistProvider().get(tenantId);
    assertAllowlistMatchesTenant(tenantAllowlist, tenantId);
    return this.executeMcpToolCall(config, credentials, toolName, toolInput, traceId, tenantAllowlist);
  }

  /**
   * A connected transport for the daily binding probe, or null if this server
   * has no resolvable config.
   *
   * Deliberately goes through the same config door, the same credential
   * lookup, and the same SSRF/allowlist guards a real dispatch does. A probe
   * that took a shortcut past any of them would answer a different question
   * than "would a tool call work right now", which is the only question worth
   * asking about a customer's own server.
   *
   * The caller owns closing the transport.
   */
  async buildProbeTransport(
    tenantId: string,
    customMcpServerId: string,
  ): Promise<MCPTransport | null> {
    const config = await this.getConfig(tenantId, customMcpServerId);
    if (!config) return null;

    const credentials: CustomMcpServerCredentials =
      config.authType === 'none'
        ? { authType: 'none' }
        // `config.authSecretName` for the same reason resolveVendorEntry passes
        // it: deriving the name looks for one no custom MCP server has ever had.
        : await this.getCredentials(tenantId, customMcpServerId, config.authType, config.authSecretName ?? undefined);

    const tenantAllowlist = await getTenantAllowlistProvider().get(tenantId);
    assertAllowlistMatchesTenant(tenantAllowlist, tenantId);
    assertMcpUrlAllowed(config.endpointUrl, tenantAllowlist);

    return createTransportSync(
      'streamable-http' as Exclude<TransportType, 'a2a'>,
      {
        endpointUrl: config.endpointUrl,
        authType: credentials.authType,
        apiKey: credentials.apiKey,
        bearerToken: credentials.bearerToken,
        customHeaders: credentials.customHeaders,
        // Shorter than the 30s a dispatch allows. A probe is not doing the
        // customer's work, and a server this slow to answer tools/list is not
        // one an agent could have used anyway.
        timeout: 5_000,
      },
    );
  }

  private async executeMcpToolCall(
    config: CustomMcpServerConfig,
    credentials: CustomMcpServerCredentials,
    toolName: string,
    toolInput: Record<string, unknown>,
    traceId: string,
    tenantAllowlist: TenantAllowlistContext,
  ): Promise<ExecuteResult> {
    assertMcpUrlAllowed(config.endpointUrl, tenantAllowlist);

    const transport: MCPTransport = createTransportSync(
      'streamable-http' as Exclude<TransportType, 'a2a'>,
      {
        endpointUrl: config.endpointUrl,
        authType: credentials.authType,
        apiKey: credentials.apiKey,
        bearerToken: credentials.bearerToken,
        customHeaders: credentials.customHeaders,
        timeout: 30_000,
      },
    );

    try {
      await transport.connect();
      logger.debug(
        { traceId, endpoint: config.endpointUrl, toolName, customMcpServerId: config.id },
        'Executing custom MCP server tool call',
      );

      const result = await transport.request<unknown>('tools/call', {
        name: toolName,
        arguments: toolInput,
      });

      // Interpret the MCP 2026-07-28 envelope (shared with every tool-call path):
      //  - inputRequired (MRTR): needs interactive input mid-call, which this
      //    path can't provide — fail cleanly with a legible error.
      //  - isError: tool ran but returned an error result — surface as failure
      //    (content preserved in `data`).
      const { inputRequired, isError: isErrorResult } = interpretMcpToolCallResult(result);
      if (inputRequired) {
        return { success: false, data: null, traceId, error: inputRequiredError(toolName) };
      }
      return {
        success: !isErrorResult,
        data: result,
        traceId,
        ...(isErrorResult ? { error: `MCP tool ${toolName} returned an error result` } : {}),
      };
    } catch (error) {
      logger.warn(
        { traceId, endpoint: config.endpointUrl, toolName, err: (error as Error).message },
        'Custom MCP server tool call failed',
      );
      return { success: false, data: null, traceId, error: (error as Error).message };
    } finally {
      transport.close();
    }
  }

  /** Resolve a custom MCP server into the SDK-compatible vendor entry shape
   *  used by tool-gateway/mcp-server.ts:resolveVendorMcpServers so the
   *  SDK auto-discovers its tools via the MCP `tools/list` protocol. The
   *  dispatcher already knows how to talk to PB for `tools/call`; this
   *  helper makes the same plumbing reachable at catalog-construction
   *  time. Returns null when the server isn't found or the URL fails the
   *  tenant allowlist (security guard fires here too). */
  async resolveVendorEntry(
    tenantId: string,
    customMcpServerId: string,
    tenantAllowlist: TenantAllowlistContext,
  ): Promise<{ type: 'http' | 'sse'; url: string; headers: Record<string, string> } | null> {
    const config = await this.getConfig(tenantId, customMcpServerId);
    if (!config) return null;
    try {
      assertMcpUrlAllowed(config.endpointUrl, tenantAllowlist);
    } catch (err) {
      logger.warn(
        { tenantId, customMcpServerId, err: (err as Error).message },
        'custom_mcp_vendor_entry_rejected_by_allowlist',
      );
      return null;
    }
    const headers: Record<string, string> = {};
    if (config.authType === 'api_key' || config.authType === 'bearer_token' || config.authType === 'custom_headers') {
      // This comment described the correct behaviour before the code did it.
      // It said to use the stored authSecretName rather than the canonical
      // `connector-{tenantId}-{connectorId}` that getCredentials derives — and
      // the very next line called getCredentials, which derived exactly that.
      // Someone diagnosed this precisely and the fix never reached the call.
      // Left as a note because a comment stating an intent the code contradicts
      // is worse than no comment: it reads as verification to the next person.
      const creds = await this.getCredentials(
        tenantId,
        customMcpServerId,
        config.authType,
        // The name PB actually stored the secret under. Deriving it instead —
        // which this did — looks for `connector-<tenantId>-<connectorId>`, a
        // name no custom MCP server has ever had.
        config.authSecretName,
      );
      if (config.authType === 'bearer_token' && creds.bearerToken) {
        headers.Authorization = `Bearer ${creds.bearerToken}`;
      } else if (config.authType === 'api_key' && creds.apiKey) {
        headers['X-API-Key'] = creds.apiKey;
      } else if (config.authType === 'custom_headers' && creds.customHeaders) {
        for (const h of creds.customHeaders) {
          if (h.key) headers[h.key] = h.value;
        }
      } else {
        // A server that DECLARES auth and produced no credential must not be
        // called anyway. The previous behaviour returned the entry with empty
        // headers and let the request go out unauthenticated, so the vendor
        // answered 401 and the log read `vendor_mcp_enumerate_auth_failed` — as
        // though the credential had been rejected rather than never sent.
        //
        // The result would be that every enumeration answers 401, the catalog
        // holds zero tools, and the agent falls back to `curl` through
        // shell_exec — raising a destructive-tool approval on a documentation
        // lookup — with only a warn line to show for it. Dropping authentication
        // is not a fallback: there is no case where silently proceeding without
        // it beats stopping.
        logger.error(
          {
            tenantId,
            customMcpServerId,
            authType: config.authType,
            secretName: config.authSecretName,
            url: config.endpointUrl,
          },
          'custom MCP server declares auth but no credential resolved — refusing to connect unauthenticated',
        );
        return null;
      }
    }
    // The custom MCP server registry only supports streamable-http today;
    // 'sse' is reserved for future transports. Default to 'http'.
    return { type: 'http', url: config.endpointUrl, headers };
  }

  private async getConfig(tenantId: string, customMcpServerId: string): Promise<CustomMcpServerConfig | null> {
    const cacheKey = `${tenantId}:${customMcpServerId}`;
    const cached = configCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CONFIG_CACHE_TTL_MS) {
      return cached.config;
    }

    try {
      // Unified connection runtime-config door. customMcpServerId IS the
      // connectors.id (= the path param) post migration 268.
      const url = new URL(
        `${this.controlPlaneUrl}/api/internal/connections/${encodeURIComponent(customMcpServerId)}/runtime-config`,
      );
      url.searchParams.set('tenantId', tenantId);

      const response = await fetch(url.toString(), {
        headers: {
          'X-Service-Auth': this.controlPlaneToken,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to fetch custom MCP server config: ${response.status}`);
      }

      // Discriminated-union response keyed on `type`. For a custom_mcp_server
      // the row we need is nested under `.config`.
      const body = (await response.json()) as {
        type?: string;
        config?: CustomMcpServerConfig;
        credentials?: { apiKey?: string; bearerToken?: string; customHeaders?: Array<{ key: string; value: string }> };
      };
      if (body.type !== 'custom_mcp_server' || !body.config) {
        logger.warn(
          { tenantId, customMcpServerId, type: body.type },
          'runtime-config door returned a non-custom_mcp_server connection',
        );
        return null;
      }
      const config = body.config;
      configCache.set(cacheKey, { config, credentials: body.credentials, fetchedAt: Date.now() });
      return config;
    } catch (error) {
      logger.error(
        { tenantId, customMcpServerId, err: (error as Error).message },
        'Failed to fetch custom MCP server config',
      );
      return cached?.config || null;
    }
  }

  /**
   * Read a custom MCP server's credential.
   *
   * `storedSecretName` is the name PB actually created the secret under, handed
   * back on the config as `authSecretName`. It is passed rather than derived
   * because the two do not agree: PB names these
   * `custom-mcp-server-<serverId>-<tenantId>`, while getConnectorSecretName
   * builds the canonical per-connector name `connector-<tenantId>-<connectorId>`
   * that OAuth-credentialed connectors use. A custom MCP server has no secret
   * under that name and never has.
   *
   * Secret Manager answers a missing secret with PERMISSION_DENIED rather than
   * NOT_FOUND — deliberately, so a caller cannot probe for existence — so the
   * failure reads like a broken grant and sent this investigation after IAM
   * twice before the logged secretName settled it.
   *
   * The canonical name remains the fallback for any caller that has no stored
   * name, so nothing that works today changes.
   */
  private async getCredentials(
    tenantId: string,
    connectorId: string,
    authType: 'api_key' | 'bearer_token' | 'custom_headers',
    storedSecretName?: string,
  ): Promise<CustomMcpServerCredentials> {
    // PB's answer first. It owns the secret and it lives in PB's project, where
    // THIS service cannot read it: the tenant runtime's service account holds
    // `roles/cloudsql.client` on the control project and no secretAccessor, and
    // the secret carries no binding of its own. A read from here therefore
    // fails, the handler refuses to connect unauthenticated, and the server
    // contributes no tools — with the connections page still showing it healthy.
    //
    // Granting the runtime per-secret access would work once and be forgotten
    // for the next server anyone connects. Resolving it where it is owned, and
    // shipping it over the authenticated call we already make for the rest of
    // the config, needs nothing done again.
    const fromControlPlane = configCache.get(`${tenantId}:${connectorId}`)?.credentials;
    if (fromControlPlane
        && (fromControlPlane.apiKey || fromControlPlane.bearerToken || fromControlPlane.customHeaders?.length)) {
      return {
        authType,
        apiKey: fromControlPlane.apiKey,
        bearerToken: fromControlPlane.bearerToken,
        customHeaders: fromControlPlane.customHeaders,
      };
    }

    // Kept as the fallback rather than deleted: a dedicated-hosting tenant
    // resolves to its OWN project, where this read does work.
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    const { resolveSecretProjectId, getConnectorSecretName } = await import(
      '../infrastructure/connector-secrets'
    );
    const client = new SecretManagerServiceClient();
    const secretName = storedSecretName || getConnectorSecretName(tenantId, connectorId);
    const projectId = resolveSecretProjectId(tenantId);
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
      });
      const payload = version.payload?.data?.toString();
      if (!payload) {
        logger.error(
          { tenantId, connectorId, secretName, projectId },
          'custom MCP credential secret is empty',
        );
        return { authType: 'none' };
      }
      const parsed = JSON.parse(payload) as CustomMcpServerCredentials;
      return { ...parsed, authType };
    } catch (error) {
      // ERROR, not warn. A server that declares auth and cannot produce it is
      // broken, and every call it makes will be rejected. Logging the name and
      // project alongside is what turns this from "the vendor returned 401"
      // into "we asked for the wrong secret".
      logger.error(
        {
          tenantId, connectorId, secretName, projectId, authType,
          usedStoredName: !!storedSecretName,
          err: (error as Error).message,
        },
        'Failed to read custom MCP server credentials',
      );
      return { authType: 'none' };
    }
  }
}

export const customMcpServerHandler = new CustomMcpServerHandler();
