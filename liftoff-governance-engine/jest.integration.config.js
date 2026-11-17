// Integration test config — exercises the governance-engine against a
// real Postgres instance brought up via docker-compose.integration.yml.
//
// Intentionally separate from jest.config.js so:
//   • `npm test` stays fast and hermetic (no docker required)
//   • CI can opt-in to integration tests via `npm run test:integration`
//
// Prereq (enforced by globalSetup):
//   docker-compose -f docker-compose.integration.yml up -d
//
// Tests live in src/__integration__ and use the `.integration.test.ts`
// suffix so the default config's `**/*.test.ts` pattern ignores them
// (the default config's roots include src but testMatch explicitly
// excludes `*.integration.test.ts` via the pathIgnorePatterns below if
// ever unified).

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/_source-ports/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Docker startup + migrations can take a bit on a cold host.
  testTimeout: 30000,
  verbose: true,
  forceExit: true,
  globalSetup: '<rootDir>/src/test-utils/integration-setup.ts',
  globalTeardown: '<rootDir>/src/test-utils/integration-teardown.ts',
};
