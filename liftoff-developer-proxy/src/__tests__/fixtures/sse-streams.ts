// SSE fixture library — captured Anthropic stream shapes for structural-diff testing.
// Each fixture includes: raw SSE bytes, expected token counts, expected cost (bigint micros).

export interface SseFixture {
  name: string;
  model: string;
  rawSse: string;           // raw SSE bytes as they arrive from Anthropic
  expected: {
    requestId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    contentLength: number;  // total chars in concatenated text deltas
  };
}

// Helper: build a minimal valid SSE stream
function sseStream(events: Array<{ type: string; data: unknown }>): string {
  return events
    .map(e => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('') + 'data: [DONE]\n\n';
}

// ── Fixture 1: Plain completion (non-streaming baseline) ──────────────────────
export const PLAIN_COMPLETION: SseFixture = {
  name:  'plain-completion',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id:    'msg_01ABC',
          type:  'message',
          role:  'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, ' } },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
    },
    {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    },
    {
      type: 'message_stop',
      data: { type: 'message_stop' },
    },
  ]),
  expected: {
    requestId:               'msg_01ABC',
    inputTokens:             10,
    outputTokens:            4,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           13, // 'Hello, world!'
  },
};

// ── Fixture 2: Cached prompt ───────────────────────────────────────────────────
export const CACHED_PROMPT: SseFixture = {
  name:  'cached-prompt',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id:    'msg_02DEF',
          type:  'message',
          role:  'assistant',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 5,
            output_tokens: 0,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 0,
          },
        },
      },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cached response.' } },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_02DEF',
    inputTokens:             5,
    outputTokens:            3,
    cachedInputTokens:       500,
    cacheCreationInputTokens: 0,
    contentLength:           16,
  },
};

// ── Fixture 3: Cache creation ─────────────────────────────────────────────────
export const CACHE_WRITE: SseFixture = {
  name:  'cache-write',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id:    'msg_03GHI',
          type:  'message',
          role:  'assistant',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 20,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1000,
          },
        },
      },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'New.' } },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_03GHI',
    inputTokens:             20,
    outputTokens:            2,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 1000,
    contentLength:           4,
  },
};

// ── Fixture 4: Mid-stream upstream error ──────────────────────────────────────
export const MID_STREAM_ERROR: SseFixture = {
  name:  'mid-stream-error',
  model: 'claude-sonnet-4-6',
  // Stream starts normally then ends abruptly without message_stop
  rawSse: [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_04JKL","type":"message","role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":8,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Part"}}\n\n',
    // Abrupt end — simulates upstream 500 after first event
  ].join(''),
  expected: {
    requestId:               'msg_04JKL',
    inputTokens:             8,
    outputTokens:            0,   // message_delta never arrived
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           4,
  },
};

// ── Fixture 5: Opus 4 — different pricing ────────────────────────────────────
export const OPUS_COMPLETION: SseFixture = {
  name:  'opus-completion',
  model: 'claude-opus-4',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_05MNO', type: 'message', role: 'assistant', model: 'claude-opus-4',
          usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Opus reply.' } },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_05MNO',
    inputTokens:             100,
    outputTokens:            50,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           11,
  },
};

// ── Fixture 6: Chunk split across TCP segments (partial SSE lines) ────────────
// Simulates the case where 'data: ' and the JSON arrive in separate read() calls.
// The parser must buffer correctly.
export const SPLIT_CHUNK: SseFixture = {
  name:  'split-chunk',
  model: 'claude-haiku-4-5',
  // Raw SSE split mid-line — parser buffer must rejoin
  rawSse: [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_06PQR","type":"message","role":"assistant","model":"claude-haiku-4-5",',
    '"usage":{"input_tokens":3,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
    'data: [DONE]\n\n',
  ].join(''),
  expected: {
    requestId:               'msg_06PQR',
    inputTokens:             3,
    outputTokens:            1,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           2,
  },
};

// ── Fixture 7: Model with date suffix ────────────────────────────────────────
export const DATE_SUFFIX_MODEL: SseFixture = {
  name:  'date-suffix-model',
  model: 'claude-sonnet-4-6-20251022',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_07STU', type: 'message', role: 'assistant',
          model: 'claude-sonnet-4-6-20251022',
          usage: { input_tokens: 15, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_07STU',
    inputTokens:             15,
    outputTokens:            7,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           0,
  },
};

