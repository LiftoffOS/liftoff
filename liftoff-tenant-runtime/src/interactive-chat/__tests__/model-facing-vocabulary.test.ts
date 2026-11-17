// The text an agent reads about itself uses the product's words (platform-backend
// INV-PB-016, the same test over this runtime's prompts).
//
// Every agent is handed the canonical voice block, which says "agent", never
// "agent" and never "team" on its own (a team is people and agents together).
// The prompt around the block then said "This agent does NOT have a live browser"
// and told the agent to say "this workspace does not have a live browser
// configured for this agent" to the person. A model follows the demonstration
// over the rule, and the platform assistants had the same defect for the same
// reason (dev share 145b8de6). This renders what the agent reads, in every
// channel and browser state, and fails on any bare "team" or "agent" outside
// identifiers, backticks, fenced code and a quoted rule. Zero tolerance.
//
// The autonomous loop's system prompt (AgentExecutionService.buildSystemPrompt)
// is not renderable without a database, so its two vocabulary lines are pinned
// by source text below, the way step-llm-carries-voice.test.ts reads that file.

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildAgentChatSystemPrompt } from '../system-prompt';
import { AGENT_VOICE_BLOCK } from '../agent-voice';
import { buildRecoveryPrompt } from '../../agent-execution/engine/recovery-prompts';
import type { AnomalyContext, WorkflowStep } from '../../agent-execution/types';

const BARE_TEAM = /(?<!\bAI )(?<![A-Za-z_])(?:team|teams|Team)(?![A-Za-z_])/g;
/** The retired noun. Both casings, singular and plural. */
const AI_TEAM = /\bAI teams?\b/gi;
/** The retired name for an agent from outside the workspace. */
const EXTERNAL_COLLABORATOR = /\bexternal collaborators?\b/gi;
const ALLOWED: RegExp[] = [
  /Microsoft Teams/g,
  /Teams page/g,
  /Teams formatting/g, // the channel's own name, in the Teams-channel formatting section
  /"(?:team|teams|agent|agents|team members|AI team|AI teams|external collaborator)"/g,
  /[Aa] team is people and agents together/g,
];

function prose(text: string): string {
  let t = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const a of ALLOWED) t = t.replace(a, '');
  return t;
}

function findings(text: string): string[] {
  const t = prose(text);
  const out: string[] = [];
  for (const re of [BARE_TEAM, AI_TEAM, EXTERNAL_COLLABORATOR]) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      out.push(t.slice(Math.max(0, at - 60), at + m[0].length + 40).replace(/\n/g, ' '));
    }
  }
  return out;
}

const baseParams = {
  agent: {
    role: 'Release Coordinator',
    messagingNickname: null,
    systemPrompt: 'I help with release decks and platform change history.',
    userInstructions: null,
    additionalContext: null,
  },
  user: { displayName: 'Test User', role: 'admin' },
  channel: 'web' as const,
  hitlLevel: 3,
  connectorList: 'No connectors configured.',
  memoryBlock: '',
  priorInvocationSummary: null,
};

describe('the text an agent reads uses the product\'s own words', () => {
  it('the scanner sees what it is meant to see', () => {
    // Bare "team" and the retired "agent" are both violations; "agent" is now
    // the word the product uses and must NOT be flagged.
    expect(findings('Tell the team to start the AI team.')).toHaveLength(2);
    expect(findings('Hand it to an external collaborator.')).toHaveLength(1);
    expect(findings('Tell the agent to start the agents.')).toHaveLength(0);
    // Identifiers are not prose, so `team_get`, teamId and team_status survive a
    // vocabulary change. This fixture is what proves the scanner still skips
    // identifiers, and it keeps working whether or not those symbols are renamed.
    expect(findings('Say "agent", never "team". Use `team_get`, teamId and team_status.')).toHaveLength(0);
  });

  it('the canonical voice block', () => {
    expect(findings(AGENT_VOICE_BLOCK)).toEqual([]);
  });

  it.each(['web', 'slack', 'teams'] as const)('the chat prompt on %s, in every browser state', (channel) => {
    const variants = [
      { hasBrowserConnector: false, activeBrowserSession: null },
      { hasBrowserConnector: true, activeBrowserSession: null },
      { hasBrowserConnector: true, activeBrowserSession: { id: 'sess-1', url: 'https://example.com' } },
    ];
    for (const v of variants) {
      const prompt = buildAgentChatSystemPrompt({ ...baseParams, channel, ...v } as Parameters<typeof buildAgentChatSystemPrompt>[0]);
      expect(findings(prompt)).toEqual([]);
    }
  });

  it('the recovery advisor prompt', () => {
    const step = { stepId: 's1', description: 'Open a pull request', type: 'tool_call' } as WorkflowStep;
    const anomaly = { kind: 'tool_error', step, error: 'HTTP 404' } as AnomalyContext;
    expect(findings(buildRecoveryPrompt(anomaly, [step], undefined, 's1', [], 0, 0))).toEqual([]);
  });

  it('the autonomous prompt\'s memory-scope and escalation lines, by source', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'agent-execution', 'service.ts'), 'utf8');
    expect(src).toContain('"global": facts useful to ALL agents in this workspace');
    expect(src).toContain('"role": shared by agents with the same role');
    expect(src).toContain('unpause an agent, choose between options');
    expect(src).not.toContain('unpause a team,');
    expect(src).not.toContain('only the Liftoff team can');
  });
});
