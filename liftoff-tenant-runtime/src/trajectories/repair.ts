// Make a recorded conversation safe to replay.
//
// A persisted transcript is not automatically a replayable one. Two live paths
// produce transcripts a provider will reject:
//
//   · the autonomous path checkpoints after EVERY tool call, so a run that died
//     between a tool_use and its result persists the dangling tool_use;
//   · the HITL pause persists deliberately mid-turn, "so the saved JSONL
//     captures the gated assistant tool_use awaiting a result".
//
// Today those either discard the work (chat drops the turn) or hand the vendor
// SDK a dangling tool_use and hope it copes. Neither is repair. This module is.
//
// The rules are applied IN ORDER and the order is load-bearing: ids are
// normalized only after the tool_use/tool_result pairing is complete, so the
// rewrite map covers every result; images are collapsed last so a placeholder
// cannot be mistaken for content by an earlier rule.

import type { CanonicalContentBlock, CanonicalMessage } from './types';
import type { ExecutionEngineId } from '../agent-execution/adapter/types';

export interface RepairOptions {
  sourceEngine: ExecutionEngineId;
  targetEngine: ExecutionEngineId;
  targetSupportsImages: boolean;
  /** Whether the run that produced this transcript ended in `error` or
   *  `aborted`.
   *
   *  Rule 1 needs it and cannot derive it: a CanonicalMessage records what was
   *  said, not how the run finished, and the difference between a completed
   *  final turn and an abandoned one is invisible in the content. The caller
   *  reading the transcript out of storage always knows the outcome. Defaults to
   *  false, which leaves the last turn intact — the conservative direction,
   *  since dropping a good turn loses work while keeping a bad one is caught by
   *  the remaining five rules. */
  lastTurnFailed?: boolean;
}

/** Anthropic's tool-id grammar. OpenAI Responses emits ids well over 450
 *  characters containing `|`, which Anthropic rejects outright, so a
 *  cross-engine replay has to rewrite them. */
const ANTHROPIC_TOOL_ID = /^[a-zA-Z0-9_-]{1,64}$/;

const IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';

export function repairForReplay(
  messages: CanonicalMessage[],
  opts: RepairOptions,
): CanonicalMessage[] {
  const crossEngine = opts.sourceEngine !== opts.targetEngine;
  let out = messages.map(cloneMessage);

  out = dropFailedTrailingTurn(out, opts.lastTurnFailed === true);
  out = synthesizeMissingToolResults(out);
  if (crossEngine) out = normalizeToolCallIds(out);
  out = repairReasoning(out, crossEngine);
  out = repairRefusals(out, crossEngine);
  if (!opts.targetSupportsImages) out = stripImages(out);

  // A message can be emptied by the rules above (an assistant turn that held
  // nothing but redacted_thinking, dropped cross-engine). An empty content array
  // is itself a 400 on most providers, so it must not survive the repair.
  return out.filter((m) => m.content.length > 0);
}

// ── Rule 1 — drop failed assistant turns ────────────────────────────────────
//
// Partial content and dangling reasoning items are what makes providers 400 on
// the retry. The trailing assistant turn of a run that ended `error` or
// `aborted` is exactly that: content the model was still producing when the run
// died.
//
// Only the TRAILING turn, and only when the caller says the run failed. Earlier
// assistant turns in the same transcript completed normally — a run has one
// terminal event, not one per turn — so dropping more would discard work that
// actually happened.
function dropFailedTrailingTurn(messages: CanonicalMessage[], failed: boolean): CanonicalMessage[] {
  if (!failed || messages.length === 0) return messages;
  const out = [...messages];
  while (out.length > 0 && out[out.length - 1].role === 'assistant') out.pop();
  return out;
}

// ── Rule 2 — synthesize missing tool results ────────────────────────────────
//
// Every tool_use needs a matching tool_result or the provider rejects the whole
// conversation. A checkpoint taken between dispatch and response, and a HITL
// pause taken deliberately at that exact point, both leave one behind.
//
// The synthesized result is marked `is_error` and says plainly that no result
// was produced. That matters: a fabricated success would tell the model its tool
// call worked, and it would build on an outcome that never happened.
function synthesizeMissingToolResults(messages: CanonicalMessage[]): CanonicalMessage[] {
  const resolved = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_result') resolved.add(b.tool_use_id);
    }
  }

  const out: CanonicalMessage[] = [];
  const outstanding: string[] = [];

  const flush = (): void => {
    if (outstanding.length === 0) return;
    out.push({
      role: 'user',
      content: outstanding.map((id) => syntheticResult(id)),
    });
    outstanding.length = 0;
  };

  for (const m of messages) {
    // Anything outstanding must be answered BEFORE the next message, whichever
    // role it carries: an assistant turn cannot follow an unanswered tool_use,
    // and a user turn cannot either.
    if (outstanding.length > 0) flush();
    out.push(m);
    for (const b of m.content) {
      if (b.type === 'tool_use' && !resolved.has(b.id)) outstanding.push(b.id);
    }
  }
  // And again at end of conversation, for a run that died on its last call.
  flush();
  return out;
}

function syntheticResult(toolUseId: string): CanonicalContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: 'No result provided',
    is_error: true,
  };
}

