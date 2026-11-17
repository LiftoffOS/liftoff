// Two-project jest config so CI can run unit tests without ever launching
// Chromium. `npm test` (default) runs ONLY the unit project; the integration
// project requires explicit opt-in via `npm run test:integration`.
//
//   npm run test:unit        — fast, ~seconds, no browser
//   npm run test:integration — launches Playwright Chromium against fixtures
//
// Browser-driving tests live under src/__tests__/integration/. Anything else
// under src/__tests__/ is a unit test.
module.exports = {
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
      testPathIgnorePatterns: ['<rootDir>/src/__tests__/integration/'],
      moduleNameMapper: {
        '^@liftoffos/sandbox-validators$': '<rootDir>/../packages/sandbox-validators/src/index.ts',
        '^@liftoffos/sandbox-contracts$': '<rootDir>/../packages/sandbox-contracts/src/index.ts',
      },
      transform: {
        '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
      },
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/__tests__/integration/**/*.test.ts'],
      moduleNameMapper: {
        '^@liftoffos/sandbox-validators$': '<rootDir>/../packages/sandbox-validators/src/index.ts',
        '^@liftoffos/sandbox-contracts$': '<rootDir>/../packages/sandbox-contracts/src/index.ts',
      },
      transform: {
        '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
      },
    },
  ],
};
