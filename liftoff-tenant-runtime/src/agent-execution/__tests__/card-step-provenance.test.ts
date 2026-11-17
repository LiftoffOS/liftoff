// The approval has to record WHICH step is asking, and whether that step was
// doing what the operator approved.
//
// The card read "Create a pull request review on the acme/webapp
// repository for pull request #42. Method: create". It did not say this was
// step s7 of the workflow the operator had already approved. Had it said so,
// the mis-gating would have been obvious at a glance instead of taking a day of
// log archaeology.
//
// Source assertions, deliberately. The defect is a field that is not written at
// a call site, and absence at a call site is not observable from the behaviour
// of the thing being called — the same reason `gate-trigger-target-both-sites`
// is a source test. Driving the whole approval path here would need the full
// gate, adapter and database fixture and would still not prove the field was
// populated at the site that runs.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The workflow-path approval creation, with its argument list. */
function workflowApprovalSite(): string {
  const at = SRC.indexOf("origin: 'external_content'");
  expect(at).toBeGreaterThan(-1);
  // Walk back to the start of the context block and forward past it.
  return SRC.slice(Math.max(0, at - 2000), at + 2000);
}

describe('the approval records which step is asking', () => {
  it('writes the step id and its description', () => {
    const site = workflowApprovalSite();
    expect(site).toContain('declaredStep: { stepId: declaredStep.stepId');
    expect(site).toContain('description: declaredStep.description ?? null');
  });

  it('records whether the step was in declared scope', () => {
    // Not inferable from the gate's decision: a card exists here precisely
    // because the gate FIRED, and since declared scope clears the category
    // path, a gate that fired on declared work means a hard invariant, level 1,
    // or a destructive marker. Which of the two cases it is, is the fact the
    // card needs.
    expect(workflowApprovalSite()).toContain('inDeclaredScope:');
  });

  it('requires EVERY pending call to be in scope, not just the first', () => {
    // Same rule the gate itself applies. A batch is in declared scope only if
    // none of its calls reached beyond the trigger.
    expect(workflowApprovalSite()).toMatch(/interceptedToolCalls\.every\(/);
  });

  it('writes nothing about a step when none declared the call', () => {
    // The conversational path has no declared step by construction. It must not
    // record an empty `declaredStep`, or the card draws a row saying nothing.
    expect(workflowApprovalSite()).toMatch(/\.\.\.\(declaredStep\s*\n?\s*\?/);
  });
});

describe('it rides in the field that already reaches the browser', () => {
  it('uses `context`, which needs no migration', () => {
    // `context` is already JSONB on hitl_approval_requests and platform-backend's
    // DTO already passes it straight through to the /review surface. The only
    // hop that was missing is the web app's type, which is fixed on that side.
    expect(workflowApprovalSite()).toMatch(/context: \{/);
  });

  it('keeps the external-content provenance that was already written', () => {
    // Additive. `origin: 'external_content'` has been travelling since the
    // external-content gate shipped, unread only because the web app never
    // declared the field.
    const site = workflowApprovalSite();
    expect(site).toContain("origin: 'external_content'");
    expect(site).toContain('screenVerdict');
  });
});

describe('the standard-tool dispatch tells a handler which declared step is calling', () => {
  // A handler cannot see whether a call was the graph's declared work or the
  // model's choice unless the dispatcher says so. memory_save reads it to
  // leave the near-duplicate guard off a declared step, which runs once per
  // run and cannot loop. Absence at this one site would put the guard back on
  // every scheduled graph's per-run note, silently.
  it('passes declaredStep.stepId into the standard-tool context', () => {
    const at = SRC.indexOf('() => executeStandardTool(');
    expect(at).toBeGreaterThan(-1);
    const site = SRC.slice(at, at + 1400);
    expect(site).toContain('declaredStepId: declaredStep?.stepId');
  });
});
