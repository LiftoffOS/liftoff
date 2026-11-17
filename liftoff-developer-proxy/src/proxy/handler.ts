// Transparent vendor proxy handler.
//
// Request lifecycle:
//   1. Pre-upstream gates: route/credential vendor match (403), vendor
//      enablement, operation classification, model allowlist + pricing (fail
//      closed — no fallback rates). All BEFORE the provider key is decrypted.
//   2. Forward upstream with an AbortController wired to (a) downstream
//      disconnect, (b) a configurable connect timeout, (c) a configurable
//      overall timeout. Tee SSE bytes to the client while accumulating usage
//      and lifecycle signals through the vendor adapter.
//   3. Record the attempt durably: one usage-log row + a billing outbox event
//      in a single transaction. Every terminal state (success, provider
//      4xx/5xx, malformed JSON, missing usage, timeout, transport error,
//      client abort) is recorded.

import { createHash, randomUUID } from 'node:crypto';
import { pokeCostIngest } from '../usage/cost-ingest-poke.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { loadConfig } from '../infrastructure/config.js';
import { getPool } from '../infrastructure/database.js';
import { track } from '../infrastructure/in-flight.js';
import { closeAfter } from './close-after.js';
import { resolveVendorApiKey } from './secret-cache.js';
import { getAdapter, getVendorConfig } from '../vendor/registry.js';
import type {
  TokenUsage,
  LifecycleStatus,
  VendorAdapter,
  VendorConfig,
  RequestCorrelation,
} from '../vendor/adapter.js';

interface AttemptContext {
  attemptId: string;
  startedAt: Date;
  auth: NonNullable<FastifyRequest['devProxyAuth']>;
  adapter: VendorAdapter;
  vendorConfig: VendorConfig;
  operation: string;
  model: string;
  serviceTier: string;
  correlation: RequestCorrelation;
  agentId: string | null;
  invocationId: string | null;
  actionId: string | null;
}

interface TerminalRecord {
  lifecycle: Exclude<LifecycleStatus, 'started'>;
  usage: TokenUsage | null;
  httpStatus: number | null;
  errorCategory: string | null;
  errorMessage?: string;
}

