// Jest Configuration for Multi-Service Integration Tests (Phase 0c).
//
// Runs *.multi-service.test.ts files against the 4-Postgres + Pub/Sub
// emulator topology defined in docker-compose.integration.yml. These
// tests start lightweight HTTP servers for each service on localhost so
// cross-service flows (preflight → authorize → record, execute batch,
// shadow-mode comparison) are exercised end-to-end.
//
// Start infra:
//   docker-compose -f docker-compose.integration.yml up -d
// Run:
//   npx jest --config jest.multi-service.config.js
// Stop infra:
//   docker-compose -f docker-compose.integration.yml down -v

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],

  testMatch: ['**/*.multi-service.test.ts'],

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
    // Strip .js extensions so NodeNext source in packages/ resolves.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  setupFilesAfterEnv: ['<rootDir>/src/test-utils/multi-service-setup.ts'],
  globalSetup: '<rootDir>/src/test-utils/multi-service-global-setup.ts',
  globalTeardown: '<rootDir>/src/test-utils/multi-service-global-teardown.ts',

  // 60s — multi-service startup can be slow on a cold Docker cache.
  testTimeout: 60000,

  // Single worker: the emulator state is shared, tests mutate it.
  maxWorkers: 1,

  verbose: true,

  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
