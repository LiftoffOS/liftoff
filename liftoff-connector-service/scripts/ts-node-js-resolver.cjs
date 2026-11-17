// ts-node CJS `.js` → `.ts` resolution shim (for the doc/tool generators).
//
// The generators run under `ts-node --transpile-only --project scripts/tsconfig.json`,
// which uses CommonJS + `moduleResolution: node` (see scripts/tsconfig.json). That
// mode CANNOT follow the explicit `.js` extension that NodeNext requires on relative
// imports in `src/` (e.g. connectors.ts → `./source-overrides.js`), so a `require`
// of such a module throws MODULE_NOT_FOUND even though the `.ts` file exists.
//
// This preload (wired via `ts-node --require`) patches Module._resolveFilename so a
// RELATIVE `.js` import that fails to resolve is retried WITHOUT the extension,
// letting ts-node's registered `.ts` handler pick it up. It is purely additive: it
// only kicks in when the original resolution throws, so real `.js`/package imports
// are untouched. src/ itself is unchanged — the `.js` suffix stays (required by the
// NodeNext app build); this only teaches the CJS script runner to follow it.
const Module = require('module');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  try {
    return originalResolveFilename.call(this, request, parent, isMain, options);
  } catch (err) {
    if (
      typeof request === 'string'
      && request.startsWith('.')
      && request.endsWith('.js')
    ) {
      return originalResolveFilename.call(this, request.slice(0, -3), parent, isMain, options);
    }
    throw err;
  }
};
