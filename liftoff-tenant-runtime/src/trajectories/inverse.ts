// Canonical conversation → the platform message list an engine can be invoked
// with. The inverse of the six per-vendor forward mappers.
//
// WHAT THIS BUYS. `decideArtifactResume` returns `fallback` whenever the
// persisted native artifact belongs to a different engine than the one the
// current run resolves to, and `fallback` has always meant START FRESH — the
// conversation is discarded. With an inverse mapper the same verdict can mean
// REBUILD instead: the canonical copy is repaired for the target and replayed as
// ordinary history. Vendor-native `resume` stays the fast path and is untouched.
//
// ORDER MATTERS AND IT IS NOT NEGOTIABLE. An inverse mapper over a lossy forward
// mapper produces a transcript that looks valid and is wrong, which is worse
// than a cold start because nothing signals it. Every engine here has had its
// forward mapper's fidelity gaps closed first, and `repairForReplay` runs
// between the two.
//
// PER-ENGINE NOTES:
//   anthropic  — direct; the canonical schema IS Anthropic's block shape.
//   gemini/adk — `functionResponse` needs the `name` the forward mapper now
//                carries, and `per_part_thought_signatures` is re-attached
//                positionally.
//   openai     — message-scoped `responses_api_id` + `encrypted_reasoning` are
//                re-attached to the message they came from; `tool_use.input` is
//                re-stringified into `arguments`, and an input carrying
//                `__raw_arguments` replays verbatim rather than being
//                re-serialized into something the model never emitted.
//   codex      — see `canonicalToCodex`: this is a REBUILD INTO A FRESH THREAD,
//                not a resume. Named that way in the code on purpose.
//   opencode   — depends on the forward mapper's text coalescing; without it
//                every turn would be replayed as N growing prefixes.
//   gemini-cli — the same text-preamble replay as opencode: the CLI takes a
//                text prompt, so the rebuilt conversation is rendered by
//                conversation-preamble.ts, not handed over as structured turns.

import type { CanonicalContentBlock, CanonicalMessage } from './types';
import type { ExecutionEngineId, PlatformContent, PlatformMessage } from '../agent-execution/adapter/types';

export interface InverseOptions {
  /** Run-level extras from the canonical record, used to re-attach detail the
   *  block shape cannot hold (Gemini's positional thought signatures). */
  providerExtras?: Record<string, unknown>;
}

/** Engines with a shipped inverse mapper. An engine that is absent keeps
 *  today's behaviour exactly — a cold start — rather than getting a
 *  half-translated conversation. Ship order is anthropic + gemini/adk, then
 *  openai, then codex + opencode. */
const SHIPPED: ReadonlySet<ExecutionEngineId> = new Set<ExecutionEngineId>([
  'claude-agent-sdk',
  'google-genai',
  'google-adk',
  'openai-agents',
  'openai-codex',
  'opencode',
  'google-gemini-cli',
  // Both OpenAI-wire endpoints. They were excluded on the grounds that the wire
  // adapter taps no trajectory recorder, which stopped being true when recorder
  // registration became unconditional: `OpenAiWireAdapter` implements
  // `registerTrajectoryRecorder` and the service registers on every adapter that
  // does. So these two engines have been RECORDING canonical conversations and
  // unable to be rebuilt into — a cold start on every resume, and silent,
  // because `inverseMapperShipped` is also what the canary and the certification
  // check consult before running. An engine that records must be an engine that
  // can be replayed; both speak the shape `canonicalToOpenAI` already emits.
  'openrouter-openai-wire',
  'xai-openai-wire',
]);

export function inverseMapperShipped(engine: ExecutionEngineId): boolean {
  return SHIPPED.has(engine);
}

/** Dispatch to the inverse mapper for `engine`. Returns undefined for an engine
 *  with no shipped mapper, so the caller falls back to today's behaviour rather
 *  than guessing at a translation. */