export async function handleVendorProxy(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.devProxyAuth!;
  const config = loadConfig();
  const pool = await getPool();
  const startedAt = new Date();
  const agentId      = (request.headers['x-agent-id']      as string) || null;
  const invocationId = (request.headers['x-invocation-id'] as string) || null;
  const actionId     = (request.headers['x-action-id']     as string) || null;

  // 1. Route vendor must match credential vendor (stable 403).
  const routeVendor = request.resolvedVendor ?? 'anthropic';
  if (routeVendor !== auth.vendor) {
    return reply.code(403).send({
      type: 'error',
      error: { type: 'permission_error', message: 'Credential vendor does not match route vendor' },
    });
  }

  // 2. Parse the request body (captured as a raw Buffer by the content-type
  //    parser). A bodyless POST fails closed here.
  const bodyBuffer = request.rawBody as Buffer | undefined;
  if (!bodyBuffer || bodyBuffer.length === 0) {
    return reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Request body required' },
    });
  }
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(bodyBuffer.toString('utf-8'));
  } catch {
    return reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
    });
  }

  const isStreaming = parsedBody.stream === true;
  const model = (parsedBody.model as string) || 'unknown';

  // 3. Resolve the vendor adapter and config (vendor enablement is the
  //    hot-path kill switch).
  let adapter: VendorAdapter;
  let vendorConfig: VendorConfig;
  try {
    adapter      = getAdapter(auth.vendor);
    vendorConfig = await getVendorConfig(pool, auth.vendor);
  } catch (err) {
    return reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: (err as Error).message },
    });
  }

  // 4. Operation classification; unknown paths never reach upstream.
  const operation = adapter.classifyOperation(request.method, request.url);
  if (!operation || operation === 'models.list') {
    return reply.code(404).send({
      type: 'error',
      error: { type: 'not_found_error', message: 'Unsupported proxy route' },
    });
  }

  const correlation = adapter.extractCorrelation(
    request.headers as Record<string, string | string[] | undefined>,
    parsedBody,
  );

  const ctx: AttemptContext = {
    attemptId: randomUUID(),
    startedAt,
    auth,
    adapter,
    vendorConfig,
    operation,
    model,
    serviceTier: typeof parsedBody.service_tier === 'string' ? parsedBody.service_tier : 'default',
    correlation,
    agentId,
    invocationId,
    actionId,
  };

  // 5. Model allowlist + pricing — fail closed BEFORE any upstream call. No
  //    cross-model fallback. Rejections are durably recorded.
  const canonical = adapter.canonicalizeModel(model);
  const allowed = vendorConfig.allowedModels.includes(canonical) || vendorConfig.allowedModels.includes(model);
  if (!allowed) {
    request.log.warn({ model, vendor: auth.vendor }, 'Model not allowed');
    await recordRejectedAttempt(ctx, 'model_not_allowed').catch((err) =>
      request.log.error({ err }, 'Failed to record model-not-allowed attempt'),
    );
    return reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: `Model not allowed: ${model}` },
    });
  }
  if (!vendorConfig.pricing[canonical]) {
    request.log.warn({ model, vendor: auth.vendor }, 'No pricing for model');
    await recordRejectedAttempt(ctx, 'unpriced_model').catch((err) =>
      request.log.error({ err }, 'Failed to record unpriced-model attempt'),
    );
    return reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: `No pricing for model: ${model}` },
    });
  }

  // 6. Resolve the vendor API key (ref-swap-validated, LRU-cached).
  let vendorApiKey: string;
  try {
    vendorApiKey = await resolveVendorApiKey(auth.secretName, auth.tenantId, auth.userId, auth.vendor);
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    request.log.error({ err, keyId: auth.keyId }, 'Failed to resolve vendor API key');
    return reply.code(code).send({
      type: 'error',
      error: { type: 'api_error', message: 'Could not resolve API credentials' },
    });
  }

  // 7. Normalize the body (adapter-owned allowlist; raw passthrough for
  //    Anthropic) and build upstream headers.
  let upstreamBody: Buffer;
  try {
    upstreamBody = adapter.normalizeRequestBody(parsedBody, bodyBuffer);
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode ?? 400;
    return reply.code(code).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: (err as Error).message },
    });
  }

  const allowedHeaders = adapter.getAllowedRequestHeaders();
  const upstreamHeaders: Record<string, string> = {
    ...adapter.buildAuthHeaders(vendorApiKey),
    'content-type': 'application/json',
  };
  for (const [k, v] of Object.entries(request.headers)) {
    if (allowedHeaders.has(k.toLowerCase()) && typeof v === 'string') {
      upstreamHeaders[k.toLowerCase()] = v;
    }
  }

  // 8. Upstream fetch with abort wiring: client disconnect, connect timeout,
  //    overall timeout.
  const abort = new AbortController();
  let abortCause: 'client' | 'connect_timeout' | 'overall_timeout' | null = null;
  let clientGone = false;

  const onClientClose = (): void => {
    clientGone = true;
    if (abortCause === null) { abortCause = 'client'; abort.abort(); }
  };
  request.raw.on('close', onClientClose);

  const connectTimer = setTimeout(() => {
    if (abortCause === null) { abortCause = 'connect_timeout'; abort.abort(); }
  }, config.UPSTREAM_CONNECT_TIMEOUT_MS);
  const overallTimer = setTimeout(() => {
    if (abortCause === null) { abortCause = 'overall_timeout'; abort.abort(); }
  }, config.UPSTREAM_OVERALL_TIMEOUT_MS);

  const upstreamUrl = adapter.buildUpstreamUrl(request.url, vendorConfig);
  let upstreamRes: Response;
  try {
    upstreamRes = await (fetch as (url: string, init: unknown) => Promise<Response>)(
      upstreamUrl.toString(),
      { method: 'POST', headers: upstreamHeaders, body: upstreamBody, duplex: 'half', signal: abort.signal },
    );
    clearTimeout(connectTimer);
  } catch (err) {
    clearTimeout(connectTimer);
    clearTimeout(overallTimer);
    request.raw.removeListener('close', onClientClose);

    const lifecycle: Exclude<LifecycleStatus, 'started'> =
      abortCause === 'client' ? 'aborted_by_client'
      : abortCause !== null ? 'timed_out'
      : 'transport_error';
    await recordTerminal(ctx, {
      lifecycle, usage: null, httpStatus: null,
      errorCategory: lifecycle === 'transport_error' ? 'upstream_fetch_failed' : lifecycle,
      errorMessage: String(err),
    }).catch((e) => request.log.error({ e }, 'Failed to record failed fetch'));

    if (lifecycle === 'aborted_by_client') return;
    return reply.code(lifecycle === 'timed_out' ? 504 : 502).send({
      type: 'error',
      error: { type: 'api_error', message: lifecycle === 'timed_out' ? 'Upstream timeout' : 'Failed to reach upstream API' },
    });
  }

  // 9. Forward safe response headers to the client.
  reply.code(upstreamRes.status);
  const safeHeaders = adapter.getSafeResponseHeaders();
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (safeHeaders.has(k.toLowerCase())) reply.header(k, v);
  }

  const emptyUsage: TokenUsage = {
    requestId: '',
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheWriteTokens: auth.vendor === 'openai' ? null : 0,
    reasoningTokens: 0,
  };

  // 10a. Non-streaming: buffer, record durably, return.
  const contentType = upstreamRes.headers.get('content-type') ?? '';
  if (!isStreaming || !upstreamRes.body || !contentType.includes('text/event-stream')) {
    let body: string;
    try {
      body = await upstreamRes.text();
    } catch (err) {
      clearTimeout(overallTimer);
      request.raw.removeListener('close', onClientClose);
      const lifecycle: Exclude<LifecycleStatus, 'started'> =
        abortCause === 'client' ? 'aborted_by_client'
        : abortCause !== null ? 'timed_out' : 'transport_error';
      await recordTerminal(ctx, {
        lifecycle, usage: null, httpStatus: upstreamRes.status,
        errorCategory: 'upstream_body_read_failed', errorMessage: String(err),
      }).catch((e) => request.log.error({ e }, 'Failed to record body-read failure'));
      if (lifecycle === 'aborted_by_client') return;
      return reply.code(502).send({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to read upstream response' },
      });
    }
    clearTimeout(overallTimer);
    request.raw.removeListener('close', onClientClose);

    let record: TerminalRecord;
    if (!upstreamRes.ok) {
      record = { lifecycle: 'failed', usage: null, httpStatus: upstreamRes.status, errorCategory: `provider_http_${upstreamRes.status}` };
    } else {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const usage = ctx.adapter.parseNonStreamingUsage(parsed, model);
        record = { lifecycle: 'completed', usage, httpStatus: upstreamRes.status, errorCategory: usage ? null : 'missing_usage' };
      } catch {
        record = { lifecycle: 'failed', usage: null, httpStatus: upstreamRes.status, errorCategory: 'malformed_provider_json' };
      }
    }

    await recordTerminal(ctx, record).catch((err) =>
      request.log.error({ err, attemptId: ctx.attemptId }, 'Failed to record non-streaming attempt'),
    );
    return reply.send(body);
  }

  // 10b. SSE streaming: tee bytes to the client while accumulating usage and
  //      lifecycle signals.
  reply.header('cache-control', 'no-cache');
  reply.header('connection', 'keep-alive');
  reply.raw.flushHeaders();

  let usage: TokenUsage = { ...emptyUsage };
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  let lifecycleSignal: TerminalRecord['lifecycle'] | null = null;
  let errorCategory: string | null = null;
  let errorMessage: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      sseBuffer += chunk;

      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const rawData = line.slice(6).trim();
        const event = ctx.adapter.parseSseDataLine(rawData);
        if (!event) continue;
        usage = ctx.adapter.accumulateUsage(usage, event);
        const signal = ctx.adapter.extractLifecycle(event);
        if (signal) {
          lifecycleSignal = signal.status;
          if (signal.errorCategory) errorCategory = signal.errorCategory;
        }
      }

      if (!clientGone) reply.raw.write(chunk);
      else break;
    }
  } catch (err) {
    errorMessage = String(err);
    request.log.warn({ err, keyId: auth.keyId }, 'SSE stream error');
  } finally {
    reader.releaseLock();
    clearTimeout(overallTimer);
    request.raw.removeListener('close', onClientClose);
  }

  let lifecycle: TerminalRecord['lifecycle'];
  if (clientGone && lifecycleSignal === null) {
    lifecycle = 'aborted_by_client';
  } else if (abortCause === 'overall_timeout' || abortCause === 'connect_timeout') {
    lifecycle = 'timed_out';
  } else if (errorMessage !== undefined && lifecycleSignal === null) {
    lifecycle = 'transport_error';
    errorCategory = errorCategory ?? 'stream_error';
  } else {
    lifecycle = lifecycleSignal ?? 'incomplete';
    if (lifecycle === 'incomplete' && errorCategory === null) {
      errorCategory = 'stream_ended_without_terminal_event';
    }
  }

  // Every byte, the terminal event included, has reached the client; only the
  // close waits for the usage row. On request-based CPU the request is the only
  // time the instance has CPU, so a write started after end() would stall until
  // the next request. The wait is bounded and its failure swallowed, so metering
  // can delay the close by at most RECORD_BEFORE_CLOSE_MAX_MS and never fail the
  // response (INV-DP-005).
  const recorded = recordTerminal(ctx, {
    lifecycle,
    usage: usage.inputTokens > 0 || usage.outputTokens > 0 || usage.requestId !== '' ? usage : null,
    httpStatus: upstreamRes.status,
    errorCategory,
    errorMessage,
  }).catch((err) =>
    request.log.error({ err, attemptId: ctx.attemptId }, 'Failed to record streaming attempt'),
  );
  await closeAfter(recorded, () => reply.raw.end());
}

