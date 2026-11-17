// Which tools end a run, and when a round has ended it.
//
// A run that has posted the review and opened the thread is finished, and the
// loop still makes one more model call to say so — a request and a round-trip on
// every completed run, on every engine, for a sentence nobody needed.
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../../infrastructure/logging';
import { terminalToolNames, roundIsTerminal, logTurnClosed } from '../terminal-tools';

const step = (stepId: string, toolName: string, onSuccess?: string) =>
  ({ stepId, description: '', toolName, ...(onSuccess ? { onSuccess } : {}) }) as never;

describe('terminalToolNames', () => {
  it('takes the tools of steps whose success path goes nowhere', () => {
    const steps = [
      step('s1', 'github__pull_request_read', 's2'),
      step('s2', 'github__pull_request_review_write', 's3'),
      step('s3', 'liftoff__open_chat_thread'),
    ];
    expect([...terminalToolNames(steps)]).toEqual(['liftoff__open_chat_thread']);
  });

  it('ignores the failure path — ending by failing is not finishing', () => {
    const steps = [step('s1', 'github__pull_request_read')];
    (steps[0] as unknown as { onFailure: string }).onFailure = 's9';
    expect([...terminalToolNames(steps)]).toEqual(['github__pull_request_read']);
  });

  it('is empty for an agent with no graph, rather than guessing one', () => {
    // A conversational agent has no terminal step, so nothing here can say when
    // it is done. The loop keeps today's behaviour.
    expect(terminalToolNames(undefined).size).toBe(0);
    expect(terminalToolNames([]).size).toBe(0);
  });

  it('skips a terminal step that calls no tool', () => {
    expect(terminalToolNames([step('s1', '')]).size).toBe(0);
  });
});

describe('roundIsTerminal', () => {
  const terminal = new Set(['liftoff__open_chat_thread', 'slack__send_message']);

  it('is true when every call in the round was terminal', () => {
    expect(roundIsTerminal(['liftoff__open_chat_thread'], terminal)).toBe(true);
    expect(roundIsTerminal(['liftoff__open_chat_thread', 'slack__send_message'], terminal)).toBe(true);
  });

  it('is FALSE when the round also did something else', () => {
    // The guard that matters. A round that posted the review and read another
    // pull request is mid-plan; ending it there truncates the run — the model
    // asked for the next thing and never got it.
    expect(roundIsTerminal(['liftoff__open_chat_thread', 'github__pull_request_read'], terminal))
      .toBe(false);
  });

  it('is false for a round that called nothing', () => {
    // That is the model talking, and the loop already ends on it.
    expect(roundIsTerminal([], terminal)).toBe(false);
  });

  it('is false when the agent has no terminal set', () => {
    expect(roundIsTerminal(['anything'], new Set())).toBe(false);
  });
});

describe('logTurnClosed', () => {
  // The adapters end the turn by returning early and the vendor never says
  // which call was not made, so the line is the only trace a closed turn leaves.
  it('names the engine, the round and the invocation', () => {
    logTurnClosed('google-genai', ['github__pull_request_review_write'], 'inv-9');
    expect((logger.info as jest.Mock).mock.calls[0][0]).toEqual({
      event: 'turn_closed_on_terminal_round',
      execution_engine: 'google-genai',
      tool_names: ['github__pull_request_review_write'],
      invocation_id: 'inv-9',
    });
  });
});
