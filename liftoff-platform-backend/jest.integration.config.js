// Jest Configuration for Integration Tests
// Runs *.integration.test.ts files against a real Postgres instance

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/migrations'],

  // Only run integration test files
  testMatch: ['**/*.integration.test.ts'],

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: false,
      // Transpile each file on its own instead of building a whole-program
      // type-check. Without this ts-jest constructs a TypeScript program over
      // everything a test imports — which for a test that reads the provider
      // constants is every provider module and its vendor SDK typings — and
      // exhausts the default heap before the first assertion. jest.config.js
      // has carried this for the unit suite all along; the two configs simply
      // drifted. `diagnostics: false` already said types are not this runner's
      // job, so nothing is lost.
      isolatedModules: true,
    }],
  },

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  // Integration test setup — connects to real Postgres
  setupFilesAfterEnv: ['<rootDir>/src/test-utils/integration-setup.ts'],
  globalSetup: '<rootDir>/src/test-utils/integration-global-setup.ts',
  globalTeardown: '<rootDir>/src/test-utils/integration-global-teardown.ts',

  // Longer timeout for DB operations
  testTimeout: 30000,

  // Single worker to avoid DB conflicts
  maxWorkers: 1,

  verbose: true,

  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
  ],

  transformIgnorePatterns: [
    '/node_modules/',
  ],
};
