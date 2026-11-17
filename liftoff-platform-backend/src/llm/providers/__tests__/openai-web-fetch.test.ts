/**
 * OpenAI provider web-fetch wiring tests.
 *
 * OpenAI bundles search and URL reading under `web_search_options`. The
 * provider must:
 *   - enable web_search_options when serverTools includes web_search OR web_fetch
 *   - set webFetchRequests: undefined in returned usage (can't split)
 */

// Mock the secrets module so OpenAIProvider.create() works without ADC.
jest.mock('../../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
  getOpenAIApiKeyForGroup: jest.fn().mockResolvedValue('test-key'),
}));

import { OpenAIProvider } from '../openai';

describe('OpenAI provider — wantsWebCapabilities detection', () => {
  let provider: OpenAIProvider;
  let createSpy: jest.SpyInstance;

  beforeEach(async () => {
    provider = (await OpenAIProvider.create())!;
    // Replace the underlying OpenAI client's chat.completions.create with a stub.
    const fakeResponse = {
      model: 'gpt-test',
      choices: [{
        message: { content: 'ok', tool_calls: null },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    createSpy = jest
      .spyOn((provider as any).client.chat.completions, 'create')
      .mockResolvedValue(fakeResponse);
  });

  it('enables web_search_options when serverTools contains web_search', async () => {
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      serverTools: [{ name: 'web_search' }],
    });
    const args = createSpy.mock.calls[0][0];
    expect(args.web_search_options).toEqual({ search_context_size: 'medium' });
  });

  it('enables web_search_options when serverTools contains web_fetch', async () => {
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      serverTools: [{ name: 'web_fetch' }],
    });
    const args = createSpy.mock.calls[0][0];
    expect(args.web_search_options).toEqual({ search_context_size: 'medium' });
  });

  it('does NOT enable web_search_options when neither is requested', async () => {
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    const args = createSpy.mock.calls[0][0];
    expect(args.web_search_options).toBeUndefined();
  });

  it('returns webFetchRequests: undefined (OpenAI bundles search+fetch)', async () => {
    const res = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      serverTools: [{ name: 'web_fetch' }],
    });
    expect(res.usage?.webFetchRequests).toBeUndefined();
  });
});
