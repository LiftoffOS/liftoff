#!/usr/bin/env npx ts-node

/**
 * Distill regression invariants harness.
 *
 * Each invariant is a structural property that distill output MUST satisfy
 * for a given fixture input. Run the harness offline against the fixtures
 * to detect regressions when distill-service.ts or its prompt evolves.
 *
 * Invariants:
 *   I7 — Hybrid execution engine never offers `produce_workflow` to the LLM.
 *        Distillation collapses to a single produce_agent tool with an
 *        optional structured workflowSteps backbone. The tool-registration
 *        call site must NOT include produce_workflow.
 */

import type { DistillOutput } from '../src/internal-agents/distill-service';
import type { IntegrationInfo } from '../src/internal-agents/distill-service';

export interface DistillFixtureInput {
  role: string;
  responsibilities: string;
  integrations: IntegrationInfo[];
}

export interface InvariantResult {
  invariant: string;
  pass: boolean;
  detail?: string;
}

/**
 * I7 — produce_workflow tool is not offered to the LLM. Asserted by
 * inspecting the tool-name list that the distill call site would register.
 * Test fixtures stub the tool-registration so the assertion runs in unit
 * tests without actually calling the LLM.
 */
export function checkI7(offeredToolNames: string[]): InvariantResult {
  if (offeredToolNames.includes('produce_workflow')) {
    return {
      invariant: 'I7',
      pass: false,
      detail: `produce_workflow is in the offered tool list (${offeredToolNames.join(', ')}). Hybrid engine retired this tool.`,
    };
  }
  return { invariant: 'I7', pass: true };
}

// Silence the unused-import warning when DistillOutput is imported only for
// fixture-side type inference.
export type _DistillOutputUnused = DistillOutput;
