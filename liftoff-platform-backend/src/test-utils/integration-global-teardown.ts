// Integration Test Global Teardown
// Stops Docker Compose Postgres

import { execSync } from 'child_process';
import * as path from 'path';

export default async function globalTeardown(): Promise<void> {
  // The caller who supplied TEST_DATABASE_URL owns that database and its
  // lifetime. `down -v` here would destroy a container this run never started
  // — and in the CI migration gate that container is shared with the step that
  // created it.
  if (process.env.TEST_DATABASE_URL) {
    console.log('[integration] TEST_DATABASE_URL supplied — leaving the caller\'s database alone.');
    return;
  }

  console.log('[integration] Stopping test Postgres...');
  try {
    execSync('docker compose -f docker-compose.test.yml down -v', {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'pipe',
    });
  } catch {
    try {
      execSync('docker-compose -f docker-compose.test.yml down -v', {
        cwd: path.resolve(__dirname, '../..'),
        stdio: 'pipe',
      });
    } catch {
      // Ignore teardown failures
    }
  }
  console.log('[integration] Teardown complete.');
}