// ---------------------------------------------------------------------------
// GET passthrough (read-only model discovery — never metered).
// ---------------------------------------------------------------------------

export async function handleVendorGetPassthrough(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.devProxyAuth!;
  const pool = await getPool();

  const routeVendor = request.resolvedVendor ?? 'anthropic';
  if (routeVendor !== auth.vendor) {
    return reply.code(403).send({
      type: 'error',
      error: { type: 'permission_error', message: 'Credential vendor does not match route vendor' },
    });
  }

  let adapter: VendorAdapter;
  let vendorConfig: VendorConfig;
  try {
    adapter      = getAdapter(auth.vendor);
    vendorConfig = await getVendorConfig(pool, auth.vendor);
  } catch (err) {
    return reply.code(400).send({
      type: 'error',
      error: { type: 'invalid_request_error', message: (err as Error).message },
    });
  }

  let vendorApiKey: string;
  try {
    vendorApiKey = await resolveVendorApiKey(auth.secretName, auth.tenantId, auth.userId, auth.vendor);
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    request.log.error({ err, keyId: auth.keyId }, 'Failed to resolve vendor API key');
    return reply.code(code).send({
      type: 'error',
      error: { type: 'api_error', message: 'Could not resolve API credentials' },
    });
  }

  const upstreamUrl = adapter.buildUpstreamUrl(request.url, vendorConfig);
  let upstreamRes: Response;
  try {
    upstreamRes = await (fetch as (url: string, init: unknown) => Promise<Response>)(
      upstreamUrl.toString(),
      { method: 'GET', headers: adapter.buildAuthHeaders(vendorApiKey) },
    );
  } catch (err) {
    request.log.error({ err, keyId: auth.keyId }, 'Upstream GET fetch failed');
    return reply.code(502).send({
      type: 'error',
      error: { type: 'api_error', message: 'Failed to reach upstream API' },
    });
  }

  reply.code(upstreamRes.status);
  const safeHeaders = adapter.getSafeResponseHeaders();
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (safeHeaders.has(k.toLowerCase())) reply.header(k, v);
  }
  return reply.send(await upstreamRes.text());
}

