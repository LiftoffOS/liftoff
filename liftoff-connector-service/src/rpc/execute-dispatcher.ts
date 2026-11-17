// Execute dispatcher — routes a typed ExecuteRequest to the right connector
// client. Connector implementations register themselves via
// `registerConnectorExecutor(connectorType, fn)`. Fix 3 ports the 52 files
// under tenant-runtime/src/connectors/clients/ into this service and each
// client module calls registerConnectorExecutor at import time.
//
// Separating the registry from the RPC handler keeps dispatch extensible:
// new connector types plug in without touching the router.

import { create } from '@bufbuild/protobuf';
import type { JsonObject } from '@bufbuild/protobuf';
import {
  ExecuteResponseSchema,
  type ExecuteResponse,
} from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_pb.js';
import { Code, ConnectError } from '@connectrpc/connect';
import { credentialService, OAuthRefreshError } from '../credentials/service.js';
import { logger } from '../infra/logging.js';
import { CONNECTORS } from '../catalog/connectors.js';
import { getConnectorFunctions } from '../catalog/connector-functions-registry.js';
import { getComposio } from '../oauth/composio-client.js';
import { resolveTranslations } from '@liftoffos/composio-overlays';
import { toolError, classifyError } from '@liftoffos/connector-types';
import { errorResponse } from './execute-error.js';
import {
  assertReadOnly,
  enforceRowCap,
  ReadOnlyViolationError,
  DEFAULT_GUARDRAILS,
} from '../clients/warehouse/query-guardrails.js';
import { checkResponseConformance } from '../observability/response-conformance.js';
import { captureResponseSample } from '../observability/response-capture.js';
import { isNativeHrisServing } from '../catalog/native-hris-types.js';
import { resolvePlatformVendorKey } from '../clients/platform-vendor-keys.js';
import { collectSecretValues, redactResponseSecrets } from '../observability/result-secret-guard.js';

// Cache the (connectorType, functionName) -> ConnectorFunction resolution for the native
// observability hook. getConnectorFunctions() rebuilds + copies the connector's full tool array on
// every call, so resolving it per native execution would be an O(tool-count) allocation + scan on
// the hot path. The tool set is static per process, so memoize the lookup.
type ResolvedFn = ReturnType<typeof getConnectorFunctions>[number] | undefined;
const nativeFnCache = new Map<string, ResolvedFn>();
function resolveNativeFn(connectorType: string, functionName: string): ResolvedFn {
  const key = `${connectorType} ${functionName}`;
  if (nativeFnCache.has(key)) return nativeFnCache.get(key);
  const fn = getConnectorFunctions(connectorType).find((f) => f.name === functionName);
  nativeFnCache.set(key, fn);
  return fn;
}

export interface ExecuteArgs {
  tenantId: string;
  connectorId: string;
  functionName: string;
  input: JsonObject;
  idempotencyKey: string;
  traceId: string;
  agentId?: string;
  actionId?: string;
}

export interface ExecutorContext {
  tenantId: string;
  connectorId: string;
  connectorType: string;
  connectorConfig: Record<string, unknown>;
  functionName: string;
  input: JsonObject;
  idempotencyKey: string;
  traceId: string;
  agentId?: string;
  actionId?: string;
  /** Resolved credentials (OAuth token, API key, etc) with auto-refresh applied. */
  credentials: {
    flowKind: string;
    accessToken?: string;
    apiKey?: string;
    privateKey?: string;
    instanceUrl?: string;
  };
}

export interface ExecutorResult {
  /** Arbitrary JSON-serializable result from the vendor call. */
  result: JsonObject;
  /** Vendor-side latency in milliseconds (excludes our wrapper). */
  vendorLatencyMs?: number;
  /** Normalized USD cost attributable to this call. */
  costUsd?: number;
  /** Whose money funded the vendor call: 'x402_wallet' (a per-call USDC
   *  payment settled by the platform x402 wallet), 'platform_key' (a
   *  platform-held credential or account balance), 'tenant_key' (the
   *  workspace's own credential or subscription). Omit when nothing was
   *  funded per-call — an OAuth send, a free endpoint — and the wire carries
   *  empty, which downstream reads as unreported. The wire is the authority
   *  on funding; consumers must not re-derive it from the connector type. */
  fundingSource?: 'x402_wallet' | 'platform_key' | 'tenant_key';
  /** The executor completed, and the vendor call inside it FAILED.
   *
   *  Until this existed an executor had exactly two ways to speak: return, or
   *  throw. The CRUD clients do neither on a vendor refusal — they return
   *  `{success: false, error}` — so the adapter packed that struct into
   *  `result` and the code below stamped `success: true` over it. A Slack send
   *  that came back `404 Connected account not found` was audited as
   *  `outcome: success`, the agent was told the message had been delivered, and
   *  nothing retried or escalated.
   *
   *  `result` still carries the vendor payload; this says what it means. */
  failure?: { message: string };
}

