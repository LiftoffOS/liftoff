// F-1 feature-equivalence — OpenAI adapter parallel to translateSDKMessage.test.ts.
//
// Same 6 canonical scenarios asserted against the OpenAI adapter's
// translation + hook layers. The pair of files together verifies that the
// platform contract behaves identically across vendors — the "no
// Anthropic-shaped abstractions" guarantee from the F-1 spec.

jest.mock('@openai/agents', () => ({
  run: jest.fn(),
  Agent: class MockAgent {
    constructor(public opts: unknown) {}
  },
}));

import { OpenAiWireAdapter } from '../openai-wire';
import { openAiTarget } from '../openai';
import type { McpToolCatalog } from '../catalog-types';
import type { InvocationInput, UserMessage } from '../types';

function makeCatalog(): McpToolCatalog {
  return { servers: [], tools: [] };
}

function makeInput(overrides: Partial<InvocationInput> = {}): InvocationInput {
  return {
    messages: [],
    systemPrompt: 'system',
    model: 'gpt-5-codex',
    provider: 'openai',
    tenantId: 't1',
    invocationId: 'inv1',
    maxTurns: 5,
    ...overrides,
  };
}

describe('F-1 — OpenAI adapter translation contract', () => {
  // ── Scenario 6: same logical translation behavior as Anthropic ────────
  // RunItem class instances use `_item`-suffixed discriminators and carry the
  // protocol payload on `rawItem` (NOT the item's top level). The previous
  // fixture used a bare `{ type: 'message_output', content }` shape that only
  // ever matched the broken matcher — it's the exact shape that masked the bug.
  // Real-class-instance coverage lives in openai/__tests__/run-item-translation.test.ts.
  describe('Scenario 6: RunItem → InvocationEvent translation', () => {
    it('translates a message_output_item (rawItem.content) into an assistant_message event', () => {
      const adapter = new OpenAiWireAdapter({ target: openAiTarget });
      adapter.registerToolCatalog(makeCatalog());
      const events = (adapter as unknown as {
        translateRunItem(item: unknown): Array<{ type: string; [k: string]: unknown }>;
      }).translateRunItem({
        type: 'message_output_item',
        rawItem: { content: [{ type: 'output_text', text: 'hi from openai' }] },
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'assistant_message', content: [{ type: 'text', text: 'hi from openai' }] }),
      ]));
    });
  });

  // ── Scenario 1: HITL gate via inputGuardrail ──────────────────────────
  describe('Scenario 1: HITL gate flows through inputGuardrail tripwire', () => {
    it('inputGuardrail trips when hitlGate denies', async () => {
      const adapter = new OpenAiWireAdapter({ target: openAiTarget });
      adapter.registerToolCatalog(makeCatalog());
      adapter.registerHitlGate(async () => ({ allow: false, reason: 'awaiting approval' }));
      const guardrails = (adapter as unknown as {
        makeInputGuardrails(input: InvocationInput): Array<{
          execute(args: { input: unknown; context: unknown }): Promise<{
            tripwireTriggered: boolean;
            outputInfo: { reason: string };
          }>;
        }>;
      }).makeInputGuardrails(makeInput());
      expect(guardrails).toHaveLength(1);
      const verdict = await guardrails[0].execute({ input: { x: 1 }, context: {} });
      expect(verdict.tripwireTriggered).toBe(true);
      expect(verdict.outputInfo.reason).toBe('awaiting approval');
    });

    it('inputGuardrail returns [] when no hitlGate is registered', () => {
      const adapter = new OpenAiWireAdapter({ target: openAiTarget });
      adapter.registerToolCatalog(makeCatalog());
      const guardrails = (adapter as unknown as {
        makeInputGuardrails(input: InvocationInput): unknown[];
      }).makeInputGuardrails(makeInput());
      expect(guardrails).toEqual([]);
    });
  });

  // ── Scenario 3: pause / resume contract ───────────────────────────────
  describe('Scenario 3: pause / resume contract', () => {
    it('pause() returns an adapter-tagged ResumeToken serializing the InvocationInput', async () => {
      const adapter = new OpenAiWireAdapter({ target: openAiTarget });
      adapter.registerToolCatalog(makeCatalog());
      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput({ invocationId: 'inv-xyz' });
      const token = await adapter.pause('hitl_gate');
      expect(token.adapterKind).toBe('openai');
      const decoded = JSON.parse(token.serialized) as { reason: string; input: InvocationInput };
      expect(decoded.reason).toBe('hitl_gate');
      expect(decoded.input.invocationId).toBe('inv-xyz');
    });

    it('resume() rebuilds InvocationInput with the user response appended', async () => {
      const adapter = new OpenAiWireAdapter({ target: openAiTarget });
      adapter.registerToolCatalog(makeCatalog());
      const invokeCalls: InvocationInput[] = [];
      (adapter as unknown as { invoke: (i: InvocationInput) => AsyncIterable<unknown> }).invoke = async function* (i: InvocationInput) {
        invokeCalls.push(i);
        yield { type: 'completion', outcome: 'success' };
      };

      (adapter as unknown as { currentInvocation: InvocationInput }).currentInvocation = makeInput();
      const token = await adapter.pause('hitl_gate');

      const collected = [];
      for await (const e of adapter.resume(token, { text: 'approved' }, new AbortController().signal)) {
        collected.push(e);
      }
      const replayed = invokeCalls[0];
      expect(replayed.messages[replayed.messages.length - 1]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'approved' }],
      });
    });
  });

  // ── Scenario 4: mid-execution user message lands in inject queue ─────
  describe('Scenario 4: injectMessage queues the user message for next turn', () => {
    it('appends to the injected[] buffer that the loop drains between run() calls', async () => {
      const adapter = new OpenAiWireAdapter({ target: openAiTarget });
      adapter.registerToolCatalog(makeCatalog());
      await adapter.injectMessage({ text: 'switch tasks' });
      const injected = (adapter as unknown as { injected: UserMessage[] }).injected;
      expect(injected).toHaveLength(1);
      expect(injected[0].text).toBe('switch tasks');
    });
  });
});
