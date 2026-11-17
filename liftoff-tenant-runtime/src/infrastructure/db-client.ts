// WS-6.1 — unified DB config factory.
//
// Pool consumers go through `getPool`/`getPoolForService` in
// infrastructure/database.ts. This file is the equivalent for clients that
// hold a dedicated connection (LISTEN/NOTIFY, one-shot scripts) and used to
// read `process.env.DATABASE_URL` directly — which was unset on
// agent-service / coordinator-service / tool-gateway-service / reflection-
// service and caused a localhost:5432 ECONNREFUSED loop on pg_notifier.

import { Client, type ClientConfig } from 'pg';
import { getManagedSecret } from './secret-store';

function buildDbConnectionString(): string {
  const host = process.env.DB_HOST;
  const user = process.env.DB_USER;
  const password = getManagedSecret('DB_PASSWORD');
  const database = process.env.DB_NAME;
  if (!host || !user || !password || !database) {
    throw new Error(
      `DB env config incomplete: ` +
        `DB_HOST=${!!host} DB_USER=${!!user} DB_PASSWORD=${!!password} DB_NAME=${!!database}`,
    );
  }
  return `postgres://${user}:${encodeURIComponent(password)}@${host}/${database}`;
}

export function buildDbClientConfig(): ClientConfig {
  return { connectionString: buildDbConnectionString() };
}

export function getDedicatedDbClient(): Client {
  return new Client(buildDbClientConfig());
}
