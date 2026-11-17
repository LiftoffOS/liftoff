// Native session-artifact binding.
//
// chat_sessions / agent_run_sessions persist an engine's NATIVE session artifact
// (today: Claude Agent SDK project JSONL). Migrations 323/324 added typed
// ownership columns so a persisted artifact can prove which engine, artifact
// format, and Liftoff format-version produced it, plus an integrity checksum.
//
// This module owns the envelope contract: stamp an artifact on write, and decide
// on read whether the CURRENT run's engine may restore it. Ownership is read from
// the persisted row and compared to the resolved resume engine — it is NEVER
// inferred from the live provider, engine flags, the selected adapter, or the
// bytes themselves. That is what prevents a deployment change from feeding one
// engine's native state to another.

import { createHash } from 'crypto';
import type { ExecutionEngineId } from './adapter/types';
import { readPackageVersion } from '../infrastructure/package-version';

/** Liftoff-owned artifact-envelope version — how Liftoff interprets the persisted
 *  bytes (encoding, envelope shape). DISTINCT from the producing SDK/CLI version:
 *  Liftoff owns this even when the vendor publishes no stable format version, so
 *  it can add fields, change encoding, or migrate storage without guessing later.
 *  Bump when the envelope or payload encoding changes. */
export const ARTIFACT_FORMAT_VERSION = 1;

/** The native artifact format each engine persists. Only engines that externalize
 *  a native session artifact into chat_sessions/agent_run_sessions appear here;
 *  today that is exclusively the Claude Agent SDK. */
export const ENGINE_ARTIFACT_FORMAT: Partial<Record<ExecutionEngineId, string>> = {
  'claude-agent-sdk': 'claude-project-jsonl',
};

/** The columns written on save (mirrors migrations 323/324). */
export interface SessionArtifactStamp {
  execution_engine: ExecutionEngineId;
  artifact_format: string;
  artifact_format_version: number;
  producer_runtime_version: string | null;
  artifact_sha256: string;
}

/** The envelope columns as read back from a persisted row (any may be NULL on a
 *  pre-binding legacy row). */
export interface PersistedArtifactEnvelope {
  execution_engine: string | null;
  artifact_format: string | null;
  artifact_format_version: number | null;
  producer_runtime_version: string | null;
  artifact_sha256: string | null;
}

export function sha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Stamp a Claude Agent SDK project-JSONL artifact for durable persistence. */
export function stampClaudeArtifact(jsonlContent: string): SessionArtifactStamp {
  return {
    execution_engine: 'claude-agent-sdk',
    artifact_format: 'claude-project-jsonl',
    artifact_format_version: ARTIFACT_FORMAT_VERSION,
    producer_runtime_version: readPackageVersion('@anthropic-ai/claude-agent-sdk'),
    artifact_sha256: sha256(jsonlContent),
  };
}

/** The canonical-copy columns written alongside the native artifact (migration
 *  362). Deliberately a SEPARATE stamp from SessionArtifactStamp: the native
 *  artifact belongs to one engine and the canonical copy belongs to none, so
 *  conflating them would let a canonical payload inherit an engine's ownership
 *  and be restored as if it were that engine's own bytes. */
export interface CanonicalArtifactStamp {
  canonical_content: string;
  canonical_schema_version: string;
  canonical_sha256: string;
}

/** Serialize a canonical payload so the SAME content always produces the SAME
 *  bytes, whatever order its keys happen to be in.
 *
 *  The canonical copy is stored in a `jsonb` column, and jsonb does not preserve
 *  key order — it sorts, by key length then bytewise. So
 *  `{"type":"text","text":"hi"}` comes back as `{"text":"hi","type":"text"}`,
 *  and a checksum taken over `JSON.stringify` before the write can never match
 *  one taken over `JSON.stringify` after the read.
 *
 *  That is not a hypothetical. It made every canonical row unreadable from the
 *  moment the column shipped: `loadCanonicalArtifact` declined each one as
 *  corrupt and cold-started, so the cross-engine rebuild the whole record exists
 *  for could not fire even once. Sorting on both sides makes the hash a
 *  statement about CONTENT, which is what it was always meant to be, rather than
 *  about a serialization Postgres was never going to preserve. */