export type ConnectorExecutor = (ctx: ExecutorContext) => Promise<ExecutorResult>;

const executors = new Map<string, ConnectorExecutor>();

export function registerConnectorExecutor(
  connectorType: string,
  executor: ConnectorExecutor,
): void {
  if (executors.has(connectorType)) {
    logger.warn({ connectorType }, 'replacing existing connector executor');
  }
  executors.set(connectorType, executor);
}

export function unregisterAllConnectorExecutors(): void {
  executors.clear();
}

export function hasConnectorExecutor(connectorType: string): boolean {
  return executors.has(connectorType);
}

/**
 * Composio dispatch — when the connector is composio_managed AND the looked-up
 * function declares `definitionSource: 'composio'` with a `vendorToolName`,
 * route the call through `composio.tools.execute()` using the per-tool
 * translate{Input,Output,Error} overlays. Returns the ExecuteResponse when
 * dispatch was attempted (success or vendor failure); returns `null` to tell
 * the caller to fall through to the native executor (function isn't
 * composio-sourced or connector isn't composio-managed).
 */
async function tryComposioDispatch(args: {
  tenantId: string;
  connectorId: string;
  connectorType: string;
  connectorConfig: Record<string, unknown>;
  functionName: string;
  input: JsonObject;
}): Promise<ExecuteResponse | null> {
  const connectorDef = CONNECTORS[args.connectorType];
  if (connectorDef?.mcp?.kind !== 'composio_managed') return null;
  const toolkitSlug = connectorDef.mcp.toolkitSlug;
  if (!toolkitSlug) return null;

  const functions = getConnectorFunctions(args.connectorType);
  const fn = functions.find((f) => f.name === args.functionName);
  if (!fn) {
    // Unknown function — let the native path produce its standard
    // "Unsupported entity type" / function-not-found error so the agent
    // surface stays consistent across both source paths.
    return null;
  }
  if (fn.definitionSource !== 'composio' || !fn.vendorToolName) return null;

  const composioConnectedAccountId = args.connectorConfig?.composioConnectedAccountId;
  if (typeof composioConnectedAccountId !== 'string' || !composioConnectedAccountId) {
    return errorResponse(toolError(
      'auth_expired',
      `composio_dispatch_missing_connection: connector=${args.connectorId} ` +
        `(${args.connectorType}) is composio_managed but ` +
        `config.composioConnectedAccountId is empty. ` +
        `Reconnect the connector to re-link the Composio account.`,
      { connectorType: args.connectorType, connectorId: args.connectorId },
    ));
  }

  const t = resolveTranslations(toolkitSlug, fn.vendorToolName);
  // Arg normalization — preserve the agent's original args, then let
  // translateInput overlay non-undefined values on top. Reason: the LLM
  // sometimes calls the tool using Composio's vendor field names
  // (`recipient_email`, `thread_id`, `is_html`) because the schema it sees
  // sources those names directly; the overlays' `translateInput` was
  // hand-authored against stable/Liftoff names (`to`, `threadId`, `isHtml`).
  // When the agent uses the vendor form, translateInput's `i.to` etc. are
  // undefined and Composio rejects the call ("at least one of 'to' (or
  // 'recipient_email') must be provided"). Spreading the original args first
  // means the vendor-named fields the agent supplied survive; translateInput
  // still adds the auto-set fields (`user_id: 'me'`, defaults) and overrides
  // any field it knows the canonical name for. Undefined values from
  // translateInput do NOT overwrite the agent's original value.
  const agentArgs = args.input as Record<string, unknown>;
  let translatedArgs: Record<string, unknown> = { ...agentArgs };
  if (t.translateInput) {
    const overlay = t.translateInput(agentArgs) as Record<string, unknown>;
    for (const [k, v] of Object.entries(overlay)) {
      if (v !== undefined) translatedArgs[k] = v;
    }
  }

  // Warehouse read-only gate (plan §2). When a function takes raw SQL
  // (fn.sqlGuard), validate it as a single read-only SELECT (fail-closed) and
  // row-cap it before dispatch — covers the Composio path for warehouse
  // connectors (e.g. Supabase run_query). Native clients apply the same gate in
  // their execute(). NOTE: agent tool-calls route through EITHER this gRPC
  // dispatcher OR tenant-runtime's in-process composio-dispatcher; the sister
  // wiring in TR's mcp-server.ts must apply the same gate (plan §3D).
  if (fn.sqlGuard) {
    const { sqlParam, dialect } = fn.sqlGuard;
    const sql = translatedArgs[sqlParam] ?? agentArgs[sqlParam];
    if (typeof sql !== 'string' || sql.trim() === '') {
      return errorResponse(toolError(
        'invalid_arguments',
        `${args.functionName} requires a non-empty SQL string in "${sqlParam}"`,
        { connectorType: args.connectorType, connectorId: args.connectorId, toolName: args.functionName },
      ));
    }
    try {
      assertReadOnly(sql, dialect);
    } catch (e) {
      if (e instanceof ReadOnlyViolationError) {
        return errorResponse(toolError(
          'permission_denied',
          `read_only_violation: ${e.reason}. Only a single read-only SELECT is permitted on a data-warehouse connector.`,
          { connectorType: args.connectorType, connectorId: args.connectorId, toolName: args.functionName },
        ));
      }
      throw e;
    }
    translatedArgs[sqlParam] = enforceRowCap(sql, DEFAULT_GUARDRAILS.maxRows);
  }

  // Async pre-dispatch enrichment. Overlay-driven, opt-in per vendor
  // tool. Sister of the wiring in liftoff-tenant-runtime's mcp-server.ts
  // (commit f18a39c). Both dispatch paths must honour the hook because
  // every agent invocation goes through ONE of them — the SDK engine
  // routes via TR's in-process composio-dispatcher, the hybrid loop
  // (CSR's path) routes here via gRPC. Used by GMAIL_CREATE_EMAIL_DRAFT
  // and OUTLOOK_CREATE_DRAFT to fetch the source thread/message via a
  // sibling vendor call and populate `recipient_email` /
  // `to_recipients` when the draft was produced by the
  // reply-tool → create-draft substitution and the LLM never passed
  // a recipient. Lookups reuse the same Composio connection
  // (connectedAccountId), so the read hits the same mailbox the
  // outer call writes to. Failures are non-fatal — the original args
  // proceed to dispatch and the draft still saves (with whatever the
  // LLM provided), matching pre-fix behaviour.
  if (t.enrichBeforeExecute) {
    const dispatchVendor = async (
      vendorSlug: string,
      vendorArgs: Record<string, unknown>,
    ): Promise<unknown> => {
      const lookup = (await getComposio().tools.execute(vendorSlug, {
        userId: args.tenantId,
        connectedAccountId: composioConnectedAccountId,
        arguments: vendorArgs,
        dangerouslySkipVersionCheck: true,
      })) as { data?: unknown; successful?: boolean; error?: string | null };
      if (lookup.successful === false) {
        throw new Error(
          `enrichBeforeExecute_lookup_failed: ${vendorSlug} returned successful=false (${lookup.error ?? 'no error'})`,
        );
      }
      return lookup.data ?? {};
    };
    try {
      translatedArgs = await t.enrichBeforeExecute(translatedArgs, { dispatchVendor });
    } catch (err) {
      logger.warn(
        {
          tenantId: args.tenantId,
          vendorToolName: fn.vendorToolName,
          err: (err as Error).message,
        },
        'enrichBeforeExecute threw — proceeding with un-enriched args',
      );
    }
  }

  const started = Date.now();
  let resp: { data?: unknown; error?: string | null; successful?: boolean };
  try {
    // @composio/core >= 0.2.0 requires a concrete toolkit version for manual
    // tools.execute() — the literal string 'latest' is rejected at runtime
    // (despite the TS type accepting it) with ComposioToolVersionRequiredError:
    // "Toolkit version not specified. For manual execution of the tool please
    // pass a specific toolkit version". SDK source @composio/core/dist/
    // CustomTool-*.cjs:225 documents this and lists `dangerouslySkipVersionCheck:
    // true` as one of the supported escape hatches. We use it deliberately:
    // every Composio call here is LLM-consumed, so 'latest' is the
    // Composio-recommended choice (see toolkit-versioning docs). Pinning a
    // specific version per toolkit would mean a manual bump every time
    // Composio releases new tool shapes — a maintenance burden with no
    // benefit at the LLM surface.
    resp = (await getComposio().tools.execute(fn.vendorToolName, {
      userId: args.tenantId,
      connectedAccountId: composioConnectedAccountId,
      arguments: translatedArgs,
      dangerouslySkipVersionCheck: true,
    })) as { data?: unknown; error?: string | null; successful?: boolean };
  } catch (e) {
    const message = (e as Error).message;
    logger.warn(
      {
        tenantId: args.tenantId,
        connectorType: args.connectorType,
        vendorToolName: fn.vendorToolName,
        err: message,
      },
      'composio_dispatch_transport_failure',
    );
    return errorResponse(
      toolError('vendor_unavailable', `composio_transport_error: ${message}`, { connectorType: args.connectorType }),
      BigInt(Math.max(0, Date.now() - started)));
  }

  const vendorLatencyMs = BigInt(Math.max(0, Date.now() - started));

  if (resp.successful === false) {
    const normalized = t.translateError({
      code: -32000,
      message: resp.error ?? 'composio_tool_unsuccessful',
      data: resp.data,
    });
    // normalized.code / .retryable come from defaultComposioErrorMap and now
    // survive to the wire. toolError re-derives retryable from code so they
    // cannot diverge; normalized.retryable is redundant but kept in the type.
    return errorResponse(
      toolError(
        normalized.code,
        normalized.message,
        { connectorType: args.connectorType },
        /* retryAfterMs */ (normalized as { retryAfterMs?: number }).retryAfterMs,
      ),
      vendorLatencyMs,
    );
  }

  const translated = t.translateOutput
    ? t.translateOutput(resp.data)
    : (resp.data ?? {});
  // Wrap primitives so the proto JsonObject contract is preserved (matches
  // the toJsonObject helper in clients/adapter.ts so both source paths land
  // the same shape on the wire).
  const result: JsonObject =
    translated == null
      ? {}
      : typeof translated === 'object'
        ? (JSON.parse(JSON.stringify(translated)) as JsonObject)
        : ({ value: translated as never } as JsonObject);

  return create(ExecuteResponseSchema, {
    success: true,
    result,
    vendorLatencyMs,
  });
}

