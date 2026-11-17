// The canonical transcript, checkpointed WITH the pause (migration 414).
//
// A paused run resumes from a transcript, and until now that transcript was
// bound to a session, not to the pause. `saveCanonicalArtifact` is an UPDATE
// onto the session row the native artifact owns, so an engine that produces no
// native session has no row for it to hit; the row it does hit is keyed by a
// thread or trigger many pauses share, so its bytes may be an earlier turn's;
// and it is fire-and-forget, so awaiting it proves nothing. The resume then
// replayed the flattened `conversationHistory` snapshot, as prose.
//
// This module gives the checkpoint its own row, one per pause, keyed by the
// pause row's id and written BEFORE that row: the pause payload carries
// `{ id, sha256, messageCount }` (or `{ failed }` with the reason), and the
// resume loads the row named by the pause it is resuming and verifies the
// tenant, the agent, the sha and the paused invocation. Freshness is by
// construction rather than by inference.
//
// The record the checkpoint holds ends on the gated call: the recorder saw the
// engine propose it and nothing answer it. `repairForReplay` would answer it
// with "No result provided", which is the one thing the resume knows better,
// so the pending call is COMPLETED in the record first (the approved result,
// the rejection, or the wake marker), then repaired, then converted for the
// engine the resume runs on. Order is load-bearing: a cross-engine repair
// renumbers tool-call ids, and it renumbers a complete pair together.

import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { snapshotCanonical } from '../trajectories/recorder';
import type { CanonicalContentBlock, CanonicalMessage } from '../trajectories/types';
import { repairForReplay } from '../trajectories/repair';
import { canonicalToEngine, inverseMapperShipped } from '../trajectories/inverse';
import { stampCanonicalArtifact, canonicalSerialize, sha256 } from './session-artifact-envelope';
import { boundToolText, maxChars } from './adapter/tool-result-bound';
import { normalizeToolName } from '../hitl-enforcement/tool-name-resolution';
import { canonicalJson } from './sideeffect-idempotency';
import type { ExecutionEngineId, PlatformMessage, ResolvedProvider } from './adapter/types';

/** What the pause payload carries about its checkpoint: the row it wrote, or
 *  why it wrote none. A resume that reads `failed` takes the snapshot path with
 *  that reason on its decision line. */
export type PauseCheckpointRef =
  | { id: string; sha256: string; messageCount: number }
  | { failed: string };

/** Where a pause site's checkpoint comes from: the recorder buffer the
 *  conversational loop registered for this run, and the engine, provider and
 *  model the loop ran on. Built once per loop, handed to each pause site. */
export interface PauseCheckpointSource {
  /** The key the loop registered its recorder under (`invocationIdForRegistry`). */
  recorderInvocationId: string;
  /** Whether the adapter registered a recorder at all. Without one the record
   *  holds only what the loop wrote itself, which is not the conversation. */
  recorderRegistered: boolean;
  engine: ExecutionEngineId;
  provider: ResolvedProvider;
  model: string;
}

/** Schema versions the loader understands; anything else is declined rather
 *  than read under the wrong shape. Mirrors canonical-artifact.ts. */
const SUPPORTED_CANONICAL_SCHEMA_VERSIONS = new Set(['1.1']);

/** Write the checkpoint for the pause row `pauseId` is about to become.
 *
 *  Awaited by the caller BEFORE the pause row is inserted, and the insert's row
 *  count is checked: a pause that exists either carries a checkpoint or says
 *  why it does not. Never throws — a checkpoint that cannot be written must
 *  not stop the pause, whose row is what the person's decision lands on. */
