export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // fastify 5's `inject` pulls light-my-request, which depends on cookie@2 —
    // ESM only, no `main`, no CJS entry. Jest does not transform node_modules,
    // so every test that calls app.inject() died on "Must use import to load ES
    // Module" rather than on anything to do with the code under test.
    //
    // The hoisted cookie@0.7.2 is CJS and exports the same parse/serialize pair
    // light-my-request uses to build and read a request's cookies. Pointing the
    // bare specifier at it keeps the tests able to load, and it is a TEST-ONLY
    // mapping: nothing here changes what the server loads at runtime, which is
    // still cookie@2 through fastify's own resolution.
    '^cookie$': '<rootDir>/node_modules/cookie/index.js',
  },
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, isolatedModules: true }],
  },
  testMatch: ['**/src/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
};
