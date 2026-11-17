// Composio dispatcher — invokes a vendor tool via @composio/core's
// tools.execute() (direct REST against Composio's backend; NOT MCP wire).
// Replaces the SDK-managed vendorMcpServers Composio branch at
// mcp-server.ts:1090-1138 (removed in C5).
//
// By moving dispatch in-process here, the existing tool-interceptor (W1
// ack contract + draft-first) and HITL / cost-attribution wrappers fire
// uniformly on Composio calls — they wrap the in-process dispatcher,
// not the SDK transport.
//
// Auth: composio.tools.execute() takes BOTH userId (tenantId, established
// at composio-client.ts:63 — connectedAccounts.link(tenantId, ...))  AND
// connectedAccountId (to disambiguate when allowMultiple: true is set on
// install — the tenant may have >1 Composio connection per toolkit).
//
// Composio cutover-completion (C5 + C9 polling).

import { Composio } from '@composio/core';
import {
  CANONICAL_RESPONSE_SHAPES,
  COMPOSIO_TOOL_OVERLAYS,
  resolveOverlayByStableName,
  defaultComposioErrorMap,
  type CanonicalKey,
  type NormalizedToolError,
  type ComposioToolOverlay,
} from '@liftoffos/composio-overlays';
import { reportComposioToolCall } from '../billing/composio-call-reporter';
import { checkComposioQuota, type RateLimitDecision } from './composio-rate-limiter';
import { logger } from '../infrastructure/logging';
import { randomUUID } from 'node:crypto';
import { getManagedSecret } from '../infrastructure/secret-store';

// Constructed lazily so unit tests can stub the SDK before importing this
// module via a `jest.mock('@composio/core', ...)`. Required env in prod:
// COMPOSIO_API_KEY (mounted from Secret Manager — secret name
// composio-api-key, shared with connector-service's existing usage).
let _composio: Composio | null = null;

/**
 * Build the per-toolkit version map from the overlay package — the same
 * source of truth used by connector-service. @composio/core >= 0.2.0
 * REJECTS global `toolkitVersions: 'latest'` at manual-execute time with
 * ComposioToolVersionRequiredError ("Toolkit version not specified..."),
 * despite the TypeScript type union accepting the literal. Verified
 * from the deployed SDK source @composio/core/dist/CustomTool-*.cjs:225,
 * which carries the example "❌ This will throw ... if toolkitVersions
 * is 'latest'" with the per-toolkit Record form as the fix.
 *
 * Pulling toolkit slugs from COMPOSIO_TOOL_OVERLAYS keeps this map in
 * lockstep with the catalog automatically: anything we've authored an
 * overlay for is a toolkit we dispatch through composio.tools.execute,
 * so it's a toolkit that needs a pinned version. 'latest' is the
 * Composio-documented choice for LLM-consumed tools.
 * See https://docs.composio.dev/docs/tools-direct/toolkit-versioning.
 */
function buildToolkitVersions(): Record<string, 'latest'> {
  const out: Record<string, 'latest'> = {};
  for (const toolkitSlug of Object.keys(COMPOSIO_TOOL_OVERLAYS)) {
    out[toolkitSlug] = 'latest';
  }
  return out;
}

function getComposio(): Composio {
  if (!_composio) {
    const apiKey = getManagedSecret('COMPOSIO_API_KEY');
    if (!apiKey) {
      throw new Error('COMPOSIO_API_KEY env var not set on tenant-runtime');
    }
    _composio = new Composio({
      apiKey,
      toolkitVersions: buildToolkitVersions(),
    });
  }
  return _composio;
}

/** Test helper — resets the cached Composio client. */
export function _resetForTesting(): void {
  _composio = null;
}

export interface DispatchArgs {
  tenantId: string;
  agentId: string | null;
  invocationId: string | null;
  connectorInstanceId: string;
  connectorType: string;                       // 'google_mail'
  toolkitSlug: string;                         // 'gmail'
  vendorToolName: string;                      // 'GMAIL_FETCH_EMAILS'
  canonicalKey: string;                        // 'gmail.list_messages'
  composioConnectedAccountId: string;          // from manifest.externalAccountId
  args: Record<string, unknown>;               // already-translated args
  translateOutput?: (vendorRespData: unknown) => unknown;
  translateError: (e: { code: number; message: string; data?: unknown }) => NormalizedToolError;
  /** The run's trigger source, forwarded from the catalog builder. Decides
   *  whether this call may spend into the platform's reserved monthly headroom:
   *  ambient work (`cron`, `event`) may not, work a person is waiting on may.
   *  Absent is treated as foreground. */
  triggeredBy?: string;
}

/** One shape for every quota refusal, so the three dispatch sites cannot drift
 *  into three different error contracts. `code: 'rate_limited'` is what the
 *  recovery path reads to classify the failure as retryable. */
