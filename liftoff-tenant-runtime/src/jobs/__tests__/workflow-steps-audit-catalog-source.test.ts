// The audit must build its catalog through the RUN's seam, not chat's.
//
// `catalog-schema-parity.test.ts` proves `buildValidationToolNames` returns the
// validator's enumeration. That is only worth anything if the audit actually
// calls it, and the call site is exactly what regressed: the job asked
// `buildChatToolCatalog`, whose `toolNames` are `gatewayResult.modelTools` — an
// array finished before vendor servers are contacted and never updated after.
// The audit fetched GitHub's 41 tools and then read a list that could not hold
// them, reporting every GitHub-bound code-review agent as unable to run.
//
// Asserted at the source level for the same reason the vendor-catalog test is:
// the behavioural path needs a database, a live connector registry and a vendor
// probe. What is checkable here is which function the job reaches for, and that
// is the half that broke.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'workflow-steps-audit.ts'), 'utf8');

describe('the workflow steps audit builds the run catalog', () => {
  it('calls buildValidationToolNames', () => {
    expect(SRC).toContain('agentExecutionService.buildValidationToolNames(');
  });

  it('does not fall back to the chat catalog', () => {
    // Chat's catalog answers a different question — what the model is offered —
    // and omits vendor-hosted tools by construction.
    //
    // The CALL, not the word: the comment above the call site names the old
    // function to say why it is no longer used, and that is worth keeping.
    expect(SRC).not.toContain('buildChatToolCatalog(');
  });

  it('passes the capability-derived sandbox set', () => {
    // Previously regressed on its own: without it the catalog carries no
    // sandbox tools and every step naming `shell_exec` / `file_*` is reported
    // unresolvable for a tool the agent holds.
    expect(SRC).toContain('sandboxCapabilities: sandboxCapabilitiesForTier(');
  });

  it('selects the compiled instruction the catalog is built from', () => {
    // buildToolsSchema reads allowedConnectors / allowedActionTypes off it. A
    // query that forgets the column yields an undefined instruction and a
    // catalog with no connector tools — the same shape as the defect that
    // produced this job's first six false findings.
    expect(SRC).toMatch(/SELECT version, instruction, integrations, capability_tier/);
  });

  it('coalesces a null instruction rather than passing it through', () => {
    // `compiled_instructions.instruction` is NULL across this estate. The chat
    // catalog never read it, so the null was invisible until validation built
    // its catalog from the run's seam — then buildToolsSchema threw on
    // `.allowedConnectors`, every agent was downgraded to structural-only, and
    // the summary reported wouldFail: 0 with no tool name checked at all.
    expect(SRC).toContain('(parsedInstruction ?? {}) as CompiledInstruction');
  });

  it('says out loud when it checked no tool names at all', () => {
    // The one degraded outcome that reads like good news.
    expect(SRC).toContain('workflow_steps_audit_degraded');
    expect(SRC).toMatch(/result\.structuralOnly === result\.agentsWithSteps/);
  });
});
