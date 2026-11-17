// Part 6 §B — canonical trajectory schema (Anthropic Messages-API block shape).
//
// At-rest GCS format. Lossless for Anthropic, lossy on export to OpenAI/Gemini
// SFT shapes (those formats can't express thinking/redacted_thinking/citations
// /cache_control/server_tool_use natively). Per-vendor mappers in
// src/trajectories/per-vendor/{anthropic,openai,gemini}.ts populate
// CanonicalContentBlock arrays from vendor-native raw output.

import type { ExecutionEngineId, NestedSpecialistEngineId } from '../agent-execution/adapter/types';
import type { ResolvedProvider } from '../agent-execution/adapter/types';

export type CanonicalContentBlock =
  | { type: 'text'; text: string; citations?: Citation[] }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  // `name` is optional because Anthropic does not carry it on a tool_result and
  // most engines do not emit it. Gemini DOES require `functionResponse.name` on
  // replay, so the mappers that can supply it must — dropping it makes the
  // transcript unreplayable on that engine.
  | { type: 'tool_result'; tool_use_id: string; name?: string; content: CanonicalContentBlock[] | string; is_error?: boolean }
  // A refusal is content the model produced, not an incidental extra. Kept as a
  // first-class block so it survives redaction, replay and grading rather than
  // being exiled to a run-level `extras.refusals[]` array that no consumer reads.
  | { type: 'refusal'; text: string }
  | { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown }
  | { type: 'web_fetch_tool_result'; tool_use_id: string; content: unknown };

export interface Citation {
  type: 'char_location' | 'page_location' | 'content_block_location' | string;
  document_index?: number;
  document_title?: string;
  cited_text?: string;
  [k: string]: unknown;
}

export interface CanonicalMessage {
  role: 'user' | 'assistant';
  content: CanonicalContentBlock[];
  /** Provider detail that belongs to THIS message and would be meaningless
   *  run-wide. `mergeProviderExtras` concatenates array-valued extras across the
   *  whole run, which is right for raw-preservation buffers and wrong for
   *  anything that has to be re-paired with the message it came from — OpenAI's
   *  `responses_api_id` and `encrypted_reasoning` are per-message and become
   *  un-repairable once flattened into a run-level array.
   *
   *  Keys in use: `responses_api_id`, `encrypted_reasoning` (both OpenAI). */
  message_scoped?: Record<string, unknown>;
}

export interface CanonicalTrajectory {
  /**.3 — the engine-provenance fields (`execution_engine`,
   * `nested_engine`) are added in 1.1 rather than silently changing the meaning
   * of 1.0. The additions are optional, so 1.1 is backward-compatible: 1.0
   * readers ignore the new fields and 1.1 readers treat them as optional.
   * Readers accept both versions during rollout. */
  schema_version: '1.0' | '1.1';
  trajectory_meta: {
    tenant_id: string;
    agent_id: string;
    invocation_id: string;
    /** Triggering human (migration 311) — PB account id or slack:/teams:<id>.
     *  Mirrors invocations.triggered_by_user_id. Omitted for non-human runs. */
    triggered_by_user_id?: string;
    /** Populated for delegated children. NULL for top-level invocations.
     *  Matches invocations.parent_invocation_id (migration 289). */
    parent_invocation_id?: string;
    /** Populated for nested code_session inner runs. NULL otherwise. */
    nested_kind?: 'code_session';
    /** IDs of bound vendor-hosted MCP servers (GitHub/Stripe/custom MCP). Their
     *  tools (`mcp__<id>__<tool>`) are reachable by the model via the remote
     *  server but are NOT enumerated in `tools` (the adapter introspects them
     *  at connect time), so conformance evaluation reads this list to treat
     *  those calls as in-set. Omitted when no vendor MCP servers were bound. */
    vendor_mcp_servers?: string[];
    /** Set by the diagnostics raw-table reconstruction when the run had NO
     *  persisted conversation and its objective/outcome had to be synthesized
     *  from the agent spec + invocation outcome (no chat text to judge). Signals
     *  the goal/conformance judges to score from the recorded outcome rather than
     *  an unreliable LLM judgment over synthesized text. Never set by capture. */
    synthesized_objective?: boolean;
    /** Set FALSE by the diagnostics raw-table reconstruction when the run's
     *  tool-call inputs could not be reliably recovered — the lossy
     *  `invocations.tool_calls` path persisted empty `{}` inputs for
     *  SDK-executed tools before the recorder-sourced fix / sink enablement.
     *  With empty inputs the (name,input) signature degenerates to name-only,
     *  so every same-name call collides — the loop / idempotency detectors
     *  MUST NOT fire on such a run (false MAST-1.3). Undefined = reliable
     *  (GCS-captured trajectories and post-fix raw rows carry real inputs). */
    inputs_reliable?: boolean;
    provider: ResolvedProvider;
    /** Concrete outer-agent engine (, schema 1.1+). Resolved from
     * provider + the engine env flags, so it distinguishes OpenAI-Agents from
     * Codex, Gemini-GenAI from ADK, and OpenAI-wire from OpenCode — which
     * `provider` alone cannot. Absent on 1.0 trajectories and on nested
     * code_session runs (those carry `nested_engine` instead). */
    execution_engine?: ExecutionEngineId;
    /** Nested code_session specialist engine (.1). Present only
     * when nested_kind === 'code_session'; kept in a SEPARATE field so an outer
     * OpenAI Codex engine is never conflated with a nested Codex coding task. */
    nested_engine?: NestedSpecialistEngineId;
    model: string;
    started_at: string;
    completed: boolean;
    tool_call_count: number;
    // Mirrors invocations.outcome, 'gated' included (migration 329).
    outcome: import('../invocations/types').InvocationOutcome;
    /** Present only when the trajectory was shortened to fit a training
     *  budget. Recorded so a consumer can tell a COMPRESSED trajectory from a
     *  genuinely short run without re-deriving it from the messages — the two
     *  look identical otherwise, and they mean opposite things. */
    compression?: {
      original_chars: number;
      final_chars: number;
      turns_dropped: number;
      tool_result_chars_removed: number;
      /** True when the protected opening and closing turns alone exceed the
       *  budget. Cutting into them is not on the table, so the caller is told
       *  rather than handed a trajectory that lost its objective. */
      still_over_budget: boolean;
    };
  };
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: CanonicalMessage[];
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  _provider_extras?: Record<string, unknown>;
  // OpenAI: { responses_api_ids?: string[], encrypted_reasoning?: string[] }
  // Gemini: { per_part_thought_signatures?: Array<string | null> }
}
