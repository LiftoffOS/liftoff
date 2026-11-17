// Durable read/write for the vendor-neutral conversation copy (migration 362).
//
// The native session artifact — Claude Agent SDK project JSONL — is owned by one
// engine, and `decideArtifactResume` returns `fallback` the moment the resuming
// engine is not that owner. `fallback` means START FRESH: the conversation is
// discarded, silently, with nothing recorded. These functions persist and read
// back the engine-neutral copy that makes the other choice possible.
//
// Deliberate properties:
//   · UPDATE, never INSERT. The canonical copy rides ALONGSIDE the native row
//     that saveRunSession / saveChatSessionJsonl owns; creating a row here would
//     produce a session with a conversation and no session id.
//   · Never writes an empty conversation. `snapshotCanonical` returns undefined
//     rather than an empty array precisely so a checkpoint that captured nothing
//     cannot overwrite a good row with nothing.
//   · Best-effort. A canonical write failing must never change the outcome of
//     the run it describes; the native path is unaffected either way.

import type { CanonicalMessage } from './types';
import { stampCanonicalArtifact, canonicalSerialize, sha256 } from '../agent-execution/session-artifact-envelope';
import type { ExecutionEngineId } from '../agent-execution/adapter/types';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** Which persisted session a canonical copy belongs to. The two tables key
 *  differently — chat_sessions on (thread_id, agent_id), agent_run_sessions on
 *  (trigger_key, agent_id) — so the scope carries both the table and its key
 *  rather than leaving a bare string that could address the wrong row. */
export type CanonicalScope =
  | { kind: 'chat'; threadId: string }
  | { kind: 'autonomous'; triggerKey: string };

export interface LoadedCanonicalArtifact {
  messages: CanonicalMessage[];
  schemaVersion: string;
  /** The engine that PRODUCED this conversation, read from the row's native
   *  ownership column. A cross-engine rebuild needs the source engine to know
   *  what to strip (signed reasoning, vendor-shaped tool-call ids), and the
   *  canonical payload itself is deliberately engine-neutral, so it cannot say. */
  sourceEngine: ExecutionEngineId;
}

/** Schema versions this reader understands. A row written under anything else is
 *  declined rather than interpreted under the wrong schema — the failure mode of
 *  guessing is a transcript that looks valid and is wrong. */
const SUPPORTED_CANONICAL_SCHEMA_VERSIONS = new Set(['1.1']);

function target(scope: CanonicalScope): { table: string; keyColumn: string; key: string } {
  return scope.kind === 'chat'
    ? { table: 'chat_sessions', keyColumn: 'thread_id', key: scope.threadId }
    : { table: 'agent_run_sessions', keyColumn: 'trigger_key', key: scope.triggerKey };
}

/** Add this turn's messages to the conversation already stored for a CHAT
 *  thread, rather than replacing it.
 *
 *  The two scopes need opposite writes, and the reason is the recorder's key.
 *  `snapshotCanonical` buffers per INVOCATION:
 *
 *    · an autonomous run is one invocation, so its buffer grows across the whole
 *      conversation and each checkpoint sees everything so far — replacing is
 *      correct, and appending would store every message as many times as the
 *      run checkpointed;
 *    · a chat THREAD is one invocation per turn, so a turn's buffer holds only
 *      that turn — replacing would leave a ten-turn thread storing turn ten and
 *      nothing else, and a rebuild from it would hand the model a single
 *      exchange presented as the entire history. Worse than a cold start,
 *      because it looks valid.
 *
 *  Read-modify-write, deliberately: the checksum is taken over the exact JSON
 *  the loader re-serializes, so it cannot be computed inside a concatenating
 *  UPDATE. Safe because turns on one thread are serialized by `chat_turn_locks`
 *  — two turns of the same thread do not run concurrently.
 *
 *  A stored copy that fails to load (unsupported version, checksum mismatch) is
 *  REPLACED rather than appended to. Appending to something we have declined to
 *  read would build a conversation on top of bytes we already decided not to
 *  trust. */
export async function appendCanonicalArtifact(
  scope: CanonicalScope,
  agentId: string,
  snapshot: { messages: CanonicalMessage[]; schemaVersion: string },
): Promise<void> {
  if (snapshot.messages.length === 0) return;
  const existing = await loadCanonicalArtifact(scope, agentId);
  const merged = existing?.messages?.length
    ? { messages: [...existing.messages, ...snapshot.messages], schemaVersion: snapshot.schemaVersion }
    : snapshot;
  await saveCanonicalArtifact(scope, agentId, merged);
}

