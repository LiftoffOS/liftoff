module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Ported code from tenant-runtime relies on `any` extensively (pg row
    // shapes, snapshot payloads, test-fixture overrides). Tenant-runtime's
    // own eslint config disables this rule for the same reason — mirror
    // that here so ported files stay green without a blanket sweep.
    '@typescript-eslint/no-explicit-any': 'off',
  },
  ignorePatterns: ['dist/', 'node_modules/', 'src/_source-ports/'],
};
