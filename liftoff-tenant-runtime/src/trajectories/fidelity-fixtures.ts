// Per-engine canonical fidelity fixtures.
//
// One canned raw event stream per engine plus the EXACT canonical message list
// it must produce. Two consumers read the same fixtures, deliberately:
//   · src/trajectories/__tests__/fidelity.<engine>.test.ts — a focused unit
//     assertion per engine, so a regression names the engine that broke it;
//   · agent-execution/certification/certify.ts — the `trajectory_fidelity`
//     category, so a mapper regression fails engine certification and therefore
//     the PR, not just one test file somebody can skip.
//
// The fixtures are driven through the REAL recorder rather than calling mappers
// directly, because two of the fidelity rules live in the recorder and not in a
// mapper: OpenCode text coalescing and the `message_scoped` merge exemption.
// A mapper-only assertion would pass with both of them reverted.

import type { ExecutionEngineId } from '../agent-execution/adapter/types';
import type { ResolvedProvider } from '../agent-execution/adapter/types';
import type { CanonicalMessage } from './types';
import { makeRecorder, getRun, releaseBuffer } from './recorder';

type RawKind = 'anthropic_sdk_message' | 'openai_run_item' | 'gemini_response' | 'adk_event' | 'codex_thread_item' | 'opencode_part' | 'gemini_cli_event';
type FixtureProvider = ResolvedProvider;

export interface FidelityFixture {
  /** The engine this fixture certifies. */
  engine: ExecutionEngineId;
  rawKind: RawKind;
  provider: FixtureProvider;
  /** Raw vendor events, in the order the adapter taps them. */
  raw: unknown[];
  /** The exact canonical messages the recorder must hold afterwards. */
  expected: CanonicalMessage[];
  /** Replay-relevant drops this fixture must NOT produce. Always empty: a
   *  fixture that legitimately drops replay-relevant content is a fixture
   *  describing a bug we have decided to keep. */
  expectedReplayRelevantDrops: string[];
}

