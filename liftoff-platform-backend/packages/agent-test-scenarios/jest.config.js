// Per-package Jest config so this package can run its unit tests
// independently of PB's root jest config.
//
// Run from this directory: `npx jest` or `npm test`.

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  moduleNameMapper: {
    // Allow the .js suffix on relative imports to resolve to .ts during testing
    // (tsc emits .js so the production import path uses .js; ts-jest needs the
    // mapper for the dev-time test resolution).
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
