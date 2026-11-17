// Latency benchmark Jest config (Phase 0c).
//
// Runs **/*.bench.ts files with a long timeout. Real per-RPC benchmarks
// (governance.authorize, connector.execute, ...) are added alongside their
// service implementations in Phase 1 and Phase 3. The smoke example in
// src/test-utils/__tests__/benchmark-smoke.bench.ts validates the harness
// itself.
//
// Run locally:
//   npx jest --config jest.benchmark.config.js
// Run in CI with bail (fail the whole suite on first breach):
//   npx jest --config jest.benchmark.config.js --bail

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],

  testMatch: ['**/*.bench.ts'],

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        diagnostics: false,
      },
    ],
  },

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  // Warmup + 1000 iterations + budget assertions — generous upper bound.
  testTimeout: 300_000,

  // Serial so CPU contention doesn't poison latency samples.
  maxWorkers: 1,

  verbose: true,

  // Single Postgres / Pub/Sub topology reuse — setup/teardown left to
  // individual benchmarks (most are pure in-memory or hit an already-
  // running docker-compose.integration.yml stack).
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
