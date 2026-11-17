// Integration Test Global Setup
// Starts Docker Compose Postgres, applies all migrations

import { execSync } from 'child_process';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_CONFIG = {
  host: 'localhost',
  port: 5433,
  database: 'liftoff_control_test',
  user: 'liftoff_test',
  password: 'test_password',
};

async function waitForPostgres(maxRetries = 30): Promise<void> {
  const pool = new Pool({ ...TEST_DB_CONFIG, connectionTimeoutMillis: 1000 });
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      if (i === maxRetries - 1) {
        await pool.end();
        throw new Error('Postgres not ready after retries');
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function applyMigrations(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pool = new Pool(TEST_DB_CONFIG);

  // Create migration tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    } catch (err) {
      console.error(`Migration failed: ${file}`, err);
      throw err;
    }
  }

  await pool.end();
}

export default async function globalSetup(): Promise<void> {
  // A caller that supplied TEST_DATABASE_URL owns the database and has already
  // migrated it — the CI migration gate hands over the throwaway Postgres it
  // just applied every migration to. Starting docker-compose there would be
  // wrong twice: the daemon is not available, and re-applying migrations over a
  // database somebody else prepared is not this file's business.
  //
  // Without this branch the whole migrations/__tests__ suite could only run
  // where a Docker daemon happened to exist, which is why none of it gated
  // anything.
  if (process.env.TEST_DATABASE_URL) {
    console.log('[integration] TEST_DATABASE_URL supplied — using it as-is (no docker, no migrate).');
    return;
  }

  console.log('[integration] Starting test Postgres...');

  // Start Docker Compose (if not already running)
  try {
    execSync('docker compose -f docker-compose.test.yml up -d --wait', {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'pipe',
    });
  } catch {
    // Fallback for older docker-compose
    execSync('docker-compose -f docker-compose.test.yml up -d', {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'pipe',
    });
  }

  console.log('[integration] Waiting for Postgres...');
  await waitForPostgres();

  console.log('[integration] Applying migrations...');
  await applyMigrations();

  console.log('[integration] Setup complete.');
}
