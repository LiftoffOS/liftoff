// Part 2 — Live ground-truth test for the OpenAI tiktoken estimate.
//
// Skipped by default. Run with:
//   LIVE_TESTS=true OPENAI_API_KEY=sk-... npx jest count-tokens.live
//
// The estimate is computed locally via tiktoken; without a ground-truth
// comparison the estimate can silently drift as OpenAI updates internal
// counting rules. Drift > 5% triggers a tuning PR on MODEL_TO_ENCODER or
// per-message overhead constants.

import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAIProvider } from '../providers/openai';

const live = process.env.LIVE_TESTS === 'true';
const describeLive = live ? describe : describe.skip;

interface FixtureMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }

function makeProvider(client: OpenAI): OpenAIProvider {
  return new (OpenAIProvider as unknown as new (c: OpenAI) => OpenAIProvider)(client);
}

function loadFixture(): { messages: FixtureMessage[] } {
  const p = path.join(__dirname, 'fixtures', '50k-conversation.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as { messages: FixtureMessage[] };
}

function toOpenAIMessages(messages: FixtureMessage[]): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return messages
    .filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }));
}

describeLive('OpenAI tokenizer ground truth (LIVE_TESTS=true)', () => {
  // The real OpenAI Chat Completions call can take several seconds.
  jest.setTimeout(60_000);

  it('tiktoken estimate is within ±5% of real prompt_tokens', async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for LIVE_TESTS');
    const openai = new OpenAI({ apiKey });
    const provider = makeProvider(openai);

    const fixture = loadFixture();
    const estimated = await provider.countTokens({
      messages: fixture.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      model: 'gpt-4o-mini',
    });
    // Cheapest possible real call: max_tokens=1 returns usage without
    // meaningful generation. We only need response.usage.prompt_tokens.
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: toOpenAIMessages(fixture.messages),
      max_tokens: 1,
    });
    const actual = response.usage!.prompt_tokens;
    const drift = Math.abs(estimated.inputTokens - actual) / actual;
    // eslint-disable-next-line no-console
    console.log({ msg: 'openai tokenizer drift', estimated: estimated.inputTokens, actual, drift });
    expect(drift).toBeLessThan(0.05);
  });
});