export function canonicalSerialize(value: unknown): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = sortDeep(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortDeep(value));
}

/** Stamp a vendor-neutral canonical conversation for durable persistence.
 *  `messages` is the CanonicalTrajectory message array; the schema version is
 *  recorded so a later reader can refuse a version it predates rather than
 *  misread it.
 *
 *  The checksum is over the order-independent serialization; the stored content
 *  is the plain one, because Postgres is going to re-serialize it into jsonb
 *  either way and the column is read as a value, not as bytes. */
export function stampCanonicalArtifact(
  messages: unknown[],
  schemaVersion: string,
): CanonicalArtifactStamp {
  return {
    canonical_content: JSON.stringify(messages),
    canonical_schema_version: schemaVersion,
    canonical_sha256: sha256(canonicalSerialize(messages)),
  };
}

/** The canonical columns as read back from a persisted row. Any may be NULL:
 *  every row written before migration 362, and every run whose recorder produced
 *  nothing, has no canonical copy. */
export interface PersistedCanonicalEnvelope {
  canonical_content: unknown;
  canonical_schema_version: string | null;
  canonical_sha256: string | null;
}

export type ArtifactResumeFailureClass =
  | 'artifact_incompatible'
  | 'artifact_missing'
  | 'unsupported_artifact_version';

export type ArtifactResumeDecision =
  | { decision: 'native' }
  | { decision: 'fallback'; failureClass: ArtifactResumeFailureClass; reason: string }
  | { decision: 'fail'; failureClass: ArtifactResumeFailureClass; reason: string };

/** Decide how a persisted native session artifact may be used on resume, given
 *  the concrete engine the CURRENT run resolves to.
 *
 *  Outcomes (Part 6 §5.5.6):
 *   - `native`   — same engine + supported format/version + intact checksum → restore.
 *   - `fallback` — owned by a DIFFERENT engine, or the format doesn't match →
 *                  do NOT restore; reconstruct from Liftoff-owned state (degraded).
 *   - `fail`     — payload missing, a newer-than-supported format version, or a
 *                  checksum mismatch (corruption) → explicit failure, never restore.
 *
 *  Ownership comes from the persisted row, never the live deployment. A
 *  pre-binding legacy row (NULL engine) is treated as claude-agent-sdk — the only
 *  engine that has ever written these tables — not as whatever the current
 *  provider resolves to. A NULL checksum is a legacy-unverified row: allowed once
 *  ownership + format already match (it will age out under the 7-day TTL). */
export function decideArtifactResume(
  row: PersistedArtifactEnvelope,
  payload: string | null | undefined,
  resumeEngine: ExecutionEngineId,
): ArtifactResumeDecision {
  if (!payload) {
    return { decision: 'fail', failureClass: 'artifact_missing', reason: 'no persisted payload' };
  }
  const owner = (row.execution_engine as ExecutionEngineId | null) ?? 'claude-agent-sdk';
  if (owner !== resumeEngine) {
    return {
      decision: 'fallback', failureClass: 'artifact_incompatible',
      reason: `artifact owned by '${owner}' but resume engine is '${resumeEngine}'`,
    };
  }
  const expectedFormat = ENGINE_ARTIFACT_FORMAT[resumeEngine];
  if (expectedFormat && row.artifact_format != null && row.artifact_format !== expectedFormat) {
    return {
      decision: 'fallback', failureClass: 'artifact_incompatible',
      reason: `artifact format '${row.artifact_format}' != expected '${expectedFormat}' for '${resumeEngine}'`,
    };
  }
  if (row.artifact_format_version != null && row.artifact_format_version > ARTIFACT_FORMAT_VERSION) {
    return {
      decision: 'fail', failureClass: 'unsupported_artifact_version',
      reason: `artifact format version ${row.artifact_format_version} > supported ${ARTIFACT_FORMAT_VERSION}`,
    };
  }
  if (row.artifact_sha256 != null && row.artifact_sha256 !== sha256(payload)) {
    return {
      decision: 'fail', failureClass: 'artifact_incompatible',
      reason: 'artifact checksum mismatch (corrupt or tampered payload)',
    };
  }
  return { decision: 'native' };
}
