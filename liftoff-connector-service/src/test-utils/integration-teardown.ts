// Jest globalTeardown for integration tests.
//
// Pool lifecycle is owned by each suite's `afterAll` (`await closeAllPools()`),
// which runs in the test-WORKER process where the pools actually live. Global
// hooks run in a SEPARATE process that never opens a pool (globalSetup only
// uses a throwaway `new Client(...).end()`), AND they bypass jest's
// `moduleNameMapper`, so a `import { closeAllPools } from '../db/pool.js'`
// here fails to resolve at load time (only pool.ts exists; the `.js` the
// NodeNext build requires is never emitted for tests) and crashes teardown —
// making the whole suite exit non-zero even when every test passed.
//
// There is nothing for this hook to close, so it is intentionally a no-op
// (`forceExit` in the config guarantees a clean exit). Leaves the
// docker-compose container running for fast re-runs:
//
//   docker-compose -f docker-compose.integration.yml down -v

export default async function globalTeardown(): Promise<void> {
  // Intentionally empty — see file header. Per-suite afterAll owns pool cleanup.
}
