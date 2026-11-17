// Subscription router.
//
// Pub/Sub subscriber for connector-events-${env} and system-events-${env}.
// Maintains an in-memory cache of all active subscriptions keyed by tenant,
// invalidated on LISTEN/NOTIFY from the reactive_subscriptions_changed
// channel (declared in migration 222). For each event:
//   1. Look up subscriptions matching (tenantId, connectorRef, entityType).
//   2. Collect the union of paths active subs reference.
//   3. Diff entity state to produce a `changes` map.
//   4. For each sub: evaluate filter, then window if any; cooldown check;
//      fire the agent via the existing event-trigger fire path.

import { PubSub, type Message } from '@google-cloud/pubsub';
import { reactiveSubscriptionRepo, type SubscriptionRow } from './repository';
import { evaluate } from './predicate-evaluator';
import { aggregate } from './window-aggregator';
import { diffAndUpdate } from './entity-state';
import { fireAgentForSubscription } from './fire';
import { stateSignature, checkLoopGuard, recordFire } from './loop-guard';
import { createEscalation } from '../agent-execution/engine/escalation-helper';
import type { ExecutionContext } from '../agent-execution/types';
import { v4 as uuidv4 } from 'uuid';
import { emitSubscriptionMetrics } from './metrics';
import { subscribeToPgChannel } from '../integrations/web-fetch/notifier';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { setTraceContext } from '../infrastructure/safe-trace-context';

const pubsub = new PubSub();
const environment = process.env.ENVIRONMENT ?? 'dev';

const cooldownCache = new Map<string, number>();

let subscriptionCacheByTenant: Map<string, SubscriptionRow[]> = new Map();
let notifySubscription: { unsubscribe: () => void } | null = null;
let metricsInterval: NodeJS.Timeout | null = null;

// Rolling counters for emitSubscriptionMetrics. Reset each emission cycle.
let matchedThisInterval = 0;
let erroredThisInterval = 0;
const evalDurations: number[] = []; // ms samples; drained on each emit

function recordEval(durationMs: number): void {
  evalDurations.push(durationMs);
  // Cap to bound memory between cycles.
  if (evalDurations.length > 10_000) evalDurations.shift();
}

function p99(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return sorted[idx];
}

async function metricsTick(): Promise<void> {
  let active = 0;
  for (const subs of subscriptionCacheByTenant.values()) active += subs.length;

  let errored = erroredThisInterval;
  // Pick up errored rows the repo has flipped to 'errored' since last tick.
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reactive_subscriptions WHERE status='errored'`
    );
    errored = Number(rows[0]?.count ?? 0);
  } catch {
    // Fall through with the in-process counter only.
  }

  await emitSubscriptionMetrics({
    activeCount: active,
    matchedThisInterval,
    erroredCount: errored,
    evalDurationP99Ms: p99(evalDurations),
  });

  matchedThisInterval = 0;
  erroredThisInterval = 0;
  evalDurations.length = 0;
}

export async function startSubscriptionRouter(): Promise<void> {
  await loadAllSubscriptionsIntoCache();
  startPgListener();

  const sub = pubsub.subscription(`connector-events-${environment}-rs`);
  sub.on('message', handleConnectorEvent);
  sub.on('error', err => logger.error('Subscription router connector-events error', { err: err.message }));

  const sysSub = pubsub.subscription(`system-events-${environment}-rs`);
  sysSub.on('message', handleSystemEvent);
  sysSub.on('error', err => logger.error('Subscription router system-events error', { err: err.message }));

  // Emit cloud monitoring metrics every 60s.
  metricsInterval = setInterval(() => {
    void metricsTick().catch(err =>
      logger.warn('emitSubscriptionMetrics failed', { err: (err as Error).message }),
    );
  }, 60_000);

  logger.info('Subscription router started');
}

async function loadAllSubscriptionsIntoCache(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM reactive_subscriptions WHERE status='active'`
  );
  const byTenant = new Map<string, SubscriptionRow[]>();
  for (const r of rows) {
    const sub = (reactiveSubscriptionRepo as unknown as {
      rowToSubscription: (r: unknown) => SubscriptionRow;
    }).rowToSubscription(r);
    if (!byTenant.has(sub.tenantId)) byTenant.set(sub.tenantId, []);
    byTenant.get(sub.tenantId)!.push(sub);
  }
  subscriptionCacheByTenant = byTenant;
  logger.info('Subscription cache loaded', {
    tenantCount: byTenant.size,
    totalSubscriptions: rows.length,
  });
}

