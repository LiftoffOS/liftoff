// Autonomous crash-resume — persist + restore the SDK session for autonomous runs
// (plan §4.10 Part C). Mirrors the live chat_sessions externalization
// (interactive-chat/chat-turn-handler) but keyed (trigger_key, agent_id) so a
// Cloud Tasks retry / Pub/Sub redelivery of the SAME trigger resumes the exact
// conversation (resumeSessionId) rather than restarting from scratch — and
// idempotency (§4.2/§4.7) replays any in-flight side effect deterministically.
//
// Gated by AUTONOMOUS_RESUME_ENABLED at the call site; this module is pure I/O.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { stampClaudeArtifact, decideArtifactResume, type PersistedArtifactEnvelope, type ArtifactResumeDecision } from './session-artifact-envelope';
import type { ExecutionEngineId, PlatformMessage } from './adapter/types';
import { loadCanonicalArtifact, type CanonicalScope } from '../trajectories/canonical-artifact';
import { repairForReplay } from '../trajectories/repair';
import { canonicalToEngine, inverseMapperShipped } from '../trajectories/inverse';
import { boundCanonicalToolResults } from './pause-checkpoint';

export function isAutonomousResumeEnabled(): boolean {
  return process.env.AUTONOMOUS_RESUME_ENABLED === '1';
}

/** Deterministic per-(trigger) cwd so a retry restores the JSONL to the same
 *  path the SDK's `resume` looks for. Sanitized + length-bounded. */
export function autonomousSessionDir(triggerKey: string): string {
  const safe = triggerKey.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  return path.join(os.tmpdir(), 'tr-run-sessions', safe);
}

// Mirror the Claude Agent SDK's project-dir encoding ('/' -> '-').
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}
function buildJsonlPath(sessionStateDir: string, sdkSessionId: string): string {
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, '.claude', 'projects', encodeProjectDir(sessionStateDir), `${sdkSessionId}.jsonl`);
}

function pool() {
  return getPoolForService('scheduled-execution');
}

export interface RunSessionRow {
  sdkSessionId: string;
  jsonlContent: string;
}

/** Load the persisted autonomous session AND decide whether its native artifact
 *  may be restored for `resumeEngine` — the engine the CURRENT run resolves to.
 *  Returns the row only for a compatible native resume; otherwise returns
 *  undefined (so the caller starts a fresh session) with the decision surfaced on
 *  `outDecision` for the caller to classify. Ownership is read from the persisted
 *  row, never inferred from the live provider. */
