// responseSchema is a CONTRACT on LLMCompletionRequest, not an Anthropic
// feature.
//
// It was declared on the shared request type but implemented only by the two
// Anthropic providers; google.ts and openai.ts ignored the field silently and
// returned ordinary prose. The one live caller — learning/chat-feedback-
// extractor.ts — does JSON.parse(response.content) and resolves its provider
// from getModelForTask('chat-feedback-extraction'), so the moment that task was
// pointed at Gemini or OpenAI the parse threw and the whole extraction batch
// died. This suite is the guard: a provider added without responseSchema
// support fails here instead of in production.

const anthropicCreate = jest.fn();
const openaiCreate = jest.fn();
const googleGenerate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: class { messages = { create: (...a: unknown[]) => anthropicCreate(...a) }; },
}));
jest.mock('openai', () => ({
  __esModule: true,
  default: class { chat = { completions: { create: (...a: unknown[]) => openaiCreate(...a) } }; },
}));
jest.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: (...a: unknown[]) => googleGenerate(...a) }; },
  FunctionCallingConfigMode: { ANY: 'ANY' },
}));
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: jest.fn(async () => 'test-key'),
  getOpenAIApiKeyForGroup: jest.fn(async () => 'test-key'),
  getAnthropicApiKey: jest.fn(async () => 'test-key'),
  getAnthropicApiKeyForGroup: jest.fn(async () => 'test-key'),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { LLMStructuredOutputError } from '../../types';
import type { LLMCompletionRequest } from '../../types';

const SCHEMA = {
  name: 'extraction_result',
  description: 'Structured learnings',
  schema: {
    type: 'object' as const,
    properties: { learnings: { type: 'array' } },
    required: ['learnings'],
  },
};

const REQUEST: LLMCompletionRequest = {
  messages: [{ role: 'user', content: 'extract' }],
  responseSchema: SCHEMA,
};

const PAYLOAD = { learnings: [{ kind: 'preference', text: 'prefers bullet points' }] };

beforeEach(() => jest.clearAllMocks());

/** Each provider, with a transport primed to return the forced call, and a
 *  transport primed to return NO call at all. */
const providers: Array<{
  name: string;
  make: () => Promise<{ complete: (r: LLMCompletionRequest) => Promise<{ content: string }> }>;
  primeSuccess: () => void;
  primeNoStructuredOutput: () => void;
}> = [
  {
    name: 'anthropic',
    make: async () => {
      const { AnthropicProvider } = await import('../anthropic');
      const p = await AnthropicProvider.create();
      if (!p) throw new Error('AnthropicProvider.create() returned null');
      return p as never;
    },
    primeSuccess: () => anthropicCreate.mockResolvedValue({
      content: [{ type: 'tool_use', name: SCHEMA.name, input: PAYLOAD }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    primeNoStructuredOutput: () => anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'here are the learnings...' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: 'openai',
    make: async () => {
      const { OpenAIProvider } = await import('../openai');
      const p = await OpenAIProvider.create();
      if (!p) throw new Error('OpenAIProvider.create() returned null');
      return p as never;
    },
    primeSuccess: () => openaiCreate.mockResolvedValue({
      model: 'gpt-x',
      choices: [{ message: { tool_calls: [{ id: '1', type: 'function', function: { name: SCHEMA.name, arguments: JSON.stringify(PAYLOAD) } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    primeNoStructuredOutput: () => openaiCreate.mockResolvedValue({
      model: 'gpt-x',
      choices: [{ message: { content: 'here are the learnings...' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  },
  {
    name: 'google',
    make: async () => {
      process.env.GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || 'test-project';
      const { GoogleProvider } = await import('../google');
      const p = await GoogleProvider.create();
      if (!p) throw new Error('GoogleProvider.create() returned null');
      return p as never;
    },
    primeSuccess: () => googleGenerate.mockResolvedValue({
      candidates: [{ content: { parts: [{ functionCall: { name: SCHEMA.name, args: PAYLOAD } }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    primeNoStructuredOutput: () => googleGenerate.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'here are the learnings...' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
  },
];

describe.each(providers)('responseSchema contract — $name', ({ make, primeSuccess, primeNoStructuredOutput }) => {
  it('returns content that JSON.parses to the schema payload', async () => {
    primeSuccess();
    const provider = await make();
    const response = await provider.complete(REQUEST);
    // This is exactly what chat-feedback-extractor does with the result.
    expect(JSON.parse(response.content)).toEqual(PAYLOAD);
  });

  it('throws LLMStructuredOutputError when the model produced no structured output', async () => {
    // Previously this returned prose and the CALLER's JSON.parse blew up with a
    // generic message, indistinguishable from genuinely malformed JSON.
    primeNoStructuredOutput();
    const provider = await make();
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LLMStructuredOutputError);
  });
});
