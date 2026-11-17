// ESLint config (plan 0F: linting must run in CI and a clean local checkout).
// The repo shipped with an `eslint src/` script but no config — this restores
// a working baseline matching the TypeScript/ESM setup.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true, jest: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-constant-condition': ['error', { checkLoops: false }],
  },
  ignorePatterns: ['dist/', 'node_modules/'],
};
