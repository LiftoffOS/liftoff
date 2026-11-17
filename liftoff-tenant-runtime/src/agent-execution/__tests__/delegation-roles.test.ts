// What a run at the bottom of a delegation tree is allowed to do.
//
// Depth and fan-out caps already bound the SHAPE of a tree. They say nothing
// about what a run does once it is in one, which is where the expensive
// failures live: a child spawned to "check the tests" spawns its own children,
// each schedules a follow-up, and a task that should have been one run becomes
// a tree nobody asked for. The cap eventually stops it — after the spend.
//
// So the tests here are mostly about the boundary (who is a leaf) and about the
// two enforcement points existing independently, because either one alone is
// the wrong shape: hiding a tool is not a control, and refusing at dispatch
// alone wastes a turn every time.

import {
  CHILD_ITERATION_BUDGET,
  LeafDelegationError,
  MAX_ORCHESTRATION_DEPTH,
  ORCHESTRATION_ONLY_TOOLS,
  assertToolAllowedForRole,
  filterToolsForRole,
  isOrchestrationOnlyTool,
  iterationBudgetFor,
  resolveDelegationRole,
} from '../delegation-roles';
import { DELEGATION_DEFAULTS } from '../delegation-defaults';

describe('who is a leaf', () => {
  it('makes the run a person started an orchestrator', () => {
    expect(resolveDelegationRole(0)).toBe('orchestrator');
    expect(resolveDelegationRole(null)).toBe('orchestrator');
    expect(resolveDelegationRole(undefined)).toBe('orchestrator');
  });

  it('makes a run with nowhere below it a leaf', () => {
    // Not a policy choice — a child of it would exceed the cap and be refused.
    expect(resolveDelegationRole(MAX_ORCHESTRATION_DEPTH)).toBe('leaf');
  });

  it('reads the boundary from the cap that is actually in force', () => {
    // A constant of its own can drift from the real cap (say 2 against 1), and
    // then no invocation reaches the leaf depth and the whole role model is
    // unreachable dead code. Two numbers that have to agree will not.
    expect(MAX_ORCHESTRATION_DEPTH).toBe(DELEGATION_DEFAULTS.MAX_DEPTH);
  });

  it('makes a run at the default cap a leaf, which is the whole point', () => {
    // The default cap is 2 (A→B→C), so the run that sits AT the cap must be a
    // leaf. If this is an orchestrator, nothing in this module ever runs.
    // Asserted against the constant rather than a literal so raising the cap
    // moves this test with it instead of silently making it vacuous.
    expect(resolveDelegationRole(DELEGATION_DEFAULTS.MAX_DEPTH)).toBe('leaf');
  });

  it('leaves a run below the cap able to hand work on', () => {
    // Depth 1 under a cap of 2 is B in A→B→C: it received delegated work and may
    // still pass it along once. This is the case the old cap of 1 refused.
    expect(resolveDelegationRole(DELEGATION_DEFAULTS.MAX_DEPTH - 1)).toBe('orchestrator');
  });

  it('treats anything deeper than the cap as a leaf too', () => {
    // A row that somehow carries a deeper value must not read as permission.
    expect(resolveDelegationRole(MAX_ORCHESTRATION_DEPTH + 5)).toBe('leaf');
  });
});

describe('what a leaf loses', () => {
  it('loses the tools that start more work', () => {
    expect(isOrchestrationOnlyTool('spawn_task_graph')).toBe(true);
    expect(isOrchestrationOnlyTool('delegate_to_agent')).toBe(true);
  });

  it('loses the tools that suspend it waiting for work', () => {
    // Both are coordination. A leaf is not coordinating — its whole job is to
    // finish and report.
    expect(isOrchestrationOnlyTool('schedule_followup')).toBe(true);
    expect(isOrchestrationOnlyTool('wake_on_job')).toBe(true);
    expect(isOrchestrationOnlyTool('sleep_until')).toBe(true);
  });

  it('keeps everything it needs to do the work', () => {
    for (const t of ['file_read', 'file_write', 'shell_exec', 'send_email', 'corpus_search']) {
      expect(isOrchestrationOnlyTool(t)).toBe(false);
    }
  });

  it('recognises the namespaced spelling every engine uses', () => {
    // Model-facing names are namespaced per MCP server; a list that only knew
    // the bare name would let every namespaced call straight through.
    expect(isOrchestrationOnlyTool('mcp__liftoff-tool-gateway__spawn_task_graph')).toBe(true);
  });

  it('recognises the per-teammate delegation tools', () => {
    // The gateway registers one `internal__<alias>__execute` per active teammate.
    // Reducing a namespaced name to its LAST segment turns these into `execute`,
    // which is not in the list — so a leaf stripped of delegate_to_agent kept a
    // bespoke delegation tool for every teammate it had. Stripping the generic
    // tool while leaving these is not a boundary.
    expect(isOrchestrationOnlyTool('internal__code_reviewer__execute')).toBe(true);
    // Two teammates sharing an alias get an id suffix; still delegation.
    expect(isOrchestrationOnlyTool('internal__code_reviewer__a1b2c3d4__execute')).toBe(true);
    // And namespaced, the way the model actually sees it.
    expect(
      isOrchestrationOnlyTool('mcp__liftoff-tool-gateway__internal__qa__execute'),
    ).toBe(true);
  });

  it('does not mistake an ordinary tool ending in execute for delegation', () => {
    // The guard keys on the internal__…__execute shape, not on the word alone.
    expect(isOrchestrationOnlyTool('execute')).toBe(false);
    expect(isOrchestrationOnlyTool('mcp__sandbox__execute')).toBe(false);
  });

  it('denies a leaf the governed fan-out tool too', () => {
    // delegate_task was missing from the list, so removing delegate_to_agent
    // left the tool that delegates to SEVERAL agents at once.
    expect(isOrchestrationOnlyTool('delegate_task')).toBe(true);
  });
});

