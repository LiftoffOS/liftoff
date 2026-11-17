// Apify native executor — a workspace's OWN account, nothing else.
//
// Apify's store actors are run for the platform from platform-backend
// (src/capability-discovery/apify-executor.ts there), on the platform's own
// rungs: the x402 prepaid token, then the platform account. This executor is
// the rung ABOVE both: a workspace that has connected its Apify account runs
// its actors here, on its own balance, and the call is booked `tenant_key`
// so the platform charges no Operating Units for the vendor part. There is
// deliberately no platform key on this path: a call that reaches here
// without the workspace's credential is refused, never quietly paid for.
//
// run_actor mirrors the platform executor's discipline: every run is started
// with a timeout, a memory cap, an item cap and a charge cap; the run is
// polled by ITS id until Apify reports a terminal status; the dataset is
// read by that id; and the cost is read from the run record after the
// per-result charges have landed (they arrive seconds after the run turns
// terminal). Nothing reads "the actor's most recent run".

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';
import { tenantOwnApiKey } from './platform-vendor-keys.js';
import { logger } from '../infra/logging.js';

const APIFY_BASE = 'https://api.apify.com/v2';
const RUN_TIMEOUT_SECONDS = 90;
const RUN_MEMORY_MB = 1024;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_TOTAL_CHARGE_USD = 1;
/** Apify's long-poll bound on a start or status call. */
const MAX_WAIT_FOR_FINISH_SECONDS = 60;
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
/** Per-result charges land after the run turns terminal (measured on a
 *  pay-per-event actor: counts ~5 s later, USD ~10 s). */
const PER_RESULT_PRICING_MODELS = new Set(['PAY_PER_EVENT', 'PRICE_PER_DATASET_ITEM']);
const SETTLEMENT_WAIT_MS = 15_000;
const SETTLEMENT_POLL_MS = 2_000;

interface ApifyRun {
  id: string;
  status: string;
  statusMessage?: string;
  usageTotalUsd?: number;
  defaultDatasetId?: string;
  pricingInfo?: { pricingModel?: string };
  chargedEventCounts?: Record<string, number>;
}

function toApiActorId(actorId: string): string {
  return actorId.trim().replace('/', '~');
}

function readSourceError(body: unknown): { type: string; message: string } | null {
  const err = (body as { error?: { type?: unknown; message?: unknown } } | null)?.error;
  return typeof err?.type === 'string' && typeof err?.message === 'string'
    ? { type: err.type, message: err.message }
    : null;
}

function positiveInt(v: unknown, fallback: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

function positiveNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function settled(run: ApifyRun | null, carriedUsd: number | undefined): boolean {
  if (!run) return false;
  const counts = run.chargedEventCounts ?? {};
  const resultsCharged = Object.entries(counts).some(
    ([event, n]) => event !== 'apify-actor-start' && typeof n === 'number' && n > 0,
  );
  const usd = run.usageTotalUsd;
  const moved = typeof usd === 'number' && (carriedUsd === undefined || usd > carriedUsd);
  return resultsCharged && moved;
}

type Transport = ReturnType<typeof makePublicWebTransport>;

async function fetchRun(transport: Transport, runId: string, waitForFinishSecs: number): Promise<ApifyRun | null> {
  const resp = await transport({
    method: 'GET',
    url: `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}`,
    query: waitForFinishSecs > 0 ? { waitForFinish: String(waitForFinishSecs) } : {},
  });
  if (!resp.ok) return null;
  const body = (await resp.json().catch(() => null)) as { data?: ApifyRun } | null;
  return body?.data ?? null;
}

/** The run's cost after its per-result charges have landed, or the figure it
 *  carried when they do not within the wait; undefined when the vendor
 *  reported nothing positive. */
async function readRunCost(transport: Transport, terminalRun: ApifyRun, itemsReturned: number): Promise<number | undefined> {
  const carried = typeof terminalRun.usageTotalUsd === 'number' ? terminalRun.usageTotalUsd : undefined;
  const expectSettlement = PER_RESULT_PRICING_MODELS.has(terminalRun.pricingInfo?.pricingModel ?? '') && itemsReturned > 0;
  const deadline = Date.now() + SETTLEMENT_WAIT_MS;
  let latest: ApifyRun | null = null;
  try {
    for (;;) {
      latest = await fetchRun(transport, terminalRun.id, 0);
      if (!latest) return carried !== undefined && carried > 0 ? carried : undefined;
      if (!expectSettlement || settled(latest, carried)) break;
      if (Date.now() + SETTLEMENT_POLL_MS > deadline) {
        logger.warn({ metric: 'apify_run_cost_unsettled', runId: terminalRun.id, usd: latest.usageTotalUsd ?? null }, 'apify per-result charges had not settled within the wait; reporting the figure as it stands');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_POLL_MS));
    }
    const usd = typeof latest?.usageTotalUsd === 'number' ? latest.usageTotalUsd : carried;
    return usd !== undefined && usd > 0 ? usd : undefined;
  } catch (err) {
    logger.warn({ runId: terminalRun.id, err: (err as Error).message }, 'apify run cost read threw; using the figure the run carried');
    return carried !== undefined && carried > 0 ? carried : undefined;
  }
}