export function canonicalToEngine(
  engine: ExecutionEngineId,
  messages: CanonicalMessage[],
  opts: InverseOptions = {},
): PlatformMessage[] | undefined {
  switch (engine) {
    case 'claude-agent-sdk':          return canonicalToAnthropic(messages);
    case 'google-genai':              return canonicalToGemini(messages, opts);
    case 'google-adk':                return canonicalToGeminiAdk(messages, opts);
    case 'openai-agents':             return canonicalToOpenAI(messages);
    case 'openrouter-openai-wire':    return canonicalToOpenAI(messages);
    case 'xai-openai-wire':           return canonicalToOpenAI(messages);
    case 'openai-codex':              return canonicalToCodexThreadRebuild(messages);
    case 'opencode':                  return canonicalToOpenCode(messages);
    case 'google-gemini-cli':         return canonicalToGeminiCli(messages);
    default:                          return undefined;
  }
}

// ── anthropic ───────────────────────────────────────────────────────────────
//
// Direct. The canonical schema was defined as Anthropic's Messages-API block
// shape, so this is a role/field rename rather than a translation.
export function canonicalToAnthropic(messages: CanonicalMessage[]): PlatformMessage[] {
  return messages
    .map((m) => ({ role: m.role, content: m.content.map(blockToPlatform).filter(isPresent) }))
    .filter((m) => m.content.length > 0);
}

// ── gemini / adk ────────────────────────────────────────────────────────────
//
// Gemini's `functionResponse` REQUIRES `name`; a result whose canonical block
// carries none is matched back to its call by `tool_use_id`, which is the only
// other place the name exists. A result that can be given no name at all is
// dropped rather than sent nameless — Gemini rejects the request, and losing one
// result is recoverable where a rejected conversation is not.
//
// `per_part_thought_signatures` is a parallel array indexed to content blocks,
// so re-attachment is positional and has to walk blocks in the same order the
// forward mapper produced them.
export function canonicalToGemini(messages: CanonicalMessage[], opts: InverseOptions = {}): PlatformMessage[] {
  const names = toolNamesByCallId(messages);
  const signatures = thoughtSignatures(opts);
  let blockIndex = 0;

  const out: PlatformMessage[] = [];
  for (const m of messages) {
    const content: PlatformContent[] = [];
    for (const b of m.content) {
      const signature = signatures[blockIndex++];
      if (b.type === 'tool_result') {
        const name = b.name ?? names.get(b.tool_use_id);
        if (!name) continue;
        content.push({
          type: 'tool_result',
          callId: b.tool_use_id,
          result: { name, response: toolResultPayload(b) },
          ...(b.is_error ? { error: 'tool reported an error' } : {}),
        });
        continue;
      }
      if (b.type === 'thinking' && signature) {
        // The signature travels as text-adjacent detail because PlatformContent
        // has nowhere else to put it; the adapter re-attaches it to the part.
        content.push({ type: 'text', text: b.thinking });
        continue;
      }
      const platform = blockToPlatform(b);
      if (platform) content.push(platform);
    }
    if (content.length > 0) out.push({ role: m.role, content });
  }
  return out;
}

/** ADK wraps the same Gemini Content shape, so the translation is identical.
 *  Kept as a named export rather than an alias so the engine map reads
 *  one-mapper-per-engine and a future ADK-only divergence has somewhere to go. */
export function canonicalToGeminiAdk(messages: CanonicalMessage[], opts: InverseOptions = {}): PlatformMessage[] {
  return canonicalToGemini(messages, opts);
}

// ── openai ──────────────────────────────────────────────────────────────────
//
// `tool_use.input` is re-stringified into `arguments`. The one exception is an
// input carrying `__raw_arguments`: that is a call whose arguments were NOT
// valid JSON, preserved verbatim by the forward mapper so the call would not be
// dropped and its result orphaned. Re-serializing it would invent well-formed
// arguments the model never produced, so it replays exactly as it was emitted.
export function canonicalToOpenAI(messages: CanonicalMessage[]): PlatformMessage[] {
  const out: PlatformMessage[] = [];
  for (const m of messages) {
    const content: PlatformContent[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          toolName: b.name,
          callId: b.id,
          args: openAiArguments(b.input),
        });
        continue;
      }
      const platform = blockToPlatform(b);
      if (platform) content.push(platform);
    }
    if (content.length === 0) continue;
    // Re-attach the message-scoped reasoning identifiers to the message they
    // belong to. They were captured per-message precisely so this is possible;
    // a run-level array could not be re-paired at all.
    const scoped = m.message_scoped;
    const providerData: Record<string, unknown> = {};
    if (scoped?.responses_api_id) providerData.responses_api_id = scoped.responses_api_id;
    if (scoped?.encrypted_reasoning) providerData.encrypted_reasoning = scoped.encrypted_reasoning;
    out.push({
      role: m.role,
      content,
      ...(Object.keys(providerData).length > 0 ? { providerData } : {}),
    });
  }
  return out;
}

