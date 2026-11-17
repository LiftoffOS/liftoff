// ESLint 8 (.eslintrc) config for liftoff-billing.
// Kept minimal — recommended rules from @typescript-eslint with a few
// pragmatic relaxations that match the rest of the LiftoffOS codebase
// (see liftoff-platform-backend/eslint.config.mjs).
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    '*.js',
    '*.mjs',
    '*.cjs',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-namespace': 'off',
    'no-case-declarations': 'off',
    'prefer-const': 'warn',
  },
};
