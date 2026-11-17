/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Source uses NodeNext `.js` import specifiers; ts-jest compiles the `.ts`,
  // so strip the extension for resolution.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // isolatedModules: type-checking is done separately by `tsc`; skipping it in
    // the test transform makes runs fast and self-contained.
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true, tsconfig: '<rootDir>/tsconfig.json' }],
  },
  // Do not scan the parent monorepo's huge node_modules for haste modules.
  modulePathIgnorePatterns: ['<rootDir>/../../node_modules'],
  // watchman hangs on the iCloud-backed working tree; disable it. Cache on local
  // disk (off iCloud) so the haste map isn't written to a dataless-placeholder FS.
  watchman: false,
  cacheDirectory: '/private/tmp/jest-injection-detector-cache',
};