// ── Fixture 8: Tool use — single tool call ────────────────────────────────────
export const TOOL_USE: SseFixture = {
  name:  'tool-use',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_08VWX', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 25, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01A', name: 'get_weather' },
      },
    },
    {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"location":' },
      },
    },
    {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"San Francisco"}' },
      },
    },
    {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_08VWX',
    inputTokens:             25,
    outputTokens:            12,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           0, // tool_use blocks have no text_delta content
  },
};

// ── Fixture 9: Parallel tools — two simultaneous tool calls ──────────────────
export const PARALLEL_TOOLS: SseFixture = {
  name:  'parallel-tools',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_09YZA', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 40, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    // First tool block
    {
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01B', name: 'search_web' },
      },
    },
    {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"TypeScript"}' },
      },
    },
    {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    // Second tool block
    {
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01C', name: 'read_file' },
      },
    },
    {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp/file.txt"}' },
      },
    },
    {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_09YZA',
    inputTokens:             40,
    outputTokens:            20,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           0,
  },
};

// ── Fixture 10: Thinking blocks ───────────────────────────────────────────────
// Extended thinking: thinking block followed by text block.
// Thinking tokens are NOT separately tracked — they count as output tokens.
export const THINKING_BLOCKS: SseFixture = {
  name:  'thinking-blocks',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_10BCD', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 30, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    // Thinking block
    {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    },
    {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me reason through this step by step.' },
      },
    },
    {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    // Text block
    {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    },
    {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'The answer is 42.' },
      },
    },
    {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: 1 },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 55 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_10BCD',
    inputTokens:             30,
    outputTokens:            55, // thinking tokens count as output
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           17, // only text_delta content: 'The answer is 42.'
  },
};

// ── Fixture 11: Truncated response — stop_reason=max_tokens ──────────────────
export const TRUNCATED_RESPONSE: SseFixture = {
  name:  'truncated-response',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_11EFG', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'This is a very long response that got cut off mid-sentence because the model hit the maximum token limit for this request and could not finish.' },
      },
    },
    {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_11EFG',
    inputTokens:             50,
    outputTokens:            4096,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           143,
  },
};

// ── Fixture 12: Empty stream — no output tokens ───────────────────────────────
// message_start then immediate message_stop with 0 output tokens
export const EMPTY_STREAM: SseFixture = {
  name:  'empty-stream',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_12HIJ', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_12HIJ',
    inputTokens:             5,
    outputTokens:            0,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           0,
  },
};

// ── Fixture 13: Large input — 200k context window ─────────────────────────────
export const LARGE_INPUT: SseFixture = {
  name:  'large-input',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_13KLM', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 200000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Summary of the massive document.' } },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1000 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_13KLM',
    inputTokens:             200000,
    outputTokens:            1000,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           32,
  },
};

// ── Fixture 14: Multi-turn continuation — cache_read from prior turns ─────────
export const MULTI_TURN_CONTINUATION: SseFixture = {
  name:  'multi-turn-continuation',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_14NOP', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 12,
            output_tokens: 0,
            cache_read_input_tokens: 8500,
            cache_creation_input_tokens: 0,
          },
        },
      },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Continuing our conversation.' } },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_14NOP',
    inputTokens:             12,
    outputTokens:            6,
    cachedInputTokens:       8500,
    cacheCreationInputTokens: 0,
    contentLength:           28,
  },
};

// ── Fixture 15: Haiku — different pricing tier ────────────────────────────────
export const HAIKU_COMPLETION: SseFixture = {
  name:  'haiku-completion',
  model: 'claude-haiku-4-5',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_15QRS', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
          usage: { input_tokens: 60, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fast haiku response.' } },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_15QRS',
    inputTokens:             60,
    outputTokens:            8,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           20,
  },
};

// ── Fixture 16: Fast stream — 50 single-character deltas ─────────────────────
export const FAST_STREAM: SseFixture = {
  name:  'fast-stream',
  model: 'claude-sonnet-4-6',
  rawSse: (() => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX';
    const events: Array<{ type: string; data: unknown }> = [
      {
        type: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'msg_16TUV', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
            usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      },
      { type: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    ];

    for (let i = 0; i < 50; i++) {
      events.push({
        type: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chars[i] } },
      });
    }

    events.push(
      { type: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } } },
      { type: 'message_stop', data: { type: 'message_stop' } },
    );

    return sseStream(events);
  })(),
  expected: {
    requestId:               'msg_16TUV',
    inputTokens:             10,
    outputTokens:            50,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           50, // 50 single-character deltas
  },
};

