// The distiller must equip every agent with the platform's native web-research
// tools. Before this, its only fetch surface was shell_exec, so agents did web
// work by curling pages in the sandbox — unsourced, slow, and (for the first
// self-serve subscriber's Competitive Intelligence Analyst) a generic
// hallucinated answer. These pin the contract.

import {
  PLATFORM_WEB_TOOLS,
  __internalValidateWorkflowSteps as validateWorkflowSteps,
  type ToolCatalog,
} from '../distill-service';
import type { WorkflowStep } from '../types';

describe('platform web tools surfaced to the distiller', () => {
  const names = PLATFORM_WEB_TOOLS.map((t) => t.name);

  it('includes the six NATIVE-backed platform tools and the team\'s own browser (no connector required)', () => {
    expect(new Set(names)).toEqual(
      new Set(['web_search', 'web_research', 'web_fetch_advanced', 'web_deep_research', 'web_people_search', 'web_finance_search', 'run_browser_task']),
    );
  });

  it('the browser is the one entry that is not a read, and says so', () => {
    // An autonomous browser agent cannot promise it only looks; the runtime
    // classes it as a write, and the distiller's catalog must agree.
    const browser = PLATFORM_WEB_TOOLS.find((t) => t.name === 'run_browser_task');
    expect(browser?.categories).toEqual(['write']);
    for (const t of PLATFORM_WEB_TOOLS) {
      if (t.name !== 'run_browser_task') expect(t.categories).toBeUndefined();
    }
  });

  it('excludes the BYOK-exclusive web tools that need a connected vendor', () => {
    // These are per-agent in the runtime (expose-tools.ts): surfacing them to
    // EVERY agent would wire a tool_call step that fails UNRESOLVABLE for any
    // agent without the vendor — the find_teammates failure class.
    for (const byok of ['web_extract', 'web_diff', 'web_task', 'web_session_save', 'web_identity_connect']) {
      expect(names).not.toContain(byok);
    }
  });

  it('every entry has a non-empty description the distiller can act on', () => {
    for (const t of PLATFORM_WEB_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe('a workflow step naming a platform web tool validates', () => {
  // The distiller now adds these to its catalog, so validateWorkflowSteps (the
  // authoring-time catalog check) accepts a tool_call step naming one. They are
  // standard-family in the runtime, so dispatch + graph validation pass there
  // too — no runtime change needed, unlike the collaboration builtins.
  const catalog: ToolCatalog = new Map(
    PLATFORM_WEB_TOOLS.map((t) => [t.name, { name: t.name, description: t.description }]),
  );

  it.each(PLATFORM_WEB_TOOLS.map((t) => t.name))('accepts a %s tool_call step', (toolName) => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', type: 'tool_call', toolName, onSuccess: '', onFailure: null } as WorkflowStep,
    ];
    const errors = validateWorkflowSteps(steps, catalog);
    expect(errors.some((e) => e.type === 'unknown_tool')).toBe(false);
  });

  it('still rejects a tool that is not in the catalog', () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', type: 'tool_call', toolName: 'web_invented_tool', onSuccess: '', onFailure: null } as WorkflowStep,
    ];
    const errors = validateWorkflowSteps(steps, catalog);
    expect(errors.some((e) => e.type === 'unknown_tool')).toBe(true);
  });
});
