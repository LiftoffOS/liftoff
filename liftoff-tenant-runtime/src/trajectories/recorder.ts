// Part 6 §C — per-invocation trajectory recorder.
//
// makeRecorder(invocationId) returns a closure adapters call via
// adapter.registerTrajectoryRecorder. The closure routes raw vendor SDK
// output through the appropriate per-vendor mapper and accumulates
// canonical messages into a per-invocation buffer. At end-of-invocation
// (writeTrajectoryIfEnabled, Part 6 §H) the buffer is consumed by
// buildCanonical and released.
//
// LRU sized for: 50 tenants × 50 agents × 4 active invocations ≈ 10K.
// ttl 1h covers worst-case (HITL pause holding a buffer through long
// approval delays); shorter ttl would silently drop trajectories on
// pauseable invocations.

import { LruCache } from '../infrastructure/lru-cache';
import type { ResolvedProvider } from '../agent-execution/adapter/types';
import {
  trajectory_unknown_block_type_total,
  trajectory_unmapped_replay_relevant_total,
} from '../observability/runtime-extensions-metrics';
import type { CanonicalMessage, CanonicalContentBlock } from './types';
import type { TrajectoryRecorder } from '../agent-execution/adapter/types';
import { anthropicSDKMessageToCanonical } from './per-vendor/anthropic';
import { openaiRunItemToCanonical } from './per-vendor/openai';
import { geminiResponseToCanonical } from './per-vendor/gemini';
import { codexThreadItemToCanonical } from './per-vendor/codex';
import { adkEventToCanonical } from './per-vendor/gemini-adk';
import { opencodePartToCanonical } from './per-vendor/opencode';
import { geminiCliEventToCanonical } from './per-vendor/gemini-cli';
import { logger as log } from '../infrastructure/logging';

export interface RecordedRun {
  messages: CanonicalMessage[];
  providerExtras: Record<string, unknown>;
  provider: ResolvedProvider;
  model: string;
  startedAt: number;
  /** Set of unknown block types observed across this run. Mappers add to it
   *  inside the same `recordRaw` call where the unknown block was seen.
   *  INFORMATIONAL — "a type was seen", not "the transcript is wrong". */
  unknownBlockTypes: Set<string>;
  /** Mirror of `unknownBlockTypes` for metric emission — once a type has
   *  been counted, it stays here so subsequent `recordRaw` calls don't
   *  re-count the same type each time. (Without this, the counter inc's
   *  on every recorded block after the first unknown block of any type.) */
  emittedUnknownTypes: Set<string>;
  /** Content a mapper DROPPED that replay needs. Separate from
   *  `unknownBlockTypes` because the two mean opposite things: one is a vendor
   *  block we have not classified yet, the other is a bug that makes this
   *  transcript unreplayable. Gates any per-engine replay rollout. */
  unmappedReplayRelevant: Set<string>;
  /** Emission dedup for `unmappedReplayRelevant`, same reason as above. */
  emittedReplayRelevant: Set<string>;
  /** Coalescing index for engines that stream CUMULATIVE content (OpenCode
   *  `message.part.updated`): key → index into `messages`. A repeat of a key
   *  REPLACES the message it points at instead of appending a new one. */
  openTextParts: Map<string, number>;
}

const buffers = new LruCache<string, RecordedRun>({
  max: 10_000,
  ttlMs: 60 * 60 * 1000,
});

type RecorderProvider = RecordedRun['provider'];

/** Increment the bounded unknown-block metric exactly once per genuinely-new
 * type for this run. Factored from the previously-inline emit logic so the
 * mapper-threw path, the unsupported-rawKind path, and the per-type sweep all
 * share one implementation and one dedup set. */
function emitUnknownOnce(run: RecordedRun, provider: RecorderProvider, blockType: string): void {
  if (run.emittedUnknownTypes.has(blockType)) return;
  run.unknownBlockTypes.add(blockType);
  run.emittedUnknownTypes.add(blockType);
  trajectory_unknown_block_type_total.inc({ provider, block_type: blockType });
}

/** Same dedup discipline as `emitUnknownOnce`, on the alertable counter. A hit
 * here means this run's canonical transcript is missing content that replay
 * needs — not that we saw a block we have not named yet. */
function emitReplayRelevantOnce(run: RecordedRun, provider: RecorderProvider, reason: string): void {
  if (run.emittedReplayRelevant.has(reason)) return;
  run.unmappedReplayRelevant.add(reason);
  run.emittedReplayRelevant.add(reason);
  trajectory_unmapped_replay_relevant_total.inc({ provider, reason });
}