export async function loadRunSession(
  triggerKey: string,
  agentId: string,
  resumeEngine: ExecutionEngineId,
  outDecision?: { decision?: ArtifactResumeDecision },
): Promise<RunSessionRow | undefined> {
  try {
    const r = await pool().query<{ sdk_session_id: string; jsonl_content: string } & PersistedArtifactEnvelope>(
      // A retired session is one a previous run ended by reporting that its
      // context window was full. Resuming it would reproduce that exactly, and
      // every later run on this trigger would die the same way. Skipped here
      // rather than deleted so an operator can still see what happened.
      `SELECT sdk_session_id, jsonl_content,
              execution_engine, artifact_format, artifact_format_version,
              producer_runtime_version, artifact_sha256
       FROM agent_run_sessions
       WHERE trigger_key = $1 AND agent_id = $2::uuid AND expires_at > NOW()
         AND retired_session_id IS DISTINCT FROM sdk_session_id`,
      [triggerKey, agentId],
    );
    if (r.rows.length === 0) return undefined;
    const row = r.rows[0];
    const decision = decideArtifactResume(row, row.jsonl_content, resumeEngine);
    if (outDecision) outDecision.decision = decision;
    if (decision.decision === 'fail') {
      // Corrupt / unsupported-version artifact — EXPLICIT failure. Quarantine the
      // poisoned row so it cannot recur, log at error, then start fresh. The
      // outDecision above still lets a pause/resume caller classify it.
      logger.error(
        { triggerKey, resumeEngine, failureClass: decision.failureClass, reason: decision.reason, event: 'session_artifact_quarantined' },
        'agent_run_sessions artifact FAILED validation (corrupt/unsupported) — quarantining the row',
      );
      // C10 — move, do not destroy. Single statement so the row cannot be both
      // deleted and unrecorded.
      await pool().query(
        `WITH moved AS (
           DELETE FROM agent_run_sessions
            WHERE trigger_key = $1 AND agent_id = $2::uuid
            RETURNING *
         )
         INSERT INTO quarantined_session_artifacts (
           source_table, key_a, key_b, sdk_session_id, jsonl_content,
           execution_engine, artifact_format, artifact_format_version,
           producer_runtime_version, artifact_sha256,
           failure_class, reason, resume_engine
         )
         SELECT 'agent_run_sessions', $1::text, $2::text, moved.sdk_session_id, moved.jsonl_content,
                moved.execution_engine, moved.artifact_format, moved.artifact_format_version,
                moved.producer_runtime_version, moved.artifact_sha256,
                $3, $4, $5
           FROM moved`,
        [triggerKey, agentId, decision.failureClass ?? null, decision.reason ?? null, resumeEngine],
      ).catch((e) => logger.warn({ err: (e as Error).message, triggerKey }, 'agent_run_sessions quarantine move failed'));
      return undefined;
    }
    if (decision.decision !== 'native') {
      // 'fallback' — owned by a different engine (expected on a provider switch).
      logger.warn(
        { triggerKey, resumeEngine, reason: decision.reason },
        'agent_run_sessions artifact not a native resume for this engine — starting a fresh session (certified fallback)',
      );
      return undefined;
    }
    return { sdkSessionId: row.sdk_session_id, jsonlContent: row.jsonl_content };
  } catch (err) {
    logger.warn({ err: (err as Error).message, triggerKey }, 'loadRunSession failed (non-fatal — fresh session)');
    return undefined;
  }
}

/** Returns whether the session was durably written. Callers that must know a
 *  resume can rely on the persisted session (a workflow adapter-step pause) read
 *  it; the conversational checkpoint ignores it and stays fire-and-forget. */
export async function saveRunSession(
  triggerKey: string,
  agentId: string,
  sdkSessionId: string,
  jsonlContent: string,
): Promise<boolean> {
  try {
    // Stamp the native-artifact envelope (engine ownership + Liftoff format
    // version + producer runtime + sha256) so a resume can validate before restore.
    const a = stampClaudeArtifact(jsonlContent);
    await pool().query(
      `INSERT INTO agent_run_sessions (trigger_key, agent_id, sdk_session_id, jsonl_content, expires_at, updated_at,
           execution_engine, artifact_format, artifact_format_version, producer_runtime_version, artifact_sha256)
       VALUES ($1, $2::uuid, $3, $4, NOW() + INTERVAL '7 days', NOW(), $5, $6, $7, $8, $9)
       ON CONFLICT (trigger_key, agent_id) DO UPDATE
         SET sdk_session_id = EXCLUDED.sdk_session_id,
             jsonl_content  = EXCLUDED.jsonl_content,
             expires_at     = EXCLUDED.expires_at,
             updated_at     = NOW(),
             execution_engine         = EXCLUDED.execution_engine,
             artifact_format          = EXCLUDED.artifact_format,
             artifact_format_version  = EXCLUDED.artifact_format_version,
             producer_runtime_version = EXCLUDED.producer_runtime_version,
             artifact_sha256          = EXCLUDED.artifact_sha256,
             -- A NEW conversation clears the retirement; the retired one does
             -- not. Both halves matter:
             --
             --   * Without the clear, the fresh session this row now holds would
             --     be skipped as if it were the saturated one, and the trigger
             --     could never resume again.
             --   * Without the guard, a checkpoint still in flight when the run
             --     ended — persistAutonomousSession is fire-and-forget after
             --     every tool call — could land AFTER retireRunSession and
             --     resurrect the exact session we just abandoned.
             --
             -- Comparing against the INCOMING session id is what separates them:
             -- same id means the same conversation, so the retirement stands.
             retired_session_id       =
               CASE WHEN agent_run_sessions.retired_session_id IS DISTINCT FROM EXCLUDED.sdk_session_id
                    THEN NULL
                    ELSE agent_run_sessions.retired_session_id
               END`,
      [triggerKey, agentId, sdkSessionId, jsonlContent,
       a.execution_engine, a.artifact_format, a.artifact_format_version, a.producer_runtime_version, a.artifact_sha256],
    );
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message, triggerKey }, 'saveRunSession failed (non-fatal)');
    return false;
  }
}