describe('filtering the catalog', () => {
  const tools = [
    { name: 'file_read' },
    { name: 'spawn_task_graph' },
    { name: 'delegate_to_agent' },
    { name: 'shell_exec' },
  ];

  it('leaves an orchestrator alone', () => {
    const r = filterToolsForRole(tools, 'orchestrator');
    expect(r.tools).toBe(tools);
    expect(r.removed).toEqual([]);
  });

  it('removes the orchestration tools for a leaf', () => {
    const r = filterToolsForRole(tools, 'leaf');
    expect(r.tools.map((t) => t.name)).toEqual(['file_read', 'shell_exec']);
    expect(r.removed).toEqual(['spawn_task_graph', 'delegate_to_agent']);
  });

  it('reports what it removed, so the log can say', () => {
    // A tool that silently disappears from a catalog is a support ticket.
    expect(filterToolsForRole(tools, 'leaf').removed).toHaveLength(2);
  });
});

describe('refusing at dispatch', () => {
  it('lets an orchestrator through', () => {
    expect(() => assertToolAllowedForRole('spawn_task_graph', 'orchestrator')).not.toThrow();
  });

  it('refuses a leaf', () => {
    // The case hiding the tool cannot cover: a resumed session assembled under
    // a different role, a replayed tool call, an engine caching its tool list.
    expect(() => assertToolAllowedForRole('spawn_task_graph', 'leaf'))
      .toThrow(LeafDelegationError);
  });

  it('tells the model what to do instead of only that it failed', () => {
    // The model is what reads this. "You cannot do this, do the work instead"
    // is usable where a bare error code is not.
    try {
      assertToolAllowedForRole('delegate_to_agent', 'leaf');
      throw new Error('should have refused');
    } catch (err) {
      expect((err as Error).message).toMatch(/child task/);
      expect((err as Error).message).toMatch(/report the result/);
    }
  });

  it('does not refuse ordinary work from a leaf', () => {
    expect(() => assertToolAllowedForRole('file_write', 'leaf')).not.toThrow();
  });
});

describe('the budgets', () => {
  it('gives a leaf the tighter one', () => {
    expect(iterationBudgetFor('leaf', 500)).toBe(CHILD_ITERATION_BUDGET);
  });

  it('never RAISES a budget', () => {
    // A tenant that configured a smaller limit meant it. The child budget is a
    // ceiling, not a grant.
    expect(iterationBudgetFor('leaf', 10)).toBe(10);
  });

  it('leaves an orchestrator on whatever the tenant configured', () => {
    expect(iterationBudgetFor('orchestrator', 500)).toBe(500);
  });

  it('leaves per-parent concurrency to the gate that already owns it', () => {
    // A second cap here would have cut effective fan-out for every existing
    // tenant from their configured value to one this module invented. The
    // dispatch gate reads the per-tenant setting, clamps it, and reports the
    // clamp; adding a second control is how two numbers stop agreeing.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'delegation-roles.ts'), 'utf8',
    ) as string;
    expect(src).not.toMatch(/export const MAX_CONCURRENT_CHILDREN/);
  });
});

