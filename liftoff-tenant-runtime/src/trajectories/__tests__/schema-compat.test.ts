// Trajectory readers must accept BOTH the legacy 1.0 at-rest
// GCS shape (no engine fields) and the 1.1 shape (with execution_engine). Proves
// a persisted 1.0 doc still parses and flows through the read+process path
// (redaction) unchanged, and that 1.1 carries execution_engine through the same
// path. The SFT-export leg of this test went with the exporters.

import { redactTrajectoryContent } from '../sink';
import type { CanonicalTrajectory } from '../types';

// A legacy 1.0 document exactly as it would sit at rest in GCS: no execution_engine.
function legacy10(): CanonicalTrajectory {
  return JSON.parse(JSON.stringify({
    schema_version: '1.0',
    trajectory_meta: {
      tenant_id: 't', agent_id: 'a', invocation_id: 'i',
      provider: 'anthropic', model: 'claude-opus-4-8',
      started_at: '2026-01-01T00:00:00.000Z', completed: true, tool_call_count: 0, outcome: 'success',
    },
    system: [{ type: 'text', text: 'sys' }],
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  })) as CanonicalTrajectory;
}

function modern11(): CanonicalTrajectory {
  const t = legacy10();
  return {...t, schema_version: '1.1', trajectory_meta: {...t.trajectory_meta, execution_engine: 'claude-agent-sdk' } };
}

describe('trajectory schema compatibility (1.0 ↔ 1.1)', () => {
  it('a legacy 1.0 GCS trajectory (no engine fields) reads and processes unchanged', () => {
    const t = legacy10();
    expect(t.schema_version).toBe('1.0');
    expect(t.trajectory_meta.execution_engine).toBeUndefined();
    const redacted = redactTrajectoryContent(t);
    expect(redacted.schema_version).toBe('1.0');
    expect(redacted.messages).toHaveLength(1);
    // Downstream SFT exporters read it without error.
  });

  it('a 1.1 trajectory carries execution_engine through read + processing', () => {
    const t = modern11();
    const redacted = redactTrajectoryContent(t);
    expect(redacted.schema_version).toBe('1.1');
    expect(redacted.trajectory_meta.execution_engine).toBe('claude-agent-sdk');
  });
});
