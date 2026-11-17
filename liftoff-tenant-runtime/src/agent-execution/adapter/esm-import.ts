// Runtime loader for ESM-only packages from CommonJS.
//
// @openai/codex-sdk and @opencode-ai/sdk publish an `exports` map with only the
// `import`/`types` conditions — no `require`/`main`. Under this repo's
// `module: commonjs`, a static `import { X } from 'pkg'` compiles to
// `require('pkg')`, which fails at runtime on Node with
// `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined`. TypeScript would
// also downlevel a plain `import()` to `require()`, re-introducing the bug — so
// we build the dynamic import via `new Function`, which the compiler leaves
// intact, and it executes as a real ESM `import()` at runtime.
export const esmImport = new Function('specifier', 'return import(specifier)') as <T = unknown>(
  specifier: string,
) => Promise<T>;
