// The pre-flight must judge a trigger-bound step the way a RUN judges it.
//
// A step may name `trigger__<op>` — the operation, not the host — and the
// executor rewrites it to whichever connector fired BEFORE it validates. The
// audit validated the raw name, so it reported UNRESOLVABLE_TOOL for a step
// that dispatches correctly.
//
// This matters more than a cosmetic wrong count. The audit is the gate that
// answers "is it safe to turn the structured path on", and it can already say
// "all clear" for a graph that then fails. A gate that also cries wolf is one
// nobody reads.
//
// The resolver is exercised directly here rather than through auditWorkflowSteps
// because that function opens a pool and builds live tool catalogs; the property
// under test is the resolution the audit now performs on each step.

import { resolveTriggerBoundTool } from '../../agent-execution/resolve-trigger-bound-tool';

/** The mapping the audit applies, extracted so the test states the same rule. */
function resolveForAudit(
  toolName: string,
  boundConnectorTypes: string[],
  catalog: ReadonlySet<string>,
): string {
  for (const source of boundConnectorTypes.length > 0 ? boundConnectorTypes : [undefined]) {
    const bound = resolveTriggerBoundTool(toolName, source, catalog);
    if (bound.kind === 'not_applicable') return toolName;
    if (bound.kind === 'resolved') return bound.toolName;
    // Mirrors the job: a pre-flight check has no event record, so `resolvable`
    // — name found, addressing unjudgeable — is the answer it always gets for a
    // step that names a real tool.
    if (bound.kind === 'resolvable') return bound.toolName;
  }
  return toolName;
}

describe('audit resolution of trigger-bound steps', () => {
  it('leaves an ordinary tool name alone', () => {
    const catalog = new Set(['gmail__send']);
    expect(resolveForAudit('gmail__send', ['google_mail'], catalog)).toBe('gmail__send');
  });

  it('resolves a trigger-bound op against a bound host that provides it', () => {
    // Whatever the resolver picks, it must be a name the catalog contains —
    // that is precisely what the validator then checks.
    const catalog = new Set(['gitlab-1924102e__get_merge_request']);
    const resolved = resolveForAudit('trigger__pr_get', ['gitlab'], catalog);
    // NOT `resolved === raw || catalog.has(resolved)`, which was the assertion
    // here and is true either way — it passed for three weeks while the audit
    // could not resolve a single trigger-bound step, because identity arguments
    // need the event record a pre-flight check never has.
    expect(resolved).not.toBe('trigger__pr_get');
    expect(catalog.has(resolved)).toBe(true);
  });

  it('leaves the raw name when no bound host provides the op, so the finding is real', () => {
    // The audit must not launder a genuinely unresolvable step into a clean
    // verdict. Reporting it is correct here.
    const catalog = new Set(['gmail__send']);
    expect(resolveForAudit('trigger__pr_get', ['google_mail'], catalog)).toBe('trigger__pr_get');
  });

  it('does not resolve when the agent is bound to nothing', () => {
    expect(resolveForAudit('trigger__pr_get', [], new Set())).toBe('trigger__pr_get');
  });
});
