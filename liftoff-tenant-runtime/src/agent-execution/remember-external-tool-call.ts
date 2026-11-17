// Remember one tool call the gateway did not dispatch — in the ledger and in
// the provenance store — whichever engine made it and however its name arrived.
//
// Two records, one call, and they were made in three places with the same
// eight lines each: the autonomous loop, the workflow-step loop and the chat
// turn all translate the engine's name to the SDK form, then write the ledger
// row and hand the result to the provenance store. A fourth caller now exists
// — the bridge, which waits for this BEFORE the model sees the result — and a
// fourth copy is how the three drifted from each other the first time.
//
// Never throws, and never takes longer than `REMEMBER_TIMEOUT_MS`: the bridge
// awaits it on the hot path of every tool call, and a store that cannot be
// reached is not grounds to stall the run. Both recorders are already
// non-throwing on their own; the bound is for the transport.

import { recordExternalToolCall } from '../action-ledger/record-external-tool-call';
import { getToolGatewayDispatcher } from '../tool-gateway/dispatcher';
import { sdkCallNameFor, isOwnGatewayTool } from '../hitl-enforcement/tool-name-resolution';
import { deriveIdArgs } from '../connectors/derive-declarations';
import { logger } from '../infrastructure/logging';

/** How long a caller that WAITS for the record (the bridge) can be held. Read
 *  per call so a test can shorten it. */
function rememberTimeoutMs(): number {
  const v = Number(process.env.EXTERNAL_CALL_REMEMBER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 5_000;
}

/** What became of the record. `skipped` is a call of our own gateway's, which
 *  the gateway remembered itself; the other three say whether the store has
 *  it. Only `recorded` and `skipped` mean "remembered before the model acts". */
export type RememberOutcome = 'recorded' | 'skipped' | 'failed' | 'timed_out';

export interface RememberExternalToolCallArgs {
  /** The run's catalog: the one place a bare `<server>__<tool>` name can be
   *  told apart from one of our own gateway's. */
  catalog: Parameters<typeof sdkCallNameFor>[0];
  tenantId: string;
  agentId: string;
  invocationId: string | undefined;
  /** The engine's id for the call. Absent when the engine gave none — the
   *  HTTP MCP path — in which case only the provenance record is made here:
   *  the ledger row is keyed by the call id, and the engine's stream will
   *  write it under the engine's own id. */
  callId?: string;
  toolName: string;
  args: Record<string, unknown> | undefined;
  result: unknown;
  error?: string;
  /** What the triggering event was about, for the ledger's version. */
  triggerTarget?: { ref: string; version: string } | null;
}

export async function rememberExternalToolCall(a: RememberExternalToolCallArgs): Promise<RememberOutcome> {
  const external = sdkCallNameFor(a.catalog, a.toolName, a.args);
  // The gateway judged, recorded and ledgered its own tools inside execute().
  if (isOwnGatewayTool(external.toolName)) return 'skipped';

  const work = Promise.all([
    a.callId === undefined ? Promise.resolve<'skipped'>('skipped') : recordExternalToolCall({
      tenantId: a.tenantId,
      agentId: a.agentId,
      toolName: external.toolName,
      callId: a.callId,
      input: external.args,
      result: a.result,
      ...(a.error ? { error: a.error } : {}),
      ...(a.invocationId ? { invocationId: a.invocationId } : {}),
      triggerTarget: a.triggerTarget ?? null,
    }),
    getToolGatewayDispatcher().observeExternal({
      tenantId: a.tenantId,
      agentId: a.agentId,
      invocationId: a.invocationId,
      toolName: external.toolName,
      input: external.args,
      result: a.result,
      ...(a.error ? { error: a.error } : {}),
      ...derivedDeclarationFor(external.inputSchema, external.toolName),
    }),
  ]);

  const timeoutMs = rememberTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      work.then(([ledger, provenance]) => (ledger === 'failed' || provenance === false ? 'failed' : 'done') as 'done' | 'failed'),
      bound,
    ]);
    if (outcome === 'failed') {
      // One half refused: the writers are non-throwing by design and say so
      // instead. The call is not remembered until both halves are; the
      // provenance half is retried with the raw data, below.
      scheduleRetry(a, 0);
      logger.warn(
        {
          event: 'external_tool_call_not_remembered',
          metric: 'provenance.remember_bypass',
          toolName: external.toolName, callId: a.callId ?? null, invocationId: a.invocationId,
        },
        'a record was refused; the stream will remember the call, late',
      );
      return 'failed';
    }
    if (outcome === 'timeout') {
      // The call proceeds — availability over enforcement, by choice — and
      // this line is what makes that choice visible: a write judged after
      // this may be judged against a store that does not yet hold this read.
      // The in-flight record may still land; the retry re-records the same
      // data, which the store takes idempotently.
      scheduleRetry(a, 0);
      logger.warn(
        {
          event: 'external_tool_call_remember_timed_out',
          metric: 'provenance.remember_bypass',
          toolName: external.toolName, callId: a.callId ?? null, invocationId: a.invocationId, timeoutMs,
        },
        'the record did not land before the model continued; the stream will remember the call, late',
      );
      return 'timed_out';
    }
    return 'recorded';
  } catch (err) {
    // A writer that threw rather than answering false — the transport, most
    // often — is the same outcome as one that answered false: the raw copy
    // is kept and retried, because the stream's copy cannot redo it.
    scheduleRetry(a, 0);
    logger.warn(
      {
        event: 'external_tool_call_not_remembered',
        metric: 'provenance.remember_bypass',
        err: (err as Error).message, toolName: external.toolName, callId: a.callId ?? null, invocationId: a.invocationId,
      },
      'the record failed; the stream will remember the call, late',
    );
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What the request tells the judge about a vendor-hosted tool: the arguments
 * that name a record, derived from the tool's own schema by the catalog
 * mappers' rule. Sent with every guard and observe rather than registered
 * once, because the gateway runs as several instances and a registration on
 * one is not on the others. Empty for a tool with no schema in hand, or none
 * that names a record.
 */
export function derivedDeclarationFor(inputSchema: unknown, toolName?: string): { derived?: { idArgs: string[] } } {
  const idArgs = deriveIdArgs(inputSchema, toolName);
  return idArgs ? { derived: { idArgs } } : {};
}

/** Whether an outcome means the call is remembered before the model acts. */
export function remembered(outcome: RememberOutcome): boolean {
  return outcome === 'recorded' || outcome === 'skipped';
}

// ── The retry, for a record that did not land ───────────────────────────────
//
// The stream's fallback cannot redo a failed PROVENANCE record: it carries the
// model-facing result — the vendor's data inside the untrusted frame — and a
// frame is one long string to the id readers. Only the raw copy the bridge
// handed the observer can establish what a read returned. So a record that
// failed or timed out at dispatch keeps that raw copy here and is retried in
// the background, with the ordering already lost (the model has moved on) but
// the data not.
//
// Lifecycle: in this process's memory, per call, at most `RETRY_ATTEMPTS` more
// tries at `RETRY_DELAYS_MS`, then dropped and logged. Nothing survives a
// process exit — a record lost that way is the bypass the first warning named.
// The ledger half is not retried here: it is keyed by the engine's call id and
// the stream writes it, idempotently, from the finished event.

const RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 25_000];
const RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;
const MAX_PENDING_RETRIES = 500;

