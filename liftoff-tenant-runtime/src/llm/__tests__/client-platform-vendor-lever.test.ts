// A platform vendor lever this client cannot serve must degrade, not throw.
//
// This plane's LLMClient registers anthropic, openai and google. The six
// gateway families (GLM, Qwen, DeepSeek, Kimi, MiniMax, Xiaomi) are served by
// the agent-execution adapter, not by this client — so a lever on one of them
// is inert HERE while it is live on the control plane, which does hold a gateway
// client.
//
// Inert has to mean inert. The dispatch below ends in
// `if (!client) throw new Error("Provider ... is not available")`, so without a
// check the lever would turn an unset client into a hard failure of every
// platform call in that area — compaction, recall, scanning — from a setting
// nobody would connect to the outage.
//
// Google is the fake here for the reason the refusal-guard suite gives: it is
// the one provider dispatched directly rather than through a purpose pool.

const mockComplete = jest.fn();

jest.mock('../providers', () => ({
  AnthropicProvider: {
    create: jest.fn().mockResolvedValue(null),
    createPool: jest.fn().mockResolvedValue(null),
  },
  GoogleProvider: {
    create: jest.fn().mockResolvedValue({
      provider: 'google',
      complete: (req: unknown) => mockComplete(req),
      countTokens: jest.fn(),
    }),
  },
  OpenAIProvider: { createPool: jest.fn().mockResolvedValue(null) },
}));

import { llmClient } from '../client';
import {
  setPlatformVendorPolicy,
  _resetPlatformVendorPolicy,
} from '../platform-vendor-policy';

const REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }], tier: 'small' as const };

beforeEach(() => {
  mockComplete.mockReset();
  mockComplete.mockResolvedValue({
    content: 'ok',
    model: 'gemini-x',
    provider: 'google',
    stopReason: 'end_turn' as const,
  });
});

afterEach(() => _resetPlatformVendorPolicy());

describe('a lever on a vendor this client cannot serve', () => {
  it('keeps the default provider instead of failing the call', async () => {
    setPlatformVendorPolicy({ quiet_work: 'qwen' });
    const res = await llmClient.complete(REQUEST, undefined, {
      purpose: 'history-compaction',
    });
    expect(res.provider).toBe('google');
  });

  it('does not hand the other vendor\'s model id to the default provider', async () => {
    // The pair coming apart is the sharper half of this. A Qwen model id on a
    // Google call is a vendor error for what is really an unset client, and it
    // would read as a broken provider rather than an inert lever.
    setPlatformVendorPolicy({ quiet_work: 'qwen' });
    await llmClient.complete(REQUEST, undefined, { purpose: 'history-compaction' });
    const sent = mockComplete.mock.calls[0][0] as { model?: string };
    expect(sent.model).toBeUndefined();
  });
});

describe('a lever on a DIRECT provider whose key is unset', () => {
  it('degrades the same way a gateway family does', async () => {
    // The resolver has two branches — gateway families and the three direct
    // providers — and the guard has to cover both. Anthropic resolves here
    // (there is no model to fix, just a provider) and is still unavailable in
    // this environment, so it must fall back rather than throw.
    setPlatformVendorPolicy({ assistants: 'anthropic' });
    const res = await llmClient.complete(REQUEST, undefined, { purpose: 'liftoff_chat' });
    expect(res.provider).toBe('google');
  });
});

describe('the default', () => {
  it('leaves every call where it already went', async () => {
    const res = await llmClient.complete(REQUEST, undefined, {
      purpose: 'history-compaction',
    });
    expect(res.provider).toBe('google');
  });
});
