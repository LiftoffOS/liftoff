// System prompt tests — verifies the prompt includes today's date,
// tool descriptions filtered by role, and the visualization format.

import { buildInsightsSystemPrompt } from '../system-prompt';
import { AGENT_VOICE_BLOCK } from '../../../shared/agent-voice';
import type { LLMToolDefinition } from '../../../llm/types';

/** Real verb contractions only; a possessive apostrophe-s is not one. */
const CONTRACTION =
  /\b\w+(?:'|’)(?:t|re|ve|ll|m)\b|\b(?:it|that|there|here|what|who|he|she|let)(?:'|’)s\b/i;

const TOOLS: LLMToolDefinition[] = [
  {
    name: 'get_agent_performance',
    description: 'Agent tasks, costs, success rates, errors',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_cost_breakdown',
    description: 'Where money goes, cost trends',
    input_schema: { type: 'object', properties: {} },
  },
];

describe('buildInsightsSystemPrompt', () => {
  it('injects today\'s date', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    expect(prompt).toContain('## Today\'s Date');
    expect(prompt).toContain('2026-04-08');
  });

  it('lists each available tool with its description', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    expect(prompt).toContain('`get_agent_performance`: Agent tasks, costs, success rates, errors');
    expect(prompt).toContain('`get_cost_breakdown`: Where money goes, cost trends');
  });

  it('falls back to "(none)" when no tools are available', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: [] });
    expect(prompt).toContain('(none available: the user has no data access tools)');
  });

  it('includes the visualization fenced block format hint', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    expect(prompt).toContain('```visualization');
    expect(prompt).toContain('metric_card');
    expect(prompt).toContain('bar_chart');
  });

  it('includes the empty-data and PII rules', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    // The empty-data rule lives under the dedicated "When tools return no
    // data" section now (previously bundled with the generic rules).
    expect(prompt).toContain('When tools return no data');
    expect(prompt).toContain('do not mention that data category');
    // The internals rule moved into the shared confidentiality block, which
    // states it more broadly than the single bullet it replaced.
    expect(prompt).toContain('Never expose raw database identifiers');
  });

  it('includes the brevity hard rules to keep no-data responses short', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    expect(prompt).toContain('## Brevity (HARD RULES)');
    expect(prompt).toContain('BE SHORT');
    expect(prompt).toContain('1-3 sentences');
    expect(prompt).toContain('NEVER respond with a help menu');
    expect(prompt).toContain('Do not list capabilities');
  });

  it('forbids fabricated/illustrative visualization blocks', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    expect(prompt).toContain('Visualization blocks must reflect real values from a tool result');
    expect(prompt).toContain('NEVER create example, illustrative, or placeholder charts');
  });

  it('gives a concrete one-sentence template for the all-empty open-question case', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    expect(prompt).toContain('Nothing to report yet');
    expect(prompt).toContain('That is the entire response');
  });
});

describe('buildInsightsSystemPrompt / bringing in a colleague', () => {
  const WITH_COLLEAGUE: LLMToolDefinition[] = [
    ...TOOLS,
    { name: 'bring_in_colleague', description: 'Bring a colleague in', input_schema: { type: 'object', properties: {} } },
  ];

  it('tells the model when to bring in each colleague, only while the tool is offered', () => {
    const offered = buildInsightsSystemPrompt({ today: '2026-09-19', availableTools: WITH_COLLEAGUE });
    expect(offered).toContain('## Bringing In A Colleague');
    expect(offered).toContain('`bring_in_colleague`');
    expect(offered).toContain('That is the Chief AI Officer, `caio`');
    expect(offered).toContain('That is Liftoff, `liftoff`');
    // A change to a team is brought in, not pointed at.
    expect(offered).toContain('bring the Chief AI Officer in (see Bringing In A Colleague)');
    expect(offered).not.toContain('Liftoff can bring the Chief AI Officer in with their words');
    // A figure asked for alongside a change is given first.
    expect(offered).toContain('give the figure from your tools first');

    // Withheld (an answer-only turn, or a turn that is itself a hand-over):
    // no section, and the change is pointed at as before, because a model
    // told to bring someone in with no tool for it invents the hand-over.
    const withheld = buildInsightsSystemPrompt({ today: '2026-09-19', availableTools: TOOLS });
    expect(withheld).not.toContain('## Bringing In A Colleague');
    expect(withheld).not.toContain('`bring_in_colleague`');
    expect(withheld).toContain('Liftoff can bring the Chief AI Officer in with their words');
  });

  it('keeps the voice rules in the new section', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-09-19', availableTools: WITH_COLLEAGUE });
    const section = prompt.slice(prompt.indexOf('## Bringing In A Colleague'), prompt.indexOf(AGENT_VOICE_BLOCK));
    expect(section).not.toContain('—');
    expect(section).not.toMatch(CONTRACTION);
    expect(section).not.toMatch(/\bAI teams?\b/i);
  });
});

describe('buildInsightsSystemPrompt / voice', () => {
  // This surface had no voice rules at all beyond brevity, and its own prose broke
  // the rules the other surfaces were being held to: em dashes throughout, "AI
  // agents" in the opening line, and "Tasks by Agent" as the worked example a model
  // is most likely to copy.

  it('carries the canonical voice block', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });

    expect(prompt).toContain(AGENT_VOICE_BLOCK);
  });

  it('contains no em dash anywhere, including the part that forbids them', () => {
    // Checked on both branches: the no-tools fallback string is interpolated into
    // the prompt and used to carry an em dash of its own.
    const withTools = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    const withoutTools = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: [] });

    expect(withTools).toContain('Never use an em dash');
    expect(withTools).not.toContain('—');
    expect(withoutTools).not.toContain('—');
  });

  it('does not contract in its own prose', () => {
    // Quoted spans are exempt: the Brevity section quotes "here's what I can do"
    // as an example of a preamble the model must never write, and rewriting the
    // quote would make it less recognisable.
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    const ownProse = prompt.replace(AGENT_VOICE_BLOCK, '').replace(/"[^"]*"/g, '');

    expect(prompt).toContain('Write "do not", "it is", "you will" in full');
    expect(ownProse).not.toMatch(CONTRACTION);
  });

  it('says "agent" rather than "agent" in its own prose and examples', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: [] });

    expect(prompt).toContain('That workforce covers agents');
    expect(prompt).toContain('"title": "Tasks by Agent"');
    expect(prompt).toContain('comparisons across agents');
  });

  it('calls the product Liftoff, never LiftoffOS', () => {
    // Asserted against the prompt with the shared block removed: the rule line has
    // to spell out what it forbids, so a bare not.toContain would fail on the rule
    // itself and prove nothing about the prose around it.
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });
    const ownProse = prompt.replace(AGENT_VOICE_BLOCK, '');

    expect(prompt).toContain('The product is called Liftoff.');
    expect(ownProse).not.toContain('LiftoffOS');
    expect(ownProse).not.toContain('Liftoff OS');
  });

  it('states the confidentiality rules it never had', () => {
    const prompt = buildInsightsSystemPrompt({ today: '2026-04-08', availableTools: TOOLS });

    expect(prompt).toContain('## Confidentiality');
    expect(prompt).toContain('the underlying model or vendor');
    expect(prompt).toContain('Never expose internal errors');
  });
});