/** Merge a mapper's per-call extras into the run's accumulated providerExtras.
 * Array-valued keys (raw-preservation buffers like `*_unmapped` / `unknown_blocks`
 * / `per_part_thought_signatures`) are CONCATENATED, not overwritten — otherwise
 * the per-event self-managing mappers (Codex/ADK/OpenCode call recordRaw once per
 * event) would keep only the LAST event's payloads and silently drop the rest
 * ("no event silently dropped"). Scalar/object keys still
 * last-write-wins, matching the previous Object.assign semantics. */
function mergeProviderExtras(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    // `message_scoped` is NOT run-level. Anything under it belongs to the
    // message being appended and is attached there by the caller before this
    // merge runs; concatenating it run-wide is exactly the bug that made
    // OpenAI's encrypted reasoning un-repairable with its own message.
    if (k === 'message_scoped') continue;
    const existing = target[k];
    target[k] = Array.isArray(existing) && Array.isArray(v) ? existing.concat(v) : v;
  }
}

/** Explicit unsupported policy. Records a rawKind the recorder
 * cannot map to canonical messages — a declared-but-not-yet-implemented kind
 * (codex_thread_item / adk_event / opencode_part, before its mapper is wired) or an
 * unexpected kind reaching the exhaustive default. NEVER throws: it counts the
 * kind on the bounded metric and returns, so a missing mapper can never
 * interrupt the adapter's invoke() loop. */
function recordUnknownRawKind(run: RecordedRun, provider: RecorderProvider, rawKind: string): void {
  emitUnknownOnce(run, provider, `unsupported_rawkind:${rawKind}`);
}

/** One place that constructs a RecordedRun, so a field added to the interface
 * cannot be initialised on one creation path and forgotten on the other. */
function newRun(provider: RecorderProvider, model: string): RecordedRun {
  return {
    messages: [],
    providerExtras: {},
    provider,
    model,
    startedAt: Date.now(),
    unknownBlockTypes: new Set(),
    emittedUnknownTypes: new Set(),
    unmappedReplayRelevant: new Set(),
    emittedReplayRelevant: new Set(),
    openTextParts: new Map(),
  };
}

export function makeRecorder(invocationId: string): TrajectoryRecorder {
  return {
    recordRaw: ({ provider, model, rawKind, raw }) => {
      let run = buffers.get(invocationId);
      if (!run) {
        run = newRun(provider, model);
        buffers.set(invocationId, run);
      }

      // Route raw vendor output to its per-vendor mapper. Two failure modes are
      // handled so a recorder problem can NEVER terminate the adapter's invoke()
      // loop: (1) a mapper that throws on a malformed payload is
      // caught below; (2) a declared-but-unmapped rawKind is routed to the
      // explicit unsupported policy. `mapped` stays undefined until a case
      // assigns it, and the post-switch write is guarded on it — so there is no
      // `message!` non-null access that can throw a TypeError.
      let mapped: {
        message: {
          role: 'user' | 'assistant';
          content: CanonicalContentBlock[];
          message_scoped?: Record<string, unknown>;
        };
        extras: Record<string, unknown>;
        coalesceKey?: string;
        /** How a message under `coalesceKey` joins the one already recorded:
         *  `replace` (the default — the payload is cumulative) or `concat`
         *  (the payload is a delta). See appendOrCoalesce. */
        coalesce?: 'replace' | 'concat';
        /** Keys whose streaming is over. The next message under one of them
         *  starts a new block rather than joining the finished one. */
        closeKeys?: string[];
      } | undefined;
      try {
        switch (rawKind) {
          case 'anthropic_sdk_message':
            mapped = anthropicSDKMessageToCanonical(raw, run.unknownBlockTypes);
            break;
          case 'openai_run_item':
            mapped = openaiRunItemToCanonical(raw, run.unknownBlockTypes, run.unmappedReplayRelevant);
            break;
          case 'gemini_response':
            mapped = geminiResponseToCanonical(raw, run.unknownBlockTypes);
            break;
          case 'codex_thread_item':
            mapped = codexThreadItemToCanonical(raw, run.unknownBlockTypes);
            break;
          case 'adk_event':
            mapped = adkEventToCanonical(raw, run.unknownBlockTypes);
            break;
          case 'opencode_part':
            mapped = opencodePartToCanonical(raw, run.unknownBlockTypes);
            break;
          case 'gemini_cli_event':
            mapped = geminiCliEventToCanonical(raw, run.unknownBlockTypes);
            break;
          default: {
            // Compile-time exhaustiveness: a new rawKind added to the union with
            // no case above fails typecheck right here. Runtime safety: an
            // unexpected kind is recorded as unknown, never thrown.
            const _exhaustive: never = rawKind;
            recordUnknownRawKind(run, provider, String(_exhaustive));
            return;
          }
        }
      } catch (err) {
        log.warn({ message: 'trajectory mapper threw', err: (err as Error).message, rawKind, invocationId });
        emitUnknownOnce(run, provider, 'recorder_threw');
        return;
      }
      // Emit the unknown-block counter ONCE per genuinely-new type the mapper
      // just appended to run.unknownBlockTypes, and the same for the alertable
      // replay-relevant counter.
      for (const t of run.unknownBlockTypes) emitUnknownOnce(run, provider, t);
      for (const r of run.unmappedReplayRelevant) emitReplayRelevantOnce(run, provider, r);
      if (mapped && mapped.message.content.length > 0) {
        appendOrCoalesce(run, mapped.message, mapped.coalesceKey, mapped.coalesce);
      }
      for (const key of mapped?.closeKeys ?? []) run.openTextParts.delete(key);
      if (mapped) mergeProviderExtras(run.providerExtras, mapped.extras);
    },
  };
}