function quotaError(decision: RateLimitDecision): Error {
  return Object.assign(
    new Error(decision.message ?? `composio_quota_denied: ${decision.reason ?? 'unknown'}`),
    {
      code: 'rate_limited',
      quotaReason: decision.reason,
      ...(decision.retryAfterMs !== undefined ? { retryAfterMs: decision.retryAfterMs } : {}),
    },
  );
}

interface ToolExecuteResult {
  data?: Record<string, unknown>;
  error?: string | null;
  successful?: boolean;
  logId?: string;
}

/** Single-shot Composio dispatch. */
export async function dispatchComposio(opts: DispatchArgs): Promise<unknown> {
  if (!opts.composioConnectedAccountId) {
    throw new Error(
      `composio_dispatch_missing_connection: tenant=${opts.tenantId} ` +
      `connector=${opts.connectorType}. Manifest.externalAccountId is empty — ` +
      `connector row config.composioConnectedAccountId was never set. Reconnect required.`,
    );
  }

  const quota = await checkComposioQuota({ tenantId: opts.tenantId, triggeredBy: opts.triggeredBy });
  if (!quota.allowed) {
    throw quotaError(quota);
  }

  const callId = randomUUID();
  const occurredAt = new Date();
  let resp: ToolExecuteResult;
  try {
    // @composio/core >= 0.2.0 rejects 'latest' at runtime for manual
    // tools.execute() — both the global and per-toolkit Record forms throw
    // ComposioToolVersionRequiredError ("Toolkit version not specified ...
    // 'latest' is not supported in manual execution"). SDK source @composio/
    // core/dist/CustomTool-*.cjs:225 lists `dangerouslySkipVersionCheck: true`
    // as a supported escape hatch. Every tool we dispatch here is LLM-
    // consumed where 'latest' is the Composio-recommended choice, so we take
    // the escape hatch deliberately rather than pinning a moving version
    // per toolkit.
    resp = (await getComposio().tools.execute(opts.vendorToolName, {
      userId: opts.tenantId,
      connectedAccountId: opts.composioConnectedAccountId,
      arguments: opts.args,
      dangerouslySkipVersionCheck: true,
    })) as ToolExecuteResult;
  } catch (e: unknown) {
    // SDK-level transport/network failure. Composio bills per attempt —
    // report the cost even on failure.
    void reportComposioToolCall({
      tenantId: opts.tenantId, agentId: opts.agentId, invocationId: opts.invocationId,
      callId, connectorType: opts.connectorType,
      toolName: opts.vendorToolName, occurredAt,
    });
    const composioErr = parseComposioSdkError(e);
    const normalized = opts.translateError(composioErr);
    logger.warn(
      { tenantId: opts.tenantId, vendorToolName: opts.vendorToolName, normalized: normalized.message },
      'composio_dispatch_transport_failure',
    );
    throw normalized;
  }

  // Cost reporting — single POST per dispatch attempt. Routes through the
  // existing pipeline: composio-call-reporter →
  // /api/internal/platform-tools/composio-tool-calls → ingestEventWithBuckets
  // → fireOuMeterEvent (inline). C6 verification: see the dispatcher test
  // suite for the per-call assertion.
  void reportComposioToolCall({
    tenantId: opts.tenantId, agentId: opts.agentId, invocationId: opts.invocationId,
    callId, connectorType: opts.connectorType,
    toolName: opts.vendorToolName, occurredAt,
  });

  if (resp.successful === false) {
    const composioErr = {
      code: -32000,
      message: resp.error ?? 'composio tool returned successful=false',
      data: resp.data,
    };
    const normalized = opts.translateError(composioErr);
    logger.warn(
      { tenantId: opts.tenantId, vendorToolName: opts.vendorToolName, error: resp.error },
      'composio_dispatch_vendor_failure',
    );
    throw normalized;
  }

  return validateCanonical(opts.canonicalKey, opts.toolkitSlug, opts.translateOutput, resp.data ?? {});
}

/** Long-running operations: fires the initial call, polls a status tool
 *  per the overlay's `polling` config until completeWhen() returns true,
 *  then returns the final canonical response. Each poll tick consumes one
 *  rate-limit slot and emits one reportComposioToolCall (Composio bills
 *  per attempt). C9. */