export const FIDELITY_FIXTURES: FidelityFixture[] = [
  // ── claude-agent-sdk ────────────────────────────────────────────────────
  // The reference implementation: nothing is lossy here. Asserted anyway so a
  // regression in the one mapper we trust cannot go unnoticed.
  {
    engine: 'claude-agent-sdk',
    rawKind: 'anthropic_sdk_message',
    provider: 'anthropic',
    raw: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing it', signature: 'sig-a' },
          { type: 'text', text: 'Calling the tool.' },
          { type: 'tool_use', id: 'toolu_1', name: 'file_read', input: { path: '/a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents', is_error: false },
        ],
      },
    ],
    expected: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing it', signature: 'sig-a' },
          { type: 'text', text: 'Calling the tool.', citations: undefined },
          { type: 'tool_use', id: 'toolu_1', name: 'file_read', input: { path: '/a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents', is_error: false },
        ],
      },
    ],
    expectedReplayRelevantDrops: [],
  },

  // ── google-genai ────────────────────────────────────────────────────────
  // Certifies both gemini fidelity rules: `functionResponse.name` survives
  // (Gemini requires it on replay) and EVERY candidate is read, not candidates[0].
  {
    engine: 'google-genai',
    rawKind: 'gemini_response',
    provider: 'google',
    raw: [
      {
        candidates: [
          { content: { parts: [
            { text: 'reasoning', thought: true, thoughtSignature: 'sig-g' },
            { functionCall: { id: 'fc_1', name: 'lookup', args: { q: 'x' } } },
          ] } },
          { content: { parts: [{ text: 'second candidate' }] } },
        ],
      },
      {
        candidates: [
          { content: { parts: [
            { functionResponse: { id: 'fc_1', name: 'lookup', response: { ok: true } } },
          ] } },
        ],
      },
    ],
    expected: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 'sig-g' },
          { type: 'tool_use', id: 'fc_1', name: 'lookup', input: { q: 'x' } },
          { type: 'text', text: 'second candidate' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_result', tool_use_id: 'fc_1', name: 'lookup', content: [{ type: 'text', text: '{"ok":true}' }] },
        ],
      },
    ],
    expectedReplayRelevantDrops: [],
  },

  // ── google-adk ──────────────────────────────────────────────────────────
  {
    engine: 'google-adk',
    rawKind: 'adk_event',
    provider: 'google',
    raw: [
      { content: { parts: [
        { text: 'thinking hard', thought: true, thoughtSignature: 'sig-adk' },
        { functionCall: { id: 'fc_9', name: 'search', args: { q: 'y' } } },
      ] } },
      { content: { parts: [
        { functionResponse: { id: 'fc_9', name: 'search', response: { hits: 2 } } },
      ] } },
    ],
    expected: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinking hard', signature: 'sig-adk' },
          { type: 'tool_use', id: 'fc_9', name: 'search', input: { q: 'y' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'fc_9', name: 'search', content: [{ type: 'text', text: '{"hits":2}' }] },
        ],
      },
    ],
    expectedReplayRelevantDrops: [],
  },

  // ── openai-agents ───────────────────────────────────────────────────────
  // Certifies all four OpenAI fidelity rules at once: reasoning stays message-scoped,
  // a refusal is a block, a malformed tool call still emits its tool_use (so its
  // result is not orphaned), and the result carries is_error.
  {
    engine: 'openai-agents',
    rawKind: 'openai_run_item',
    provider: 'openai',
    raw: [
      {
        type: 'reasoning_item',
        rawItem: {
          id: 'rs_1',
          rawContent: [{ text: 'internal reasoning' }],
          providerData: { encrypted_content: 'ENC-BLOB' },
        },
      },
      {
        type: 'tool_call_item',
        rawItem: { type: 'function_call', name: 'lookup', arguments: '{not json', call_id: 'call_1' },
      },
      {
        type: 'tool_call_output_item',
        rawItem: { call_id: 'call_1', status: 'incomplete', output: 'boom' },
      },
      {
        type: 'message_output_item',
        rawItem: { content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] },
      },
    ],
    expected: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'internal reasoning', signature: undefined }],
        message_scoped: { responses_api_id: 'rs_1', encrypted_reasoning: 'ENC-BLOB' },
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { __raw_arguments: '{not json' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: [{ type: 'text', text: 'boom' }] }],
      },
      {
        role: 'assistant',
        content: [{ type: 'refusal', text: 'I cannot help with that.' }],
      },
    ],
    // The malformed-arguments case IS a replay-relevant event, and the mapper
    // records it — but it no longer DROPS anything, so the transcript stays
    // replayable. The counter fires as a signal, not as a loss.
    expectedReplayRelevantDrops: ['openai:invalid_json_args'],
  },

  // ── openai-codex ────────────────────────────────────────────────────────
  // Certifies that command_execution and file_change now have a canonical shape
  // — required for CROSS-ENGINE rebuild, which reads `messages` and cannot see
  // `extras.codex_unmapped`.
  {
    engine: 'openai-codex',
    rawKind: 'codex_thread_item',
    provider: 'openai',
    raw: [
      { type: 'item.started', item: { id: 'cmd_1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'cmd_1', type: 'command_execution', command: 'npm test', aggregated_output: '2 failing', status: 'failed' } },
      { type: 'item.completed', item: { id: 'fc_1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } },
    ],
    expected: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'cmd_1', name: 'command_execution', input: { command: 'npm test' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'cmd_1', content: '2 failing', is_error: true }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'fc_1', name: 'file_change', input: { changes: [{ path: 'src/a.ts', kind: 'update' }] } }],
      },
    ],
    expectedReplayRelevantDrops: [],
  },

  // ── opencode ────────────────────────────────────────────────────────────
  // The live-defect fixture. THREE cumulative updates of the same text part must
  // yield ONE assistant message holding the final text — not three growing
  // prefixes. Uncoalesced this produced 3 messages, and every consumer of
  // finalAssistantText / messageFeatures read all three.
  //
  // A tool part streams the same way — `pending` with empty input, then
  // `running` with the arguments, then `completed` — under one call id, and
  // the CLI names the tool with its server prefix. The record holds ONE
  // tool_use per call, with the arguments the run sent, under the catalog's
  // name: a record with two tool_use blocks for one id is one no engine
  // accepts back, and a resume replays the record to the engine.
  {
    engine: 'opencode',
    rawKind: 'opencode_part',
    provider: 'glm',
    raw: [
      { type: 'message.part.updated', properties: { part: { id: 'prt_1', type: 'text', text: 'Let' } } },
      { type: 'message.part.updated', properties: { part: { id: 'prt_1', type: 'text', text: 'Let me' } } },
      { type: 'message.part.updated', properties: { part: { id: 'prt_1', type: 'text', text: 'Let me check.' } } },
      { type: 'message.part.updated', properties: { part: { id: 'prt_2', type: 'tool', tool: 'liftoff_file_read', callID: 'call_7', state: { status: 'pending', input: {} } } } },
      { type: 'message.part.updated', properties: { part: { id: 'prt_2', type: 'tool', tool: 'liftoff_file_read', callID: 'call_7', state: { status: 'running', input: { path: '/b.txt' } } } } },
      { type: 'message.part.updated', properties: { part: { id: 'prt_2', type: 'tool', tool: 'liftoff_file_read', callID: 'call_7', state: { status: 'completed', input: { path: '/b.txt' }, output: 'ok' } } } },
    ],
    expected: [
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_7', name: 'file_read', input: { path: '/b.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_7', content: 'ok' }] },
    ],
    expectedReplayRelevantDrops: [],
  },

  // ── google-gemini-cli ───────────────────────────────────────────────────
  // The opposite streaming shape from opencode: `message` events carry DELTAS,
  // one chunk each, so three of them must join into ONE assistant message
  // holding the whole text — not the last chunk (replace) and not three
  // fragments (append). A tool call closes the text before it, so the answer
  // that follows the result is a new block in order. The CLI's own search is
  // Google's, not ours, so it records as a server-side tool use, and the
  // proxy's tools drop the `mcp_liftoff_` prefix the CLI put on them.
  {
    engine: 'google-gemini-cli',
    rawKind: 'gemini_cli_event',
    provider: 'google',
    raw: [
      { type: 'init', session_id: 'sess_1', model: 'gemini-3-pro' },
      { type: 'message', role: 'assistant', content: 'Let', delta: true },
      { type: 'message', role: 'assistant', content: ' me', delta: true },
      { type: 'message', role: 'assistant', content: ' check.', delta: true },
      { type: 'tool_use', tool_name: 'mcp_liftoff_file_read', tool_id: 'call_7', parameters: { path: '/b.txt' } },
      { type: 'tool_result', tool_id: 'call_7', status: 'success', output: 'ok' },
      { type: 'tool_use', tool_name: 'google_web_search', tool_id: 'call_8', parameters: { query: 'liftoff' } },
      { type: 'tool_result', tool_id: 'call_8', status: 'success', output: 'Sources: …' },
      { type: 'message', role: 'assistant', content: 'Done.', delta: true },
      { type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 4, cached: 0 } },
    ],
    expected: [
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_7', name: 'file_read', input: { path: '/b.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_7', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 'call_8', name: 'web_search', input: { query: 'liftoff' } }] },
      { role: 'user', content: [{ type: 'web_search_tool_result', tool_use_id: 'call_8', content: 'Sources: …' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ],
    expectedReplayRelevantDrops: [],
  },
];

export interface FidelityRunResult {
  messages: CanonicalMessage[];
  replayRelevantDrops: string[];
  unknownBlockTypes: string[];
}

/** Drive a fixture's raw events through the real recorder and return what it
 *  accumulated. Releases the buffer, so repeated calls are independent. */
export function runFidelityFixture(fixture: FidelityFixture, invocationId?: string): FidelityRunResult {
  const id = invocationId ?? `fidelity-${fixture.engine}-${fixture.raw.length}`;
  releaseBuffer(id);
  const recorder = makeRecorder(id);
  for (const raw of fixture.raw) {
    recorder.recordRaw({
      invocationId: id,
      provider: fixture.provider,
      model: 'fixture-model',
      rawKind: fixture.rawKind,
      raw,
    });
  }
  const run = getRun(id);
  const result: FidelityRunResult = {
    messages: run ? run.messages.map((m) => m) : [],
    replayRelevantDrops: run ? [...run.unmappedReplayRelevant] : [],
    unknownBlockTypes: run ? [...run.unknownBlockTypes] : [],
  };
  releaseBuffer(id);
  return result;
}

/** True when the fixture reproduces exactly. Used by certification, which has no
 *  jest matchers available. Structural equality via canonical JSON — the
 *  canonical schema is JSON-serializable by construction, and undefined-valued
 *  optional keys are exactly what JSON.stringify drops, which is the same
 *  equivalence `toEqual` applies in the unit tests. */
export function fixtureReproduces(fixture: FidelityFixture): { ok: boolean; detail?: string } {
  const actual = runFidelityFixture(fixture);
  const a = JSON.stringify(actual.messages);
  const e = JSON.stringify(fixture.expected);
  if (a !== e) return { ok: false, detail: `messages diverged\n  expected: ${e}\n  actual:   ${a}` };
  const drops = [...actual.replayRelevantDrops].sort().join(',');
  const expectedDrops = [...fixture.expectedReplayRelevantDrops].sort().join(',');
  if (drops !== expectedDrops) {
    return { ok: false, detail: `replay-relevant drops diverged: expected [${expectedDrops}] got [${drops}]` };
  }
  return { ok: true };
}

/** The fixture certifying a given engine, if one exists. Engines with no mapper
 *  of their own (openrouter-openai-wire taps no recorder) have none. */
export function fidelityFixtureFor(engine: ExecutionEngineId): FidelityFixture | undefined {
  return FIDELITY_FIXTURES.find((f) => f.engine === engine);
}

// ── a CONVERSATION, as distinct from an engine's output ─────────────────────
//
// FIDELITY_FIXTURES above each certify one engine's raw output -> canonical
// mapping, so they are assistant-only by nature: a mapping fixture describes
// what an engine SAYS. That is the right subject for fidelity and the wrong one
// for rebuild, because what a rebuild carries is a conversation — questions as
// well as answers.
//
// The distinction is not academic. The canonical record shipped assistant-only
// for its first days: the recorder taps adapter OUTPUT and nothing recorded the
// input, so a rebuilt thread handed the next engine the agent's own past
// answers with none of the prompts, and the model answered "NO CONTEXT", which
// was honest about what it received. Every count-based check passed throughout
// — 2 messages in, 2 out.
//
// Shaped like a real stored conversation: alternating turns,
// tool use in the middle, the codewords only recoverable from the user turns.
export const REBUILD_CONVERSATION_FIXTURE: CanonicalMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Please remember this codeword for later: ZEPHYRA.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Got it, ZEPHYRA.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Second codeword to remember: ZEPHYRB.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Saving both codewords now.' },
      { type: 'tool_use', id: 'call_mem_1', name: 'memory_save', input: { content: 'ZEPHYRA, ZEPHYRB' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_mem_1', content: 'saved' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Both codewords are saved.' }] },
  { role: 'user', content: [{ type: 'text', text: 'What two codewords did I ask you to remember?' }] },
];

/** The facts a rebuild of {@link REBUILD_CONVERSATION_FIXTURE} must preserve.
 *  Asserted as CONTENT rather than counts: the answer to the last question
 *  exists only in the user turns, so a rebuild that keeps every message and
 *  loses those is a rebuild that cannot be answered from. */
export const REBUILD_CONVERSATION_FACTS = {
  userTurns: 4,
  mustContain: ['ZEPHYRA', 'ZEPHYRB'],
} as const;
