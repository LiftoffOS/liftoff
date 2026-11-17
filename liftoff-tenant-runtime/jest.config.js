/** @type {import('jest').Config} */
module.exports = {
  // Use ts-jest for TypeScript support
  preset: 'ts-jest',

  // Test environment
  testEnvironment: 'node',

  // Root directory
  rootDir: '.',

  // Test file patterns
  testMatch: [
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/mcp-servers/**/*.test.ts',
    '<rootDir>/mcp-servers/**/*.spec.ts',
    '<rootDir>/scripts/**/*.test.ts',
    '<rootDir>/tools/**/*.test.ts',
    // migrations/__tests__ was never matched, so every test written there since
    // 023 has been unreachable — `npx jest migrations/...` reports "no tests
    // found" rather than running them. They all guard on TEST_DATABASE_URL and
    // describe.skip without it, so matching them costs CI nothing and makes
    // them runnable against a migrated database, which is the only way a
    // migration's SQL gets executed before a deploy runs it.
    '<rootDir>/migrations/**/*.test.ts',
  ],

  // Module path aliases (matching tsconfig if any)
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // @liftoffos/proto-gen ships compiled JS with .js extensions in its
    // deep-import paths; map through node_modules directly so Jest's
    // classic resolver can find them.
    '^@liftoffos/proto-gen/dist/(.*)\\.js$': '<rootDir>/node_modules/@liftoffos/proto-gen/dist/$1.js',
    '^@liftoffos/proto-gen/dist/(.*)$': '<rootDir>/node_modules/@liftoffos/proto-gen/dist/$1.js',
    // ESM-only packages (no main/require entry) that the classic Jest resolver
    // can't load. Adapter unit tests fully mock them via jest.mock(); map to a
    // resolvable CJS stub so the module id resolves.
    // The sandbox sidecar's own source, imported by the real-shell suites so the
    // code_session protocol is exercised against the sidecar's actual
    // BashSession rather than a mock of it. `packages/sandbox-contracts` is a
    // workspace symlink whose `main` points at a `dist/` that is only built
    // inside the sidecar image, so the classic resolver cannot find it — and it
    // fails as "Converting circular structure to JSON" from jest-worker, which
    // names neither the module nor the file. Mapped to source, which ts-jest
    // compiles like any other TS here.
    '^@liftoffos/sandbox-contracts$': '<rootDir>/packages/sandbox-contracts/src/index.ts',
    '^@openai/codex-sdk$': '<rootDir>/src/test-utils/esm-mock-stub.ts',
    '^@opencode-ai/sdk$': '<rootDir>/src/test-utils/esm-mock-stub.ts',
  },

  // Setup files
  setupFilesAfterEnv: ['<rootDir>/src/test-utils/setup.ts'],

  // Coverage configuration
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/test-utils/**',
    '!src/index.ts',
    // Page scripts: these functions are serialized with Function.toString()
    // and evaluated inside the browser (recorder.ts), so they may reference
    // nothing outside themselves. Coverage instrumentation inserts a counter
    // object into every function, which a serialized copy evaluated in a bare
    // realm cannot see — ReferenceError: cov_xxx is not defined — so the
    // self-containment tests failed exactly when a CI shard collected
    // coverage for these files.
    '!src/browser-sessions/takeover-capture/describe-target.ts',
    '!src/browser-sessions/takeover-capture/page-controls.ts',
    '!src/browser-sessions/takeover-capture/protected-control.ts',
    '!src/browser-sessions/takeover-capture/route-template.ts',
  ],

  // Coverage thresholds — enforced in CI
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

  // Coverage output directory
  coverageDirectory: 'coverage',

  // Transform configuration
  // diagnostics: false — type-checking is handled by `npm run typecheck`, no need
  // to repeat it in every worker (saves ~30% memory per worker).
  // isolatedModules: true — transpile each file standalone instead of running the
  // full ts-jest type-aware program. In type-aware mode ts-jest type-checks every
  // test file's whole dependency graph PER FILE (~55s/file, measured on a clean
  // release build), intermittently pushing the suite past 80min and getting dev
  // builds cancelled mid-run. The type-check is redundant — `npm run typecheck`
  // already does it as a separate CI step — so transpile-only is pure win (~7x).
  transform: {
    // Transform TypeScript files with ts-jest
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: false,
      isolatedModules: true,
    }],
    // Transform ESM-only JS packages (e.g. until-async, msw) with ts-jest in JS mode
    '^.+\\.js$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      diagnostics: false,
      isolatedModules: true,
    }],
  },

  // Module file extensions
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Clear mocks between tests
  clearMocks: true,

  // Restore mocks after each test
  restoreMocks: true,

  // Verbose output
  verbose: true,

  // Limit parallel workers to avoid OOM.
  // ts-jest workers are memory-heavy (~1-2GB each). Defaulting to one per CPU
  // core exhausts RAM on local dev machines and crashes macOS.
  maxWorkers: '25%',

  // Recycle workers that accumulate too much memory from large test suites.
  workerIdleMemoryLimit: '512MB',

  // Test timeout
  testTimeout: 10000,

  // Force-exit after all tests complete so workers don't hang on open handles
  // (e.g. pg connection pools, PubSub subscribers kept alive by mock timers).
  forceExit: true,

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/tests/validation-rig/',
    '/tests/fault-injection/',
    '\\.integration\\.test\\.ts$',  // Integration tests hit real DBs — excluded from unit suite
    '\\.browser\\.test\\.ts$',      // Real-Chromium tests — their own project (jest.browser.config.js)
  ],

  // Transform ignore patterns
  // Exclude ESM-only packages from the ignore list so ts-jest can transform them
  transformIgnorePatterns: [
    '/node_modules/(?!(msw|until-async)/)',
  ],
};
