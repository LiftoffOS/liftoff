// WS-5.4 — daily probe cron, A.2-deepened.
//
// One probe per (tenant, connector_manifest). Records result in
// connector_binding_probes; the materialized connector_binding_health view
// flips to 'degraded' after 3 consecutive failures.
//
// Pre-A.2 the probe was a registry-lookup only: does the manifest's
// connector_type resolve to a known function set in the in-process registry?
// That catches "manifest references unknown connector_type" (the WS-5.3
// class) but says nothing about whether the binding actually works at
// dispatch time. A bound Composio account whose OAuth token was revoked
// passed the old probe; the next agent invocation against it failed.
//
// A.2 routes per transport so the probe exercises the same path a real
// dispatch would. probe_kind on the recorded row tells the dashboard
// which strategy ran:
//
//   • 'registry_only'              — connector_type not registered (failure)
//   • 'vendor_mcp_tools_list'      — vendor-hosted MCP; tools/list against vendor URL with Bearer
//   • 'sidecar_tools_list'         — locally-hosted MCP sidecar; HTTP tools/list against sidecar URL
//   • 'composio_credential_refresh'— composio_managed; GetCredentials touched Composio auth
//   • 'rest_auth_test'             — REST direct; GetCredentials touched OAuth refresh chain
//
// composio_managed vs REST direct is detected by inspecting the connector
// function registry's `definitionSource` field (the proto field on every
// ToolDefinition that connector-service sets to 'composio' for tools
// dispatched via composio.tools.execute). This is the authoritative signal
// — connector-service controls the registry, and the registry already
// distinguishes the dispatch path. We do NOT use a connector-type-name
// regex because that's fragile (misses new composio types, false-positives
// on names containing 'drive', etc.).
//
// customer_hosted (BYOC custom MCP) lives in `custom_mcp_servers`, not
// `connector_manifests`, so it's not reached by this probe loop at all.
//
// Kill switch: BINDING_PROBE_DEEP_DISABLED=1 reverts to registry-only.

import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { scrubLogger } from '../observability/scrub-logger';
import { getToolSchemas as getConnectorFunctions } from './tool-schema-cache';
import { getConnectorServiceClient } from './connector-service-client';
import { createTransportSync } from '../tool-gateway/transports';
import type { MCPTransport } from '@liftoffos/runtime-mcp-transports';
import { getManagedSecret } from '../infrastructure/secret-store';
import { pickProbeReadFunction, isPayloadRejection, type ProbeCandidateFunction } from './probe-read-function';

export type ProbeKind =
  | 'registry_only'
  | 'vendor_mcp_tools_list'
  | 'sidecar_tools_list'
  | 'composio_credential_refresh'
  | 'rest_auth_test'
  // BYOC custom MCP — currently unreachable from this probe loop
  // (custom_mcp_servers is a separate table) but the value is kept in
  // the enum so dashboards can reference it ahead of BYOC probing.
  | 'customer_hosted_skipped'
  // A real tools/list against the customer's own MCP server. The value above
  // was a placeholder for the whole life of this probe because BYOC was never
  // reached; this is what actually runs now.
  | 'customer_hosted_tools_list';

export type ProbeErrorCode =
  | 'REGISTRY_UNKNOWN'
  | 'CLIENT_UNAVAILABLE'
  | 'CONFIG_LOOKUP_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_AUTH_FAILED'
  | 'VENDOR_5XX'
  // Vendor-side 504 / gateway timeout — operator remediation differs from
  // our local withTimeout() cutoff (MCP_TIMEOUT). Vendor slowness vs our
  // budget being too tight.
  | 'VENDOR_TIMEOUT'
  | 'MISSING_BEARER_TOKEN'
  // The vendor answered that the probe's request was malformed. The binding
  // reached the vendor; the probe asked a question the function's schema
  // did not say it could not answer. Never a reason to reconnect.
  | 'PROBE_PAYLOAD_REJECTED'
  | 'SIDECAR_DOWN'
  | 'COMPOSIO_AUTH_FAILED'
  | 'REST_AUTH_FAILED'
  | 'UNKNOWN';

