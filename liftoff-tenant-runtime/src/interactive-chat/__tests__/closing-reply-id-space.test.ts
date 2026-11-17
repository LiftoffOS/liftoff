// The closing nudge's spend must land on the agent that spent it.
//
// `usageContext.agentId` is read as a RUNTIME id: `resolveByokRoutedCall` hands
// it to `openByokSession` as `runtimeAgentId`, which maps runtime ->
// control plane through `internal_agent_runtime_mapping`. The two spaces are
// disjoint (ADR-039), so an id from the wrong one matches zero rows with no
// error — the session posts `agentId: null` and the row loses its team.
//
// Every caller of this nudge is `chat-turn-handler`, whose own `agentId` is the
// id the CONTROL PLANE addressed the team by. Passing it straight through
// produces `agent_id_reverse_mapping_miss` on every chat turn, with the
// control-plane id in the field, while both repos' tests stay green:
// `llm_usage_log.agent_id` is free TEXT with no FK, so the wrong space is
// STORED without complaint and only the billing label is lost.

import { readFileSync } from 'fs';
import { join } from 'path';

const mockComplete = jest.fn();

jest.mock('../../llm/client', () => ({
  llmClient: {
    complete: (...args: unknown[]) => mockComplete(...args),
    modelSelectionFor: jest.fn(() => undefined),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { requestClosingReply } from '../closing-reply';

const RUNTIME_ID = '90816ede-009b-4c55-a20c-2de91e7590d6';

beforeEach(() => {
  mockComplete.mockReset();
  mockComplete.mockResolvedValue({ content: 'Here is what I did.' });
});

describe('the closing nudge attributes its own spend', () => {
  it('puts the agent id it was given on the usage context, unchanged', () => {
    // The contract the callers have to satisfy: this function does not resolve
    // anything, so whatever it is handed is what reaches the ledger and the
    // BYOK resolver.
    return requestClosingReply({
      tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
      agentId: RUNTIME_ID,
      threadId: 'da07be9a-dac5-4e9e-bff3-3453d16d20aa',
      invocationId: '9ab5fefc-0000-4000-8000-000000000000',
      userMessage: 'i want my report now',
      activityDigest: '1 action in Google Docs',
    }).then(() => {
      expect(mockComplete).toHaveBeenCalled();
      const usageContext = mockComplete.mock.calls[0][2] as Record<string, string>;
      expect(usageContext.agentId).toBe(RUNTIME_ID);
      expect(usageContext.purpose).toBe('chat_closing_reply');
    });
  });
});

describe('every caller hands it the RUNTIME id', () => {
  // Source-level, because standing the whole chat-turn handler up to observe
  // one argument would test the harness rather than the property. The property
  // is which VARIABLE is passed, and that is exactly what this reads.
  const HANDLER = readFileSync(join(__dirname, '..', 'chat-turn-handler.ts'), 'utf8');

  /** Each argument block in the handler that reaches the nudge.
   *
   *  `correctReplyContradictingTheLedger` is in here because it calls
   *  `requestClosingReply` on the handler's behalf, so the handler is still the
   *  caller of record — and a check that reads only the direct call sites would
   *  have gone green while an indirect one carried the control-plane id. The
   *  pass-through itself is asserted below. */
  function callBlocks(): string[] {
    const out: string[] = [];
    const re = /(?:requestClosingReply(?:WithVerdict)?|correctReplyContradictingTheLedger)\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(HANDLER)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      while (i < HANDLER.length && depth > 0) {
        if (HANDLER[i] === '{') depth++;
        else if (HANDLER[i] === '}') depth--;
        i++;
      }
      out.push(HANDLER.slice(start, i - 1));
    }
    return out;
  }

  it('finds the call sites at all, so a rename cannot make this vacuously pass', () => {
    expect(callBlocks().length).toBeGreaterThanOrEqual(5);
  });

  it.each(callBlocks().map((b, i) => [i, b]))(
    'call site %i passes runtimeAgentIdForRun, never the control-plane agentId',
    (_i, block) => {
      expect(block).toContain('agentId: runtimeAgentIdForRun');
      // `agentId,` is the shorthand for the control-plane id this handler was
      // called with. It is the exact shape the defect had.
      expect(block).not.toMatch(/^\s*agentId,\s*$/m);
    },
  );
});

// The INDIRECT caller, which is the hop a source-level check over the handler
// alone cannot see: it hands its input's agentId to the nudge, so the handler's
// own argument is the whole of the guarantee.
describe('the ledger correction passes the id it was given straight through', () => {
  it('reaches the nudge with the runtime id, unchanged', async () => {
    const { correctReplyContradictingTheLedger } = await import('../ledger-contradiction');
    await correctReplyContradictingTheLedger({
      replyText: 'No battle card was created or changed.',
      calls: [{ name: 'google-docs-8fd9fc68__create_document_markdown', success: true, result: { id: 'doc-1' } }],
      tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
      agentId: RUNTIME_ID,
      threadId: 'da07be9a-dac5-4e9e-bff3-3453d16d20aa',
      invocationId: '9ab5fefc-0000-4000-8000-000000000000',
      userMessage: 'so where is my report',
    });
    expect(mockComplete).toHaveBeenCalled();
    const usageContext = mockComplete.mock.calls[0]![2] as Record<string, string>;
    expect(usageContext.agentId).toBe(RUNTIME_ID);
    expect(usageContext.purpose).toBe('chat_closing_reply');
  });
});
