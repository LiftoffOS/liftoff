// Jest Configuration for Liftoff Platform Backend

/** @type {import('jest').Config} */
module.exports = {
  // Use ts-jest for TypeScript support
  preset: 'ts-jest',

  // Test environment
  testEnvironment: 'node',

  // Root directory for tests
  roots: [
    '<rootDir>/src',
    '<rootDir>/scripts',
    '<rootDir>/packages/liftoff-cli/src',
    '<rootDir>/packages/contract-tests/src',
    '<rootDir>/packages/chat-attachments/src',
    '<rootDir>/packages/database/src',
    '<rootDir>/packages/embedding/src',
    '<rootDir>/packages/governance-types/src',
    '<rootDir>/packages/embedding/__tests__',
    '<rootDir>/packages/pubsub/src',
    '<rootDir>/packages/browser-record/src',
    '<rootDir>/packages/redact/src',
    '<rootDir>/packages/service-client/src',
    '<rootDir>/packages/telemetry/src',
    '<rootDir>/packages/turn-bounds/src',
  ],

  // Test file patterns
  testMatch: [
    '**/*.test.ts',
    '**/*.spec.ts',
  ],

  // Module file extensions
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Transform TypeScript files
  // diagnostics: false — type-checking is handled by `npm run typecheck`.
  // isolatedModules: true — switches ts-jest to transpileModule API (no full
  // TS program per worker), cutting per-worker heap by ~50%.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: false,
      isolatedModules: true,
    }],
    // Only `jose` reaches this: transformIgnorePatterns below still excludes
    // the rest of node_modules, and nothing in src/ is JavaScript. jose ships
    // ESM only and arrives transitively under firebase-admin 14 (via jwks-rsa),
    // so without a transform every suite that imports firebase-admin dies at
    // parse time on `export`.
    '^.+\\.jsx?$': ['ts-jest', {
      tsconfig: { allowJs: true, module: 'commonjs', target: 'es2022' },
      diagnostics: false,
      isolatedModules: true,
    }],
  },

  // Coverage configuration
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/test-utils/**',
    '!src/**/*.d.ts',
  ],

  // Coverage thresholds — commented out until test coverage reaches target
  // Uncomment when global coverage reaches 70%
  // coverageThreshold: {
  //   global: {
  //     branches: 70,
  //     functions: 70,
  //     lines: 70,
  //     statements: 70,
  //   },
  // },

  // Coverage directory
  coverageDirectory: 'coverage',

  // Clear mocks between each test
  clearMocks: true,

  // Restore mocks automatically
  restoreMocks: true,

  // Module path aliases (match tsconfig if needed)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Pin the service-client workspace package to its in-repo SOURCE. Its
    // package.json main points at dist/, and when dist/ is missing (fresh
    // clone, git worktree) Node's walk-up resolution silently escapes the
    // checkout and loads a SIBLING checkout's stale dist — where jest.mock
    // registrations (e.g. google-auth-library) no longer apply, so unit
    // tests made real OIDC token requests. Mapping to source keeps tests
    // hermetic regardless of dist freshness.
    '^@liftoffos/service-client$': '<rootDir>/packages/service-client/src/index.ts',
    // Strip .js extensions from relative imports so ESM-style NodeNext source
    // (used in packages/*/src) resolves under the root classic-resolution config.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // @liftoffos/proto-gen ships compiled JS with .js extensions in its
    // deep-import paths; map through node_modules directly.
    '^@liftoffos/proto-gen/dist/(.*)\\.js$': '<rootDir>/node_modules/@liftoffos/proto-gen/dist/$1.js',
    '^@liftoffos/proto-gen/dist/(.*)$': '<rootDir>/node_modules/@liftoffos/proto-gen/dist/$1.js',
  },

  // Setup files to run before tests
  setupFilesAfterEnv: ['<rootDir>/src/test-utils/setup.ts'],

  // Limit parallel workers to avoid OOM.
  // ts-jest workers are memory-heavy (~1-2GB each). Defaulting to one per CPU
  // core exhausts RAM on local dev machines and crashes macOS.
  maxWorkers: '25%',

  // Recycle workers that accumulate too much memory from large test suites.
  workerIdleMemoryLimit: '512MB',

  // Test timeout (10 seconds)
  testTimeout: 10000,

  // Verbose output
  verbose: true,

  // Force-exit after all tests complete so workers don't hang on open handles
  // (e.g. pg connection pools kept alive after test suite finishes).
  forceExit: true,

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '\\.integration\\.test\\.ts$',  // Integration tests run via jest.integration.config.js only
  ],

  // Transform ignore patterns
  //
  // `jose` is excluded from the ignore list, i.e. it IS transformed. It ships
  // ESM only (its sole export condition points at dist/webapi/index.js), and it
  // arrives transitively under firebase-admin 14 via jwks-rsa. Left ignored,
  // every suite that so much as imports firebase-admin dies at parse time with
  // "Jest encountered an unexpected token" — 29 suites did.
  transformIgnorePatterns: [
    '/node_modules/(?!jose/)',
  ],
};
