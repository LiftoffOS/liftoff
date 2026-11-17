/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Set env defaults before the module graph loads (see jest.setup.ts) — e.g.
  // FINCH_CLIENT_ID, so catalog projections that snapshot availability at
  // import time behave like a Finch-configured (dev) environment.
  setupFiles: ['<rootDir>/jest.setup.ts'],
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
    // Stub @liftoffos/telemetry so unit suites never import the real
    // OpenTelemetry SDK (its nested @opentelemetry/* TS sources throw
    // "Cannot read properties of undefined (reading 'TELEMETRY_SDK_NAME')"
    // under ts-jest). Jest-runtime only — tsc + the prod build use the real
    // package. See src/test-utils/telemetry-stub.ts.
    '^@liftoffos/telemetry$': '<rootDir>/src/test-utils/telemetry-stub.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 10000,
  verbose: true,
  forceExit: true,
};