export async function dispatchComposioWithPolling(
  opts: DispatchArgs & { polling: NonNullable<ComposioToolOverlay['polling']> },
): Promise<unknown> {
  // 1. initial call — same flow as dispatchComposio but we don't run the
  // canonical-shape validator on the initial response; the status response
  // is what we validate.
  if (!opts.composioConnectedAccountId) {
    throw new Error(
      `composio_dispatch_missing_connection: tenant=${opts.tenantId} ` +
      `connector=${opts.connectorType}`,
    );
  }
  const initialQuota = await checkComposioQuota({ tenantId: opts.tenantId, triggeredBy: opts.triggeredBy });
  if (!initialQuota.allowed) {
    throw quotaError(initialQuota);
  }
  const occurredAt = new Date();
  const initial = (await getComposio().tools.execute(opts.vendorToolName, {
    userId: opts.tenantId,
    connectedAccountId: opts.composioConnectedAccountId,
    arguments: opts.args,
    dangerouslySkipVersionCheck: true,
  })) as ToolExecuteResult;
  void reportComposioToolCall({
    tenantId: opts.tenantId, agentId: opts.agentId, invocationId: opts.invocationId,
    callId: randomUUID(), connectorType: opts.connectorType,
    toolName: opts.vendorToolName, occurredAt,
  });
  if (initial.successful === false) {
    throw opts.translateError({
      code: -32000,
      message: initial.error ?? 'composio polling-initial returned successful=false',
      data: initial.data,
    });
  }
  const jobId = (initial.data ?? {})[opts.polling.jobIdField];
  if (typeof jobId !== 'string' && typeof jobId !== 'number') {
    throw new Error(
      `composio_polling_no_job_id: ${opts.canonicalKey} initial response had ` +
      `no value at field '${opts.polling.jobIdField}'`,
    );
  }

  // 2. resolve the status tool's vendor name.
  const statusOverlayEntry = resolveOverlayByStableName(opts.toolkitSlug, opts.polling.statusToolStableName);
  if (!statusOverlayEntry) {
    throw new Error(
      `composio_polling_status_tool_missing: ${opts.toolkitSlug}.${opts.polling.statusToolStableName}`,
    );
  }
  const statusVendorName = statusOverlayEntry.vendorToolName;

  // 3. poll loop.
  for (let attempt = 0; attempt < opts.polling.maxAttempts; attempt++) {
    await sleep(opts.polling.intervalMs);
    // Each poll tick is a billable Composio attempt and spends a unit of both
    // meters, exactly like the initial call.
    const pollQuota = await checkComposioQuota({ tenantId: opts.tenantId, triggeredBy: opts.triggeredBy });
    if (!pollQuota.allowed) {
      throw quotaError(pollQuota);
    }
    const status = (await getComposio().tools.execute(statusVendorName, {
      userId: opts.tenantId,
      connectedAccountId: opts.composioConnectedAccountId,
      arguments: { [opts.polling.statusToolJobIdField]: jobId },
      dangerouslySkipVersionCheck: true,
    })) as ToolExecuteResult;
    void reportComposioToolCall({
      tenantId: opts.tenantId, agentId: opts.agentId, invocationId: opts.invocationId,
      callId: randomUUID(), connectorType: opts.connectorType,
      toolName: statusVendorName, occurredAt: new Date(),
    });
    if (status.successful === false) {
      throw opts.translateError({
        code: -32000,
        message: status.error ?? 'composio polling-status returned successful=false',
        data: status.data,
      });
    }
    const state = (status.data ?? {})[opts.polling.stateField];
    if (opts.polling.failedWhen?.(state)) {
      throw opts.translateError({
        code: -32503,
        message: `composio operation failed (state=${JSON.stringify(state)})`,
        data: status.data,
      });
    }
    if (opts.polling.completeWhen(state)) {
      return validateCanonical(opts.canonicalKey, opts.toolkitSlug, opts.translateOutput, status.data ?? {});
    }
  }

  throw new Error(
    `polling_timeout: ${opts.canonicalKey} did not complete within ` +
    `${opts.polling.maxAttempts * opts.polling.intervalMs}ms ` +
    `(${opts.polling.maxAttempts} attempts × ${opts.polling.intervalMs}ms)`,
  );
}

function validateCanonical(
  canonicalKey: string,
  toolkitSlug: string,
  translateOutput: ((data: unknown) => unknown) | undefined,
  vendorData: unknown,
): unknown {
  const canonical = translateOutput ? translateOutput(vendorData) : vendorData;
  const schema = CANONICAL_RESPONSE_SHAPES[canonicalKey as CanonicalKey];
  if (schema) {
    const parsed = schema.safeParse(canonical);
    if (!parsed.success) {
      logger.error(
        { canonicalKey, zodIssues: parsed.error.issues },
        'canonical_shape_violation',
      );
      throw new Error(
        `canonical_shape_violation: ${canonicalKey} — translateOutput ` +
        `produced a value that does not match the registered canonical shape. ` +
        `Re-author translateOutput in @liftoffos/composio-overlays/overlays/${toolkitSlug}.ts.`,
      );
    }
    return parsed.data;
  }
  return canonical;
}

function parseComposioSdkError(e: unknown): { code: number; message: string; data?: unknown } {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return {
      code:
        'code' in e && typeof (e as { code: unknown }).code === 'number'
          ? (e as { code: number }).code
          : -32000,
      message: String((e as { message: unknown }).message),
      data: 'data' in e ? (e as { data: unknown }).data : undefined,
    };
  }
  return { code: -32000, message: String(e), data: undefined };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reference defaults to silence unused-import warnings if the dispatcher
// drops translateError; the overlay always provides one via resolveTranslations.
void defaultComposioErrorMap;
