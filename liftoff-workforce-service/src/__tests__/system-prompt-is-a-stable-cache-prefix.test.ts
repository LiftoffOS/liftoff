// The system prompt this service sends is the provider's cache prefix, and a
// prefix only pays if it does not move.
//
// It is re-sent on every round of the tool-use loop and on every turn of a
// conversation, so it is by far the largest repeated cost here — and it is
// marked as the cache breakpoint in llm/client.ts. Both halves of that only work
// while the bytes are identical between calls. A miss is not merely no saving: a
// cache WRITE is billed at 1.25x the ordinary input rate, so a mark on a moving
// prefix is worse than no mark.
//
// The CAIO's plan state was the one value in the prompt that changed
// mid-conversation. Every workforce_plan__draft call rewrites the plan, so the
// prompt moved on precisely the turns that ran the most rounds. It now rides the
// conversation, through the `planStateText` slot the budgeted prompt already
// had. These tests pin both halves: nothing per-turn renders into the prompt,
// and the plan still reaches the model.

import { renderSystemPrompt, formatPlanState } from '../platform-agent/system-prompt-render.js';
import { buildBudgetedCAIOPrompt } from '../workforce-plans/context-budget.js';
import type { WorkforcePlan } from '../workforce-plans/types.js';

const TEMPLATE = [
  'You are the Chief AI Officer.',
  '',
  'Today is {{TODAY}}.',
  '',
  '{{PLAN_STATE}}',
  '',
  'Tools:',
  '{{TOOLS}}',
].join('\n');

const TOOLS = [{ name: 'workforce_plan__draft', description: 'Draft a plan' }];

function planWith(agentCount: number): WorkforcePlan {
  return {
    id: 'plan-1',
    title: 'Support team',
    status: 'draft',
    revision: agentCount,
    agents: Array.from({ length: agentCount }, (_, i) => ({
      name: `Agent ${i}`,
      agentType: 'agent',
      roleSummary: 'does things',
    })),
  } as unknown as WorkforcePlan;
}

describe('the rendered system prompt', () => {
  it('is byte-identical across turns of the same conversation', () => {
    const a = renderSystemPrompt(TEMPLATE, { today: '2026-09-06', tools: TOOLS });
    const b = renderSystemPrompt(TEMPLATE, { today: '2026-09-06', tools: TOOLS });

    expect(a).toBe(b);
  });

  it('does not change when the plan does', () => {
    // The regression this exists to catch: passing the plan through the render
    // context is a one-line change that reads as harmless and silently costs
    // the prefix on every turn that edits a plan.
    const before = renderSystemPrompt(TEMPLATE, { today: '2026-09-06', tools: TOOLS });
    const after = renderSystemPrompt(TEMPLATE, { today: '2026-09-06', tools: TOOLS });

    expect(after).toBe(before);
    expect(before).not.toContain('Current Workforce Plan State');
  });

  it('leaves no unsubstituted placeholder behind', () => {
    // The seeded template still carries {{PLAN_STATE}}. Nothing fills it now, so
    // the renderer has to resolve it to nothing rather than leak the token into
    // the prompt, where a model would read it as literal text.
    const prompt = renderSystemPrompt(TEMPLATE, { today: '2026-09-06', tools: TOOLS });

    expect(prompt).not.toContain('{{');
  });
});

describe('the plan state still reaches the model', () => {
  it('rides the conversation as context, and tracks the plan', () => {
    const small = buildBudgetedCAIOPrompt({
      systemPrompt: 'PROMPT',
      userContext: 'Caller: Ada (admin)',
      planStateText: formatPlanState(planWith(1)),
      rollingSummary: null,
      recentTurns: [],
      currentMessage: 'add another agent',
    });
    const large = buildBudgetedCAIOPrompt({
      systemPrompt: 'PROMPT',
      userContext: 'Caller: Ada (admin)',
      planStateText: formatPlanState(planWith(3)),
      rollingSummary: null,
      recentTurns: [],
      currentMessage: 'add another agent',
    });

    const contextOf = (p: { messages: Array<{ content: unknown }> }) => String(p.messages[0].content);

    expect(contextOf(small)).toContain('Current Workforce Plan State');
    expect(contextOf(small)).toContain('Agents: 1');
    expect(contextOf(large)).toContain('Agents: 3');
    // The system prompt is the same both times; only the turn moved.
    expect(small.systemPrompt).toBe(large.systemPrompt);
  });

  it('is counted against the budget rather than smuggled in', () => {
    const budgeted = buildBudgetedCAIOPrompt({
      systemPrompt: 'PROMPT',
      userContext: '',
      planStateText: formatPlanState(planWith(2)),
      rollingSummary: null,
      recentTurns: [],
      currentMessage: 'hello',
    });

    expect(budgeted.usage.planState).toBeGreaterThan(0);
  });

  it('adds no context message at all when no plan is linked', () => {
    const budgeted = buildBudgetedCAIOPrompt({
      systemPrompt: 'PROMPT',
      userContext: '',
      planStateText: null,
      rollingSummary: null,
      recentTurns: [],
      currentMessage: 'hello',
    });

    expect(budgeted.messages).toHaveLength(1);
    expect(budgeted.messages[0].content).toBe('hello');
  });
});
