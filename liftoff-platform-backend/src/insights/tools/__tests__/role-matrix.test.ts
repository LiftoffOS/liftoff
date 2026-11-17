// Role matrix tests — exhaustively asserts the table from the implementation
// plan. The matrix is the second line of defense (the system prompt is the
// first), so we test every (tool × role) combination explicitly.

import { canRoleCallTool, toolsForRole, TOOL_ACCESS_MATRIX } from '../role-matrix';
import { WORKSPACE_ACTION_TOOLS } from '../../../workspace-actions/tools';

/** The built-in analytics and browser tools only: the shared workspace-action
 *  tools are registered alongside and asserted separately below. */
const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_ACTION_TOOLS.map((t) => t.definition.name));
function builtInToolsForRole(role: Parameters<typeof toolsForRole>[0]): string[] {
  return toolsForRole(role).filter((name) => !WORKSPACE_TOOL_NAMES.has(name));
}
import type { InsightsRole } from '../types';

const ALL_ROLES: InsightsRole[] = ['owner', 'admin', 'member', 'viewer'];

const EXPECTED: Record<string, Record<InsightsRole, boolean>> = {
  get_agent_performance: { owner: true, admin: true, member: true, viewer: true },
  get_cost_breakdown:    { owner: true, admin: true, member: true, viewer: true },
  get_human_activity:    { owner: true, admin: true, member: true, viewer: false },
  get_oversight_config:  { owner: true, admin: true, member: true, viewer: true },
  get_workforce_composition: { owner: true, admin: true, member: true, viewer: true },
  get_execution_trends:  { owner: true, admin: true, member: true, viewer: true },
  get_connector_health:  { owner: true, admin: true, member: true, viewer: true },
  // The three dataset tools read back what THIS conversation already fetched
  // and paid for, so they follow the reads around them rather than the
  // browser's spend rule: every role, viewer included.
  dataset_query:         { owner: true, admin: true, member: true, viewer: true },
  dataset_extract:       { owner: true, admin: true, member: true, viewer: true },
  dataset_list:          { owner: true, admin: true, member: true, viewer: true },
};

describe('canRoleCallTool', () => {
  for (const [tool, byRole] of Object.entries(EXPECTED)) {
    for (const role of ALL_ROLES) {
      it(`${tool} × ${role} → ${byRole[role]}`, () => {
        expect(canRoleCallTool(tool, role)).toBe(byRole[role]);
      });
    }
  }

  it('unknown tool name returns false for every role', () => {
    for (const role of ALL_ROLES) {
      expect(canRoleCallTool('get_world_domination', role)).toBe(false);
    }
  });
});

describe('toolsForRole', () => {
  // 10 analytics tools + 4 browser tools + 3 dataset tools + the colleague to
  // bring in.
  const BROWSER_TOOLS = [
    'navigate_browser_session', 'run_browser_task',
    'start_browser_session', 'read_active_browser_session',
  ];
  const DATASET_TOOLS = ['dataset_query', 'dataset_extract', 'dataset_list'];

  it('owner gets all 20 built-in tools', () => {
    expect(builtInToolsForRole('owner')).toHaveLength(20);
  });

  it('admin gets all 20 built-in tools', () => {
    expect(builtInToolsForRole('admin')).toHaveLength(20);
  });

  it('member gets all 20 built-in tools', () => {
    const tools = builtInToolsForRole('member');
    expect(tools).toHaveLength(20);
    expect(tools).toContain('get_human_activity'); // allow_own counts as callable
  });

  it('viewer gets 15 built-in tools (no human_activity or browser)', () => {
    const tools = builtInToolsForRole('viewer');
    expect(tools).toHaveLength(15);
    expect(tools).toContain('get_data_source_rates'); // a price list, not anyone's activity
    expect(tools).not.toContain('get_human_activity');
    // Reading further back in the conversation they are already in shows a
    // viewer what their own client already renders. No role is in a
    // conversation and barred from reading it.
    expect(tools).toContain('read_conversation_history');
    expect(tools).toContain('recall_conversations');
  });

  // A parked result is this conversation's own, and reading it changes
  // nothing, so it is offered on every turn a person has: an ordinary one, a
  // hand-over, and an answer-only turn a team brought this assistant in for.
  it.each(ALL_ROLES)('%s can read this conversation\'s datasets', (role) => {
    for (const name of DATASET_TOOLS) {
      expect(toolsForRole(role)).toContain(name);
      expect(toolsForRole(role, { answerOnly: true })).toContain(name);
      expect(toolsForRole(role, { asColleague: true })).toContain(name);
    }
  });

  // Everyone can ask for a colleague, as on Liftoff; what the colleague may
  // then do is its own role decision.
  it.each(ALL_ROLES)('%s can bring in a colleague on an ordinary turn', (role) => {
    expect(toolsForRole(role)).toContain('bring_in_colleague');
  });

  // Depth one: a turn that is itself a hand-over is offered no colleague of
  // its own, and an answer-only turn has nobody present to confirm anything.
  it.each(ALL_ROLES)('%s is offered no colleague on a hand-over', (role) => {
    expect(toolsForRole(role, { asColleague: true })).not.toContain('bring_in_colleague');
    // Everything else stays: the person is present.
    expect(toolsForRole(role, { asColleague: true })).toEqual(
      toolsForRole(role).filter((name) => name !== 'bring_in_colleague'),
    );
  });

  it.each(ALL_ROLES)('%s is offered no colleague on an answer-only turn', (role) => {
    expect(toolsForRole(role, { answerOnly: true })).not.toContain('bring_in_colleague');
  });

  // A browser session costs money for as long as it is open, and a viewer's
  // whole role is to look without changing or spending anything. Asserted by
  // name rather than by count so adding an eleventh analytics tool cannot
  // quietly let a viewer open a browser.
  it.each(BROWSER_TOOLS)('a viewer cannot call %s', (tool) => {
    expect(toolsForRole('viewer')).not.toContain(tool);
  });

  it.each(BROWSER_TOOLS)('a member can call %s', (tool) => {
    expect(toolsForRole('member')).toContain(tool);
  });
});

describe('TOOL_ACCESS_MATRIX', () => {
  it('matrix is frozen', () => {
    expect(Object.isFrozen(TOOL_ACCESS_MATRIX)).toBe(true);
    for (const v of Object.values(TOOL_ACCESS_MATRIX)) {
      expect(Object.isFrozen(v)).toBe(true);
    }
  });

  it('every tool has an entry for every role', () => {
    for (const tool of Object.keys(TOOL_ACCESS_MATRIX)) {
      for (const role of ALL_ROLES) {
        expect(TOOL_ACCESS_MATRIX[tool][role]).toBeDefined();
      }
    }
  });
});

describe('workspace-action tools resolve by their own permission', () => {
  it('a name the matrix does not know is answered by the shared registry', () => {
    // review_list is a read any member may make; review_decide needs the
    // member floor; a viewer gets the first and not the second.
    expect(canRoleCallTool('review_list', 'viewer')).toBe(true);
    expect(canRoleCallTool('review_decide', 'member')).toBe(true);
    expect(canRoleCallTool('review_decide', 'viewer')).toBe(false);
    expect(toolsForRole('member')).toContain('review_decide');
    expect(toolsForRole('viewer')).not.toContain('review_decide');
  });

  it('a name neither knows is denied', () => {
    expect(canRoleCallTool('not_a_tool', 'owner')).toBe(false);
  });
});
