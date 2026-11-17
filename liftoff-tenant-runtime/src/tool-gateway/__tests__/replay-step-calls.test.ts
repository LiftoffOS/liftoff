// The fourth dispatch seam: the model's own call inside a step's turn.
//
// A pause re-dispatches the step it paused on — every HITL pause site in the
// workflow loop writes `resumeAfterStepId: currentStepId`, "re-dispatch the gated
// step on approve" — so a step whose model created a document and then gated on a
// later call runs its turn again, whole, in another process. This wrapper is what
// stops the second turn making the document again.
//
// It wraps the tool list the in-process McpServer is built from, because that is
// the one place every tool on every engine passes through.
// `observe-result-size.ts` sits at the same seam and its headline records what
// happens otherwise: wired into `mcp-bridge`, a guarantee covers the OpenAI /
// Gemini loops and misses the ~99% of production that is Anthropic.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { replayRecordedStepCalls } from '../replay-step-calls';
import { StepReplayLedger } from '../../agent-execution/step-replay-ledger';

const CREATE = 'google-docs-8fd9fc68__create_document_markdown';
const CARD = { title: 'Acme: Battle Card: AllAgents', body: '# Card' };
const CTX = { tenantId: 't1', agentId: 'a1', invocationId: 'inv-1' };

/** A tool list shaped as the gateway builds it. */
function tools(handler: jest.Mock) {
  return [
    { name: CREATE, handler: handler as unknown as (a: never, e: never) => Promise<unknown> },
    { name: 'google-docs-8fd9fc68__search_documents', handler: handler as unknown as (a: never, e: never) => Promise<unknown> },
  ];
}

function ledgerWith(result: unknown): StepReplayLedger {
  const l = new StepReplayLedger('s13');
  l.recordRequest(
    { connector: 'google-docs-8fd9fc68', actionType: 'create_document_markdown', payload: CARD },
    result,
  );
  return l;
}

describe('a call the step has already completed', () => {
  it('is answered with that call\'s own result, and the handler is not run', async () => {
    const handler = jest.fn(async () => ({ content: [{ type: 'text', text: 'SHOULD NOT HAPPEN' }] }));
    const wrapped = replayRecordedStepCalls(tools(handler), ledgerWith({ documentId: '10OzC7pB' }), CTX);

    const out = await wrapped[0]!.handler(CARD as never, undefined as never);
    expect(handler).not.toHaveBeenCalled();
    expect(out).toEqual({ documentId: '10OzC7pB' });
  });

  it('is recognised under the SDK-prefixed name too', async () => {
    // The Claude SDK registers `mcp__<server>__<tool>`; the bridge engines use the
    // bare catalog name. A replay that held on one engine and not the other would
    // be worse than none, because nothing would say which.
    const handler = jest.fn(async () => 'dispatched');
    const wrapped = replayRecordedStepCalls(
      [{ name: `mcp__liftoff-tool-gateway__${CREATE}`, handler: handler as never }],
      ledgerWith('recorded'),
      CTX,
    );
    await expect(wrapped[0]!.handler(CARD as never, undefined as never)).resolves.toBe('recorded');
    expect(handler).not.toHaveBeenCalled();
  });

  it('says so, naming the step, so a live run can be checked without reading a prompt', async () => {
    const wrapped = replayRecordedStepCalls(tools(jest.fn()), ledgerWith('x'), CTX);
    await wrapped[0]!.handler(CARD as never, undefined as never);
    const { logger } = jest.requireMock('../../infrastructure/logging') as { logger: { info: jest.Mock } };
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: 's13', toolName: CREATE, invocationId: 'inv-1' }),
      expect.stringContaining('already completed'),
    );
  });
});

describe('everything else dispatches exactly as it did', () => {
  it('a DIFFERENT document is new work', async () => {
    const handler = jest.fn(async () => 'dispatched');
    const wrapped = replayRecordedStepCalls(tools(handler), ledgerWith('recorded'), CTX);
    await expect(wrapped[0]!.handler({ title: 'Card: Corvid' } as never, undefined as never))
      .resolves.toBe('dispatched');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a tool with no entry at all', async () => {
    const handler = jest.fn(async () => ['fresh']);
    const wrapped = replayRecordedStepCalls(tools(handler), ledgerWith('recorded'), CTX);
    await expect(wrapped[1]!.handler({ q: 'Card' } as never, undefined as never)).resolves.toEqual(['fresh']);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is argument-order blind, because key order does not change the call', async () => {
    const handler = jest.fn(async () => 'dispatched');
    const wrapped = replayRecordedStepCalls(tools(handler), ledgerWith('recorded'), CTX);
    await expect(wrapped[0]!.handler({ body: CARD.body, title: CARD.title } as never, undefined as never))
      .resolves.toBe('recorded');
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the handler its second argument through untouched', async () => {
    // The SDK hands `extra` to every tool; losing it would break tools that read
    // it while leaving the ones that do not looking fine.
    const handler = jest.fn(async () => 'dispatched');
    const wrapped = replayRecordedStepCalls(tools(handler), ledgerWith('recorded'), CTX);
    await wrapped[0]!.handler({ title: 'other' } as never, { signal: 'x' } as never);
    expect(handler).toHaveBeenCalledWith({ title: 'other' }, { signal: 'x' });
  });

  it('a call that was GATED is dispatched on approve, because it never succeeded', async () => {
    // The safety-critical case. A person approves a call, the run resumes, and the
    // step is re-dispatched. The approved call must still happen — and it does by
    // construction: only a call that SUCCEEDED is in the ledger, and a gated call
    // never dispatched, so it is not there. A replay that answered it would mean a
    // person approved an act that then never took place.
    const handler = jest.fn(async () => 'the approved call ran');
    // The ledger holds the write the step made BEFORE the gate fired.
    const wrapped = replayRecordedStepCalls(tools(handler), ledgerWith('the earlier write'), CTX);
    await expect(wrapped[0]!.handler({ title: 'the gated card' } as never, undefined as never))
      .resolves.toBe('the approved call ran');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps every other field on the tool it wraps', async () => {
    // The list is handed to createSdkMcpServer, which reads more than the name.
    const extra = { name: CREATE, description: 'create', inputSchema: {}, handler: jest.fn() as never };
    const [wrapped] = replayRecordedStepCalls([extra], ledgerWith('recorded'), CTX);
    expect(wrapped).toMatchObject({ name: CREATE, description: 'create', inputSchema: {} });
  });
});
