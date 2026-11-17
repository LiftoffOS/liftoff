/**
 * Pins the sentence that routes "automate what I just did" from a team's
 * chat to the Chief AI Officer, and its companion for a NEW team.
 *
 * In a team's chat, "automate what I just did" means a change to that team's
 * own standing work, and the rail exists (`bring_in_colleague`); what did not
 * exist was the sentence telling the team so. The same sentence sits in the
 * tool's description so the palette and the prompt agree, and the browser
 * preamble says protected data never goes into a browser task. No
 * contractions, no em dashes, never "agent" in the new copy.
 */
import { buildAgentChatSystemPrompt } from '../system-prompt';
import { STANDARD_TOOLS } from '../../tools/standard-tools';

const baseParams = {
  agent: {
    role: 'Competitive Intelligence Analyst',
    messagingNickname: null,
    systemPrompt: 'You run a Monday competitor sweep.',
    userInstructions: '## Workflows\n1. Sweep sources',
  },
  user: { displayName: 'Test User', role: 'admin' },
  channel: 'web' as const,
  hitlLevel: 3,
  connectorList: 'No connectors configured.',
  memoryBlock: '',
  priorInvocationSummary: null,
};

const AUTOMATE = 'When the user asks you to automate what they just did, or to keep doing something they did with you or in the browser beside this conversation, that is a change to what you are: bring in "caio" with the request in their terms, naming the pages and the steps as they were done.';
const NEW_TEAM = 'When the user wants a NEW agent rather than a change to you, say that the Chief AI Officer designs new agents in its own chat and through Liftoff, and do not bring it in for that.';

describe('automate what was done', () => {
  const prompt = buildAgentChatSystemPrompt(baseParams);

  it('the colleagues section carries the sentence, after the Chief AI Officer clause', () => {
    const section = prompt.indexOf('### Three colleagues you can bring in');
    const caio = prompt.indexOf('bring in `caio`, the Chief AI Officer');
    const automate = prompt.indexOf(AUTOMATE);
    const newTeam = prompt.indexOf(NEW_TEAM);
    expect(section).toBeGreaterThan(-1);
    expect(caio).toBeGreaterThan(section);
    expect(automate).toBeGreaterThan(caio);
    expect(newTeam).toBeGreaterThan(automate);
    expect(prompt.split(AUTOMATE)).toHaveLength(2);
  });

  it('the bring_in_colleague description carries the same two sentences', () => {
    const tool = STANDARD_TOOLS.find((t) => t.name === 'bring_in_colleague')!;
    expect(tool.description).toContain(AUTOMATE);
    expect(tool.description).toContain(NEW_TEAM);
  });

  it('the browser preamble prohibits protected data in a browser task and says what is recorded', () => {
    const withBrowser = buildAgentChatSystemPrompt({ ...baseParams, hasBrowserConnector: true } as never);
    expect(withBrowser).toContain('### Protected data never goes into a browser task');
    expect(withBrowser).toContain('A task that carries one is refused before it reaches the browser.');
    expect(withBrowser).toContain('protected fields are not recorded when identified');
    const run = STANDARD_TOOLS.find((t) => t.name === 'run_browser_task')!;
    expect(run.description).toContain('NEVER put a password, one-time code, payment card or bank detail');
    expect(run.description).toContain('protected fields are not recorded when identified');
    const nav = STANDARD_TOOLS.find((t) => t.name === 'navigate_browser_session')!;
    expect(nav.description).toContain('never repeat a redacted or truncated address as exact');
  });

  it('the new copy has no contraction, no em dash and never says "AI team"', () => {
    const copy = [AUTOMATE, NEW_TEAM,
      buildAgentChatSystemPrompt({ ...baseParams, hasBrowserConnector: true } as never)
        .split('### Protected data never goes into a browser task')[1]?.split('\n\n')[1] ?? '',
    ].join(' ');
    expect(copy).not.toMatch(/—/);
    expect(copy).not.toMatch(/\b\w+n't\b|\b(?:it|that|there|what|who)'s\b|\b\w+'(?:ll|re|ve|d)\b/i);
    expect(copy.toLowerCase()).not.toMatch(/\bai team\b/);
  });
});