// ---------------------------------------------------------------------------
// Durable recording: usage-log row + billing outbox event, one transaction.
// ---------------------------------------------------------------------------

function legacyStatus(lifecycle: TerminalRecord['lifecycle']): string {
  switch (lifecycle) {
    case 'completed': return 'final';
    case 'aborted_by_client': return 'disconnected';
    default: return 'error';
  }
}

async function recordRejectedAttempt(ctx: AttemptContext, reason: string): Promise<void> {
  await recordTerminal(ctx, { lifecycle: 'failed', usage: null, httpStatus: null, errorCategory: reason });
}

// Tracked (infrastructure/in-flight.ts): when the client has already hung up,
// the request is over before the write, and only tracking keeps shutdown from
// closing the pool under it.
function recordTerminal(ctx: AttemptContext, record: TerminalRecord): Promise<void> {
  return track(writeTerminal(ctx, record));
}

async function writeTerminal(ctx: AttemptContext, record: TerminalRecord): Promise<void> {
  const pool = await getPool();
  const usage = record.usage;
  const cacheWrite = usage
    ? (usage.cacheWriteTokens ?? (ctx.auth.vendor === 'openai' ? null : usage.cacheCreationInputTokens))
    : (ctx.auth.vendor === 'openai' ? null : 0);

  const cost = usage ? ctx.adapter.computeCost(usage, ctx.vendorConfig) : null;
  const costMicros = cost ?? 0n;
  const completeness = usage ? (cost === null ? 'unavailable' : 'measured') : 'unavailable';
  const requestId = usage?.requestId || generateFallbackRequestId(ctx.attemptId);
  const completedAt = new Date();
  const durationMs = Math.round(completedAt.getTime() - ctx.startedAt.getTime());
  const triggeredBy = ctx.auth.userId ? `human:${ctx.auth.userId}` : 'system';

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO developer_proxy_usage_log
         (tenant_id, user_id, credential_id, vendor, model, request_id,
          attempt_id, lifecycle_status, operation, service_tier,
          provider_request_id, session_id, thread_id, turn_id, client_request_id,
          input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens,
          reasoning_tokens, total_tokens, cost_micros, status, http_status,
          usage_completeness, error_category, error_message,
          started_at, finalized_at, agent_id, invocation_id, action_id)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10,
               $11, $12, $13, $14, $15,
               $16, $17, $18, $19,
               $20, $21, $22, $23, $24,
               $25, $26, $27,
               $28, NOW(), $29, $30, $31)`,
      [
        ctx.auth.tenantId, ctx.auth.userId, ctx.auth.keyId, ctx.auth.vendor,
        usage?.model || ctx.model, requestId,
        ctx.attemptId, record.lifecycle, ctx.operation, usage?.serviceTier ?? ctx.serviceTier,
        usage?.requestId || null, ctx.correlation.sessionId ?? null, ctx.correlation.threadId ?? null,
        ctx.correlation.turnId ?? null, ctx.correlation.clientRequestId ?? null,
        usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.cachedInputTokens ?? 0, cacheWrite,
        usage?.reasoningTokens ?? 0, usage?.totalTokens ?? null, costMicros.toString(),
        legacyStatus(record.lifecycle), record.httpStatus,
        completeness, record.errorCategory, record.errorMessage ?? null,
        ctx.startedAt, ctx.agentId, ctx.invocationId, ctx.actionId,
      ],
    );

    // Billing outbox event — atomically bound to the usage row. The billing
    // service consumes it idempotently keyed on request_id.
    await client.query(
      `INSERT INTO outbox_events (event_id, event_type, schema_version, tenant_id, payload, occurred_at)
       VALUES ($1, 'billing.meter.usage_recorded', 2, $2, $3, NOW())
       ON CONFLICT (event_id) DO NOTHING`,
      [
        randomUUID(), ctx.auth.tenantId,
        JSON.stringify({
          requestId, attemptId: ctx.attemptId, tenantId: ctx.auth.tenantId, userId: ctx.auth.userId,
          credentialId: ctx.auth.keyId, vendor: ctx.auth.vendor, model: usage?.model || ctx.model,
          operation: ctx.operation, lifecycleStatus: record.lifecycle,
          inputTokens: usage?.inputTokens ?? 0, cachedInputTokens: usage?.cachedInputTokens ?? 0,
          cacheWriteTokens: cacheWrite, outputTokens: usage?.outputTokens ?? 0,
          reasoningTokens: usage?.reasoningTokens ?? 0, costMicros: costMicros.toString(),
          usageCompleteness: completeness, status: legacyStatus(record.lifecycle),
          startedAt: ctx.startedAt.toISOString(), agentId: ctx.agentId, invocationId: ctx.invocationId,
          sessionId: ctx.correlation.sessionId ?? null,
        }),
      ],
    );

    // Audit outbox event so developer-proxy requests appear on the activity
    // page. drainOutboxes() (outbox/worker.ts) POSTs audit.* events to
    // platform-backend on its next ingestion-feed poll, which pokeCostIngest arms.
    await client.query(
      `INSERT INTO outbox_events (event_id, event_type, schema_version, tenant_id, payload, occurred_at)
       VALUES ($1, 'audit.developer_proxy_request', 1, $2, $3, NOW())
       ON CONFLICT (event_id) DO NOTHING`,
      [
        randomUUID(), ctx.auth.tenantId,
        JSON.stringify({
          tenantId: ctx.auth.tenantId, internalAgentId: ctx.agentId ?? undefined,
          action: 'developer_proxy_request',
          inputArgs: {
            model: usage?.model || ctx.model, operation: ctx.operation,
            inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, userId: ctx.auth.userId,
          },
          outputSummary: null,
          outcome: record.lifecycle === 'completed' ? 'success' : 'error',
          durationMs, triggeredBy, invocationId: ctx.invocationId ?? undefined,
          sessionId: ctx.correlation.sessionId ?? undefined,
        }),
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  // The row is spend platform-backend's cost pass has not seen: arm it.
  await pokeCostIngest();
}

function generateFallbackRequestId(attemptId: string): string {
  return createHash('sha256').update(attemptId).digest('hex').slice(0, 32);
}
