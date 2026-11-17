// WS-0 — connector-service ESLint config (legacy .eslintrc form retained).
//
// The local plugin is registered via the standard npm linking mechanism:
// `eslint-plugin-r5-local` lives in ./eslint-rules/ and is consumed via
// `"eslint-plugin-r5-local": "file:./eslint-rules"` in package.json. No
// resolution shim required.

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'r5-local'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'r5-local/no-stub-success-fallback': 'error',
    'r5-local/client-method-arity': 'error',
  },
  overrides: [
    {
      // Ported connector clients + normalizers use the tenant-runtime coding
      // style which relies on `any` for flexible payload shapes. Keeping the
      // port line-for-line simplifies future sync; we relax the
      // `no-explicit-any` rule for these directories only.
      files: ['src/clients/**/*.ts', 'src/normalizers/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'src/_source-ports/', 'eslint-rules/'],
};
