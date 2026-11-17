// Which calls the contract check may judge.
//
// The check asks whether a call does what the team was built and approved to
// do, and the answer is only meaningful for a call that reaches the world the
// team was hired into. A distilled contract never names how the team
// remembers, asks, waits or hands over, so judged against it those calls read
// as outside: a reviewer agent can be gated for bringing the Chief AI Officer
// into its own chat (`bring_in_colleague`).
//
// So every tool the model can call is read out of its registration site and
// classified: it acts outside the platform and stays eligible, or it is exempt
// by one of the four predicates (bookkeeping, own-workspace chat, self-wake,
// platform-own). A tool that is neither fails here, on the commit that adds
// it, naming itself.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isEligibleCall } from '../contract-check';
import {
  isInProcessBookkeepingTool,
  isOwnWorkspaceChatTool,
  isPlatformOwnTool,
  isSelfWakeTool,
} from '../tool-name-resolution';
import { STANDARD_TOOL_EFFECTS } from '../../tool-gateway/tool-effect';
import type { ModelTool, ToolCallRequest } from '../types';

const REGISTRATION_SITES = [
  'src/tools/standard-tools.ts',
  'src/tool-gateway/mcp-server.ts',
];

/** The registered tools that act outside the platform: a page, a sandbox that
 *  can reach anything, a capability that runs against a vendor. These stay
 *  eligible; a read among them is excluded by its effect, not by this list. */
const ACTS_OUTSIDE = new Set([
  '__fail_once__',
  'act_in_browser_session',
  'navigate_browser_session',
  'run_browser_task',
  // Sets another run of this same team going, which does whatever the brief
  // says. What it reaches is the world the team was hired into.
  'work_on_this_in_the_background',
  'web_task',
  'code_session',
  'run_capability',
  'capability_search',
]);

/** Reads: excluded by effect, whichever surface they read. Listed so that a
 *  read is never mistaken for an unclassified tool. */
const READS = new Set(Object.entries(STANDARD_TOOL_EFFECTS).filter(([, e]) => e === 'read').map(([n]) => n).concat([
  'search', 'read_agent_messages', 'find_teammates', 'recall_conversations', 'review_recent_activity',
  'read_conversation_history',
]));

function registeredToolNames(): string[] {
  const names = new Set<string>();
  for (const site of REGISTRATION_SITES) {
    const source = readFileSync(resolve(__dirname, '../../..', site), 'utf8');
    for (const m of source.matchAll(/name: '([a-z_0-9]+)',/g)) names.add(m[1]);
  }
  return [...names].sort();
}

const exempt = (name: string): boolean =>
  isInProcessBookkeepingTool(name) || isOwnWorkspaceChatTool(name) || isSelfWakeTool(name) || isPlatformOwnTool(name);

describe('every registered tool is classified for the contract check', () => {
  it.each(registeredToolNames())('%s is classified', (name) => {
    const classified = exempt(name) || ACTS_OUTSIDE.has(name) || READS.has(name);
    expect(classified).toBe(true);
    // Never both: a tool that acts outside is not exempt.
    if (ACTS_OUTSIDE.has(name)) expect(exempt(name)).toBe(false);
  });

  it('the acts-outside list has not gone stale', () => {
    const registered = new Set(registeredToolNames());
    for (const name of ACTS_OUTSIDE) if (name !== '__fail_once__') expect(registered.has(name)).toBe(true);
  });
});

describe('isEligibleCall', () => {
  const call = (name: string): ToolCallRequest => ({ id: 'c', name, input: {} });
  const tools: ModelTool[] = [
    { name: 'bring_in_colleague', description: '', inputSchema: {}, effect: 'write' } as ModelTool,
    { name: 'memory_save', description: '', inputSchema: {}, effect: 'write' } as ModelTool,
    { name: 'web_task', description: '', inputSchema: {}, effect: 'write' } as ModelTool,
    { name: 'github__create_review', description: '', inputSchema: {}, effect: 'write', categories: ['externalPublishing'] } as ModelTool,
    { name: 'github__get_pull_request', description: '', inputSchema: {}, effect: 'read' } as ModelTool,
  ];

  it('a platform-own call is never a candidate, bare or prefixed', () => {
    expect(isEligibleCall(call('bring_in_colleague'), tools)).toBe(false);
    expect(isEligibleCall(call('mcp__liftoff-tool-gateway__bring_in_colleague'), tools)).toBe(false);
    expect(isEligibleCall(call('memory_save'), tools)).toBe(false);
    expect(isEligibleCall(call('open_chat_thread'), tools)).toBe(false);
  });

  it('a call that acts outside stays eligible; a read never is', () => {
    expect(isEligibleCall(call('web_task'), tools)).toBe(true);
    expect(isEligibleCall(call('github__create_review'), tools)).toBe(true);
    expect(isEligibleCall(call('github__get_pull_request'), tools)).toBe(false);
  });

  it("a connector tool that merely ends the same way is somebody else's, and stays eligible", () => {
    expect(isPlatformOwnTool('some_vendor__memory_save')).toBe(false);
    expect(isEligibleCall(call('some_vendor__memory_save'), [{ name: 'some_vendor__memory_save', description: '', inputSchema: {}, effect: 'write' } as ModelTool])).toBe(true);
  });
});