// ── Rule 3 — normalize tool-call ids across engines ─────────────────────────
//
// Build the rewrite map from tool_use first, then apply it to every matching
// tool_result. Rewriting each block independently would break the pairing, which
// is the one property the ids exist to carry.
function normalizeToolCallIds(messages: CanonicalMessage[]): CanonicalMessage[] {
  const rewrite = new Map<string, string>();
  let n = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use' && !ANTHROPIC_TOOL_ID.test(b.id)) {
        if (!rewrite.has(b.id)) rewrite.set(b.id, `call_${n++}`);
      }
    }
  }
  if (rewrite.size === 0) return messages;

  for (const m of messages) {
    m.content = m.content.map((b) => {
      if (b.type === 'tool_use') {
        const next = rewrite.get(b.id);
        return next ? { ...b, id: next } : b;
      }
      if (b.type === 'tool_result') {
        const next = rewrite.get(b.tool_use_id);
        return next ? { ...b, tool_use_id: next } : b;
      }
      return b;
    });
  }
  return messages;
}

// ── Rule 4 — reasoning ──────────────────────────────────────────────────────
//
// SAME engine: keep `thinking` verbatim, signature and all, INCLUDING when the
// text is empty. An OpenAI signed-but-empty reasoning block is load-bearing —
// the signature is the payload, and dropping the block because it "looks empty"
// breaks the replay it was kept for.
//
// CROSS engine: a signature is meaningless to another vendor and
// `redacted_thinking` is opaque ciphertext only its issuer can read. Convert
// what survives translation (`thinking` → `text`), drop what does not, and strip
// the message-scoped encrypted reasoning that would otherwise be re-attached to
// an engine that cannot decrypt it.
function repairReasoning(messages: CanonicalMessage[], crossEngine: boolean): CanonicalMessage[] {
  if (!crossEngine) return messages;
  for (const m of messages) {
    const next: CanonicalContentBlock[] = [];
    for (const b of m.content) {
      if (b.type === 'redacted_thinking') continue;
      if (b.type === 'thinking') {
        // An empty thinking block carries nothing once its signature is gone.
        if (b.thinking) next.push({ type: 'text', text: b.thinking });
        continue;
      }
      next.push(b);
    }
    m.content = next;
    if (m.message_scoped) {
      const { encrypted_reasoning: _dropped, ...rest } = m.message_scoped;
      m.message_scoped = rest;
    }
  }
  return messages;
}

// ── Rule 5 — refusals ───────────────────────────────────────────────────────
//
// Same engine: a refusal block replays as a refusal block. Cross engine: no
// other vendor has the block, and silently dropping it would erase the reason
// the conversation went the way it did, so it becomes text.
function repairRefusals(messages: CanonicalMessage[], crossEngine: boolean): CanonicalMessage[] {
  if (!crossEngine) return messages;
  for (const m of messages) {
    m.content = m.content.map((b) => (b.type === 'refusal' ? { type: 'text' as const, text: b.text } : b));
  }
  return messages;
}

// ── Rule 6 — images ─────────────────────────────────────────────────────────
//
// Images reach the canonical transcript inside tool_result content, which the
// Anthropic mapper carries verbatim. When the target cannot accept them, replace
// each with a placeholder AND collapse consecutive placeholders — otherwise a
// conversation that read forty screenshots becomes forty identical lines, which
// costs real tokens and tells the model nothing it did not learn from the first.
function stripImages(messages: CanonicalMessage[]): CanonicalMessage[] {
  for (const m of messages) {
    m.content = m.content.map((b) => {
      if (b.type !== 'tool_result' || typeof b.content === 'string') return b;
      return { ...b, content: collapsePlaceholders(b.content.map(imageToPlaceholder)) };
    });
  }
  return messages;
}

function imageToPlaceholder(b: CanonicalContentBlock): CanonicalContentBlock {
  // `image` is not a canonical block type, but Anthropic tool results carry one
  // and the mapper preserves the array verbatim, so it is present at runtime.
  return (b as { type: string }).type === 'image'
    ? { type: 'text', text: IMAGE_PLACEHOLDER }
    : b;
}

function collapsePlaceholders(blocks: CanonicalContentBlock[]): CanonicalContentBlock[] {
  const out: CanonicalContentBlock[] = [];
  for (const b of blocks) {
    const isPlaceholder = b.type === 'text' && b.text === IMAGE_PLACEHOLDER;
    const prev = out[out.length - 1];
    const prevIsPlaceholder = prev && prev.type === 'text' && prev.text === IMAGE_PLACEHOLDER;
    if (isPlaceholder && prevIsPlaceholder) continue;
    out.push(b);
  }
  return out;
}

/** Deep-enough copy that repair never mutates the caller's transcript. The
 *  stored canonical copy is read by other consumers on the same request; a
 *  repair that edited it in place would change what they see. */
function cloneMessage(m: CanonicalMessage): CanonicalMessage {
  return {
    role: m.role,
    content: m.content.map((b) => (b.type === 'tool_result' && Array.isArray(b.content)
      ? { ...b, content: [...b.content] }
      : { ...b })),
    ...(m.message_scoped ? { message_scoped: { ...m.message_scoped } } : {}),
  };
}