export interface ProbeResult {
  ok: boolean;
  error?: string;
  errorCode?: ProbeErrorCode;
  latency_ms?: number;
  probe_kind?: ProbeKind;
}

interface BindingRow {
  id: string;
  tenant_id: string;
  connector_type: string;
  alias: string | null;
}

const DEEP_PROBE_TIMEOUT_MS = 5_000;

/**
 * Consecutive failed probes before a binding is reported as unusable.
 *
 * Two, not one: the probe reaches third-party servers over the internet, and a
 * single timeout is far more often a blip than a broken binding. Two is also
 * what the materialized health view already needed before it would call a
 * binding degraded, so the number people read on the dashboard and the number
 * that raises a badge in the product agree.
 */
const REPORT_AFTER_CONSECUTIVE_FAILURES = Number(
  process.env.BINDING_PROBE_REPORT_THRESHOLD ?? 2,
);

type ConnectorClient = ReturnType<typeof getConnectorServiceClient>;

export async function probeAllBindings(): Promise<{ probed: number; ok: number; failed: number }> {
  const pool = getPool();
  const bindings = await pool.query(`
    SELECT id, tenant_id, connector_type, alias
    FROM connector_manifests
    WHERE enabled = true
  `);
  let ok = 0;
  let failed = 0;
  for (const b of bindings.rows as BindingRow[]) {
    const startMs = Date.now();
    const result = await runProbeForBinding(b);
    result.latency_ms = Date.now() - startMs;
    await recordProbeResult(b.id, b.tenant_id, result);
    if (result.ok) ok++;
    else failed++;
    scrubLogger.info({
      event: 'connector_binding_dispatchable',
      tenant_id: b.tenant_id,
      connector_instance_id: b.id,
      connector_type: b.connector_type,
      ok: result.ok,
      probe_kind: result.probe_kind ?? null,
      error_code: result.errorCode ?? null,
      latency_ms: result.latency_ms,
    });
    await reportIfPersistentlyFailing(b.id, b.tenant_id, b.connector_type, result);
  }

  // Customer-hosted MCP servers are not manifests and so were never reached by
  // the loop above — this probe has always skipped them, which left every BYOC
  // binding with no health signal of any kind. Nothing else covers them
  // either: connector-service never writes a status for the type, so a dead
  // customer server read as Active indefinitely.
  const byoc = await probeCustomMcpServers();
  ok += byoc.ok;
  failed += byoc.failed;
  try {
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY connector_binding_health`);
  } catch (err) {
    try {
      await pool.query(`REFRESH MATERIALIZED VIEW connector_binding_health`);
    } catch (err2) {
      logger.warn(
        { err: (err as Error).message, fallback_err: (err2 as Error).message },
        'probeAllBindings: REFRESH MATERIALIZED VIEW failed',
      );
    }
  }
  return { probed: (bindings.rowCount ?? 0) + byoc.probed, ok, failed };
}

/**
 * Probe every customer-hosted MCP server an agent is actually bound to.
 *
 * Scoped to bound servers rather than every server the tenant has ever
 * registered: an unbound server failing is nobody's problem yet, and the
 * product has nothing to say about it. The binding set comes from the local
 * agent mirror, which the canonical reconciler keeps in step with the control
 * plane, so this needs no extra call to find out what matters.
 *
 * A probe here is a real `tools/list` over the same transport a dispatch would
 * use, built from the same runtime-config door the dispatcher reads. A server
 * that answers is working; one that refuses auth or does not answer is not.
 */
async function probeCustomMcpServers(): Promise<{ probed: number; ok: number; failed: number }> {
  const pool = getPool();
  let rows: Array<{ tenant_id: string; connector_id: string }>;
  try {
    const res = await pool.query<{ tenant_id: string; connector_id: string }>(
      `SELECT DISTINCT a.tenant_id, e->>'id' AS connector_id
         FROM cached_internal_agents a
         CROSS JOIN LATERAL jsonb_array_elements(a.integrations) e
        WHERE a.status = 'active'
          AND e->>'integrationId' = 'custom_mcp_server'
          AND e->>'id' IS NOT NULL`,
    );
    rows = res.rows;
  } catch (err) {
    // The mirror is a cache; a read failure here must not take the whole
    // probe run down with it.
    logger.warn(
      { err: (err as Error).message },
      'probeCustomMcpServers: could not enumerate bound BYOC servers',
    );
    return { probed: 0, ok: 0, failed: 0 };
  }

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const startMs = Date.now();
    const result = await runCustomMcpProbe(row.tenant_id, row.connector_id);
    result.latency_ms = Date.now() - startMs;
    // Recorded against the connector id rather than a manifest id — BYOC has
    // no manifest, and the connector id is what every other surface keys on.
    await recordProbeResult(row.connector_id, row.tenant_id, result);
    if (result.ok) ok++;
    else failed++;
    scrubLogger.info({
      event: 'connector_binding_dispatchable',
      tenant_id: row.tenant_id,
      connector_instance_id: row.connector_id,
      connector_type: 'custom_mcp_server',
      ok: result.ok,
      probe_kind: result.probe_kind ?? null,
      error_code: result.errorCode ?? null,
      latency_ms: result.latency_ms,
    });
    await reportIfPersistentlyFailing(
      row.connector_id,
      row.tenant_id,
      'custom_mcp_server',
      result,
    );
  }
  return { probed: rows.length, ok, failed };
}

/** One `tools/list` against a customer's own MCP server. */
export async function runCustomMcpProbe(
  tenantId: string,
  connectorId: string,
): Promise<ProbeResult> {
  let transport: MCPTransport | undefined;
  try {
    const { customMcpServerHandler } = await import('../tool-gateway/custom-mcp-server-handler');
    const built = await customMcpServerHandler.buildProbeTransport(tenantId, connectorId);
    if (!built) {
      return {
        ok: false,
        error: 'custom MCP server config not found',
        errorCode: 'CONFIG_LOOKUP_FAILED',
        probe_kind: 'customer_hosted_tools_list',
      };
    }
    transport = built;
    await withTimeout(transport.connect(), DEEP_PROBE_TIMEOUT_MS, 'customer connect');
    await withTimeout(
      transport.request<unknown>('tools/list', {}),
      DEEP_PROBE_TIMEOUT_MS,
      'customer tools/list',
    );
    return { ok: true, probe_kind: 'customer_hosted_tools_list' };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      errorCode: classifyError(err, 'SIDECAR_DOWN'),
      probe_kind: 'customer_hosted_tools_list',
    };
  } finally {
    try {
      await transport?.close?.();
    } catch {
      // A transport that will not close cleanly has already told us what we
      // came to find out.
    }
  }
}

/**
 * Tell the control plane a binding is unusable, once it has failed enough
 * consecutive probes to rule out a blip.
 *
 * This is the step that turns the probe from a dashboard into a product
 * signal. The probe has recorded results and refreshed a health view since it
 * was written, and nothing read either — a binding could fail every day for a
 * month and the Connections page still showed it healthy. Reporting flips the
 * connector to `error`, which the Connections page renders as a Reconnect card
 * and the Teams page badges on every agent bound to it.
 *
 * Best-effort throughout: a reporting failure must never abort the run or mark
 * a probe as failed that actually succeeded.
 */
async function reportIfPersistentlyFailing(
  connectorId: string,
  tenantId: string,
  connectorType: string,
  result: ProbeResult,
): Promise<void> {
  if (result.ok) return;
  // REGISTRY_UNKNOWN is our own catalog being out of step with the deployed
  // registry, CLIENT_UNAVAILABLE is this service's own wiring, and
  // PROBE_PAYLOAD_REJECTED is the probe asking a malformed question — none is
  // the customer's connection being broken. Sending someone to reconnect a
  // healthy account would waste their time and fix nothing.
  if (
    result.errorCode === 'REGISTRY_UNKNOWN' ||
    result.errorCode === 'CLIENT_UNAVAILABLE' ||
    result.errorCode === 'PROBE_PAYLOAD_REJECTED'
  ) return;

  try {
    const streak = await consecutiveFailureCount(connectorId, tenantId);
    if (streak < REPORT_AFTER_CONSECUTIVE_FAILURES) return;
    await reportReconnectRequired(connectorId, tenantId, {
      reason: `binding_probe_${result.errorCode ?? 'UNKNOWN'}`,
      consecutiveFailures: streak,
      connectorType,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, connectorId, tenantId, connectorType },
      'binding-probe: reporting reconnect-required failed',
    );
  }
}

/** How many probes in a row this binding has failed, most recent first. */
async function consecutiveFailureCount(
  connectorId: string,
  tenantId: string,
): Promise<number> {
  const res = await getPool().query<{ ok: boolean }>(
    `SELECT ok FROM connector_binding_probes
      WHERE connector_manifest_id = $1 AND tenant_id = $2
      ORDER BY probed_at DESC
      LIMIT $3`,
    [connectorId, tenantId, REPORT_AFTER_CONSECUTIVE_FAILURES],
  );
  let streak = 0;
  for (const row of res.rows) {
    if (row.ok) break;
    streak++;
  }
  return streak;
}

/**
 * POST the report to connector-service, which owns the connectors table.
 *
 * Uses the same service-auth header every other tenant-runtime call to that
 * service uses. Deliberately a plain fetch rather than the Connect client:
 * this is a REST admin route, and adding it to the proto surface for one
 * best-effort write would be a heavier contract than the write deserves.
 */
async function reportReconnectRequired(
  connectorId: string,
  tenantId: string,
  meta: { reason: string; consecutiveFailures: number; connectorType: string },
): Promise<void> {
  const baseUrl = process.env.CONNECTOR_SERVICE_URL;
  const token = getManagedSecret('CONNECTOR_SERVICE_TOKEN');
  if (!baseUrl || !token) {
    logger.warn(
      { connectorId, tenantId },
      'binding-probe: CONNECTOR_SERVICE_URL/TOKEN unset, cannot report reconnect-required',
    );
    return;
  }

  const res = await fetch(
    `${baseUrl}/api/connectors/internal/admin/connectors/reconnect-required`,
    {
      method: 'POST',
      headers: {
        'X-Service-Auth': token,
        'content-type': 'application/json',
        'x-account-id': 'tenant-runtime-binding-probe',
      },
      body: JSON.stringify({ connectorId, reason: meta.reason }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!res.ok) {
    logger.warn(
      { connectorId, tenantId, status: res.status },
      'binding-probe: connector-service rejected the reconnect-required report',
    );
    return;
  }
  logger.warn(
    {
      connectorId,
      tenantId,
      connectorType: meta.connectorType,
      consecutiveFailures: meta.consecutiveFailures,
      reason: meta.reason,
      event: 'binding_probe_reported_reconnect_required',
    },
    'binding-probe: binding reported unusable after consecutive failures',
  );
}

function registryUnknown(binding: BindingRow): ProbeResult {
  return {
    ok: false,
    error: `connector_type '${binding.connector_type}' has no registered functions`,
    errorCode: 'REGISTRY_UNKNOWN',
    probe_kind: 'registry_only',
  };
}

export async function runProbeForBinding(binding: BindingRow): Promise<ProbeResult> {
  // The registry holds the function set connector-service dispatches through
  // — composio_managed and REST direct. A vendor-hosted MCP or a sidecar has
  // NO registry entry by design: its tools are enumerated live from the
  // server at invocation time. So an empty registry is a failure only once
  // the transport lookup below says the registry is the dispatch path.
  const fns = getConnectorFunctions(binding.connector_type) ?? [];

  // Kill switch: registry-only mode issues no outbound call at all, which
  // leaves the registry as its only signal.
  if (process.env.BINDING_PROBE_DEEP_DISABLED === '1') {
    return fns.length === 0 ? registryUnknown(binding) : { ok: true, probe_kind: 'registry_only' };
  }

  // B3: composio_managed detection is driven by connector-service's
  // authoritative `definitionSource` field on the cached tool schemas
  // (proto field on every ToolDefinition; populated by connector-service
  // when it builds the registry from @liftoffos/composio-overlays + native
  // entries). If ANY function for this connector_type has
  // definitionSource='composio', the connector is composio_managed and
  // GetCredentials is the right probe (exercises the Composio auth chain).
  const isComposioManaged = fns.some(f => f.definitionSource === 'composio');

  // B4: client-unavailable is a real failure mode (almost always a missing
  // CONNECTOR_SERVICE_URL env, broken VPC, or service-account loss). The
  // dashboard MUST see this as red, not silently green — operators were
  // missing real outages before this fix.
  let client: ConnectorClient;
  try {
    client = getConnectorServiceClient();
  } catch (err) {
    return {
      ok: false,
      error: `connector-service client unavailable: ${(err as Error).message}`,
      errorCode: 'CLIENT_UNAVAILABLE',
      probe_kind: 'registry_only',
    };
  }

  let configResp;
  try {
    configResp = await withTimeout(
      (client as unknown as {
        getMcpServerConfig: (_req: unknown) => Promise<{
          exists: boolean;
          isVendorHosted: boolean;
          transport?: unknown;
          mcpUrl?: string;
        }>;
      }).getMcpServerConfig({
        tenantContext: { tenantId: binding.tenant_id },
        connectorId: binding.id,
      }),
      DEEP_PROBE_TIMEOUT_MS,
      'getMcpServerConfig',
    );
  } catch (err) {
    return {
      ok: false,
      error: `getMcpServerConfig failed: ${(err as Error).message}`,
      errorCode: classifyError(err, 'CONFIG_LOOKUP_FAILED'),
      probe_kind: 'registry_only',
    };
  }

  // Vendor-hosted MCP: fetch creds then tools/list with Bearer auth.
  if (configResp.exists && configResp.isVendorHosted && configResp.mcpUrl) {
    return probeVendorMcp(binding, configResp.mcpUrl, client);
  }

  // Sidecar: real HTTP tools/list against the resolved sidecar URL.
  if (configResp.exists && !configResp.isVendorHosted && configResp.mcpUrl) {
    return probeSidecar(configResp.mcpUrl);
  }

  // exists=false: composio_managed or REST direct, so the registry IS the
  // dispatch path. A connector_type it does not know fails before any
  // outbound call is ever issued (the WS-5.3 class); surface that here.
  if (fns.length === 0) return registryUnknown(binding);

  // Branch on the registry-sourced signal we computed above. Pass `fns` so
  // the REST direct branch can pick a read-only function to dispatch as a
  // vendor-liveness probe.
  return probeCredentialRefresh(binding, client, isComposioManaged, fns);
}

// B1: vendor MCP probe must fetch credentials and pass them as Bearer.
// Vendor MCP servers (Stripe, Notion, GitHub, HubSpot, Snowflake, etc.) all
// require Bearer tokens; without one, tools/list returns 401 and the probe
// falsely flags a healthy binding as MCP_AUTH_FAILED. For an OAuth or DCR
// connector the Bearer is the access token; for an api_key connector (sentry,
// databricks, tolt) it is the key itself, which arrives in `apiKey`, never in
// `oauth` — the same rule resolveVendorMcpServers applies at invocation time.
async function probeVendorMcp(
  binding: BindingRow,
  mcpUrl: string,
  client: ConnectorClient,
): Promise<ProbeResult> {
  let bearerToken: string | undefined;
  try {
    const creds = await withTimeout(
      client.getCredentials({
        tenantContext: { tenantId: binding.tenant_id },
        connectorId: binding.id,
      }),
      DEEP_PROBE_TIMEOUT_MS,
      'getCredentials',
    );
    bearerToken = creds.oauth?.accessToken || creds.apiKey?.apiKey;
  } catch (err) {
    return {
      ok: false,
      error: `vendor MCP getCredentials failed: ${(err as Error).message}`,
      errorCode: classifyError(err, 'MCP_AUTH_FAILED'),
      probe_kind: 'vendor_mcp_tools_list',
    };
  }
  if (!bearerToken) {
    // A connector with neither an access token nor an API key in storage will
    // fail the SDK's tools/list as soon as an agent calls it. Surface here.
    return {
      ok: false,
      error: 'vendor MCP credentials returned no oauth.accessToken and no apiKey',
      errorCode: 'MISSING_BEARER_TOKEN',
      probe_kind: 'vendor_mcp_tools_list',
    };
  }

  let probe: MCPTransport | undefined;
  try {
    probe = createTransportSync('streamable-http', {
      endpointUrl: mcpUrl,
      authType: 'bearer_token',
      bearerToken,
      timeout: DEEP_PROBE_TIMEOUT_MS,
    });
    await probe.connect();
    await probe.request('tools/list', {});
    return { ok: true, probe_kind: 'vendor_mcp_tools_list' };
  } catch (err) {
    return {
      ok: false,
      error: `vendor MCP tools/list failed: ${(err as Error).message}`,
      errorCode: classifyError(err),
      probe_kind: 'vendor_mcp_tools_list',
    };
  } finally {
    try { probe?.close(); } catch { /* best-effort */ }
  }
}

// B2: real sidecar HTTP probe. Pre-fix this called connector-service's
// ListTools RPC which serves CACHED schemas — if the sidecar was down but
// the schemas were cached, the probe falsely reported OK. The fix is to
// actually call tools/list against the sidecar's HTTP endpoint, so a
// missing or unresponsive sidecar surfaces here.
async function probeSidecar(mcpUrl: string): Promise<ProbeResult> {
  let probe: MCPTransport | undefined;
  try {
    probe = createTransportSync('streamable-http', {
      endpointUrl: mcpUrl,
      authType: 'none',
      timeout: DEEP_PROBE_TIMEOUT_MS,
    });
    await probe.connect();
    await probe.request('tools/list', {});
    return { ok: true, probe_kind: 'sidecar_tools_list' };
  } catch (err) {
    return {
      ok: false,
      error: `sidecar tools/list failed: ${(err as Error).message}`,
      errorCode: classifyError(err, 'SIDECAR_DOWN'),
      probe_kind: 'sidecar_tools_list',
    };
  } finally {
    try { probe?.close(); } catch { /* best-effort */ }
  }
}

async function probeCredentialRefresh(
  binding: BindingRow,
  client: ConnectorClient,
  isComposioManaged: boolean,
  fns: ReadonlyArray<ProbeCandidateFunction>,
): Promise<ProbeResult> {
  // For composio_managed, GetCredentials is sufficient — a 200 proves
  // the connected account is alive and the token chain works.
  //
  // For REST direct, GetCredentials by itself only proves WE can decrypt
  // our stored OAuth token; it doesn't prove the vendor still honors it
  // (token revocation, IP block, rotated secret). REST direct does both:
  //   1. GetCredentials (cheap, fails fast on missing secret).
  //   2. Execute a categories=['read']-only function with a minimal
  //      payload (vendor-side liveness check).
  if (isComposioManaged) {
    try {
      await withTimeout(
        client.getCredentials({
          tenantContext: { tenantId: binding.tenant_id },
          connectorId: binding.id,
        }),
        DEEP_PROBE_TIMEOUT_MS,
        'getCredentials',
      );
      return { ok: true, probe_kind: 'composio_credential_refresh' };
    } catch (err) {
      return {
        ok: false,
        error: `getCredentials failed: ${(err as Error).message}`,
        errorCode: classifyError(err, 'COMPOSIO_AUTH_FAILED'),
        probe_kind: 'composio_credential_refresh',
      };
    }
  }

  // REST direct — credential refresh first.
  try {
    await withTimeout(
      client.getCredentials({
        tenantContext: { tenantId: binding.tenant_id },
        connectorId: binding.id,
      }),
      DEEP_PROBE_TIMEOUT_MS,
      'getCredentials (rest)',
    );
  } catch (err) {
    return {
      ok: false,
      error: `getCredentials failed: ${(err as Error).message}`,
      errorCode: classifyError(err, 'REST_AUTH_FAILED'),
      probe_kind: 'rest_auth_test',
    };
  }

  // Then dispatch a read-only function the probe can call with no input.
  // Credential-only success when the connector has none: a fabricated
  // argument would only measure the fabrication.
  const readAction = pickProbeReadFunction(fns);
  if (!readAction) {
    return { ok: true, probe_kind: 'rest_auth_test' };
  }

  try {
    const execResp = await withTimeout(
      (client as unknown as {
        execute: (req: unknown) => Promise<{ success: boolean; error?: string; errorCode?: string }>;
      }).execute({
        tenantContext: { tenantId: binding.tenant_id },
        connectorId: binding.id,
        functionName: readAction.name,
        input: {},
        idempotencyKey: `probe-${binding.id}-${Date.now()}`,
      }),
      DEEP_PROBE_TIMEOUT_MS,
      'execute (rest probe)',
    );
    if (execResp.success) {
      return { ok: true, probe_kind: 'rest_auth_test' };
    }
    const message = execResp.error ?? execResp.errorCode ?? '';
    const classified = classifyError(new Error(message), 'REST_AUTH_FAILED');
    return {
      ok: false,
      error: `REST probe dispatch returned non-success: ${execResp.error ?? '<no error message>'}`,
      errorCode: classified === 'REST_AUTH_FAILED' && isPayloadRejection(message)
        ? 'PROBE_PAYLOAD_REJECTED'
        : classified,
      probe_kind: 'rest_auth_test',
    };
  } catch (err) {
    return {
      ok: false,
      error: `REST probe dispatch failed: ${(err as Error).message}`,
      errorCode: classifyError(err, 'REST_AUTH_FAILED'),
      probe_kind: 'rest_auth_test',
    };
  }
}

function classifyError(err: unknown, fallback: ProbeErrorCode = 'UNKNOWN'): ProbeErrorCode {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  // Vendor-originated timeouts (504 / "gateway timeout" / vendor-side
  // message) are distinct from our own withTimeout() local cutoff.
  if (message.includes('504') || message.includes('gateway timeout') || message.includes('vendor timeout')) return 'VENDOR_TIMEOUT';
  if (message.includes('timeout') || message.includes('timed out')) return 'MCP_TIMEOUT';
  if (message.includes('401') || message.includes('unauthorized')) return 'MCP_AUTH_FAILED';
  if (message.includes('403') || message.includes('forbidden')) return 'MCP_AUTH_FAILED';
  if (message.includes('500') || message.includes('502') || message.includes('503')) return 'VENDOR_5XX';
  return fallback;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function recordProbeResult(
  connectorManifestId: string,
  tenantId: string,
  result: ProbeResult,
): Promise<void> {
  await getPool().query(
    `INSERT INTO connector_binding_probes
       (connector_manifest_id, tenant_id, ok, error, latency_ms, probe_kind)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      connectorManifestId,
      tenantId,
      result.ok,
      result.error ?? null,
      result.latency_ms ?? null,
      result.probe_kind ?? null,
    ],
  );
}