/** Abandon a session that can no longer be resumed.
 *
 *  The autonomous path checkpoints after EVERY tool call, so by the time a run
 *  ends there is already a persisted row and there was no final output to check
 *  when it was written. The chat path can guard its single write; this one has
 *  to undo one — hence retire-after-the-fact rather than skip-before.
 *
 *  Deliberately a flag and not a DELETE. The artifact is the evidence for why a
 *  trigger suddenly started from scratch, and throwing it away would leave the
 *  next person with a gap and no explanation. Best-effort: failing to retire
 *  costs the NEXT run one wasted attempt, and must never fail the run that just
 *  finished. */
export async function retireRunSession(
  triggerKey: string,
  agentId: string,
  sdkSessionId: string,
  reason: string,
): Promise<void> {
  try {
    await pool().query(
      `UPDATE agent_run_sessions
          SET retired_session_id = sdk_session_id, updated_at = NOW()
        WHERE trigger_key = $1 AND agent_id = $2::uuid AND sdk_session_id = $3`,
      [triggerKey, agentId, sdkSessionId],
    );
    logger.warn(
      { event: 'agent_run_session_retired', triggerKey, agentId, sdkSessionId, reason },
      'autonomous session retired; the next run on this trigger starts a fresh conversation',
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, triggerKey, sdkSessionId },
      'retireRunSession failed (non-fatal — the next run will resume the saturated session once and fail)',
    );
  }
}

/** Restore a persisted session's JSONL to disk so the SDK's `resume` finds it.
 *  Creates BOTH the cwd (sessionStateDir, used as the SDK subprocess cwd) AND
 *  the <HOME>/.claude/projects/<encoded>/ transcript dir. */
export async function restoreRunSessionToDisk(
  sessionStateDir: string,
  sdkSessionId: string,
  jsonlContent: string,
): Promise<void> {
  try {
    await fs.mkdir(sessionStateDir, { recursive: true });
    const p = buildJsonlPath(sessionStateDir, sdkSessionId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, jsonlContent, 'utf-8');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'restoreRunSessionToDisk failed — SDK will start a fresh session');
  }
}

/** Read the current on-disk JSONL for a session (to externalize after the run). */
export async function readRunSessionJsonl(sessionStateDir: string, sdkSessionId: string): Promise<string | null> {
  try {
    return await fs.readFile(buildJsonlPath(sessionStateDir, sdkSessionId), 'utf-8');
  } catch {
    return null;
  }
}

/** Ensure the sessionStateDir ITSELF exists on disk. The adapter passes this as
 *  `cwd` to the Claude Agent SDK's query() → Node's spawn() uses it as the child
 *  process's working directory. If it does not exist, spawn fails with ENOENT and
 *  the SDK MISREPORTS it as "Claude Code executable not found at <cli.js>. Is
 *  options.pathToClaudeCodeExecutable set?" — cli.js exists; the cwd is missing.
 *  Mirrors interactive-chat's ensureSessionStateDir. Must run for EVERY autonomous
 *  run that sets sessionStateDir, whether or not a prior session exists — otherwise
 *  first runs (no prior) never create the dir and every one fails. */
export async function ensureRunSessionDir(sessionStateDir: string): Promise<void> {
  await fs.mkdir(sessionStateDir, { recursive: true });
}