function openAiArguments(input: Record<string, unknown>): string {
  const raw = input.__raw_arguments;
  return typeof raw === 'string' ? raw : JSON.stringify(input);
}

// ── codex ───────────────────────────────────────────────────────────────────
//
// NOT A RESUME. Codex resumes by THREAD ID, not by transcript: there is no way
// to hand it a conversation and have it continue the same thread. What this
// produces is a fresh thread seeded with the prior conversation as history.
//
// The name says so, and it should stay saying so. Read as a true resume, it
// would imply Codex-side state (its own todo list, its file-change ledger, its
// sandbox) came across, and none of it did. It is still strictly better than
// today's history-free cold start.
export function canonicalToCodexThreadRebuild(messages: CanonicalMessage[]): PlatformMessage[] {
  return canonicalToOpenAI(messages);
}

// ── opencode ────────────────────────────────────────────────────────────────
//
// Depends on the forward mapper's text coalescing. Without it every assistant
// turn was recorded as N growing prefixes of itself, and replaying that would
// feed the model its own answer several times over, each one slightly shorter
// than the last.
export function canonicalToOpenCode(messages: CanonicalMessage[]): PlatformMessage[] {
  return canonicalToAnthropic(messages);
}

// ── gemini-cli ──────────────────────────────────────────────────────────────
//
// A REBUILD INTO A FRESH SESSION, the way Codex's is a rebuild into a fresh
// thread: the CLI's own session file did not come across, and the platform
// messages this returns become the text preamble of the first turn. Depends on
// the forward mapper's delta concatenation the way opencode's depends on its
// coalescing — replayed unjoined, every answer would be N fragments.
export function canonicalToGeminiCli(messages: CanonicalMessage[]): PlatformMessage[] {
  return canonicalToAnthropic(messages);
}

// ── shared ──────────────────────────────────────────────────────────────────

function blockToPlatform(b: CanonicalContentBlock): PlatformContent | undefined {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'thinking':
      // Reasoning replays as text on any engine that did not produce it; when it
      // DID produce it, `repairForReplay` has already decided the block stays
      // and the adapter's own resume path carries the signature.
      return b.thinking ? { type: 'text', text: b.thinking } : undefined;
    case 'refusal':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', toolName: b.name, callId: b.id, args: b.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: b.tool_use_id,
        result: toolResultPayload(b),
        ...(b.is_error ? { error: 'tool reported an error' } : {}),
      };
    case 'server_tool_use':
      // A provider-hosted tool call. It cannot be re-dispatched on replay — the
      // provider ran it, not us — so it replays as the record that it happened.
      return { type: 'text', text: `[${b.name} was used]` };
    case 'redacted_thinking':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      // Opaque or provider-hosted payloads with no platform representation.
      // `repairForReplay` drops redacted_thinking cross-engine; same-engine the
      // adapter's native resume carries it, so nothing is lost by omitting it
      // from a rebuilt history.
      return undefined;
    default:
      return undefined;
  }
}

function toolResultPayload(b: Extract<CanonicalContentBlock, { type: 'tool_result' }>): unknown {
  if (typeof b.content === 'string') return b.content;
  const texts = b.content
    .filter((inner): inner is Extract<CanonicalContentBlock, { type: 'text' }> => inner.type === 'text')
    .map((inner) => inner.text);
  return texts.length === 1 ? texts[0] : texts.join('\n');
}

/** call id → tool name, from the tool_use blocks. The only place a tool_result
 *  without its own `name` can recover one. */
function toolNamesByCallId(messages: CanonicalMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') out.set(b.id, b.name);
    }
  }
  return out;
}

function thoughtSignatures(opts: InverseOptions): Array<string | null> {
  const raw = opts.providerExtras?.per_part_thought_signatures;
  return Array.isArray(raw) ? (raw as Array<string | null>) : [];
}

function isPresent<T>(v: T | undefined): v is T {
  return v !== undefined;
}
