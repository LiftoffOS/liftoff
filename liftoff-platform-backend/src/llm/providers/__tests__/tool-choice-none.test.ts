// `toolChoice: 'none'` is an intent every loop may state — answer now, call
// nothing — and each adapter honours it the way its vendor takes it. The
// vendors' own docs (read 2026-09-22): Anthropic `{type:"none"}`; Gemini
// FunctionCallingMode NONE; OpenAI, xAI, DeepSeek, Kimi and Qwen `"none"`;
// Z.AI "only auto is supported"; MiniMax's OpenAI-format API documents no
// tool_choice. For the last two the request goes out with no tools and the
// tool history folded into text, which every chat API accepts.

import type OpenAI from 'openai';
import { FunctionCallingMode } from '@google-cloud/vertexai';
import { OpenAIProvider } from '../openai';
import { OpenRouterProvider } from '../openrouter';
import { toAnthropicToolChoice } from '../anthropic-shared';
import { foldToolHistory } from '../../fold-tool-history';
import type { LLMCompletionRequest } from '../../types';

jest.mock('../../../infrastructure/secrets', () => ({ getSecret: jest.fn() }));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../registry-tier-loader', () => ({ startRegistryTierRefresh: jest.fn() }));

function stubClient(create: jest.Mock): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}
function openai(create: jest.Mock): OpenAIProvider {
  const Ctor = OpenAIProvider as unknown as new (client: OpenAI) => OpenAIProvider;
  return new Ctor(stubClient(create));
}
function openrouter(create: jest.Mock): OpenRouterProvider {
  const Ctor = OpenRouterProvider as unknown as new (client: OpenAI, provider: string, tiers: Record<string, string>) => OpenRouterProvider;
  return new Ctor(stubClient(create), 'openrouter', { large: 'z-ai/glm-5', medium: 'z-ai/glm-5', small: 'z-ai/glm-5' });
}

const completion = {
  choices: [{ message: { role: 'assistant', content: 'Here is what I have.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const TOOLS = [{ name: 'dataset_query', description: 'Read rows', input_schema: { type: 'object' as const, properties: { datasetId: { type: 'string' as const } } } }];

const request: LLMCompletionRequest = {
  messages: [
    { role: 'system', content: 'You help.' },
    { role: 'user', content: 'Top posts?' },
    { role: 'assistant', content: 'Reading on.', toolCalls: [{ id: 'call-1', name: 'dataset_query', input: { datasetId: 'ds-1', limit: 20 } }] },
    { role: 'user', content: '', toolResults: [{ toolCallId: 'call-1', content: '{"rows":[1,2]}' }] },
    { role: 'user', content: 'The reading budget for one reply has been used. Write the reply now.' },
  ],
  tools: TOOLS,
  toolChoice: 'none',
  model: 'gpt-5.4',
};

describe('a vendor that takes tool_choice none on the wire', () => {
  it('OpenAI sends the tools and tool_choice "none", with the tool history as tool messages', async () => {
    const create = jest.fn().mockResolvedValue(completion);
    const out = await openai(create).complete(request);
    expect(out.content).toBe('Here is what I have.');
    const body = create.mock.calls[0][0];
    expect(body.tool_choice).toBe('none');
    expect(body.tools).toHaveLength(1);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
  });

  it('OpenRouter does the same for a vendor whose docs offer none (Qwen, DeepSeek, Kimi)', async () => {
    for (const model of ['qwen/qwen3.8-max-0902', 'deepseek/deepseek-v4', 'moonshotai/kimi-k3']) {
      const create = jest.fn().mockResolvedValue(completion);
      await openrouter(create).complete({ ...request, model });
      const body = create.mock.calls[0][0];
      expect(body.tool_choice).toBe('none');
      expect(body.tools).toHaveLength(1);
      expect(body.messages.some((m: { role: string }) => m.role === 'tool')).toBe(true);
    }
  });

  it('Anthropic maps none to { type: "none" }', () => {
    expect(toAnthropicToolChoice('none')).toEqual({ type: 'none' });
  });

  it('Gemini maps none to FunctionCallingMode.NONE', () => {
    // Mirrors toGoogleFunctionCallingConfig, which is not exported.
    const mode = (tc: string) => (tc === 'none' ? FunctionCallingMode.NONE : tc === 'required' ? FunctionCallingMode.ANY : FunctionCallingMode.AUTO);
    expect(mode('none')).toBe('NONE');
  });
});

describe('a vendor that cannot be told none (Z.AI GLM, MiniMax over OpenRouter)', () => {
  it('sends no tools and no tool_choice, and folds the calls and results into the turns that made them', async () => {
    for (const model of ['z-ai/glm-5', 'minimax/minimax-m3']) {
      const create = jest.fn().mockResolvedValue(completion);
      const out = await openrouter(create).complete({ ...request, model });
      expect(out.content).toBe('Here is what I have.');
      const body = create.mock.calls[0][0];
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      const roles = body.messages.map((m: { role: string }) => m.role);
      expect(roles).toEqual(['system', 'user', 'assistant', 'user', 'user']);
      expect(body.messages[2].content).toBe('Reading on.\n\n[Tools called]\ndataset_query({"datasetId":"ds-1","limit":20})');
      expect(body.messages[2].tool_calls).toBeUndefined();
      expect(body.messages[3].content).toBe('[Tool results]\ndataset_query:\n{"rows":[1,2]}');
    }
  });

  it('the same vendors keep their tools on an ordinary turn', async () => {
    const create = jest.fn().mockResolvedValue(completion);
    await openrouter(create).complete({ ...request, model: 'z-ai/glm-5', toolChoice: 'auto' });
    const body = create.mock.calls[0][0];
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });

  it('the streamed call is shaped the same way', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'Here' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }
    const create = jest.fn().mockResolvedValue(chunks());
    const events = [];
    for await (const e of openrouter(create).completeStream({ ...request, model: 'z-ai/glm-5' })) events.push(e);
    const body = create.mock.calls[0][0];
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.messages.some((m: { role: string }) => m.role === 'tool')).toBe(false);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });
});

describe('foldToolHistory', () => {
  it('leaves a conversation without tool fields as it is, and drops the request-level tool fields', () => {
    const plain: LLMCompletionRequest = { messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, toolChoice: 'none', serverTools: [{ name: 'web_search' }] };
    const folded = foldToolHistory(plain);
    expect(folded.messages).toEqual(plain.messages);
    expect(folded.tools).toBeUndefined();
    expect(folded.toolChoice).toBeUndefined();
    expect(folded.serverTools).toBeUndefined();
  });

  it('names a result by the call that produced it, and shortens long arguments', () => {
    const folded = foldToolHistory({
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_capability', input: { args: { q: 'x'.repeat(1000) } } }] },
        { role: 'user', content: 'and one more thing', toolResults: [{ toolCallId: 'c1', content: 'kept as dataset …' }, { toolCallId: 'c9', content: 'orphan' }] },
      ],
    });
    expect(folded.messages[0].content).toMatch(/^\[Tools called\]\nrun_capability\(\{"args":\{"q":"x{300,}…\)$/);
    expect(folded.messages[1].content).toBe('[Tool results]\nrun_capability:\nkept as dataset …\n\nc9:\norphan\n\nand one more thing');
  });
});
