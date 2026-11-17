// Every tool this service can enumerate has a phrase a person can read, and no
// tool name ever reaches a person.
//
// The label used to be derived in the browser from the tool's name, which
// produced "Using Get_config" for `team__get_config`. A browser cannot
// enumerate the tools of three services; this one can enumerate its own, so the
// ratchet lives here: add a tool without a label and this fails.
//
// The second property is the one that holds when the ratchet cannot: whatever
// arrives, the phrase is never built out of the name. The Chief AI Officer's and
// the Tenant Runtime's registries are in other repos and can drift, and the
// answer to drift is a phrase that says nothing rather than an identifier.

import { toolActivityLabel, NEUTRAL_ACTIVITY_LABEL, _authoredActivityLabels } from '../tool-activity-label';
import { WORKSPACE_ACTION_TOOLS } from '../../workspace-actions/tools';
import { listColleaguesTool, bringInColleagueTool } from '../../liftoff/delegation-targets';
import { capabilitySearchTool, runCapabilityTool } from '../../liftoff/capability-tools';
import { datasetTools } from '../../datasets/tools';
import { BROWSER_ASSISTANT_TOOLS } from '../../browser-sessions/assistant-tools';
import { registerInsightsTools } from '../../insights/tools';
import { getToolDefinitionsForRole } from '../../insights/tools/dispatcher';

/** Every name this service can put on a `tool_call` frame of its own. */
function enumerableToolNames(): string[] {
  registerInsightsTools();
  return [
    ...WORKSPACE_ACTION_TOOLS.map((t) => t.definition.name),
    ...[listColleaguesTool, bringInColleagueTool, capabilitySearchTool, runCapabilityTool].map((t) => t.name),
    ...datasetTools.map((t) => t.name),
    ...BROWSER_ASSISTANT_TOOLS.map((t) => t.name),
    ...getToolDefinitionsForRole('owner').map((d) => d.name),
  ];
}

it('has an authored phrase for every tool this service offers', () => {
  const missing = [...new Set(enumerableToolNames())].filter((n) => !_authoredActivityLabels()[n]).sort();
  expect(missing).toEqual([]);
});

it('never puts a tool name, or anything built from one, in front of a person', () => {
  const authored = _authoredActivityLabels();
  for (const [name, label] of Object.entries(authored)) {
    // No identifier shape survives into a label: no underscores, and not the
    // name itself in any casing.
    expect(label).not.toContain('_');
    expect(label.toLowerCase()).not.toContain(name.toLowerCase());
    expect(label[0]).toBe(label[0]!.toUpperCase());
  }
});

it('falls back to a phrase that says nothing, never to the name', () => {
  // The exact shape that leaked: a two-segment name whose second segment is not
  // a vendor. The old deriver title-cased it to "Using Get_config".
  expect(toolActivityLabel('some_future__get_config')).toBe(NEUTRAL_ACTIVITY_LABEL);
  expect(toolActivityLabel('a_tool_nobody_authored')).toBe(NEUTRAL_ACTIVITY_LABEL);
  expect(toolActivityLabel('')).toBe(NEUTRAL_ACTIVITY_LABEL);
});

it('names the vendor of an MCP tool, spelled the way the vendor spells it', () => {
  expect(toolActivityLabel('mcp__github-7d07a896__get_file_contents')).toBe('Working in GitHub');
  expect(toolActivityLabel('mcp__notion-aa11bb22cc__search')).toBe('Working in Notion');
  expect(toolActivityLabel('mcp__hubspot__list_contacts')).toBe('Working in HubSpot');
  // Unknown vendor: title-cased, which is the best a slug allows, and still a
  // vendor rather than a function.
  expect(toolActivityLabel('mcp__acme-parts__lookup_sku')).toBe('Working in Acme Parts');
});

it('reads the one that went wrong the way a person would', () => {
  expect(toolActivityLabel('team__get_config')).toBe('Reading the agent');
  expect(toolActivityLabel('team_archive')).toBe('Removing the agent');
});
