/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Exclude non-unit suites from `npm test`:
  //   - integration: require docker-compose, run via `npm run test:integration`
  //     using jest.integration.config.js
  //   - benchmarks:  live under __benchmark__/, run via `npm run bench`
  //     using jest.benchmark.config.js
  testPathIgnorePatterns: [
    '/node_modules/',
    '/_source-ports/',
    '\\.integration\\.test\\.ts$',
    '/__integration__/',
    '/__benchmark__/',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Global setup — env vars + mocks for database / logging / stripe so
  // ported tests (admission, usage-ledger, action-ledger) that do
  // `jest.mock('../infrastructure/database')` get a concrete mock object
  // instead of the auto-mock of the real Proxy-based `pool` export.
  setupFilesAfterEnv: ['<rootDir>/src/test-utils/setup.ts'],
  testTimeout: 10000,
  verbose: true,
  forceExit: true,
};