function startPgListener(): void {
  notifySubscription = subscribeToPgChannel('reactive_subscriptions_changed', (payload) => {
    const [tenantId] = payload.split(':');
    if (tenantId) void invalidateTenant(tenantId);
  });
}

export async function stopSubscriptionRouter(): Promise<void> {
  notifySubscription?.unsubscribe();
  notifySubscription = null;
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}

async function invalidateTenant(tenantId: string): Promise<void> {
  subscriptionCacheByTenant.delete(tenantId);
}

async function handleConnectorEvent(message: Message): Promise<void> {
  try {
    const env = JSON.parse(message.data.toString()) as {
      tenantId?: string;
      connectorId?: string;
      connectorType?: string;
      connectorRef?: string;
      entityType?: string;
      entityId?: string;
      payload?: { id?: string; data?: Record<string, unknown> };
      data?: Record<string, unknown>;
    };
    const tenantId = env.tenantId || message.attributes?.tenantId;
    const connectorId = env.connectorId || message.attributes?.connectorId;
    const connectorRef = env.connectorType || env.connectorRef;
    const entityType = env.entityType || message.attributes?.entityType;
    const entityId = env.entityId || env.payload?.id;

    if (!tenantId || !connectorRef || !entityType || !connectorId || !entityId) { message.ack(); return; }

    const subs = await reactiveSubscriptionRepo.listForConnectorEvent(tenantId, connectorRef, entityType);
    if (subs.length === 0) { message.ack(); return; }

    const watchedPaths = collectPathsFromSubs(subs);
    const entityData = env.payload?.data ?? env.data ?? {};
    const changes = await diffAndUpdate(tenantId, connectorId, entityType, entityId, watchedPaths, entityData);
    const evt = { data: entityData, changes };

    await Promise.allSettled(subs.map(s => maybeFire(s, evt, entityId, entityType, watchedPaths)));
    message.ack();
  } catch (err) {
    logger.error('handleConnectorEvent error', { err: (err as Error).message });
    message.nack();
  }
}

