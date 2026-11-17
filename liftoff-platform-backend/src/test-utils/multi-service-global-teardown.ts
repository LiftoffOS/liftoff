// Tears down the multi-service integration stack. On CI, called by Jest
// once after all test suites finish; locally you can leave the stack up
// and re-run `jest --config jest.multi-service.config.js` against it.

import { execSync } from 'child_process';

const COMPOSE_FILE = 'docker-compose.integration.yml';

export default async function globalTeardown(): Promise<void> {
  if (process.env.KEEP_MULTI_SERVICE_STACK === '1') {
    console.log('[multi-service] KEEP_MULTI_SERVICE_STACK=1 — leaving stack running.');
    return;
  }

  console.log('[multi-service] Tearing down docker-compose stack...');
  try {
    execSync(`docker-compose -f ${COMPOSE_FILE} down -v`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.warn('[multi-service] teardown failed — continuing:', (err as Error).message);
  }
}
