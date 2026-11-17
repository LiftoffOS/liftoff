// Structured recovery decisions.
//
// The advisor's prompt asks for BARE decision words (continue / complete /
// escalate / fail / ask_user) while the only parser matched BRACKETED
// [COMPLETE] / [ESCALATE] / [FAIL]. A prose answer matched nothing, fell
// through the stopReason==='end_turn' heuristic, and became decision='complete'
// — so an advisor that decided to ESCALATE produced a clean successful run.
// 'ask_user' was unreachable outright: the parser's decision union omitted it
// and it never set userQuestion, leaving the clarification branch dead.

jest.mock('../../connectors/tool-schema-cache', () => ({
  resolveEntityType: jest.fn(() => undefined),
  getToolSchemas: jest.fn(async () => []),
}));

import { AgentExecutionService } from '../service';
import type { LLMCompletionResponse } from '../../llm/types';

type Parser = (r: LLMCompletionResponse) => {
  decision: string;
  toolCalls: Array<{ connector: string; actionType: string; payload: unknown }>;
  escalationReason?: string;
  failureReason?: string;
  userQuestion?: string;
  output?: unknown;
  nextStepId?: string;
};

function parse(response: Partial<LLMCompletionResponse>): ReturnType<Parser> {
  const service = new AgentExecutionService();
  return (service as unknown as { parseRecoveryDecision: Parser })
    .parseRecoveryDecision({
      content: '',
      model: 'm',
      provider: 'anthropic',
      ...response,
    } as LLMCompletionResponse);
}

function decisionCall(input: Record<string, unknown>) {
  return { toolCalls: [{ id: '1', name: 'recovery_decision', input }] };
}

describe('parseRecoveryDecision', () => {
  it.each(['continue', 'complete', 'escalate', 'fail', 'ask_user'])(
    'round-trips decision=%s', (decision) => {
      expect(parse(decisionCall({ decision })).decision).toBe(decision);
    },
  );

  it('reaches ask_user WITH its question — previously unreachable', () => {
    const result = parse(decisionCall({ decision: 'ask_user', userQuestion: 'which sheet?' }));
    expect(result.decision).toBe('ask_user');
    expect(result.userQuestion).toBe('which sheet?');
  });

  it('carries escalate / fail reasons', () => {
    expect(parse(decisionCall({ decision: 'escalate', escalationReason: 'auth expired' })).escalationReason)
      .toBe('auth expired');
    expect(parse(decisionCall({ decision: 'fail', failureReason: 'no such sheet' })).failureReason)
      .toBe('no such sheet');
  });

  it('maps proposed continue toolCalls through the dispatch mapping', () => {
    // The {alias}__{function} split has to survive, or a retry the advisor
    // proposes cannot be dispatched.
    const result = parse(decisionCall({
      decision: 'continue',
      toolCalls: [{ name: 'price_data__get_bitcoin_price', input: { vs: 'usd' } }],
    }));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      connector: 'price_data',
      actionType: 'get_bitcoin_price',
      payload: { vs: 'usd' },
    });
  });

  it('keeps nextStepId for a forward jump', () => {
    expect(parse(decisionCall({ decision: 'continue', nextStepId: 's4' })).nextStepId).toBe('s4');
  });

  it('does NOT turn prose into complete — it escalates', () => {
    // The exact regression: no structured call, only text.
    const result = parse({ content: 'escalate: the connector is disconnected', stopReason: 'end_turn' });
    expect(result.decision).toBe('escalate');
    expect(result.escalationReason).toMatch(/no structured decision/i);
  });

  it('escalates rather than trusting an unrecognised decision value', () => {
    expect(parse(decisionCall({ decision: 'yolo' })).decision).toBe('escalate');
  });

  it('ignores non-decision tool calls', () => {
    const result = parse({ toolCalls: [{ id: '1', name: 'some_other_tool', input: {} }] });
    expect(result.decision).toBe('escalate');
  });
});