async function handleSystemEvent(message: Message): Promise<void> {
  try {
    const env = JSON.parse(message.data.toString()) as {
      tenantId?: string;
      topic?: string;
      data?: Record<string, unknown>;
      payload?: { id?: string; data?: Record<string, unknown> };
    };
    const tenantId = env.tenantId || message.attributes?.tenantId;
    const topic = env.topic || message.attributes?.topic;
    if (!tenantId || !topic) { message.ack(); return; }

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM reactive_subscriptions
       WHERE tenant_id=$1 AND status='active' AND source_kind='system_event'
         AND source_spec->>'topic'=$2`,
      [tenantId, topic]
    );
    const subs = rows.map(r => (reactiveSubscriptionRepo as unknown as {
      rowToSubscription: (r: unknown) => SubscriptionRow;
    }).rowToSubscription(r));
    if (subs.length === 0) { message.ack(); return; }

    const data = env.payload?.data ?? env.data ?? {};
    const recordKey = env.payload?.id ?? 'system';
    const evt = { data, changes: {} };
    await Promise.allSettled(subs.map(s => maybeFire(s, evt, recordKey)));
    message.ack();
  } catch (err) {
    logger.error('handleSystemEvent error', { err: (err as Error).message });
    message.nack();
  }
}

async function maybeFire(
  sub: SubscriptionRow,
  evt: { data: Record<string, unknown>; changes?: Record<string, { old: unknown; new: unknown }> },
  recordKey: string,
  eventEntityType?: string,
  watchedPaths?: string[],
): Promise<void> {
  const start = Date.now();
  try {
    if (sub.filter && !evaluate(sub.filter, evt)) return;

    if (sub.window) {
      const agg = await aggregate(sub.id, sub.window, evt);
      if (!agg.matched) return;
    }

    const cdKey = `${sub.id}:${recordKey}`;
    const cdMs = (sub.cooldownSeconds ?? 60) * 1000;
    const last = cooldownCache.get(cdKey);
    if (last && Date.now() - last < cdMs) return;
    cooldownCache.set(cdKey, Date.now());

    // No-progress loop guard (connector_event only — subjectKey + state signature are
    // meaningful there). Counts same-state repeats (a loop) and 24h fire volume (runaway);
    // on a trip it SKIPS the fire and escalates instead of spinning on one subject.
    if (sub.source.kind === 'connector_event') {
      const connectorRef = sub.source.connectorRef;
      const entityType = eventEntityType ?? sub.source.entityType ?? 'unknown';
      const subjectKey = `${connectorRef}:${entityType}:${recordKey}`;
      const sig = stateSignature(entityType, evt.data, watchedPaths ?? []);
      const verdict = await checkLoopGuard(sub, subjectKey, sig);
      if (verdict !== 'ok') {
        const ctx = {
          tenantId: sub.tenantId, agentId: sub.agentId, workflowId: uuidv4(), taskId: uuidv4(),
          instructionVersion: 0,
          instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' } as unknown as ExecutionContext['instruction'],
          traceId: `loop-guard-${sub.id}`, agentType: 'agent' as const, hitlLevel: 3,
          modelConfig: {}, execConfig: {}, memoryScope: {},
        } as ExecutionContext;
        await createEscalation(
          ctx,
          `Reactive loop guard tripped (${verdict}) on ${subjectKey}: the team has fired repeatedly without new progress. Review manually.`,
          { kind: 'escalation' },
        ).catch(() => '');
        logger.warn({ tenant_id: sub.tenantId, subscription_id: sub.id, subjectKey, stateSig: sig, reason: verdict }, 'loop_guard_tripped');
        return; // skip the fire
      }
      await recordFire(sub, subjectKey, sig);
    }

    // WS-1.2 — bind tenant_id to the logging trace context before firing
    // the agent so every fire-path log emission carries attribution.
    if (sub.tenantId) setTraceContext({ tenantId: sub.tenantId });

    await fireAgentForSubscription(sub, evt, recordKey);
    matchedThisInterval++;
  } catch (err) {
    erroredThisInterval++;
    logger.warn('maybeFire error', {
      err: (err as Error).message,
      subscription_id: sub.id,
    });
  } finally {
    recordEval(Date.now() - start);
  }
}

function collectPathsFromSubs(subs: SubscriptionRow[]): string[] {
  const paths = new Set<string>();
  for (const s of subs) {
    collectPathsFromExpr(s.filter, paths);
    if (s.window?.field) paths.add(s.window.field);
  }
  return Array.from(paths);
}

function collectPathsFromExpr(expr: unknown, out: Set<string>): void {
  if (!expr || typeof expr !== 'object') return;
  const e = expr as { path?: string; operands?: unknown[]; operand?: unknown };
  if (e.path) out.add(e.path);
  if (e.operands) for (const o of e.operands) collectPathsFromExpr(o, out);
  if (e.operand) collectPathsFromExpr(e.operand, out);
}

// Exposed for tests / debug endpoints.
export function getSubscriptionCacheForTenant(tenantId: string): SubscriptionRow[] | undefined {
  return subscriptionCacheByTenant.get(tenantId);
}
