// The rule that would have caught the read-args defect at the moment it was written.
//
// `CompensationClient.read` is declared `(entityType, entityId, payload?)`, both
// executors call it with three arguments, and `GenericMCPClient.read` declared
// two. JavaScript permits the call, TypeScript permits the implementation — a
// function with FEWER parameters is assignable to a signature with more — so the
// payload was dropped in silence and every read-verb tool on a generic-MCP
// connector reached its vendor with no arguments.
//
// Run through RuleTester rather than through `npx eslint`, because the plugin is
// linked via `file:./eslint-rules` and a git worktree sharing the main
// checkout's node_modules resolves that to the OTHER checkout's rules. The rule
// is correct in CI, where the package resolves from the repo itself; this proves
// it here without depending on that linkage.

// `eslint` ships no type declarations in this tree, and adding @types/eslint to
// production dependencies for one test is the wrong trade. Required rather than
// imported, with the shape asserted where it is used.
/* eslint-disable @typescript-eslint/no-var-requires */
const { RuleTester } = require('eslint');
const rule = require('../../../eslint-rules/client-method-arity.js');

const ruleTester = new RuleTester({
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

/** The rule only looks at files under src/clients/. */
const FILENAME = '/repo/src/clients/some-mcp.ts';

ruleTester.run('client-method-arity', rule, {
  valid: [
    {
      // The fixed shape.
      filename: FILENAME,
      code: `class SomeClient implements CompensationClient {
        async read(entityType: string, entityId?: string, payload?: Record<string, unknown>) { return payload; }
      }`,
    },
    {
      // A class that does not implement the contract makes no promise.
      filename: FILENAME,
      code: `class Helper {
        async read(entityType: string, entityId: string) { return entityId; }
      }`,
    },
    {
      // A method the interface does not declare is not the rule's business.
      filename: FILENAME,
      code: `class SomeClient implements CompensationClient {
        async semanticInverse(a: string) { return a; }
      }`,
    },
    {
      // Outside src/clients/ the rule says nothing.
      filename: '/repo/src/polling/scheduler.ts',
      code: `class SomeClient implements CompensationClient {
        async read(entityType: string, entityId: string) { return entityId; }
      }`,
    },
  ],
  invalid: [
    {
      // The defect, exactly as it was written.
      filename: FILENAME,
      code: `class GenericMCPClient implements CompensationClient {
        async read(entityType: string, entityId: string) { return entityId; }
      }`,
      errors: [{ messageId: 'tooFewParams' }],
    },
    {
      // `delete` had the same shape, and GitHub's delete_file needs owner,
      // repo, path and branch — none of which could ever be addressed.
      filename: FILENAME,
      code: `class GenericMCPClient implements CompensationClient {
        async delete(entityType: string, entityId: string) { return entityId; }
      }`,
      errors: [{ messageId: 'tooFewParams' }],
    },
  ],
});

describe('client-method-arity', () => {
  it('ran its RuleTester cases', () => {
    // RuleTester throws on failure at module scope; this keeps jest honest
    // about having actually executed the file.
    expect(rule.meta.messages.tooFewParams).toContain('silently');
  });
});