/** Persist the canonical conversation onto the session row that already exists
 *  for this (scope, agent). No-op when there is no such row yet: the native
 *  save creates it, and this runs alongside rather than ahead of it. */
export async function saveCanonicalArtifact(
  scope: CanonicalScope,
  agentId: string,
  snapshot: { messages: CanonicalMessage[]; schemaVersion: string },
): Promise<void> {
  if (snapshot.messages.length === 0) return;
  const { table, keyColumn, key } = target(scope);
  const stamp = stampCanonicalArtifact(snapshot.messages, snapshot.schemaVersion);
  try {
    const pool = getPoolForService('scheduled-execution');
    // agent_id is uuid on agent_run_sessions and text on chat_sessions; the
    // cast is applied per table rather than to the parameter so neither shape
    // has to be coerced at the call site.
    const agentPredicate = scope.kind === 'chat' ? 'agent_id = $2' : 'agent_id = $2::uuid';
    await pool.query(
      `UPDATE ${table}
          SET canonical_content        = $3::jsonb,
              canonical_schema_version = $4,
              canonical_sha256         = $5,
              updated_at               = NOW()
        WHERE ${keyColumn} = $1 AND ${agentPredicate}`,
      [key, agentId, stamp.canonical_content, stamp.canonical_schema_version, stamp.canonical_sha256],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, scope: scope.kind, agentId },
      'saveCanonicalArtifact failed (non-fatal — the native artifact path is unaffected)',
    );
  }
}

/** Read the canonical conversation for this (scope, agent), or undefined when
 *  there is none, it is unreadable, or its checksum does not match.
 *
 *  A checksum mismatch returns undefined rather than throwing: the caller's
 *  alternative is today's cold start, and a corrupt canonical copy must degrade
 *  to that rather than take the run down. It is logged at warn so the corruption
 *  is still visible. */
export async function loadCanonicalArtifact(
  scope: CanonicalScope,
  agentId: string,
): Promise<LoadedCanonicalArtifact | undefined> {
  const { table, keyColumn, key } = target(scope);
  try {
    const pool = getPoolForService('scheduled-execution');
    const agentPredicate = scope.kind === 'chat' ? 'agent_id = $2' : 'agent_id = $2::uuid';
    const r = await pool.query<{
      canonical_content: unknown;
      canonical_schema_version: string | null;
      canonical_sha256: string | null;
      execution_engine: string | null;
    }>(
      `SELECT canonical_content, canonical_schema_version, canonical_sha256, execution_engine
         FROM ${table}
        WHERE ${keyColumn} = $1 AND ${agentPredicate} AND expires_at > NOW()`,
      [key, agentId],
    );
    if (r.rows.length === 0) return undefined;
    const row = r.rows[0];
    if (!row.canonical_content) return undefined;

    const version = row.canonical_schema_version ?? '';
    if (!SUPPORTED_CANONICAL_SCHEMA_VERSIONS.has(version)) {
      logger.warn(
        { scope: scope.kind, agentId, version, event: 'canonical_artifact_unsupported_version' },
        'canonical conversation is under an unsupported schema version — declining it',
      );
      return undefined;
    }

    const messages = row.canonical_content as CanonicalMessage[];
    if (!Array.isArray(messages) || messages.length === 0) return undefined;

    // Compared over the ORDER-INDEPENDENT serialization, on both sides.
    //
    // Re-serializing with plain JSON.stringify was the original approach and it
    // could never match: jsonb sorts object keys, so a payload written as
    // {"type":..,"text":..} reads back as {"text":..,"type":..} and hashes
    // differently while being identical content. Every canonical row was
    // therefore declined as corrupt, which is why the cross-engine rebuild had
    // never once fired.
    if (row.canonical_sha256 && row.canonical_sha256 !== sha256(canonicalSerialize(messages))) {
      logger.warn(
        { scope: scope.kind, agentId, event: 'canonical_artifact_checksum_mismatch' },
        'canonical conversation checksum did not match — declining it and cold-starting',
      );
      return undefined;
    }

    return {
      messages,
      schemaVersion: version,
      // A pre-binding row with no recorded owner is claude-agent-sdk: it is the
      // only engine that has ever written these tables. Matches the same
      // defaulting decideArtifactResume makes, for the same reason.
      sourceEngine: (row.execution_engine as ExecutionEngineId | null) ?? 'claude-agent-sdk',
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, scope: scope.kind, agentId },
      'loadCanonicalArtifact failed (non-fatal — the caller cold-starts)',
    );
    return undefined;
  }
}