/** Prepare the autonomous-resume session for a run: pin the deterministic cwd,
 *  ALWAYS create it (the fix), and — if a prior session was persisted for this
 *  (triggerKey, agentId) — restore its JSONL to disk and return its resumeSessionId
 *  so the SDK continues the exact conversation. A first run (no prior) still gets a
 *  created cwd, which is what a plain spawn(cwd) needs. */
export async function prepareAutonomousSession(
  triggerKey: string,
  agentId: string,
  resumeEngine: ExecutionEngineId,
): Promise<{ sessionStateDir: string; resumeSessionId?: string; rebuiltMessages?: PlatformMessage[] }> {
  const sessionStateDir = autonomousSessionDir(triggerKey);
  await ensureRunSessionDir(sessionStateDir);
  const outDecision: { decision?: ArtifactResumeDecision } = {};
  const prior = await loadRunSession(triggerKey, agentId, resumeEngine, outDecision);
  if (prior) {
    await restoreRunSessionToDisk(sessionStateDir, prior.sdkSessionId, prior.jsonlContent);
    return { sessionStateDir, resumeSessionId: prior.sdkSessionId };
  }

  // `fallback` means the persisted artifact belongs to a DIFFERENT engine. It
  // used to mean "start fresh", which discarded the conversation outright. The
  // canonical copy is engine-neutral, so it can be repaired for the resuming
  // engine and replayed as history instead.
  //
  // Every other verdict keeps today's behaviour exactly: `fail` has already
  // quarantined the row, `native` was handled above, and a run with no decision
  // at all (no row, or a retired one) has nothing to rebuild from.
  if (outDecision.decision?.decision === 'fallback') {
    const rebuiltMessages = await rebuildFromCanonical(
      { kind: 'autonomous', triggerKey }, agentId, resumeEngine,
    );
    if (rebuiltMessages) return { sessionStateDir, rebuiltMessages };
  }
  return { sessionStateDir };
}

/** Load the canonical conversation for a session, repair it for `resumeEngine`,
 *  and translate it into that engine's platform message list.
 *
 *  Returns undefined — meaning "keep today's cold start" — whenever any step
 *  cannot be completed honestly: no canonical copy, no shipped inverse mapper
 *  for this engine, or a repair that leaves nothing. A partial or guessed
 *  translation would be worse than a cold start, because a cold start is at
 *  least obviously a cold start. */
export async function rebuildFromCanonical(
  scope: CanonicalScope,
  agentId: string,
  resumeEngine: ExecutionEngineId,
): Promise<PlatformMessage[] | undefined> {
  try {
    if (!inverseMapperShipped(resumeEngine)) return undefined;
    const canonical = await loadCanonicalArtifact(scope, agentId);
    if (!canonical) return undefined;

    const repaired = repairForReplay(canonical.messages, {
      sourceEngine: canonical.sourceEngine,
      targetEngine: resumeEngine,
      // Conservative: an engine we cannot prove reads images is treated as one
      // that cannot, which costs a placeholder line rather than a rejected
      // conversation.
      targetSupportsImages: false,
    });
    if (repaired.length === 0) return undefined;

    // Each tool result bounded to the cap the model-facing result gets, so a
    // rebuilt conversation never carries more than the model was shown.
    const messages = canonicalToEngine(resumeEngine, boundCanonicalToolResults(repaired));
    if (!messages || messages.length === 0) return undefined;

    logger.info(
      {
        event: 'canonical_conversation_rebuilt',
        sourceEngine: canonical.sourceEngine,
        resumeEngine,
        agentId,
        canonicalMessages: canonical.messages.length,
        replayedMessages: messages.length,
      },
      'rebuilt the conversation from the canonical record for a different engine (was: cold start)',
    );
    return messages;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, agentId, resumeEngine },
      'canonical rebuild failed (non-fatal — falls back to a cold start)',
    );
    return undefined;
  }
}
