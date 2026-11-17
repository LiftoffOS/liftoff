// Connect-RPC server implementation for ConnectorService.
//
// Handlers are registered against the proto-defined service descriptor
// from @liftoffos/proto-gen. Every request is typed, every response is
// a proto message built via create() so the $typeName + defaults are
// populated by protobuf-es.
//
// Surface (see liftoff/connector/v1/connector_service.proto):
//   Execute        — single connector op
//   ExecuteBatch   — batched ops with per-item partial failure
//   Warm           — pre-fetch credentials for a set of connector TYPES
//   GetCredentials — fetch + auto-refresh credentials for one connector
//   GetFunctionalTypes — connector types with a resolvable MCP config
//   GetCapabilities    — capability groups + provider list + scopes
//   PrefetchThread     — read entity thread/comments and format as markdown for LLM context
//
// Auth: handled by verifyServiceAuth middleware mounted on the Express
// app before expressConnectMiddleware.

import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';
import { create, type JsonObject } from '@bufbuild/protobuf';
import { withSpan } from '@liftoffos/telemetry';
import { ConnectorService } from '@liftoffos/proto-gen';
import {
  ExecuteBatchResponseSchema,
  WarmResponseSchema,
  WarmFailureSchema,
  GetCredentialsResponseSchema,
  OauthCredentialsSchema,
  ApiKeyCredentialsSchema,
  KeypairCredentialsSchema,
  GetFunctionalTypesResponseSchema,
  GetCapabilitiesResponseSchema,
  ListToolsResponseSchema,
  ConnectorToolSetSchema,
  ReturnedIdsSchema,
  ToolDefinitionSchema,
  ListTenantConnectorsResponseSchema,
  ConnectorSummarySchema,
  GetMcpServerConfigResponseSchema,
  PrefetchThreadResponseSchema,
  MarkConnectorErrorResponseSchema,
  ClearConnectorErrorResponseSchema,
  LookupTenantConnectorResponseSchema,
  ListErroredConnectorsResponseSchema,
  ErroredConnectorSchema,
  McpTransport,
  type ExecuteRequest,
  type ExecuteResponse,
  type ExecuteBatchRequest,
  type ExecuteBatchResponse,
  type WarmRequest,
  type WarmResponse,
  type GetCredentialsRequest,
  type GetCredentialsResponse,
  type GetFunctionalTypesRequest,
  type GetFunctionalTypesResponse,
  type GetCapabilitiesRequest,
  type GetCapabilitiesResponse,
  type ListToolsRequest,
  type ListToolsResponse,
  type ListTenantConnectorsRequest,
  type ListTenantConnectorsResponse,
  type GetMcpServerConfigRequest,
  type GetMcpServerConfigResponse,
  type PrefetchThreadRequest,
  type PrefetchThreadResponse,
  type MarkConnectorErrorRequest,
  type MarkConnectorErrorResponse,
  type ClearConnectorErrorRequest,
  type ClearConnectorErrorResponse,
  type LookupTenantConnectorRequest,
  type LookupTenantConnectorResponse,
  type ListErroredConnectorsRequest,
  type ListErroredConnectorsResponse,
} from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_pb.js';
import {
  CapabilityEntrySchema,
  CapabilityProviderSchema,
  AuthFlowKind,
} from '@liftoffos/proto-gen/liftoff/connector/v1/types_pb.js';
import { getMCPServerConfig } from '../catalog/mcp-server-registry.js';
import { logger } from '../infra/logging.js';
import {
  credentialService,
  warmCredentialsByType,
  OAuthRefreshError,
} from '../credentials/service.js';
import {
  getFunctionalConnectorTypes,
  getCapabilityGroups,
} from '../catalog/capabilities.js';
import { listTools as listToolsFromRegistry } from '../catalog/tool-schemas.js';
import { connectorCrudService } from '../crud/service.js';
import { withTenantScope, withAdminScope } from '../db/pool.js';
import { runConnectorExecution } from './execute-dispatcher.js';
import { markConnectorReconnectRequired } from '../oauth/connector-ops.js';
import { formatThreadAsMarkdown } from '../context/thread-formatter.js';
import { v4 as uuidv4 } from 'uuid';
import { toolError, classifyError, isRetryable, type ToolErrorCode } from '@liftoffos/connector-types';
import { errorResponse } from './execute-error.js';

