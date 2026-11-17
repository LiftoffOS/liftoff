// The TypeSafe fixture contract, on its own runner.
//
// It reaches the live vendor and needs no database, so it runs outside both
// the unit suite (which must never reach a vendor) and the database-backed
// integration config (whose global setup starts Postgres). The
// `typesafe-contract` cloudbuild step runs this with TYPESAFE_API_KEY from
// Secret Manager and fails the build when the key is missing; a developer
// box without the key sees the suite skip with a printed reason.
//
//   TYPESAFE_API_KEY=... npx jest --config jest.typesafe-contract.config.js

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/typesafe'],
  testMatch: ['**/fixtures.integration.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false, isolatedModules: true }],
  },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  testTimeout: 120000,
  maxWorkers: 1,
  verbose: true,
};