describe('the wiring', () => {
  const read = (rel: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', rel), 'utf8') as string;

  it('filters the catalog at assembly, so the model never sees the tools', () => {
    // Discovering the refusal at dispatch means the model already spent a turn
    // writing a delegation that was always going to be refused, then had to
    // recover from the error.
    expect(read('service.ts')).toMatch(/filterToolsForRole\(enumerated, role\)/);
  });

  it('also refuses at dispatch, reading the role off the catalog', () => {
    // On the catalog rather than the bridge context: six adapters construct
    // that context, and the one that forgot would silently let a leaf delegate.
    const bridge = read('adapter/mcp-bridge.ts');
    expect(bridge).toMatch(/assertToolAllowedForRole\(functionName, catalog\.delegationRole/);
  });

  it('checks before looking the tool up, so a hidden tool still refuses clearly', () => {
    const bridge = read('adapter/mcp-bridge.ts');
    expect(bridge.indexOf('assertToolAllowedForRole('))
      .toBeLessThan(bridge.indexOf('const tool = catalog.tools.find'));
  });

  it('applies the child budget where the run state is created', () => {
    expect(read('service.ts')).toMatch(/iterationBudgetFor\([\s\S]{0,400}resolveDelegationRoleFor\(input\.tenantId, input\.delegationDepth\)/);
  });

  it('decides the role from the TENANT\'s cap, never the in-code default', () => {
    // The cap is per-tenant and clamped. A tenant who raised theirs has a
    // middle layer that may legitimately delegate — deciding from the default
    // would strip its tools while the dispatch gate happily allowed the call,
    // so the tools would be missing and nothing would explain why.
    const src = read('service.ts');
    expect(src).toMatch(/resolveDelegationRoleFor\(params\.tenantId, params\.delegationDepth\)/);
    expect(src).not.toMatch(/resolveDelegationRole\(input\.delegationDepth\)/);
    expect(src).not.toMatch(/resolveDelegationRole\(params\.delegationDepth\)/);
  });

  it('falls back to the restrictive direction when the cap cannot be read', () => {
    // A run wrongly treated as a leaf loses tools it could have used. One
    // wrongly treated as an orchestrator gets to build the tree the cap exists
    // to prevent. Only one of those is a safe way to be wrong.
    const roles = read('delegation-roles.ts');
    expect(roles).toMatch(/let maxDepth = MAX_ORCHESTRATION_DEPTH;/);
    expect(roles).toMatch(/fall back to the in-code default — the restrictive direction/);
  });

  it('does not narrow the fan-out a tenant configured', () => {
    // The delegation limit stays exactly what the gate resolved. A regression
    // here is invisible in behaviour — runs still succeed, just more slowly —
    // which is why it is asserted rather than left to review.
    expect(read('service.ts')).toMatch(/const limit = pLimit\(input\.maxConcurrent \?\? gate\.maxConcurrent\);/);
  });

  it('names only tools that are really registered somewhere', () => {
    // A name in this list that no tool actually has is a control that looks
    // like it covers something and does not. The tools are spread across the
    // gateway and the standard-tool set, so both are searched.
    const sources = ['tool-gateway/mcp-server.ts', 'tools/standard-tools.ts']
      .map((rel) => require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', rel), 'utf8',
      ) as string)
      .join('\n');
    for (const name of ORCHESTRATION_ONLY_TOOLS) {
      expect(sources).toContain(`'${name}'`);
    }
  });

  it('covers every tool the gateway registers with a spawn effect (the converse)', () => {
    // The inversion of the test above, and the one that would have caught both
    // holes this list shipped with: delegate_task (the governed fan-out tool,
    // absent from the list while delegate_to_agent was in it) and the
    // per-teammate internal__*__execute tools (whose namespaced names reduced
    // to the bare token `execute` and sailed through). A control that lists
    // tools by hand is only as good as the check that the list is complete, so
    // completeness is derived from the gateway's own declarations: every
    // modelTools.push with effect: 'spawn' must be refused for a leaf, either
    // by name or by shape.
    const gateway = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'tool-gateway', 'mcp-server.ts'), 'utf8',
    ) as string;
    const spawnDeclared: string[] = [];
    // Walk each modelTools.push block and collect the name when the block
    // declares effect: 'spawn'. Name may be a literal or the per-teammate
    // template variable.
    const pushBlocks = gateway.split('modelTools.push(').slice(1);
    for (const block of pushBlocks) {
      const head = block.slice(0, 600);
      if (!/effect:\s*'spawn'/.test(head)) continue;
      const literal = head.match(/name:\s*'([^']+)'/);
      if (literal) {
        spawnDeclared.push(literal[1]);
      } else if (/name:\s*intToolName/.test(head)) {
        // The per-teammate tools: representative concrete spellings, including
        // the id-suffixed collision form.
        spawnDeclared.push('internal__code_reviewer__execute');
        spawnDeclared.push('internal__code_reviewer__a1b2c3d4__execute');
      }
    }
    expect(spawnDeclared.length).toBeGreaterThan(0);
    for (const name of spawnDeclared) {
      expect({ name, refused: isOrchestrationOnlyTool(name) }).toEqual({ name, refused: true });
    }
  });
});