const SERVICE_NAME = 'liftoff-connector-service';

function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withSpan(SERVICE_NAME, name, undefined, async () => fn());
}

function extraToJsonObject(extra: Record<string, unknown> | undefined): JsonObject | undefined {
  if (!extra) return undefined;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function requireTenantId(
  req: { tenantContext?: { tenantId: string } },
  method: string,
): string {
  const tid = req.tenantContext?.tenantId;
  if (!tid || typeof tid !== 'string' || tid.length === 0) {
    throw new ConnectError(
      `${method}: tenantContext.tenantId is required`,
      Code.InvalidArgument,
    );
  }
  return tid;
}

function oauthRefreshToConnectError(err: OAuthRefreshError): ConnectError {
  let grpcCode: Code;
  switch (err.reason) {
    case 'reconnect_required':
    case 'no_refresh_token':
      grpcCode = Code.FailedPrecondition;
      break;
    case 'vendor_unavailable':
      grpcCode = Code.Unavailable;
      break;
    default:
      grpcCode = Code.Internal;
  }
  // OAuth-refresh errors stay a THROWN ConnectError (not an in-band
  // success:false response) — this preserves the FailedPrecondition contract +
  // the markConnectorReconnectRequired status-flip. Attach the taxonomy to the
  // ConnectError metadata so TR reads x-tool-error-code directly instead of
  // re-guessing from the gRPC code alone. Connect-RPC propagates
  // ConnectError.metadata to the client.
  const toolErrorCode: ToolErrorCode =
    err.reason === 'vendor_unavailable' ? 'vendor_unavailable' : 'auth_expired';
  const ce = new ConnectError(err.message, grpcCode);
  ce.metadata.set('x-tool-error-code', toolErrorCode);
  ce.metadata.set('x-tool-retryable', String(isRetryable(toolErrorCode)));
  return ce;
}

function flowKindStringToProto(flow: string): AuthFlowKind {
  switch (flow) {
    case 'static_oauth':
      return AuthFlowKind.STATIC_OAUTH;
    case 'dynamic_client_registration':
      return AuthFlowKind.DYNAMIC_CLIENT_REGISTRATION;
    case 'api_key':
      return AuthFlowKind.API_KEY;
    case 'keypair':
      return AuthFlowKind.KEYPAIR;
    case 'none':
      return AuthFlowKind.NONE;
    default:
      return AuthFlowKind.UNSPECIFIED;
  }
}

export default function registerConnectorService(router: ConnectRouter): ConnectRouter {
  return router.service(ConnectorService, {
    // ── Execute ───────────────────────────────────────────────────────
    async execute(
      req: ExecuteRequest,
      _ctx: HandlerContext,
    ): Promise<ExecuteResponse> {
      const tenantId = requireTenantId(req, 'Execute');
      if (!req.connectorId) {
        throw new ConnectError(
          'Execute: connectorId is required (UUID). Type-alias dispatch is no longer supported.',
          Code.InvalidArgument,
        );
      }
      return traced('Execute', async () => {
        try {
          return await runConnectorExecution({
            tenantId,
            connectorId: req.connectorId,
            functionName: req.functionName,
            input: req.input ?? {},
            idempotencyKey: req.idempotencyKey,
            traceId: req.traceId,
            agentId: req.agentId,
            actionId: req.actionId,
          });
        } catch (err) {
          if (err instanceof OAuthRefreshError) {
            await markConnectorReconnectRequired(err.tenantId, err.connectorId, err.vendor);
            throw oauthRefreshToConnectError(err);
          }
          if (err instanceof ConnectError) throw err;
          logger.error(
            { err: (err as Error).message, connectorId: req.connectorId },
            'Execute failed',
          );
          throw new ConnectError((err as Error).message, Code.Internal);
        }
      });
    },

    // ── PrefetchThread ────────────────────────────────────────────────
    async prefetchThread(
      req: PrefetchThreadRequest,
      _ctx: HandlerContext,
    ): Promise<PrefetchThreadResponse> {
      const tenantId = requireTenantId(req, 'PrefetchThread');
      if (!req.connectorId || !req.entityType || !req.entityId) {
        throw new ConnectError(
          'PrefetchThread: connectorId, entityType, entityId required',
          Code.InvalidArgument,
        );
      }
      return traced('PrefetchThread', async () => {
        try {
          const connector = await connectorCrudService.getById(req.connectorId, tenantId);
          if (!connector) {
            return create(PrefetchThreadResponseSchema, {
              success: false, content: '', error: 'connector not found',
            });
          }
          const result = await runConnectorExecution({
            tenantId,
            connectorId: req.connectorId,
            functionName: `read_${req.entityType}`,
            input: { id: req.entityId },
            idempotencyKey: uuidv4(),
            traceId: req.traceId ?? '',
          });
          if (!result.success) {
            return create(PrefetchThreadResponseSchema, {
              success: false, content: '', error: result.error ?? 'read failed',
            });
          }
          const formatted = formatThreadAsMarkdown(connector.type, req.entityType, result.result);
          if (!formatted) {
            return create(PrefetchThreadResponseSchema, {
              success: false, content: '', error: 'connector returned no data',
            });
          }
          return create(PrefetchThreadResponseSchema, {
            success: true, content: formatted, error: '',
          });
        } catch (err) {
          logger.warn(
            { connectorId: req.connectorId, entityType: req.entityType, err: (err as Error).message },
            'PrefetchThread failed',
          );
          return create(PrefetchThreadResponseSchema, {
            success: false, content: '', error: (err as Error).message,
          });
        }
      });
    },

    // ── ExecuteBatch ──────────────────────────────────────────────────
    async executeBatch(
      req: ExecuteBatchRequest,
      _ctx: HandlerContext,
    ): Promise<ExecuteBatchResponse> {
      const tenantId = requireTenantId(req, 'ExecuteBatch');
      return traced('ExecuteBatch', async () => {
        // Per-item partial failure: the batch itself always returns 200;
        // each op reports its own success/error in results[i].
        const results: ExecuteResponse[] = [];
        for (const op of req.operations) {
          try {
            const res = await runConnectorExecution({
              tenantId,
              connectorId: op.connectorId,
              functionName: op.functionName,
              input: op.input ?? {},
              idempotencyKey: op.idempotencyKey,
              traceId: op.traceId,
              agentId: op.agentId,
              actionId: op.actionId,
            });
            results.push(res);
          } catch (err) {
            // A batch item cannot throw per-item (it must return a response),
            // so an OAuthRefreshError here is classified inline AND still flips
            // the connector status like the single Execute path. Mirror
            // oauthRefreshToConnectError's reason→code mapping so batch and
            // single Execute agree (vendor outage → vendor_unavailable, else
            // reconnect → auth_expired).
            if (err instanceof OAuthRefreshError) {
              await markConnectorReconnectRequired(err.tenantId, err.connectorId, err.vendor);
              const code = err.reason === 'vendor_unavailable' ? 'vendor_unavailable' : 'auth_expired';
              results.push(errorResponse(toolError(code, err.message)));
            } else {
              const code = classifyError({ message: (err as Error).message });
              results.push(errorResponse(toolError(code, (err as Error).message)));
            }
          }
        }
        return create(ExecuteBatchResponseSchema, { results });
      });
    },

    // ── Warm ──────────────────────────────────────────────────────────
    async warm(
      req: WarmRequest,
      _ctx: HandlerContext,
    ): Promise<WarmResponse> {
      const tenantId = requireTenantId(req, 'Warm');
      return traced('Warm', async () => {
        const result = await warmCredentialsByType(tenantId, req.connectorTypes);
        return create(WarmResponseSchema, {
          warmedConnectorTypes: result.warmedTypes,
          failures: result.failures.map((f) =>
            create(WarmFailureSchema, {
              connectorType: f.connectorType,
              reason: f.reason,
            }),
          ),
        });
      });
    },

    // ── GetCredentials ────────────────────────────────────────────────
    async getCredentials(
      req: GetCredentialsRequest,
      _ctx: HandlerContext,
    ): Promise<GetCredentialsResponse> {
      const tenantId = requireTenantId(req, 'GetCredentials');
      if (!req.connectorId) {
        throw new ConnectError(
          'GetCredentials: connectorId is required',
          Code.InvalidArgument,
        );
      }
      return traced('GetCredentials', async () => {
        try {
          const creds = await credentialService.getCredentials(tenantId, req.connectorId);
          const flowKind = flowKindStringToProto(creds.flowKind);

          switch (creds.flowKind) {
            case 'static_oauth':
            case 'dynamic_client_registration':
              return create(GetCredentialsResponseSchema, {
                flowKind,
                oauth: create(OauthCredentialsSchema, {
                  accessToken: creds.accessToken ?? '',
                  refreshToken: creds.refreshToken ?? '',
                  expiresAtEpochSec: creds.expiresAt
                    ? BigInt(Math.floor(creds.expiresAt.getTime() / 1000))
                    : 0n,
                  scopes: creds.scopes ?? [],
                }),
              });
            case 'api_key':
              return create(GetCredentialsResponseSchema, {
                flowKind,
                apiKey: create(ApiKeyCredentialsSchema, {
                  apiKey: creds.apiKey ?? '',
                  extra: extraToJsonObject(creds.extra),
                }),
              });
            case 'keypair':
              return create(GetCredentialsResponseSchema, {
                flowKind,
                keypair: create(KeypairCredentialsSchema, {
                  privateKey: creds.privateKey ?? '',
                }),
              });
            default:
              return create(GetCredentialsResponseSchema, { flowKind });
          }
        } catch (err) {
          if (err instanceof OAuthRefreshError) {
            await markConnectorReconnectRequired(err.tenantId, err.connectorId, err.vendor);
            throw oauthRefreshToConnectError(err);
          }
          if (err instanceof ConnectError) throw err;
          throw new ConnectError((err as Error).message, Code.Internal);
        }
      });
    },

    // ── GetFunctionalTypes ────────────────────────────────────────────
    async getFunctionalTypes(
      _req: GetFunctionalTypesRequest,
      _ctx: HandlerContext,
    ): Promise<GetFunctionalTypesResponse> {
      return traced('GetFunctionalTypes', async () =>
        create(GetFunctionalTypesResponseSchema, {
          connectorTypes: getFunctionalConnectorTypes(),
        }),
      );
    },

    // ── GetCapabilities ───────────────────────────────────────────────
    async getCapabilities(
      _req: GetCapabilitiesRequest,
      _ctx: HandlerContext,
    ): Promise<GetCapabilitiesResponse> {
      return traced('GetCapabilities', async () => {
        const groups = getCapabilityGroups();
        return create(GetCapabilitiesResponseSchema, {
          capabilities: groups.map((g) =>
            create(CapabilityEntrySchema, {
              capability: g.capability,
              providers: g.providers.map((p) =>
                create(CapabilityProviderSchema, {
                  connectorType: p.connectorType,
                  requiredScopes: p.requiredScopes,
                }),
              ),
            }),
          ),
        });
      });
    },

    // ── ListTools ─────────────────────────────────────────────────────
    async listTools(
      req: ListToolsRequest,
      _ctx: HandlerContext,
    ): Promise<ListToolsResponse> {
      // Require tenant context so callers can not bypass auth/tenancy
      // context for a surface tool-gateway depends on.
      requireTenantId(req, 'ListTools');
      return traced('ListTools', async () => {
        const result = listToolsFromRegistry({
          connectorTypes: req.connectorTypes,
          cachedVersion: req.cachedVersion,
        });
        return create(ListToolsResponseSchema, {
          version: result.version,
          unchanged: result.unchanged,
          toolSets: result.toolSets.map((set) =>
            create(ConnectorToolSetSchema, {
              connectorType: set.connectorType,
              displayName: set.displayName,
              tools: set.tools.map((t) =>
                create(ToolDefinitionSchema, {
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema as unknown as JsonObject,
                  categories: t.categories,
                  isWrite: t.isWrite,
                  // Provenance of `categories` (declared vs name-inferred), so
                  // the governance Authorize decision can trust a declared read.
                  classificationSource: t.classificationSource,
                  // Proto-gen v0.7.0 (W1.4): pass through metadata the
                  // registry has been carrying but never reached the wire.
                  draftVariant: t.draftVariant ?? '',
                  entityType: t.entityType ?? '',
                  workRole: t.workRole ?? '',
                  pairedAck: t.pairedAck ?? '',
                  acknowledges: t.acknowledges ?? '',
                  workItemKind: t.workItemKind ?? '',
                  // Proto-gen v0.8.0 (Composio cutover): dispatch-source marker
                  // + vendor tool name so tenant-runtime's stable-name router
                  // can pick the right dispatch path.
                  definitionSource: t.definitionSource ?? '',
                  vendorToolName: t.vendorToolName ?? '',
                  // Proto-gen v0.19.0: record provenance, host-only result
                  // fields, staged writes. Repeated fields take [] rather than
                  // undefined — proto-3 has no null for one, and the runtime
                  // reads an empty array as "not declared".
                  idArgs: t.idArgs ?? [],
                  returnsIds: (t.returnsIds ?? []).map((r) =>
                    create(ReturnedIdsSchema, { entityType: r.entityType, path: r.path }),
                  ),
                  egressOnly: t.egressOnly ?? [],
                  writeRole: t.writeRole ?? '',
                  pairedApply: t.pairedApply ?? '',
                }),
              ),
            }),
          ),
        });
      });
    },

    // ── ListTenantConnectors ──────────────────────────────────────────
    async listTenantConnectors(
      req: ListTenantConnectorsRequest,
      _ctx: HandlerContext,
    ): Promise<ListTenantConnectorsResponse> {
      const tenantId = requireTenantId(req, 'ListTenantConnectors');
      return traced('ListTenantConnectors', async () => {
        const rows = await connectorCrudService.listTenantConnectors(tenantId, {
          connectorTypes: req.connectorTypes,
          statuses: req.statuses,
        });
        return create(ListTenantConnectorsResponseSchema, {
          connectors: rows.map((r) =>
            create(ConnectorSummarySchema, {
              id: r.id,
              connectorType: r.connectorType,
              displayName: r.displayName,
              name: r.name,
              status: r.status,
              flowKind: flowKindStringToProto(r.flowKind),
              apiKeyHint: r.apiKeyHint,
              lastSyncAtEpochSec: BigInt(r.lastSyncAtEpochSec),
              createdAtEpochSec: BigInt(r.createdAtEpochSec),
              updatedAtEpochSec: BigInt(r.updatedAtEpochSec),
            }),
          ),
        });
      });
    },

    // ── GetMcpServerConfig ────────────────────────────────────────────
    //
    // Resolve the MCP server config for a connector instance.
    //   - Looks up the connector row by (tenantId, connectorId) so the
    //     caller doesn't need to have the type on hand.
    //   - Runs the static registry lookup, then applies any per-workspace
    //     `urlResolver` against the stored `connector.config` (Snowflake,
    //     Databricks) so the returned `mcp_url` is already fully resolved.
    //   - `exists=false` signals "this connector type has no MCP config"
    //     (REST-path connector). Callers should treat that as skip, not
    //     as an error — every connector type is a legitimate non-MCP
    //     candidate.
    async getMcpServerConfig(
      req: GetMcpServerConfigRequest,
      _ctx: HandlerContext,
    ): Promise<GetMcpServerConfigResponse> {
      const tenantId = requireTenantId(req, 'GetMcpServerConfig');
      if (!req.connectorId) {
        throw new ConnectError(
          'GetMcpServerConfig: connectorId is required',
          Code.InvalidArgument,
        );
      }
      return traced('GetMcpServerConfig', async () => {
        try {
          const connector = await connectorCrudService.getById(req.connectorId, tenantId);
          if (!connector) {
            throw new ConnectError(
              `Connector ${req.connectorId} not found for tenant ${tenantId}`,
              Code.NotFound,
            );
          }
          const mcpConfig = getMCPServerConfig(connector.type, connector.config);
          if (!mcpConfig) {
            // Composio cutover-completion (C5): composio_managed connectors
            // now produce no MCP server config (mcp-server-registry.ts skips
            // them) and land here as exists=false. tenant-runtime's
            // resolveVendorMcpServers treats absent the same as disabled,
            // and the in-process composio-dispatcher handles tool calls.
            return create(GetMcpServerConfigResponseSchema, { exists: false });
          }

          // vendor_hosted / sidecar branch — Bearer auth (legacy MCP path).
          return create(GetMcpServerConfigResponseSchema, {
            exists: true,
            isVendorHosted: mcpConfig.isVendorHosted,
            mcpUrl: mcpConfig.mcpUrl,
            transport: transportStringToProto(mcpConfig.transport),
            requiresBearerAuth: true,
            composioUserId: '',
          });
        } catch (err) {
          if (err instanceof ConnectError) throw err;
          logger.error(
            {
              err: (err as Error).message,
              stack: (err as Error).stack,
              connectorId: req.connectorId,
              tenantId,
            },
            'GetMcpServerConfig failed',
          );
          throw new ConnectError((err as Error).message, Code.Internal);
        }
      });
    },

    // ── MarkConnectorError ────────────────────────────────────────────
    async markConnectorError(
      req: MarkConnectorErrorRequest,
      _ctx: HandlerContext,
    ): Promise<MarkConnectorErrorResponse> {
      const tenantId = requireTenantId(req, 'MarkConnectorError');
      if (!req.connectorId || !req.errorCode) {
        throw new ConnectError(
          'MarkConnectorError: connectorId and errorCode required',
          Code.InvalidArgument,
        );
      }
      // The connectors.error_code column has a CHECK constraint that allows
      // exactly these two values. Validate at the RPC boundary so callers
      // get a clear InvalidArgument instead of a Postgres constraint error
      // at write time. Migration 014_connector_error_code.sql owns the
      // canonical list — update both sides in lockstep.
      const ALLOWED_ERROR_CODES = new Set([
        'byok_insufficient_funds',
        'byok_invalid_key',
      ]);
      if (!ALLOWED_ERROR_CODES.has(req.errorCode)) {
        throw new ConnectError(
          `MarkConnectorError: errorCode must be one of ${[...ALLOWED_ERROR_CODES].join(', ')}`,
          Code.InvalidArgument,
        );
      }
      return traced('MarkConnectorError', async () => {
        await withTenantScope(tenantId, async (client) => {
          await client.query(
            `UPDATE connectors
               SET status='error', error_code=$3, updated_at=NOW()
             WHERE id=$2 AND tenant_id=$1`,
            [tenantId, req.connectorId, req.errorCode],
          );
        });
        logger.info(
          { tenantId, connectorId: req.connectorId, errorCode: req.errorCode, reason: req.reason },
          'MarkConnectorError',
        );
        return create(MarkConnectorErrorResponseSchema, {});
      });
    },

    // ── ClearConnectorError ───────────────────────────────────────────
    async clearConnectorError(
      req: ClearConnectorErrorRequest,
      _ctx: HandlerContext,
    ): Promise<ClearConnectorErrorResponse> {
      const tenantId = requireTenantId(req, 'ClearConnectorError');
      if (!req.connectorId) {
        throw new ConnectError(
          'ClearConnectorError: connectorId required',
          Code.InvalidArgument,
        );
      }
      return traced('ClearConnectorError', async () => {
        await withTenantScope(tenantId, async (client) => {
          // 'active' is the only "connected and usable" state in the
          // connectors enum ('pending' | 'active' | 'error' | 'disabled' |
          // 'disconnected'). On error recovery, restore the row to 'active'.
          await client.query(
            `UPDATE connectors
               SET status='active', error_code=NULL, updated_at=NOW()
             WHERE id=$2 AND tenant_id=$1`,
            [tenantId, req.connectorId],
          );
        });
        return create(ClearConnectorErrorResponseSchema, {});
      });
    },

    // ── LookupTenantConnector ─────────────────────────────────────────
    async lookupTenantConnector(
      req: LookupTenantConnectorRequest,
      _ctx: HandlerContext,
    ): Promise<LookupTenantConnectorResponse> {
      const tenantId = requireTenantId(req, 'LookupTenantConnector');
      if (!req.connectorType) {
        throw new ConnectError(
          'LookupTenantConnector: connectorType required',
          Code.InvalidArgument,
        );
      }
      return traced('LookupTenantConnector', async () => {
        return withTenantScope(tenantId, async (client) => {
          // Pick the most relevant row, not just the first by id. A tenant
          // can have multiple connector rows of the same type (e.g. one
          // 'disconnected' soft-deleted row plus a freshly reconnected
          // 'active' one). 'active' wins; 'error' is next so the runtime
          // can surface the BYOK envelope; then 'pending' (mid-setup);
          // 'disabled'/'disconnected' are returned last but the resolver
          // treats them as "no connector". The ORDER BY uses a CASE-rank
          // so the priority is explicit, not alphabetical.
          const res = await client.query<{
            id: string;
            status: string;
            error_code: string | null;
          }>(
            `SELECT id::text AS id, status, error_code
               FROM connectors
              WHERE tenant_id=$1 AND type=$2
              ORDER BY
                CASE status
                  WHEN 'active'       THEN 0
                  WHEN 'error'        THEN 1
                  WHEN 'pending'      THEN 2
                  WHEN 'disabled'     THEN 3
                  WHEN 'disconnected' THEN 4
                  ELSE 5
                END,
                id ASC
              LIMIT 1`,
            [tenantId, req.connectorType],
          );
          if (res.rows.length === 0) {
            return create(LookupTenantConnectorResponseSchema, {
              connectorId: '', status: '', errorCode: '', present: false,
            });
          }
          const row = res.rows[0];
          return create(LookupTenantConnectorResponseSchema, {
            connectorId: row.id,
            status: row.status,
            errorCode: row.error_code ?? '',
            present: true,
          });
        });
      });
    },

    // ── ListErroredConnectors (cross-tenant admin) ────────────────────
    async listErroredConnectors(
      req: ListErroredConnectorsRequest,
      _ctx: HandlerContext,
    ): Promise<ListErroredConnectorsResponse> {
      if (!req.connectorType || !req.errorCode) {
        throw new ConnectError(
          'ListErroredConnectors: connectorType and errorCode required',
          Code.InvalidArgument,
        );
      }
      return traced('ListErroredConnectors', async () => {
        // Cross-tenant — must use admin scope. Tenant pool has RLS on the
        // connectors table and would either return zero rows or fail.
        return withAdminScope(
          {
            caller: 'connector-service.ListErroredConnectors',
            reason: 'byok-reprobe worker scan across all tenants',
            actor: 'system:byok-reprobe',
          },
          async (client) => {
            const res = await client.query<{ tenant_id: string; id: string }>(
              `SELECT tenant_id::text AS tenant_id, id::text AS id
                 FROM connectors
                WHERE type=$1 AND status='error' AND error_code=$2`,
              [req.connectorType, req.errorCode],
            );
            return create(ListErroredConnectorsResponseSchema, {
              connectors: res.rows.map((r) =>
                create(ErroredConnectorSchema, {
                  tenantId: r.tenant_id,
                  connectorId: r.id,
                }),
              ),
            });
          },
        );
      });
    },
  });
}

function transportStringToProto(
  transport: 'sse' | 'streamable-http' | 'stdio',
): McpTransport {
  switch (transport) {
    case 'sse':
      return McpTransport.SSE;
    case 'streamable-http':
      return McpTransport.STREAMABLE_HTTP;
    case 'stdio':
      return McpTransport.STDIO;
    default:
      return McpTransport.UNSPECIFIED;
  }
}