function failure(message: string, result: JsonObject = {}, extra: Partial<ExecutorResult> = {}): ExecutorResult {
  return { result, failure: { message }, ...extra };
}

async function runActor(ctx: ExecutorContext, transport: Transport): Promise<ExecutorResult> {
  const actorId = typeof ctx.input.actorId === 'string' ? ctx.input.actorId.trim() : '';
  if (!actorId) return failure('run_actor needs actorId ("username/actor-name")');
  const input = ctx.input.input && typeof ctx.input.input === 'object' ? ctx.input.input as JsonObject : {};
  const maxItems = positiveInt(ctx.input.maxItems, DEFAULT_MAX_ITEMS, 1000);
  const maxTotalChargeUsd = positiveNumber(ctx.input.maxTotalChargeUsd, DEFAULT_MAX_TOTAL_CHARGE_USD);
  const id = toApiActorId(actorId);

  const started = Date.now();
  const deadline = started + (RUN_TIMEOUT_SECONDS + 15) * 1000;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  let run: ApifyRun;
  try {
    const resp = await transport({
      method: 'POST',
      url: `${APIFY_BASE}/acts/${encodeURIComponent(id)}/runs`,
      query: {
        timeout: String(RUN_TIMEOUT_SECONDS),
        memory: String(RUN_MEMORY_MB),
        waitForFinish: String(MAX_WAIT_FOR_FINISH_SECONDS),
        maxItems: String(maxItems),
        maxTotalChargeUsd: String(maxTotalChargeUsd),
      },
      body: input,
    });
    const body = (await resp.json().catch(() => null)) as { data?: ApifyRun } | null;
    if (!resp.ok) {
      const sourceError = readSourceError(body);
      const message = sourceError
        ? `apify refused the run: ${sourceError.type}: ${sourceError.message}`
        : `apify refused the run (HTTP ${resp.status})`;
      return failure(message, (body as JsonObject) ?? {}, { vendorLatencyMs: Date.now() - started });
    }
    if (!body?.data?.id) return failure('apify acknowledged the run without a run id', {}, { vendorLatencyMs: Date.now() - started });
    run = body.data;
  } catch (err) {
    return failure(`apify start call failed: ${(err as Error).message}`, {}, { vendorLatencyMs: Date.now() - started });
  }

  // A run exists from here on: every outcome below carries its id, and a
  // charge the vendor reports is this attempt's.
  const withRun = (message: string, cost?: number): ExecutorResult => ({
    result: { runId: run.id, status: run.status } as JsonObject,
    vendorLatencyMs: Date.now() - started,
    failure: { message },
    ...(cost !== undefined ? { costUsd: cost } : {}),
    fundingSource: 'tenant_key',
  });

  try {
    while (!TERMINAL_STATUSES.has(run.status) && remainingMs() > 0) {
      const waitSecs = Math.max(1, Math.min(MAX_WAIT_FOR_FINISH_SECONDS, Math.ceil(remainingMs() / 1000)));
      const polled = await fetchRun(transport, run.id, waitSecs);
      if (!polled) return withRun('apify could not be reached while the run was in progress');
      run = polled;
    }
  } catch (err) {
    return withRun(`apify status poll failed: ${(err as Error).message}`);
  }
  if (!TERMINAL_STATUSES.has(run.status)) return withRun('the run did not finish in time', run.usageTotalUsd);
  if (run.status !== 'SUCCEEDED') {
    return withRun(
      run.status === 'TIMED-OUT' ? 'the run timed out' : `the run ended ${run.status}${run.statusMessage ? `: ${run.statusMessage.slice(0, 200)}` : ''}`,
      run.usageTotalUsd && run.usageTotalUsd > 0 ? run.usageTotalUsd : undefined,
    );
  }

  let items: unknown[];
  try {
    const itemsResp = await transport({
      method: 'GET',
      url: `${APIFY_BASE}/actor-runs/${encodeURIComponent(run.id)}/dataset/items`,
      query: { limit: String(maxItems), format: 'json' },
    });
    if (!itemsResp.ok) return withRun(`apify would not give up the run's dataset (HTTP ${itemsResp.status})`, run.usageTotalUsd);
    const parsed = (await itemsResp.json().catch(() => [])) as unknown;
    items = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return withRun(`apify dataset read failed: ${(err as Error).message}`, run.usageTotalUsd);
  }

  const costUsd = await readRunCost(transport, run, items.length);
  return {
    result: {
      runId: run.id,
      datasetId: run.defaultDatasetId ?? null,
      items: items as JsonObject[keyof JsonObject],
    } as JsonObject,
    vendorLatencyMs: Date.now() - started,
    ...(costUsd !== undefined ? { costUsd } : {}),
    fundingSource: 'tenant_key',
  };
}