interface PendingRetry { args: RememberExternalToolCallArgs; attempt: number; timer: NodeJS.Timeout }
const pendingRetries = new Set<PendingRetry>();

function scheduleRetry(args: RememberExternalToolCallArgs, attempt: number): void {
  if (attempt >= RETRY_ATTEMPTS) {
    logger.warn(
      {
        event: 'external_tool_call_record_dropped',
        metric: 'provenance.remember_dropped',
        toolName: args.toolName, callId: args.callId ?? null, invocationId: args.invocationId, attempts: attempt,
      },
      'the provenance record never landed; the store does not hold this read',
    );
    return;
  }
  if (pendingRetries.size >= MAX_PENDING_RETRIES) {
    logger.warn(
      { event: 'external_tool_call_record_dropped', metric: 'provenance.remember_dropped', reason: 'queue_full', invocationId: args.invocationId },
      'too many records waiting to retry; this one is dropped',
    );
    return;
  }
  const entry: PendingRetry = {
    args,
    attempt,
    timer: setTimeout(() => {
      pendingRetries.delete(entry);
      void retryOnce(args, attempt + 1);
    }, RETRY_DELAYS_MS[attempt]),
  };
  entry.timer.unref?.();
  pendingRetries.add(entry);
}

async function retryOnce(args: RememberExternalToolCallArgs, attempt: number): Promise<void> {
  const external = sdkCallNameFor(args.catalog, args.toolName, args.args);
  try {
    const ok = await getToolGatewayDispatcher().observeExternal({
      tenantId: args.tenantId,
      agentId: args.agentId,
      invocationId: args.invocationId,
      toolName: external.toolName,
      input: external.args,
      result: args.result,
      ...(args.error ? { error: args.error } : {}),
      ...derivedDeclarationFor(external.inputSchema, external.toolName),
    });
    if (ok) {
      logger.info(
        { event: 'external_tool_call_record_retried', toolName: external.toolName, invocationId: args.invocationId, attempt },
        'the provenance record landed on retry',
      );
      return;
    }
  } catch {
    // fall through to the next attempt
  }
  scheduleRetry(args, attempt);
}

/** For tests: how many records are waiting to retry, and a way to clear them. */
export function _pendingRetryCountForTesting(): number { return pendingRetries.size; }
export function _clearPendingRetriesForTesting(): void {
  for (const e of pendingRetries) clearTimeout(e.timer);
  pendingRetries.clear();
}
