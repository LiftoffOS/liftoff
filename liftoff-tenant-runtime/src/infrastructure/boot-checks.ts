// WS-6.2 — boot-time DB invariant. Refuses to start if the Pool or the
// dedicated LISTEN/NOTIFY client can't reach Postgres.
//
// Without this, agent-service has been silently reconnecting forever; the
// invariant moves the failure mode from "looks healthy but isn't processing
// anything" to "fails closed at startup with a clear error".

import { getDedicatedDbClient } from './db-client';
import { getPool } from './database';
import { logger } from './logging';

export async function assertDatabaseReachable(): Promise<void> {
  // (a) Pool SELECT 1
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }

  // (b) Dedicated LISTEN/NOTIFY round-trip
  const notif = getDedicatedDbClient();
  await notif.connect();
  const channel = `boot_check_${Math.random().toString(36).slice(2)}`;
  let received = false;
  notif.on('notification', (msg) => {
    if (msg.channel === channel) received = true;
  });
  await notif.query(`LISTEN "${channel}"`);
  await notif.query(`NOTIFY "${channel}", 'ok'`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (!received) {
    await notif.end();
    throw new Error(`LISTEN/NOTIFY round-trip failed on channel ${channel}`);
  }
  await notif.end();

  logger.info('boot check: database reachable + LISTEN/NOTIFY working');
}