/** Append a mapped message, unless the engine streams content under a key we
 * have already recorded — in which case JOIN it to that message in place.
 *
 * Two ways to join, and a mapper says which, because they are correct for
 * opposite payloads. OpenCode's `part.text` is CUMULATIVE — it grows over the
 * turn — so appending produced N growing prefixes of the same answer (see
 * per-vendor/opencode.ts) and the right join is REPLACE. The Gemini CLI's
 * `message` events are DELTAS — one chunk each — so replacing would keep only
 * the last chunk and the right join is CONCAT of the text. A mapper that
 * picked the wrong one would record an answer that is either N copies of
 * itself or its final word. */
function appendOrCoalesce(
  run: RecordedRun,
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[]; message_scoped?: Record<string, unknown> },
  coalesceKey?: string,
  coalesce: 'replace' | 'concat' = 'replace',
): void {
  if (coalesceKey !== undefined) {
    const existingIdx = run.openTextParts.get(coalesceKey);
    const existing = existingIdx !== undefined ? run.messages[existingIdx] : undefined;
    if (existing) {
      if (coalesce === 'replace') {
        run.messages[existingIdx!] = message;
        return;
      }
      const target = existing.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined;
      const delta = message.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined;
      if (target && delta) {
        target.text += delta.text;
        return;
      }
    }
    run.openTextParts.set(coalesceKey, run.messages.length);
  }
  run.messages.push(message);
}

export function getRun(invocationId: string): RecordedRun | undefined {
  return buffers.get(invocationId);
}

/** The canonical schema version the recorder writes. Kept beside the recorder
 *  rather than derived from `buildCanonical`, because a snapshot taken mid-run
 *  has no trajectory metadata yet and still has to record which schema its
 *  messages were shaped under. */
export const CANONICAL_SNAPSHOT_SCHEMA_VERSION = '1.1';

export interface CanonicalSnapshot {
  messages: CanonicalMessage[];
  schemaVersion: string;
  provider: RecorderProvider;
  model: string;
}

/** A point-in-time copy of a run's accumulated canonical conversation, for
 *  durable persistence mid-run.
 *
 *  Distinct from `buildCanonical`, which assembles the full at-rest document at
 *  end-of-run (system prompt, tool defs, outcome, metadata) and needs facts a
 *  mid-run checkpoint does not have. This returns only the conversation, which
 *  is what a resume actually replays.
 *
 *  Returns undefined when there is nothing to persist, so a caller can tell "no
 *  conversation captured" from "an empty conversation" — writing the latter over
 *  a good row would destroy the very thing the checkpoint exists to protect. */
export function snapshotCanonical(invocationId: string): CanonicalSnapshot | undefined {
  const run = buffers.get(invocationId);
  if (!run || run.messages.length === 0) return undefined;
  return {
    messages: run.messages,
    schemaVersion: CANONICAL_SNAPSHOT_SCHEMA_VERSION,
    provider: run.provider,
    model: run.model,
  };
}

export function releaseBuffer(invocationId: string): void {
  buffers.delete(invocationId);
}

/** Direct canonical-message write for synthetic captures that don't have a
 *  vendor-shaped raw payload (e.g. nested code_session inner runs in the
 *  OpenAI Codex / Gemini CLI subprocess paths, where the inner SDK output
 *  isn't reachable). Bypasses the per-vendor mappers and pushes the
 *  caller-built CanonicalMessage straight into the per-invocation buffer.
 *
 *  Use sparingly: this is the back door for captures that genuinely can't
 *  be reconstructed from raw vendor output. Adapters tapping their native
 *  SDK loop should keep using recordRaw. */
export function recordCanonicalMessage(
  invocationId: string,
  provider: ResolvedProvider,
  model: string,
  message: CanonicalMessage,
): void {
  if (message.content.length === 0) return;
  let run = buffers.get(invocationId);
  if (!run) {
    run = newRun(provider, model);
    buffers.set(invocationId, run);
  }
  run.messages.push(message);
}
