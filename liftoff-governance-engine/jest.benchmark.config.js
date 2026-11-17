/**
 * Benchmark config — kept separate from the default jest.config.js so the
 * unit/integration suite stays quick and predictable. Benchmarks live under
 * `src/__benchmark__` and are matched by `*.bench.test.ts`. They run
 * sequentially (`--runInBand`) so worker CPU contention doesn't pollute the
 * latency numbers.
 *
 * Invoked via `npm run bench` locally and in Cloud Build after the normal
 * test step. `--bail` in the npm script makes the first regression fail CI.
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__benchmark__/**/*.bench.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/_source-ports/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // 60s — each bench runs thousands of iterations in a single process.
  testTimeout: 60000,
  // Chatty output so CI surfaces measured percentiles on every run.
  verbose: true,
  forceExit: true,
  // Belt-and-suspenders: even if invoked without --runInBand, keep worker
  // count at 1 so the measurements aren't polluted by other jest workers.
  maxWorkers: 1,
};
