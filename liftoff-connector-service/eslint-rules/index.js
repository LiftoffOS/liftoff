// WS-0 — local ESLint plugin (`eslint-plugin-r5-local`) entry point.
//
// Aliased into Node's resolution cache by `.eslintrc.cjs` (require shim) so
// ESLint's `plugins: ['r5-local']` resolves here without an actual npm
// package or a symlink. Adding new rules: drop the rule file into
// eslint-rules/ and require it here.

module.exports = {
  rules: {
    'no-stub-success-fallback': require('./no-stub-success-fallback.js'),
    'client-method-arity': require('./client-method-arity.js'),
  },
};