// ── Fixture 17: Malformed data line ──────────────────────────────────────────
// Contains one line with invalid JSON; parseSseDataLine must return null, not throw.
export const MALFORMED_DATA_LINE: SseFixture = {
  name:  'malformed-data-line',
  model: 'claude-sonnet-4-6',
  rawSse: [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_17WXY","type":"message","role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
    'event: content_block_delta\n',
    'data: {bad json here!!!}\n\n', // malformed — should be skipped silently
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Valid."}}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
    'data: [DONE]\n\n',
  ].join(''),
  expected: {
    requestId:               'msg_17WXY',
    inputTokens:             7,
    outputTokens:            2,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           6, // only 'Valid.' — malformed line skipped
  },
};

// ── Fixture 18: Unknown event type ────────────────────────────────────────────
// SSE event type not recognized by adapter (e.g. "ping") — should be skipped.
export const UNKNOWN_EVENT_TYPE: SseFixture = {
  name:  'unknown-event-type',
  model: 'claude-sonnet-4-6',
  rawSse: [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_18ZAB","type":"message","role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":9,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
    'event: ping\n',
    'data: {"type":"ping"}\n\n', // unknown type — adapter returns event with type='ping' but accumulateUsage ignores it
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Pong."}}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
    'data: [DONE]\n\n',
  ].join(''),
  expected: {
    requestId:               'msg_18ZAB',
    inputTokens:             9,
    outputTokens:            3,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           5, // 'Pong.'
  },
};

// ── Fixture 19: Zero usage — edge case for cost computation ──────────────────
// 0 input and 0 output tokens — computeCost must return 0n, not throw.
export const ZERO_USAGE_RESPONSE: SseFixture = {
  name:  'zero-usage-response',
  model: 'claude-sonnet-4-6',
  rawSse: sseStream([
    {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_19CDE', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    },
    { type: 'message_stop', data: { type: 'message_stop' } },
  ]),
  expected: {
    requestId:               'msg_19CDE',
    inputTokens:             0,
    outputTokens:            0,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           0,
  },
};

// ── Fixture 20: Responses API format ─────────────────────────────────────────
// Anthropic Responses API streaming uses different event names.
// The adapter must handle/skip unknown event types gracefully without panic.
export const RESPONSES_API_FORMAT: SseFixture = {
  name:  'responses-api-format',
  model: 'claude-sonnet-4-6',
  // Responses API uses different event names — adapter should skip unknown types
  rawSse: [
    'event: response.created\n',
    'data: {"type":"response.created","response":{"id":"resp_20FGH","model":"claude-sonnet-4-6"}}\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"Hello from Responses API"}\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":" response."}\n\n',
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"id":"resp_20FGH","usage":{"input_tokens":11,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n\n',
    'data: [DONE]\n\n',
  ].join(''),
  // These events are not the Anthropic SSE format — adapter skips them all.
  // Usage is 0 because message_start / message_delta events never appeared.
  expected: {
    requestId:               '',
    inputTokens:             0,
    outputTokens:            0,
    cachedInputTokens:       0,
    cacheCreationInputTokens: 0,
    contentLength:           0,
  },
};

export const ALL_FIXTURES: SseFixture[] = [
  PLAIN_COMPLETION,
  CACHED_PROMPT,
  CACHE_WRITE,
  MID_STREAM_ERROR,
  OPUS_COMPLETION,
  SPLIT_CHUNK,
  DATE_SUFFIX_MODEL,
  TOOL_USE,
  PARALLEL_TOOLS,
  THINKING_BLOCKS,
  TRUNCATED_RESPONSE,
  EMPTY_STREAM,
  LARGE_INPUT,
  MULTI_TURN_CONTINUATION,
  HAIKU_COMPLETION,
  FAST_STREAM,
  MALFORMED_DATA_LINE,
  UNKNOWN_EVENT_TYPE,
  ZERO_USAGE_RESPONSE,
  RESPONSES_API_FORMAT,
];
