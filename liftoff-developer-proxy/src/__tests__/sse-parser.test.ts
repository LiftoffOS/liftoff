// SSE structural-diff harness — Phase 1.5f verification gate.
// Each fixture is replayed through AnthropicAdapter.parseSseDataLine +
// accumulateUsage and asserted against expected token counts.
// No DB or network required.

import { AnthropicAdapter } from '../vendor/anthropic.js';
import type { TokenUsage, VendorConfig } from '../vendor/adapter.js';
import {
  ALL_FIXTURES,
  type SseFixture,
  TOOL_USE,
  PARALLEL_TOOLS,
  MALFORMED_DATA_LINE,
  ZERO_USAGE_RESPONSE,
  THINKING_BLOCKS,
  UNKNOWN_EVENT_TYPE,
  RESPONSES_API_FORMAT,
} from './fixtures/sse-streams.js';

const adapter = new AnthropicAdapter();

// Minimal VendorConfig for computeCost tests
const MOCK_VENDOR_CONFIG: VendorConfig = {
  vendor: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  allowedModels: ['claude-sonnet-4-6'],
  pricing: {
    'claude-sonnet-4-6': {
      inMicros:        3_000_000,
      outMicros:       15_000_000,
      cacheReadMicros:  300_000,
      cacheWriteMicros: 3_750_000,
    },
  },
};

function parseStream(rawSse: string, model: string): TokenUsage {
  let usage: TokenUsage = {
    requestId: '',
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  const buffer = rawSse;
  // Simulate chunked delivery: feed the stream line by line
  const lines = buffer.split('\n');
  let remaining = '';

  for (const line of lines) {
    const full = remaining + line;
    remaining = '';

    if (!full.startsWith('data: ')) continue;
    const rawData = full.slice(6).trim();
    const event = adapter.parseSseDataLine(rawData);
    if (event) usage = adapter.accumulateUsage(usage, event);
  }

  return usage;
}

function extractContent(rawSse: string): string {
  let content = '';
  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const obj = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (obj.type === 'content_block_delta') {
        const delta = (obj.delta as Record<string, unknown> | undefined);
        if (delta?.type === 'text_delta') content += (delta.text as string) ?? '';
      }
    } catch {
      // ignore
    }
  }
  return content;
}

describe.each(ALL_FIXTURES.map(f => [f.name, f] as [string, SseFixture]))(
  'SSE structural-diff: %s',
  (_name, fixture) => {
    let usage: TokenUsage;
    let content: string;

    beforeAll(() => {
      usage   = parseStream(fixture.rawSse, fixture.model);
      content = extractContent(fixture.rawSse);
    });

    test('request_id extracted', () => {
      expect(usage.requestId).toBe(fixture.expected.requestId);
    });

    test('input tokens', () => {
      expect(usage.inputTokens).toBe(fixture.expected.inputTokens);
    });

    test('output tokens', () => {
      expect(usage.outputTokens).toBe(fixture.expected.outputTokens);
    });

    test('cached input tokens', () => {
      expect(usage.cachedInputTokens).toBe(fixture.expected.cachedInputTokens);
    });

    test('cache creation tokens', () => {
      expect(usage.cacheCreationInputTokens).toBe(fixture.expected.cacheCreationInputTokens);
    });

    test('content delta length', () => {
      expect(content.length).toBe(fixture.expected.contentLength);
    });
  },
);

// ---------------------------------------------------------------------------
// Split-chunk buffering: adapter must handle partial lines across chunks
// ---------------------------------------------------------------------------

test('parser handles partial SSE line split across two chunks', () => {
  const half1 = 'data: {"type":"message_start","message":{"id":"msg_split","type":"message","role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":7,';
  const half2 = '"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n';

  // The adapter's parseSseDataLine processes a complete data line.
  // This test verifies the handler's own buffer logic (simulated here).
  let buffer = '';
  let finalUsage: TokenUsage = {
    requestId: '', model: 'claude-sonnet-4-6',
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0,
  };

  for (const chunk of [half1, half2]) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const event = adapter.parseSseDataLine(line.slice(6).trim());
      if (event) finalUsage = adapter.accumulateUsage(finalUsage, event);
    }
  }

  expect(finalUsage.requestId).toBe('msg_split');
  expect(finalUsage.inputTokens).toBe(7);
});

// ---------------------------------------------------------------------------
// TOOL_USE: parseSseDataLine returns expected event types
// ---------------------------------------------------------------------------

describe('TOOL_USE: event type assertions', () => {
  test('content_block_start contains tool_use type in content_block', () => {
    const events: Array<{ type: string; data: unknown }> = [];
    for (const line of TOOL_USE.rawSse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = adapter.parseSseDataLine(line.slice(6).trim());
      if (event) events.push(event);
    }

    const blockStart = events.find(e => e.type === 'content_block_start');
    expect(blockStart).toBeDefined();
    const blockData = blockStart!.data as Record<string, unknown>;
    const contentBlock = blockData.content_block as Record<string, unknown>;
    expect(contentBlock.type).toBe('tool_use');

    const blockDeltas = events.filter(e => e.type === 'content_block_delta');
    expect(blockDeltas.length).toBeGreaterThan(0);

    const blockStop = events.find(e => e.type === 'content_block_stop');
    expect(blockStop).toBeDefined();
  });

  test('stop_reason is tool_use in message_delta', () => {
    for (const line of TOOL_USE.rawSse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = adapter.parseSseDataLine(line.slice(6).trim());
      if (event?.type === 'message_delta') {
        const data = event.data as Record<string, unknown>;
        const delta = data.delta as Record<string, unknown>;
        expect(delta.stop_reason).toBe('tool_use');
        return;
      }
    }
    fail('No message_delta event found');
  });
});

