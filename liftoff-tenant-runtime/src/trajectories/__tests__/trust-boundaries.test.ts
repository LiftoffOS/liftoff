// Tenant outer-engine and code_session trust-boundary
// regression tests, consolidated. These assert the invariants this workstream
// touches: the CONCRETE engine is always recorded, resolution never silently
// falls back to a different (uncertified) engine, and a nested code_session
// specialist engine is NEVER conflated with the outer execution engine.
//
// The deeper properties that require driving a full adapter/runner
// (workspace isolation, timeout/cancellation, runtime-native approval NOT
// bypassing Liftoff HITL) live in the per-adapter and code-session suites; this
// file covers the provenance/no-fallback surface without loading vendor SDKs.

import { recordCanonicalMessage, releaseBuffer } from '../recorder';
import { buildCanonical } from '../canonical-builder';
import { resolveExecutionEngine } from '../../agent-execution/adapter/engine-resolver';
import { RESOLVABLE_EXECUTION_ENGINE_IDS, RESOLVED_PROVIDERS } from '../../agent-execution/adapter/types';
import type { ResolvedProvider, ExecutionEngineId } from '../../agent-execution/adapter/types';

describe(' — tenant outer-engine boundary', () => {
  it('resolution is deterministic and never falls back to a different engine', () => {
    const providers: readonly ResolvedProvider[] = RESOLVED_PROVIDERS;
    const envs: NodeJS.ProcessEnv[] = [
      {}, { OPENAI_ENGINE: 'agents' }, { GOOGLE_ENGINE: 'adk' }, { OPENROUTER_ENGINE: 'wire' }, { XAI_ENGINE: 'wire' },
    ];
    // Both sets derived from the vendor record. A provider missing from the
    // first is a provider whose resolution is never checked; an engine missing
    // from the second would make this assertion reject a legitimate answer.
    const known = new Set<ExecutionEngineId>(RESOLVABLE_EXECUTION_ENGINE_IDS);
    for (const p of providers) {
      for (const env of envs) {
        const a = resolveExecutionEngine(p, env);
        const b = resolveExecutionEngine(p, env);
        expect(a).toBe(b); // deterministic — no fallback branch
        expect(known.has(a)).toBe(true); // only ever a certified engine, never unknown-legacy
      }
    }
  });

  it('a top-level trajectory records the concrete outer engine resolved from its provider (not a nested one)', () => {
    const invocationId = `outer-${Math.random()}`;
    recordCanonicalMessage(invocationId, 'openai', 'gpt-5-codex', { role: 'assistant', content: [{ type: 'text', text: 'hi' }] });
    const prev = process.env.OPENAI_ENGINE;
    delete process.env.OPENAI_ENGINE; // default → openai-codex
    try {
      const traj = buildCanonical({
        invocationId, systemPrompt: '', objective: 'o', toolDefs: [],
        meta: { tenantId: 't', agentId: 'a', completed: true, outcome: 'success' },
      })!;
      expect(traj.trajectory_meta.execution_engine).toBe('openai-codex');
      expect(traj.trajectory_meta.nested_engine).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OPENAI_ENGINE; else process.env.OPENAI_ENGINE = prev;
      releaseBuffer(invocationId);
    }
  });
});

describe(' — code_session boundary', () => {
  it('a nested code_session trajectory records the specialist engine, NEVER the outer execution engine', () => {
    const invocationId = `nested-${Math.random()}`;
    recordCanonicalMessage(invocationId, 'openai', 'codex-session', { role: 'assistant', content: [{ type: 'text', text: 'done' }] });
    try {
      const traj = buildCanonical({
        invocationId, systemPrompt: '', objective: 'fix bug', toolDefs: [],
        meta: {
          tenantId: 't', agentId: 'a', parentInvocationId: 'p',
          nestedKind: 'code_session', nestedEngine: 'codex-code-session',
          completed: true, outcome: 'success',
        },
      })!;
      // Specialist provenance present; outer engine ABSENT (never conflated).
      expect(traj.trajectory_meta.nested_engine).toBe('codex-code-session');
      expect(traj.trajectory_meta.execution_engine).toBeUndefined();
      expect(traj.trajectory_meta.nested_kind).toBe('code_session');
      // Lineage to the spawning outer invocation is preserved.
      expect(traj.trajectory_meta.parent_invocation_id).toBe('p');
    } finally {
      releaseBuffer(invocationId);
    }
  });
});
