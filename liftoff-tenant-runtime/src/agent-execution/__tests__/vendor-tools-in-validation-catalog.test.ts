// Workflow validation must see vendor-hosted MCP tools.
//
// buildToolsSchema assembles standard, web, sandbox and connector-manifest
// tools — all from sources this process owns. A vendor-hosted connector has NO
// entry in connector-service's function registry: GitHub is `mcp:
// vendor_hosted`, so its 44 tools live only on api.githubcopilot.com's MCP
// server, which the SDK is handed directly.
//
// That list is what validateWorkflowGraph checks against, and what a
// trigger-bound step resolves against. So without the merge, a workflow step
// naming ANY GitHub tool is rejected as `unknown_tool` against a catalog that
// structurally cannot contain it — nothing to do with the step being wrong.
//
// A GitHub-triggered run then refuses with:
//
//   none of that host's tools in this run's catalog match any known name for it
//   (looked for: pull_request_read)
//
// naming a tool that does exist, on a server the agent is bound to.
//
// Asserted at the source level because the behavioural path needs the whole
// execution service plus a live vendor probe. What matters is that the merge is
// present, guarded, and inside buildToolsSchema — the seam the suite stubs.
// Putting it at the CALL site instead would bypass that stub and pull the ESM
// SDK into tests that never load it.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The body of buildToolsSchema, which is the seam the tests stub. */
function buildToolsSchemaBody(): string {
  const start = SRC.indexOf('private async buildToolsSchema(');
  expect(start).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  // First `return tools;` closes the method.
  return rest.slice(0, rest.indexOf('return tools;'));
}

describe('the validation catalog includes vendor-hosted MCP tools', () => {
  it('merges them inside buildToolsSchema, not at the call site', () => {
    const body = buildToolsSchemaBody();
    expect(body).toContain('resolveVendorMcpServers');
    expect(body).toContain('enumerateVendorMcpTools');
  });

  it('skips the vendor path when the agent has no integrations', () => {
    // A run with nothing bound has no vendor server to ask, and the guard is
    // also what keeps the import out of suites that exercise the real method.
    expect(buildToolsSchemaBody()).toMatch(/vendorIntegrations\.length > 0/);
  });

  it('degrades to the previous behaviour rather than failing the run', () => {
    // A validation list missing vendor names is what shipped until now, so
    // failing closed here would be a regression, not a safeguard.
    expect(buildToolsSchemaBody()).toContain('Failed to load vendor MCP tools for buildToolsSchema');
  });

  it('does not re-add a tool the in-process catalog already has', () => {
    // The gateway's own dedup is first-wins; this must not double-register a
    // name and make one tool look like two in the validation set.
    expect(buildToolsSchemaBody()).toMatch(/tools\.some\(\(t: \{ name: string \}\) => t\.name === vt\.name\)/);
  });

  it('resolves trigger-bound steps BEFORE the graph validator sees them', () => {
    // Order is the whole correctness condition here and nothing about it is
    // visible to a type checker. `trigger__pr_get` is deliberately absent from
    // the catalog — it is an operation, not a tool — so a validator that runs
    // first rejects a correctly-authored workflow with
    //   [UNRESOLVABLE_TOOL] Tool "trigger__pr_get" is not in the agent's
    //   available tool catalog
    // even though both steps have in fact resolved to real GitHub tools.
    const resolveAt = SRC.indexOf('resolveTriggerBoundTool(step.toolName');
    const validateAt = SRC.indexOf('validateWorkflowGraph(workflowSteps');
    expect(resolveAt).toBeGreaterThan(-1);
    expect(validateAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(validateAt);
  });

  it('leaves the stale-alias remap AFTER validation, where it belongs', () => {
    // The remap repairs a name that WAS valid when authored and has since
    // moved, so validation must see the authored name to report honestly on it.
    // Only the trigger-bound pass belongs before — its input was never a tool
    // name at all.
    const validateAt = SRC.indexOf('validateWorkflowGraph(workflowSteps');
    const remapAt = SRC.indexOf('resolveStepToolName(step.toolName');
    expect(remapAt).toBeGreaterThan(validateAt);
  });

  it('verifies the tamper hash BEFORE anything rewrites a step', () => {
    // The hash is computed over context.workflowSteps, and both rewrite passes
    // mutate that array in place. Verifying afterwards compares a hash of the
    // rewritten steps against the stored one and reports tampering on this
    // process's own legitimate work.
    //
    // Otherwise a run whose steps both resolved correctly to GitHub dies with
    // "Workflow steps have been tampered with." The stale-alias remap has the
    // same exposure — any run where an alias had actually moved would be
    // called tampering.
    const hashAt = SRC.indexOf('this.verifyWorkflowStepsHash(state.context)');
    const resolveAt = SRC.indexOf('resolveTriggerBoundTool(step.toolName');
    const remapAt = SRC.indexOf('resolveStepToolName(step.toolName');
    expect(hashAt).toBeGreaterThan(-1);
    expect(hashAt).toBeLessThan(resolveAt);
    expect(hashAt).toBeLessThan(remapAt);
  });

  it('still validates workflow steps against buildToolsSchema', () => {
    // If the call site stops using this seam, the merge above stops mattering
    // and vendor steps silently break again.
    expect(SRC).toMatch(/const allTools = await this\.buildToolsSchema\(state\.context\);/);
  });
});