// ---------------------------------------------------------------------------
// PARALLEL_TOOLS: two separate tool block sequences captured
// ---------------------------------------------------------------------------

describe('PARALLEL_TOOLS: two tool block sequences', () => {
  test('two content_block_start events with tool_use type at indices 0 and 1', () => {
    const blockStarts: Array<Record<string, unknown>> = [];
    for (const line of PARALLEL_TOOLS.rawSse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = adapter.parseSseDataLine(line.slice(6).trim());
      if (event?.type === 'content_block_start') {
        const data = event.data as Record<string, unknown>;
        const cb = data.content_block as Record<string, unknown>;
        if (cb.type === 'tool_use') blockStarts.push(data);
      }
    }
    expect(blockStarts.length).toBe(2);
    expect((blockStarts[0]).index).toBe(0);
    expect((blockStarts[1]).index).toBe(1);
  });

  test('tool names are captured in correct order', () => {
    const toolNames: string[] = [];
    for (const line of PARALLEL_TOOLS.rawSse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = adapter.parseSseDataLine(line.slice(6).trim());
      if (event?.type === 'content_block_start') {
        const data = event.data as Record<string, unknown>;
        const cb = data.content_block as Record<string, unknown>;
        if (cb.type === 'tool_use') toolNames.push(cb.name as string);
      }
    }
    expect(toolNames).toEqual(['search_web', 'read_file']);
  });
});

// ---------------------------------------------------------------------------
// THINKING_BLOCKS: thinking tokens count as output, not separate
// ---------------------------------------------------------------------------

describe('THINKING_BLOCKS: token accounting', () => {
  test('thinking_delta events are present but thinking text not counted in contentLength', () => {
    let hasThinkingDelta = false;
    let contentLength = 0;

    for (const line of THINKING_BLOCKS.rawSse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const obj = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (obj.type === 'content_block_delta') {
          const delta = obj.delta as Record<string, unknown>;
          if (delta?.type === 'thinking_delta') hasThinkingDelta = true;
          if (delta?.type === 'text_delta') contentLength += ((delta.text as string) ?? '').length;
        }
      } catch { /* skip */ }
    }

    expect(hasThinkingDelta).toBe(true);
    expect(contentLength).toBe(THINKING_BLOCKS.expected.contentLength);
  });

  test('output tokens include thinking tokens (from message_delta)', () => {
    const usage = parseStream(THINKING_BLOCKS.rawSse, THINKING_BLOCKS.model);
    expect(usage.outputTokens).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// MALFORMED_DATA_LINE: parseSseDataLine returns null, does not throw
// ---------------------------------------------------------------------------

describe('MALFORMED_DATA_LINE: resilience', () => {
  test('parseSseDataLine returns null for malformed JSON, does not throw', () => {
    expect(() => {
      const result = adapter.parseSseDataLine('{bad json here!!!}');
      expect(result).toBeNull();
    }).not.toThrow();
  });

  test('stream continues processing after malformed line', () => {
    const usage = parseStream(MALFORMED_DATA_LINE.rawSse, MALFORMED_DATA_LINE.model);
    expect(usage.requestId).toBe('msg_17WXY');
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN_EVENT_TYPE: adapter skips gracefully
// ---------------------------------------------------------------------------

describe('UNKNOWN_EVENT_TYPE: skips ping and other unknowns', () => {
  test('ping event parsed without error and does not affect usage', () => {
    const pingEvent = adapter.parseSseDataLine('{"type":"ping"}');
    // parseSseDataLine returns the event (it parsed valid JSON); accumulateUsage ignores it
    expect(pingEvent).not.toBeNull();
    expect(pingEvent!.type).toBe('ping');

    const initialUsage: TokenUsage = {
      requestId: 'test', model: 'claude-sonnet-4-6',
      inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, cacheCreationInputTokens: 0,
    };
    const afterPing = adapter.accumulateUsage(initialUsage, pingEvent!);
    expect(afterPing).toEqual(initialUsage); // unchanged
  });

  test('full stream with ping event produces correct token counts', () => {
    const usage = parseStream(UNKNOWN_EVENT_TYPE.rawSse, UNKNOWN_EVENT_TYPE.model);
    expect(usage.inputTokens).toBe(9);
    expect(usage.outputTokens).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ZERO_USAGE_RESPONSE: computeCost returns 0n, does not throw
// ---------------------------------------------------------------------------

describe('ZERO_USAGE_RESPONSE: cost computation edge case', () => {
  test('computeCost returns 0n for zero input and output tokens', () => {
    const usage = parseStream(ZERO_USAGE_RESPONSE.rawSse, ZERO_USAGE_RESPONSE.model);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);

    expect(() => {
      const cost = adapter.computeCost(usage, MOCK_VENDOR_CONFIG);
      expect(cost).toBe(0n);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RESPONSES_API_FORMAT: adapter handles gracefully without panic
// ---------------------------------------------------------------------------

describe('RESPONSES_API_FORMAT: unknown event types skipped gracefully', () => {
  test('all Responses API event types parse without throwing', () => {
    const responsesApiLines = [
      '{"type":"response.created","response":{"id":"resp_20FGH","model":"claude-sonnet-4-6"}}',
      '{"type":"response.output_text.delta","delta":"Hello"}',
      '{"type":"response.completed","response":{"id":"resp_20FGH"}}',
    ];
    for (const line of responsesApiLines) {
      expect(() => adapter.parseSseDataLine(line)).not.toThrow();
    }
  });

  test('Responses API stream produces zero usage (no message_start/delta events)', () => {
    const usage = parseStream(RESPONSES_API_FORMAT.rawSse, RESPONSES_API_FORMAT.model);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.requestId).toBe('');
  });
});