export async function runConnectorExecution(args: ExecuteArgs): Promise<ExecuteResponse> {
  const { tenantId, connectorId, functionName, input, idempotencyKey, traceId, agentId, actionId } = args;

  // Internal-tier platform vendors have no per-tenant connector instance: the
  // platform funds them and a workspace never connects them, so there is no
  // row to look up. The caller addresses them with the explicit
  // `internal:<type>` form — NOT a revival of type-alias dispatch, which was
  // removed because a bare type is ambiguous across a tenant's instances;
  // an internal vendor has exactly one platform identity and zero instances,
  // so the namespaced form is unambiguous by construction. Catalog entries
  // whose status is 'internal' resolve this way, and so do the visible cards
  // the platform keeps serving beside a workspace's own connection
  // (`platformServed`, strale and gloria); everything else still requires a
  // real connector UUID.
  let creds: Awaited<ReturnType<typeof credentialService.getCredentials>>;
  let info: Awaited<ReturnType<typeof credentialService.getConnectorConfig>>;
  if (connectorId.startsWith('internal:')) {
    const connectorType = connectorId.slice('internal:'.length);
    const def = CONNECTORS[connectorType];
    if (!def || (def.status !== 'internal' && !def.platformServed)) {
      throw new ConnectError(
        `no internal connector type ${connectorType}`,
        Code.NotFound,
      );
    }
    // The platform key rides in creds (not only in the executor's fallback)
    // so it joins the secret-scrub set below and can never echo back in a
    // vendor response.
    creds = {
      flowKind: 'api_key',
      apiKey: resolvePlatformVendorKey(connectorType),
    } as typeof creds;
    info = { connectorType, config: {} } as typeof info;
  } else {
    // Resolve credentials (includes auto-refresh for OAuth flows close to expiry).
    creds = await credentialService.getCredentials(tenantId, connectorId);

    // Look up connector type + per-instance config from the connectors table.
    info = await credentialService.getConnectorConfig(tenantId, connectorId);
  }
  if (!info) {
    throw new ConnectError(
      `connector ${connectorId} not found for tenant ${tenantId}`,
      Code.NotFound,
    );
  }

  // Literal credential values (+ base64 / URL-encoded forms) to scrub out of any
  // vendor response that echoes them, before it leaves the process. Computed once;
  // empty for composio_managed (Composio holds the token, returns "REDACTED").
  const secretValues = collectSecretValues(creds);

  // Composio dispatch branch — the C5 piece the Composio cutover left out.
  //
  // The catalog rewrite in connector-functions-registry.ts (boot-time
  // buildComposioFunctions for every composio_managed connector type)
  // produces ConnectorFunctions whose entityType is `undefined` because
  // Composio overlays don't carry it — the vendor tool name + Composio's
  // own dispatch is the contract. The native REST executor lookup below
  // (`executors.get(info.connectorType)`) then routes the call through
  // e.g. GoogleMailClient, which switches on entityType and falls into
  // its default branch with `Unsupported entity type: <stable name>`
  // because the new tool slugs (mark_as_read, etc.) have no native
  // counterpart. Every composio_managed tool call has been failing
  // silently on the agent's tool-result surface since the catalog cutover.
  //
  // The fix: route any function that explicitly declares
  // definitionSource='composio' through composio.tools.execute() using
  // the per-tool translate{Input,Output,Error} overlays. Native dispatch
  // remains the fall-through for legacy / hand-authored functions on
  // composio_managed connectors (rare — most composio_managed types
  // overwrote their *_FUNCTIONS array at module load) and for every
  // non-composio_managed connector.
  const composioOutcome = await tryComposioDispatch({
    tenantId,
    connectorId,
    connectorType: info.connectorType,
    connectorConfig: info.config,
    functionName,
    input,
  });
  if (composioOutcome) {
    return redactResponseSecrets(composioOutcome, secretValues, {
      connectorType: info.connectorType,
      functionName,
    });
  }

  const executor = executors.get(info.connectorType);
  if (!executor) {
    throw new ConnectError(
      `no executor registered for connector type "${info.connectorType}". This is a server configuration bug — see registerConnectorExecutor in execute-dispatcher.ts`,
      Code.Unimplemented,
    );
  }

  // Warehouse read-only gate (plan §2) for NATIVE warehouse clients (BigQuery,
  // Snowflake, Databricks). Mirrors the Composio-path gate in tryComposioDispatch
  // so read-only enforcement + row cap are uniform regardless of dispatch path.
  {
    const fn = getConnectorFunctions(info.connectorType).find((f) => f.name === functionName);
    if (fn?.sqlGuard) {
      const { sqlParam, dialect } = fn.sqlGuard;
      const rawSql = (input as Record<string, unknown>)[sqlParam];
      if (typeof rawSql !== 'string' || rawSql.trim() === '') {
        return errorResponse(toolError(
          'invalid_arguments',
          `${functionName} requires a non-empty SQL string in "${sqlParam}"`,
          { connectorType: info.connectorType, connectorId, toolName: functionName },
        ));
      }
      try {
        assertReadOnly(rawSql, dialect);
      } catch (e) {
        if (e instanceof ReadOnlyViolationError) {
          return errorResponse(toolError(
            'permission_denied',
            `read_only_violation: ${e.reason}. Only a single read-only SELECT is permitted on a data-warehouse connector.`,
            { connectorType: info.connectorType, connectorId, toolName: functionName },
          ));
        }
        throw e;
      }
      (input as Record<string, unknown>)[sqlParam] = enforceRowCap(rawSql, DEFAULT_GUARDRAILS.maxRows);
    }
  }

  const started = Date.now();
  try {
    const outcome = await executor({
      tenantId,
      connectorId,
      connectorType: info.connectorType,
      connectorConfig: info.config,
      functionName,
      input,
      idempotencyKey,
      traceId,
      agentId,
      actionId,
      credentials: {
        flowKind: creds.flowKind,
        accessToken: creds.accessToken,
        apiKey: creds.apiKey,
        privateKey: creds.privateKey,
        instanceUrl: creds.instanceUrl,
      },
    });
    // Native HRIS observability (Phase 2 drift + Phase 4 capture) — non-fatal. Resolve the tool
    // ONCE and pass it to both, and wrap the whole block so an observability bug can never turn a
    // successful vendor call into a tool error.
    try {
      const nativeFn = isNativeHrisServing(info.connectorType)
        ? resolveNativeFn(info.connectorType, functionName)
        : undefined;
      if (nativeFn) {
        const conf = checkResponseConformance(info.connectorType, functionName, nativeFn, outcome.result);
        if (conf?.drift) {
          logger.warn(
            { connectorType: info.connectorType, functionName, traceId, violations: conf.violations.slice(0, 20) },
            'native_hris_response_drift',
          );
        }
        void captureResponseSample(info.connectorType, functionName, nativeFn, outcome.result);
      }
    } catch (obsErr) {
      logger.warn(
        { connectorType: info.connectorType, functionName, err: (obsErr as Error).message },
        'native_hris_observability_error',
      );
    }
    const vendorLatencyMs = outcome.vendorLatencyMs ?? (Date.now() - started);

    // An in-band failure is a failure. Classified the same way a thrown one is,
    // so the two paths cannot drift: the caller gets one error contract
    // regardless of whether the client threw or returned `success: false`.
    if (outcome.failure) {
      return errorResponse(
        toolError(
          classifyError({ message: outcome.failure.message }),
          // Name the connector IN THE MESSAGE.
          //
          // A vendor error identifies its own objects and knows nothing about
          // ours. Composio's read
          //   `Connected account "ca_…" not found`
          // and the recovery text for not_found is "The target does not
          // exist" — so neither string said which connector had failed.
          //
          // An agent cannot reason about that. Reading this error off a SLACK
          // send, it cannot attribute the opaque id and may escalate to a human
          // saying "GitHub access cannot be established — reconnect ca_…",
          // while GitHub is healthy and has no Composio account at all —
          // sending somebody to reconnect the wrong integration.
          //
          // recoveryFor already prefixes "the <type> connector" for
          // auth_expired and permission_denied; not_found and the rest get
          // nothing, so the attribution has to travel on the message.
          `${info.connectorType}.${functionName}: ${outcome.failure.message}`,
          { connectorType: info.connectorType, connectorId, toolName: functionName },
        ),
        BigInt(Math.max(0, Math.floor(vendorLatencyMs))),
      );
    }

    const response = create(ExecuteResponseSchema, {
      success: true,
      result: outcome.result,
      vendorLatencyMs: BigInt(Math.max(0, Math.floor(vendorLatencyMs))),
      costUsd: outcome.costUsd ?? 0,
      fundingSource: outcome.fundingSource ?? '',
    });
    return redactResponseSecrets(response, secretValues, {
      connectorType: info.connectorType,
      functionName,
    });
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    // OAuthRefreshError must propagate to the RPC router so it can both flip
    // the connector status to `error` and surface FailedPrecondition to the
    // caller. Packing it into a generic success=false response would lose
    // both signals — the connector card stays green and the agent only
    // sees an opaque message.
    if (err instanceof OAuthRefreshError) throw err;   // thrown-ConnectError path (not in-band success:false) — unchanged
    const message = (err as Error).message;
    const httpStatus = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode;
    const code = classifyError({ message, httpStatus });
    return redactResponseSecrets(
      errorResponse(
        toolError(code, message, { connectorType: info.connectorType, connectorId }),
        BigInt(Math.max(0, Date.now() - started)),
      ),
      secretValues,
      { connectorType: info.connectorType, functionName },
    );
  }
}