export async function writePauseCheckpoint(args: {
  tenantId: string;
  agentId: string;
  pauseId: string;
  invocationId: string | null;
  source: PauseCheckpointSource;
}): Promise<PauseCheckpointRef> {
  if (!args.source.recorderRegistered) return { failed: 'no recorder' };
  const snapshot = snapshotCanonical(args.source.recorderInvocationId);
  if (!snapshot) return { failed: 'no canonical record' };
  const stamp = stampCanonicalArtifact(snapshot.messages, snapshot.schemaVersion);
  try {
    const rowCount = await withTenantScope(
      args.tenantId,
      async (client) => {
        const r = await client.query(
          `INSERT INTO pause_checkpoints
             (tenant_id, pause_id, invocation_id, agent_id, execution_engine, provider, model,
              canonical_content, canonical_schema_version, canonical_sha256, message_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
          [
            args.tenantId, args.pauseId, args.invocationId, args.agentId,
            args.source.engine, args.source.provider, args.source.model,
            stamp.canonical_content, stamp.canonical_schema_version, stamp.canonical_sha256,
            snapshot.messages.length,
          ],
        );
        return r.rowCount ?? 0;
      },
      'scheduled-execution',
    );
    if (rowCount !== 1) return { failed: `insert wrote ${rowCount} rows` };
    return { id: args.pauseId, sha256: stamp.canonical_sha256, messageCount: snapshot.messages.length };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: args.tenantId, agentId: args.agentId, pauseId: args.pauseId },
      'pause checkpoint insert failed; the pause carries the reason and its resume replays the snapshot',
    );
    return { failed: `insert failed: ${(err as Error).message}` };
  }
}

/** Remove a checkpoint whose pause row never landed (a clarification that
 *  deduplicated onto an earlier open row). Best-effort: an orphan expires on
 *  its own, this only keeps the table honest sooner. */
export async function discardPauseCheckpoint(tenantId: string, pauseId: string): Promise<void> {
  try {
    await withTenantScope(
      tenantId,
      (client) => client.query(`DELETE FROM pause_checkpoints WHERE tenant_id = $1 AND pause_id = $2`, [tenantId, pauseId]),
      'scheduled-execution',
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId, pauseId }, 'orphan pause checkpoint not removed; it expires with its window');
  }
}

export interface LoadedPauseCheckpoint {
  messages: CanonicalMessage[];
  sha256: string;
  messageCount: number;
  /** The engine that PRODUCED the record, for the cross-engine repair. */
  sourceEngine: ExecutionEngineId;
  provider: string;
  model: string;
}

export type PauseCheckpointLoad =
  | { ok: true; checkpoint: LoadedPauseCheckpoint }
  | { ok: false; reason: string };

/** Load the checkpoint for the pause being resumed and verify it is THIS
 *  pause's: the payload names the resumed row, the row belongs to this
 *  tenant and agent, its sha is the one the payload carries, and its
 *  invocation is the one that paused. Any miss is a reason for the snapshot
 *  path, never an error: the snapshot is what every resume replayed until now. */
export async function loadPauseCheckpoint(args: {
  tenantId: string;
  agentId: string;
  /** The pause row being resumed. */
  pauseId: string;
  /** The invocation that paused, as the pause row records it. */
  pausedInvocationId: string | null;
  ref: PauseCheckpointRef | undefined;
}): Promise<PauseCheckpointLoad> {
  const { ref } = args;
  // A pause written before the checkpoint existed, or by a site that writes
  // none (a workflow step; the wake and delegation pauses an approved call
  // raises from the resume itself).
  if (!ref) return { ok: false, reason: 'pause carries no checkpoint' };
  if ('failed' in ref) return { ok: false, reason: `checkpoint failed at the pause: ${ref.failed}` };
  if (ref.id !== args.pauseId) return { ok: false, reason: 'checkpoint id is not the pause being resumed' };
  try {
    const rows = await withTenantScope(
      args.tenantId,
      async (client) => {
        const r = await client.query<{
          agent_id: string;
          invocation_id: string | null;
          execution_engine: string;
          provider: string;
          model: string;
          canonical_content: unknown;
          canonical_schema_version: string;
          canonical_sha256: string;
          message_count: number;
        }>(
          `SELECT agent_id, invocation_id, execution_engine, provider, model,
                  canonical_content, canonical_schema_version, canonical_sha256, message_count
             FROM pause_checkpoints
            WHERE tenant_id = $1 AND pause_id = $2 AND expires_at > NOW()`,
          [args.tenantId, args.pauseId],
        );
        return r.rows;
      },
      'scheduled-execution',
    );
    if (rows.length === 0) return { ok: false, reason: 'checkpoint row missing or expired' };
    const row = rows[0];
    if (row.agent_id !== args.agentId) return { ok: false, reason: 'checkpoint belongs to another agent' };
    if (row.canonical_sha256 !== ref.sha256) return { ok: false, reason: 'checkpoint sha256 differs from the one the pause carries' };
    // Both sides must NAME an invocation: two NULLs are two absences, not a
    // match, and a checkpoint that cannot be bound to the paused invocation is
    // not replayed.
    if (!row.invocation_id || !args.pausedInvocationId) {
      return { ok: false, reason: 'checkpoint invocation cannot be verified' };
    }
    if (row.invocation_id !== args.pausedInvocationId) {
      return { ok: false, reason: 'checkpoint invocation is not the paused invocation' };
    }
    if (!SUPPORTED_CANONICAL_SCHEMA_VERSIONS.has(row.canonical_schema_version)) {
      return { ok: false, reason: `checkpoint schema version ${row.canonical_schema_version} is not supported` };
    }
    const messages = row.canonical_content as CanonicalMessage[];
    if (!Array.isArray(messages) || messages.length === 0) return { ok: false, reason: 'checkpoint holds no messages' };
    // Integrity, over the order-independent serialization on both sides: jsonb
    // sorts keys, so a hash over the write-time JSON.stringify could never
    // match one over the read-back bytes (see canonical-artifact.ts).
    if (sha256(canonicalSerialize(messages)) !== row.canonical_sha256) {
      return { ok: false, reason: 'checkpoint content does not match its sha256' };
    }
    return {
      ok: true,
      checkpoint: {
        messages,
        sha256: row.canonical_sha256,
        messageCount: Number(row.message_count),
        sourceEngine: row.execution_engine as ExecutionEngineId,
        provider: row.provider,
        model: row.model,
      },
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: args.tenantId, pauseId: args.pauseId },
      'pause checkpoint load failed; the resume replays the snapshot',
    );
    return { ok: false, reason: `checkpoint load failed: ${(err as Error).message}` };
  }
}

/** A call the pause stamped, in the shape both the HITL and the wake payloads
 *  carry it. */
export interface PendingCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function toolUseBlocks(messages: CanonicalMessage[]): Array<Extract<CanonicalContentBlock, { type: 'tool_use' }>> {
  const out: Array<Extract<CanonicalContentBlock, { type: 'tool_use' }>> = [];
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_use') out.push(b);
  return out;
}

function answeredCallIds(messages: CanonicalMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_result') out.add(b.tool_use_id);
  return out;
}

/** The record's `tool_use` for a call the pause stamped, or undefined when the
 *  record does not hold it.
 *
 *  By id first: the gate stamps the engine's own id on a pending call wherever
 *  the engine has one at the gate (the Claude SDK's toolUseID, the model's
 *  call id on the bridge engines), and the wake and delegation pauses carry
 *  the engine's id from the call that produced them, so the pause and the
 *  record name the same block.
 *
 *  Then by the call itself, for the pauses whose id is not the record's: a
 *  gate raised inside the in-process gateway names no engine call, and the
 *  CLI engines dispatch through an HTTP proxy that issues an id of its own.
 *  The call is still in the record, proposed by the engine, and it is found by
 *  what the model actually sent — the same tool, the same arguments. An
 *  UNANSWERED match is preferred, last one first, which is the call the gate
 *  stopped on; an answered match is taken only when there is no unanswered
 *  one, which is the wake call an engine reported before the pause. */
export function findPendingCallInRecord(
  messages: CanonicalMessage[],
  call: PendingCall,
): Extract<CanonicalContentBlock, { type: 'tool_use' }> | undefined {
  const uses = toolUseBlocks(messages);
  const byId = uses.find((b) => b.id === call.id);
  if (byId) return byId;
  const answered = answeredCallIds(messages);
  const wanted = `${normalizeToolName(call.name)}|${canonicalJson(call.input ?? {})}`;
  const matches = uses.filter((b) => `${normalizeToolName(b.name)}|${canonicalJson(b.input ?? {})}` === wanted);
  for (let i = matches.length - 1; i >= 0; i--) {
    if (!answered.has(matches[i].id)) return matches[i];
  }
  return matches.length > 0 ? matches[matches.length - 1] : undefined;
}

/** A pending call's answer, ready to be written into the record as the
 *  `tool_result` for the record's own id. */
export interface PendingCallCompletion {
  /** The record's tool_use id — from findPendingCallInRecord, never the pause's. */
  recordCallId: string;
  name: string;
  content: string;
  isError: boolean;
  /** What was actually dispatched, when a reviewer rewrote the call before
   *  approving it. The record holds the model's draft; a transcript that
   *  records the draft as the thing that was sent is a lie the model reasons
   *  from next turn, so the block is rewritten to the call that ran. */
  input?: Record<string, unknown>;
}

/** What a completion does with an answer the record ALREADY holds for its
 *  call. The record answers a pending call whenever the engine saw a result
 *  before the pause tore the turn down: the bridge answers a gated call with
 *  its refusal, a delegation call with the pending marker, and a wake call
 *  with the wake marker, and the CLI engines — dispatching through the HTTP
 *  proxy, which cannot abort the CLI's turn — record every one of them.
 *
 *  `replace`: the answer in the record is a placeholder for a decision that
 *  had not been made yet — the refusal a reviewer has since approved past,
 *  the marker of a fan-out that has since finished. It is rewritten in
 *  place with what actually happened, so the model never reads that its
 *  approved call was refused.
 *
 *  `keep`: the answer in the record IS the call's result — the wake tool
 *  returned its marker and the run stopped as asked — and the continuation
 *  turn, not the result, carries what happened next. */
export type RecordedAnswer = 'replace' | 'keep';

/** Complete the pending calls in the record, BEFORE repair.
 *
 *  One user message carrying every result the record does not already hold,
 *  which is the shape a provider requires: every tool_use of a turn answered
 *  in the message that follows it. A call the record already answers is
 *  rewritten in place or left as it is by `recordedAnswer`, so no call ever
 *  gets two results. Nothing is appended when there is nothing to append.
 *  The caller's messages are never mutated. */
export function completePendingCalls(
  messages: CanonicalMessage[],
  completions: PendingCallCompletion[],
  recordedAnswer: RecordedAnswer,
): CanonicalMessage[] {
  const rewrites = new Map(completions.filter((c) => c.input !== undefined).map((c) => [c.recordCallId, c.input!]));
  const answered = answeredCallIds(messages);
  const replacements = new Map<string, PendingCallCompletion>();
  if (recordedAnswer === 'replace') {
    for (const c of completions) if (answered.has(c.recordCallId) && !replacements.has(c.recordCallId)) replacements.set(c.recordCallId, c);
  }
  const out: CanonicalMessage[] = rewrites.size === 0 && replacements.size === 0
    ? [...messages]
    : messages.map((m) => ({
        ...m,
        content: m.content.map((b) => {
          if (b.type === 'tool_use' && rewrites.has(b.id)) return { ...b, input: rewrites.get(b.id)! };
          if (b.type === 'tool_result' && replacements.has(b.tool_use_id)) return resultBlock(replacements.get(b.tool_use_id)!);
          return b;
        }),
      }));
  const seen = new Set<string>();
  const blocks: CanonicalContentBlock[] = [];
  for (const c of completions) {
    if (answered.has(c.recordCallId) || seen.has(c.recordCallId)) continue;
    seen.add(c.recordCallId);
    blocks.push(resultBlock(c));
  }
  if (blocks.length === 0) return out;
  return [...out, { role: 'user', content: blocks }];
}

function resultBlock(c: PendingCallCompletion): CanonicalContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: c.recordCallId,
    name: c.name,
    content: c.content,
    ...(c.isError ? { is_error: true } : {}),
  };
}

/** Bound each tool result to the same cap the model-facing result gets, so a
 *  replayed transcript never carries more than the model was shown. Applied to
 *  the canonical blocks, ahead of conversion, so every engine's rendering —
 *  native or preamble — reads the bounded text. Shared with the cross-engine
 *  rebuild off the session tables, which replays the same kind of record. */
export function boundCanonicalToolResults(messages: CanonicalMessage[]): CanonicalMessage[] {
  const max = maxChars();
  return messages.map((m) => ({
    ...m,
    content: m.content.map((b) => {
      if (b.type !== 'tool_result') return b;
      if (typeof b.content === 'string') return { ...b, content: boundToolText(b.content, max) };
      return {
        ...b,
        content: b.content.map((inner) => (inner.type === 'text' ? { ...inner, text: boundToolText(inner.text, max) } : inner)),
      };
    }),
  }));
}

/** Exactly one tool result per tool use, and no result for a call that is not
 *  there. The property the whole ordering exists to keep, asserted on what the
 *  adapter is handed rather than assumed. */
function toolPairingFault(messages: PlatformMessage[]): string | undefined {
  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === 'tool_use') uses.set(c.callId, (uses.get(c.callId) ?? 0) + 1);
      if (c.type === 'tool_result') results.set(c.callId, (results.get(c.callId) ?? 0) + 1);
    }
  }
  for (const [id, n] of uses) {
    const r = results.get(id) ?? 0;
    if (n !== 1) return `tool_use ${id} appears ${n} times`;
    if (r !== 1) return `tool_use ${id} has ${r} results`;
  }
  for (const id of results.keys()) {
    if (!uses.has(id)) return `tool_result ${id} answers no tool_use`;
  }
  return undefined;
}

export type CheckpointConversion =
  | { ok: true; messages: PlatformMessage[] }
  | { ok: false; reason: string };

/** The completed record, repaired for `targetEngine` and converted into that
 *  engine's platform messages, each tool result bounded. Undefined-shaped
 *  failures become a reason: no inverse mapper, a repair that left nothing, or
 *  a pairing the assertion refuses. */
export function checkpointToAdapterInput(
  messages: CanonicalMessage[],
  opts: { sourceEngine: ExecutionEngineId; targetEngine: ExecutionEngineId },
): CheckpointConversion {
  if (!inverseMapperShipped(opts.targetEngine)) {
    return { ok: false, reason: `no inverse mapper for ${opts.targetEngine}` };
  }
  const repaired = repairForReplay(messages, {
    sourceEngine: opts.sourceEngine,
    targetEngine: opts.targetEngine,
    // Conservative, as rebuildFromCanonical is: an engine not proven to read
    // images gets a placeholder line rather than a rejected conversation.
    targetSupportsImages: false,
  });
  if (repaired.length === 0) return { ok: false, reason: 'repair left no messages' };
  const converted = canonicalToEngine(opts.targetEngine, boundCanonicalToolResults(repaired));
  if (!converted || converted.length === 0) return { ok: false, reason: 'conversion produced no messages' };
  const fault = toolPairingFault(converted);
  if (fault) return { ok: false, reason: `tool pairing violated: ${fault}` };
  return { ok: true, messages: converted };
}

/** What a resumed run carries into the conversational loop when its transcript
 *  came from the checkpoint: the record through the completed pending call
 *  (for the recorder, so the run's NEXT checkpoint holds the whole
 *  conversation) and the same record converted for the engine (for the
 *  adapter). Attached to the execution context by the two resume readers. */
export interface ResumeTranscript {
  canonical: CanonicalMessage[];
  messages: PlatformMessage[];
  /** The same record in the shape a pause payload persists, so a pause the
   *  resumed run raises in turn snapshots the WHOLE conversation onto its
   *  payload — the run's own history starts empty on this path, and a
   *  snapshot taken from it alone would begin at the continuation. */
  snapshot: PersistedTurn[];
  sha256: string;
  messageCount: number;
}

/** One turn of the transcript a pause payload persists: the shape of
 *  `HybridResumeState.conversationHistory`, declared here so the renderer
 *  below does not depend on the service module. */
export interface PersistedTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

/** The canonical record as persisted turns: an assistant message becomes one
 *  turn carrying its text and its calls, a user message its text turn and one
 *  `tool` turn per result it answers. The same shape `approvedExchange` and
 *  `wakeExchangeFor` append, so a snapshot built on it replays through the
 *  same path every snapshot does. */
export function canonicalToPersistedTranscript(messages: CanonicalMessage[]): PersistedTurn[] {
  const names = new Map<string, string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  const out: PersistedTurn[] = [];
  for (const m of messages) {
    const text = m.content
      .flatMap((b) => (b.type === 'text' || b.type === 'refusal' ? [b.text] : b.type === 'thinking' && b.thinking ? [b.thinking] : []))
      .join('\n');
    if (m.role === 'assistant') {
      const toolCalls = m.content
        .filter((b): b is Extract<CanonicalContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      if (text || toolCalls.length > 0) out.push({ role: 'assistant', content: text, ...(toolCalls.length > 0 ? { toolCalls } : {}) });
      continue;
    }
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const content = typeof b.content === 'string'
        ? b.content
        : b.content.flatMap((inner) => (inner.type === 'text' ? [inner.text] : [])).join('\n');
      out.push({ role: 'tool', toolCallId: b.tool_use_id, toolName: b.name ?? names.get(b.tool_use_id) ?? '', content });
    }
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

/** The texts a resumed transcript carries, for provenance: what the paused
 *  half read is what the resumed half may name. Text blocks and tool results,
 *  which is where identifiers arrive. */
export function resumeTranscriptTexts(messages: PlatformMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type === 'text' && c.text) out.push(c.text);
      if (c.type === 'tool_result') out.push(typeof c.result === 'string' ? c.result : JSON.stringify(c.result ?? ''));
    }
  }
  return out;
}
