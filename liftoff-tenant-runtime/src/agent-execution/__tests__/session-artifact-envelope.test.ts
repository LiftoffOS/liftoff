// Native session-artifact binding: stamp + the three-outcome resume decision.
// Ownership/format/version/integrity are validated from the persisted row and the
// resolved resume engine — never inferred from the live provider.

import {
  stampClaudeArtifact, decideArtifactResume, sha256, ARTIFACT_FORMAT_VERSION,
  type PersistedArtifactEnvelope,
} from '../session-artifact-envelope';

const JSONL = '{"type":"user","message":"hi"}\n{"type":"assistant","message":"hello"}\n';

/** A fully-stamped Claude artifact row, with optional field overrides. */
function claudeRow(over: Partial<PersistedArtifactEnvelope> = {}): PersistedArtifactEnvelope {
  return {
    execution_engine: 'claude-agent-sdk',
    artifact_format: 'claude-project-jsonl',
    artifact_format_version: ARTIFACT_FORMAT_VERSION,
    producer_runtime_version: '0.3.220',
    artifact_sha256: sha256(JSONL),
    ...over,
  };
}

describe('stampClaudeArtifact', () => {
  it('stamps the claude-agent-sdk envelope + sha256 of the payload', () => {
    const a = stampClaudeArtifact(JSONL);
    expect(a.execution_engine).toBe('claude-agent-sdk');
    expect(a.artifact_format).toBe('claude-project-jsonl');
    expect(a.artifact_format_version).toBe(ARTIFACT_FORMAT_VERSION);
    expect(a.artifact_sha256).toBe(sha256(JSONL));
    // producer runtime is the SDK package version (best-effort; may be null in odd envs)
    expect(a.producer_runtime_version === null || typeof a.producer_runtime_version === 'string').toBe(true);
  });
});

describe('decideArtifactResume', () => {
  it('native: same engine + format + version + intact checksum', () => {
    expect(decideArtifactResume(claudeRow(), JSONL, 'claude-agent-sdk')).toEqual({ decision: 'native' });
  });

  it('fail (artifact_missing): no persisted payload', () => {
    expect(decideArtifactResume(claudeRow(), null, 'claude-agent-sdk'))
      .toMatchObject({ decision: 'fail', failureClass: 'artifact_missing' });
  });

  it('fallback (artifact_incompatible): artifact owned by a different engine', () => {
    expect(decideArtifactResume(claudeRow(), JSONL, 'openai-codex'))
      .toMatchObject({ decision: 'fallback', failureClass: 'artifact_incompatible' });
  });

  it('fallback (artifact_incompatible): format does not match the resume engine', () => {
    expect(decideArtifactResume(claudeRow({ artifact_format: 'codex-thread' }), JSONL, 'claude-agent-sdk'))
      .toMatchObject({ decision: 'fallback', failureClass: 'artifact_incompatible' });
  });

  it('fail (unsupported_artifact_version): newer than this runtime supports', () => {
    expect(decideArtifactResume(claudeRow({ artifact_format_version: ARTIFACT_FORMAT_VERSION + 1 }), JSONL, 'claude-agent-sdk'))
      .toMatchObject({ decision: 'fail', failureClass: 'unsupported_artifact_version' });
  });

  it('fail (artifact_incompatible): checksum mismatch (corrupt payload)', () => {
    expect(decideArtifactResume(claudeRow(), JSONL + 'tampered', 'claude-agent-sdk'))
      .toMatchObject({ decision: 'fail', failureClass: 'artifact_incompatible' });
  });

  it('legacy NULL-engine row is owned by claude-agent-sdk (the sole historical writer), not the live provider', () => {
    const legacy = claudeRow({ execution_engine: null, artifact_format: null, artifact_format_version: null, artifact_sha256: null });
    expect(decideArtifactResume(legacy, JSONL, 'claude-agent-sdk')).toEqual({ decision: 'native' });
    expect(decideArtifactResume(legacy, JSONL, 'openai-codex'))
      .toMatchObject({ decision: 'fallback', failureClass: 'artifact_incompatible' });
  });

  it('NULL checksum (legacy-unverified) is allowed once ownership + format match', () => {
    expect(decideArtifactResume(claudeRow({ artifact_sha256: null }), JSONL, 'claude-agent-sdk'))
      .toEqual({ decision: 'native' });
  });
});
