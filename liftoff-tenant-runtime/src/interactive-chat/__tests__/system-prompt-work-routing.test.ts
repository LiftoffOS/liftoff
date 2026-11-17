/**
 * Pins the chat-versus-work contract in the chat system prompt.
 *
 * A chat turn hands the user's message to the SAME engine and tool catalog a
 * scheduled run uses, and the distilled persona below it describes the
 * agent's procedure in the imperative. Nothing else in the prompt tells the
 * model that a conversation is not a schedule tick — so a question that
 * merely touches the agent's job ("what's the schedule for running?") reads
 * as an activation, and the model runs the full multi-minute procedure,
 * writing to real documents, instead of answering.
 *
 * The contract has to hold from BOTH anchor positions this file already
 * relies on for its other hard rules: the top section (read before the
 * persona) and the final reminders (recency anchor after it). Position is
 * load-bearing — see the section 14 comment in system-prompt.ts.
 */
import { buildAgentChatSystemPrompt } from '../system-prompt';

const baseParams = {
  agent: {
    role: 'Competitive Intelligence Analyst',
    messagingNickname: null,
    systemPrompt: 'You run a Monday competitor sweep and keep the watch list current.',
    userInstructions: '## Workflows\n1. Read the watch list\n2. Sweep sources\n3. Update the digest',
  },
  user: { displayName: 'Test User', role: 'admin' },
  channel: 'web' as const,
  hitlLevel: 3,
  connectorList: 'No connectors configured.',
  memoryBlock: '',
  priorInvocationSummary: null,
};

describe('chat-versus-work contract', () => {
  const prompt = buildAgentChatSystemPrompt(baseParams);

  it('states that a chat message is not a schedule tick, before the persona', () => {
    const rule = prompt.indexOf('Your scheduled procedure is not a chat reflex');
    const persona = prompt.indexOf(baseParams.agent.systemPrompt);
    expect(rule).toBeGreaterThan(-1);
    expect(persona).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(persona);
    expect(prompt).toContain('A chat message is not a schedule tick');
  });

  it('tells the model to answer questions about the work in words', () => {
    expect(prompt).toContain('Answer "what is your schedule?" by SAYING the schedule');
  });

  it('gates the full procedure on an explicit do-the-work-now ask, through the tool', () => {
    expect(prompt).toContain(
      'The full procedure runs in this conversation ONLY when the user explicitly asks you to do the work now',
    );
    expect(prompt).toContain('by calling `run_routine_now`');
    expect(prompt).toContain('never claim a run happened without that tool returning started');
  });

  it('defaults ambiguity to answering, not running', () => {
    expect(prompt).toContain('answer the question; the user will say so if they want the work run');
  });

  it('repeats the rule in the final reminders, after the persona', () => {
    const reminder = prompt.lastIndexOf(
      'Do not start your workflow procedure unless the user explicitly asked you to do the work now',
    );
    const persona = prompt.indexOf(baseParams.agent.systemPrompt);
    expect(reminder).toBeGreaterThan(persona);
  });
});
