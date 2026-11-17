module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  rootDir: 'src',
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['**/*.ts', '!**/__tests__/**'],
  // Transpile-only: the package tsconfig is a `composite` project, which makes
  // ts-jest's default type-checking transform slow/hang. The taxonomy is tiny
  // and `npm run build` already type-checks it, so transpile-only is safe here.
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
