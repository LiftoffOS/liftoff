/**
 * The wire contract for platform-backend's internal LLM relay
 * (`POST /api/internal/llm/complete`).
 *
 * WHY THIS IS HERE. Every service that calls the relay — harvest, workforce,
 * governance — used to hand-write its own copy of this request shape, because
 * the canonical `LLMCompletionRequest` lives inside platform-backend's `src/`
 * and was never published. Three copies, three chances to get it wrong, and
 * nothing on the wire to catch a mismatch: the relay accepts whatever JSON it
 * is given.
 *
 * A copy can be wrong in a way nothing reports. Typing the field as
 * `responseSchema?: Record<string, unknown>` invites passing a BARE JSON Schema
 * where the relay expects the `{name, description?, schema}` wrapper. With no
 * `name`, the provider builds `tool_choice: {type: 'tool', name: undefined}`,
 * JSON.stringify drops the key, and Anthropic rejects the request with
 * `tool_choice.tool.name: Field required` — a 400 about a field the caller
 * never knew existed, three services away from the mistake. Every such call
 * fails that way, and because the relay answers 500 rather than 4xx, a
 * caller's terminal-vs-retryable check reads it as retryable and re-queues
 * each one forever.
 *
 * The shared-types drift fence cannot catch this class: it is a name-based
 * lint over a SINGLE repo, so a duplicate living in another repository is
 * invisible to it. Importing the type here is what makes the mismatch a
 * compile error in the consumer instead of a runtime 400 in production.
 *
 * `LLMWireRequest` is deliberately the JSON-serializable SUBSET. Anything that
 * cannot survive `JSON.stringify` (an `AbortSignal`, a callback) belongs on
 * platform-backend's in-process `LLMCompletionRequest`, which extends this —
 * not here.
 */

/** Model capability tier. Each provider resolves this to its own model ID.
 *
 *  The top tier is 'large': platform-backend migration 534 restored the name
 *  migration 196 had changed. A vendor's Frontier model is a designation above
 *  the tiers, not a tier, and is deliberately not in this union. */
export type LLMWireModelTier = 'large' | 'medium' | 'small';

/** A single conversation turn as it crosses the relay. */
export interface LLMWireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  cacheControl?: { type: 'ephemeral' };
}

/**
 * Structured-output request. The relay turns this into a forced single tool
 * call, so `name` is REQUIRED — it becomes both the tool's name and the
 * `tool_choice.name` that forces it.
 *
 * Passing a bare JSON Schema here is the drift bug described above. The schema
 * itself goes in `schema`; it is not this object.
 */
export interface LLMWireResponseSchema {
  /** Tool name for the forced call. Required — an absent name reaches the
   *  provider as `tool_choice: {type:'tool'}` and is rejected. */
  name: string;
  description?: string;
  /** The JSON Schema the output must satisfy. */
  schema: Record<string, unknown>;
}

/** The JSON-serializable request body accepted by the internal LLM relay. */
export interface LLMWireRequest {
  messages: LLMWireMessage[];
  /** Explicit model ID. Prefer `tier` for cross-provider compatibility. */
  model?: string;
  /** Capability tier, resolved per-provider. Ignored when `model` is set. */
  tier?: LLMWireModelTier;
  maxTokens?: number;
  temperature?: number;
  /** System prompt. Some callers send this instead of a system-role message. */
  systemPrompt?: string;
  /** Forces structured JSON output via a single tool call. */
  responseSchema?: LLMWireResponseSchema;
}

/**
 * Validate the relay-crossing parts of a request.
 *
 * Returns a human-readable reason, or null when the request is acceptable.
 * The relay uses this to answer 400 instead of letting a malformed body reach
 * the provider and come back as a 500 — which matters beyond legibility:
 * callers classify 4xx as terminal (ack-and-skip) and 5xx as retryable, so a
 * 500 for a permanently-malformed body is an infinite retry loop.
 */
export function validateLLMWireRequest(request: unknown): string | null {
  if (!request || typeof request !== 'object') return 'request must be an object';
  const r = request as Partial<LLMWireRequest>;

  if (!Array.isArray(r.messages) || r.messages.length === 0) {
    return 'request.messages is required and must be non-empty';
  }

  if (r.responseSchema !== undefined) {
    const rs = r.responseSchema as Partial<LLMWireResponseSchema>;
    if (!rs || typeof rs !== 'object') {
      return 'request.responseSchema must be an object';
    }
    if (typeof rs.name !== 'string' || rs.name.length === 0) {
      // The exact shape harvest-service sent. Name the likely cause, because
      // the provider-level error ("tool_choice.tool.name: Field required")
      // points at a field the caller never wrote.
      return (
        'request.responseSchema.name is required and must be a non-empty string. ' +
        'It is the name of the forced tool call. If you passed a bare JSON Schema, ' +
        'wrap it: { name, description?, schema: <your schema> }.'
      );
    }
    if (!rs.schema || typeof rs.schema !== 'object') {
      return 'request.responseSchema.schema is required and must be a JSON Schema object';
    }
  }

  return null;
}

/**
 * The provider-executed web tools a platform assistant is given.
 *
 * Here rather than in either service because BOTH need it and they are separate
 * deployables: platform-backend runs Liftoff and the Insights Manager in
 * process, and liftoff-workforce-service runs the Chief AI Officer in its own
 * repository against its own database. Two copies of two wire names is exactly
 * the drift this package exists to prevent.
 *
 * These are names, not versions. Which wire TYPE each name resolves to depends
 * on the model and the platform running the turn — Vertex has no web fetch at
 * all, and the dynamic-filtering variants need a recent model — so that
 * decision belongs at the provider boundary (anthropicServerToolType), not
 * here.
 *
 * Deliberately NOT the tenant runtime's browser tools. Those are BYOK-exclusive
 * and gated on a per-agent binding, and a platform assistant has no agent row
 * to carry one.
 */
export const WEB_SERVER_TOOLS: ReadonlyArray<{ name: string }> = [
  { name: 'web_search' },
  { name: 'web_fetch' },
];