async function simpleGet(transport: Transport, url: string, query: Record<string, string>, started: number, what: string): Promise<ExecutorResult> {
  try {
    const resp = await transport({ method: 'GET', url, query });
    const body = (await resp.json().catch(() => null)) as JsonObject | JsonObject[] | null;
    const vendorLatencyMs = Date.now() - started;
    if (!resp.ok) {
      const sourceError = readSourceError(body);
      return failure(
        sourceError ? `apify ${what}: ${sourceError.type}: ${sourceError.message}` : `apify ${what} failed (HTTP ${resp.status})`,
        (Array.isArray(body) ? {} : body) ?? {},
        { vendorLatencyMs },
      );
    }
    const result: JsonObject = Array.isArray(body)
      ? { items: body as JsonObject[keyof JsonObject] }
      : ((body?.data as JsonObject | undefined) ?? body ?? {});
    return { result, vendorLatencyMs };
  } catch (err) {
    return failure(`apify ${what} failed: ${(err as Error).message}`, {}, { vendorLatencyMs: Date.now() - started });
  }
}

export async function apifyExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const byoKey = tenantOwnApiKey(ctx);
  if (!byoKey) {
    return failure(
      'apify: no connected Apify account on this workspace; the platform runs Store actors on its own rungs from platform-backend, not through this connector',
    );
  }
  const transport = makePublicWebTransport('apify', { ...DEFAULT_PUBLIC_WEB_HEADERS, Authorization: `Bearer ${byoKey}` });
  const started = Date.now();

  switch (ctx.functionName) {
    case 'run_actor':
      return runActor(ctx, transport);
    case 'get_dataset_items': {
      const datasetId = typeof ctx.input.datasetId === 'string' ? ctx.input.datasetId.trim() : '';
      if (!datasetId) return failure('get_dataset_items needs datasetId');
      return simpleGet(
        transport,
        `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items`,
        {
          limit: String(positiveInt(ctx.input.limit, DEFAULT_MAX_ITEMS, 1000)),
          offset: String(positiveInt(ctx.input.offset, 0, 1_000_000)),
          format: 'json',
        },
        started,
        'dataset read',
      );
    }
    case 'get_actor': {
      const actorId = typeof ctx.input.actorId === 'string' ? ctx.input.actorId.trim() : '';
      if (!actorId) return failure('get_actor needs actorId');
      return simpleGet(transport, `${APIFY_BASE}/acts/${encodeURIComponent(toApiActorId(actorId))}`, {}, started, 'actor read');
    }
    case 'list_runs': {
      const query: Record<string, string> = { limit: String(positiveInt(ctx.input.limit, 20, 100)), desc: '1' };
      if (typeof ctx.input.status === 'string' && ctx.input.status.trim()) query.status = ctx.input.status.trim().toUpperCase();
      return simpleGet(transport, `${APIFY_BASE}/actor-runs`, query, started, 'run list');
    }
    default:
      return failure(`apify has no tool named ${ctx.functionName}`);
  }
}

registerConnectorExecutor('apify', apifyExecutor);
