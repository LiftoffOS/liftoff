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
  // Each bench runs thousands of requests in a single process, and the gate is
  // the RATIO the test asserts — never the wall clock it takes to measure it.
  // At 60s it WAS the wall clock: 2,100 sequential round-trips at the
  // latencies a loaded 2-vCPU builder produces (Execute p50 up to 39ms) need
  // ~40-60s, so on a busy builder jest killed the test before its assertion
  // ran and reported a timeout instead of a verdict. Three consecutive runs of
  // one commit died that way while measuring 4.39× / 4.51× against a 6× gate.
  // 300s is far past anything a contended builder has produced and far short
  // of a hang, which the build's own timeout catches.
  testTimeout: 300000,
  // Chatty output so CI surfaces measured percentiles on every run.
  verbose: true,
  forceExit: true,
  // Belt-and-suspenders: even if invoked without --runInBand, keep worker
  // count at 1 so the measurements aren't polluted by other jest workers.
  maxWorkers: 1,
};
