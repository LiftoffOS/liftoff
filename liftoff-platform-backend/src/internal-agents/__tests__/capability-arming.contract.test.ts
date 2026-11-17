// Agents are armed at distillation with what their work needs.
//
// The distiller designs the workflow, so it is the one component positioned to
// decide the agent's equipment — the person describing the work should never
// have to know a "capability tier" exists. The keyword heuristic
// (detectSandboxCapabilities) is deliberately conservative — its own comments
// explain the over-detection that forced the tightening — which makes
// it systematically blind to data-handling workflows whose prose never mentions
// code. This contract pins the assessment as a REQUIRED part of every
// distillation and its consumption as a tier signal.

import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeDistillOutput } from '../distill-normalize';

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { __internalGetProduceAgentToolText } from '../distill-service';

const DISTILL = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

describe('capability needs are assessed on every distillation', () => {
  it('the produce_agent schema requires the assessment', () => {
    // Optional means a model under token pressure omits it and the agent
    // silently defaults to connector_only — the exact under-provisioning this
    // exists to remove.
    //
    // Asserted against the BUILT schema rather than the source text. The
    // original regex pinned one formatting of the `required:` line, so hoisting
    // that list into a named constant — which the waved strategy needs, because
    // every per-branch tool composes from the same field source — broke a test
    // whose subject had not changed. What the contract is actually about is the
    // tool the model receives, so that is what this now reads.
    const schema = JSON.parse(__internalGetProduceAgentToolText()) as {
      input_schema: { required: string[] };
    };
    expect(schema.input_schema.required).toEqual([
      'summary', 'systemPrompt', 'userInstructions', 'triggerConfig', 'skills', 'capabilityNeeds',
    ]);
  });

  it('the schema explains both directions, not just when to say yes', () => {
    // One-sided guidance recreates the over-detection problem: a workspace
    // granted to a conversational agent clutters its tool surface and degrades
    // its tool choices.
    const start = DISTILL.indexOf('capabilityNeeds: {');
    expect(start).toBeGreaterThan(-1);
    const block = DISTILL.slice(start, DISTILL.indexOf("required: ['workspace', 'reasoning']", start));
    expect(block).toContain('workspace: true when');
    expect(block).toContain('workspace: false for');
    expect(block).toMatch(/dedup/i);
    expect(block).toMatch(/spreadsheets/i);
  });

  it('the declared need is a tier signal alongside the binding and the keywords', () => {
    expect(DISTILL).toMatch(/sandboxDetected \|\| workspaceDeclared \? 'execution_enabled' : 'connector_only'/);
    // And a declaration the keywords missed is observable, so the heuristic's
    // blind spots become data instead of anecdotes.
    expect(DISTILL).toContain("metric: 'distill.capability.workspace_declared'");
  });
});

describe('normalizeDistillOutput repairs capabilityNeeds', () => {
  it('coerces a stringified workspace boolean', () => {
    const out = normalizeDistillOutput({
      capabilityNeeds: { workspace: 'true', reasoning: 'reads a growing sheet' },
    });
    expect((out.capabilityNeeds as Record<string, unknown>).workspace).toBe(true);
  });

  it('drops null and non-object values without failing the payload', () => {
    expect('capabilityNeeds' in normalizeDistillOutput({ capabilityNeeds: null })).toBe(false);
    expect('capabilityNeeds' in normalizeDistillOutput({ capabilityNeeds: 'yes' })).toBe(false);
  });

  it('never invents a workspace the model did not claim', () => {
    // Repair preserves intent: an unusable declaration is removed, not defaulted
    // to true, and consumers treat absence as no declaration.
    const out = normalizeDistillOutput({ capabilityNeeds: { workspace: 'maybe', reasoning: 'x' } });
    const needs = out.capabilityNeeds as Record<string, unknown>;
    expect('workspace' in needs).toBe(false);
  });
});
