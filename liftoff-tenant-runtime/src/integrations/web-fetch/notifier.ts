import { Client } from 'pg';
import { EventEmitter } from 'events';
import { logger } from '../../infrastructure/logging';
import { getDedicatedDbClient } from '../../infrastructure/db-client';
import type { WebVendor } from './types';

// One dedicated long-lived pg.Client per process, multiplexed across every
// LISTEN channel the runtime cares about. Today the only consumer is the
// web-fetch admission layer on `web_fetch_release`; future subsystems can
// add more channels by calling `subscribeToPgChannel(...)` without paying a
// new Cloud SQL connection each time.
//
// Why a dedicated Client and NOT a pool connection: LISTEN needs a long-lived
// connection that isn't recycled between queries. Pooled connections would
// be released back and the subscription would silently drop.
//
// Connection-budget accounting: this client sits OUTSIDE `getPoolForService`
// pool sizing. One connection per pod is the floor; the Cloud SQL plan
// includes that headroom.
let dedicatedClient: Client | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
const channelHandlers = new Map<string, Set<(payload: string) => void>>();

interface ChannelSubscription { unsubscribe: () => void }

/**
 * Subscribe to a Postgres NOTIFY channel through the shared LISTEN client.
 * The handler fires once per notification with the NOTIFY payload.
 *
 * Calls are reentrant: multiple subscribers on the same channel share one
 * `LISTEN <channel>`. When the last subscriber unsubscribes, the channel is
 * `UNLISTEN`ed. When the client reconnects after a transport failure, every
 * subscribed channel is re-LISTENed automatically.
 */
export function subscribeToPgChannel(
  channel: string,
  handler: (payload: string) => void,
): ChannelSubscription {
  let handlers = channelHandlers.get(channel);
  const isFirstSubscriber = !handlers || handlers.size === 0;
  if (!handlers) {
    handlers = new Set();
    channelHandlers.set(channel, handlers);
  }
  handlers.add(handler);

  // If we're the first subscriber and we already have a connection, LISTEN
  // now. Otherwise the LISTEN happens automatically on connect/reconnect.
  if (isFirstSubscriber && dedicatedClient) {
    dedicatedClient.query(`LISTEN ${quoteIdent(channel)}`).catch((err: Error) =>
      logger.warn({ err: err.message, channel }, 'pg_notifier LISTEN failed'),
    );
  }

  void connectNotifier();

  return {
    unsubscribe: () => {
      const set = channelHandlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) {
        channelHandlers.delete(channel);
        dedicatedClient?.query(`UNLISTEN ${quoteIdent(channel)}`).catch(() => {});
      }
    },
  };
}

// Whitelist: Postgres identifier must be alphanumeric/underscore. Channel
// names are caller-supplied constants in production but we still validate
// to make the SQL builder injection-proof.
function quoteIdent(channel: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(channel)) {
    throw new Error(`invalid pg LISTEN channel name: ${channel}`);
  }
  return `"${channel}"`;
}

// Legacy convenience API for the web-fetch admission layer. New subsystems
// should call `subscribeToPgChannel` directly with their own dispatcher.
let releaseEmitter: EventEmitter | null = null;
let releaseSubscription: ChannelSubscription | null = null;

export function getReleaseEmitter(): EventEmitter {
  if (!releaseEmitter) {
    releaseEmitter = new EventEmitter();
    releaseEmitter.setMaxListeners(0);
    releaseSubscription = subscribeToPgChannel('web_fetch_release', (payload) => {
      releaseEmitter?.emit('release', payload as WebVendor);
    });
  }
  return releaseEmitter;
}

async function connectNotifier(): Promise<void> {
  if (dedicatedClient) return;
  // WS-6.1 — route through the unified DB config so the dedicated LISTEN
  // client uses the same DB_HOST/DB_USER/DB_PASSWORD/DB_NAME the Pool reads.
  // `process.env.DATABASE_URL` was unset on agent-service / coordinator /
  // tool-gateway / reflection and caused a localhost:5432 ECONNREFUSED loop.
  const client = getDedicatedDbClient();
  client.on('notification', (msg) => {
    if (!msg.channel || msg.payload == null) return;
    const handlers = channelHandlers.get(msg.channel);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(msg.payload); } catch (err) {
        logger.warn({ err: (err as Error).message, channel: msg.channel }, 'pg_notifier handler threw');
      }
    }
  });
  client.on('error', (err) => {
    logger.warn({ err: err.message }, 'pg_notifier client error; reconnecting');
    dedicatedClient = null;
    scheduleReconnect();
  });
  client.on('end', () => {
    logger.warn('pg_notifier client closed; reconnecting');
    dedicatedClient = null;
    scheduleReconnect();
  });
  try {
    await client.connect();
    dedicatedClient = client;
    // Re-LISTEN every subscribed channel after (re)connect.
    for (const channel of channelHandlers.keys()) {
      await client.query(`LISTEN ${quoteIdent(channel)}`);
    }
    logger.info({ channels: Array.from(channelHandlers.keys()) }, 'pg_notifier connected and listening');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pg_notifier initial connect failed; reconnecting');
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectNotifier();
  }, 2_000);
  reconnectTimer.unref();
}

// Best-effort shutdown for tests + graceful shutdown handlers.
export async function shutdownNotifier(): Promise<void> {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  releaseSubscription?.unsubscribe();
  releaseSubscription = null;
  releaseEmitter?.removeAllListeners();
  releaseEmitter = null;
  channelHandlers.clear();
  if (dedicatedClient) { await dedicatedClient.end().catch(() => {}); dedicatedClient = null; }
}
