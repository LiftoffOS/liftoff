// Suggestion Applier Tests

const mockQuery = jest.fn();
const mockGetModelForTask = jest.fn().mockResolvedValue(null);
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: mockGetModelForTask }),
}));
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../llm/client', () => ({
  llmClient: {
    modelSelectionFor: (pair: { model?: string; provider?: string } | null | undefined) =>
      (pair?.model
        ? { provider: pair.provider ?? 'anthropic', model: pair.model }
        : (pair?.provider ? { provider: pair.provider } : {})),
    complete: jest.fn().mockResolvedValue({ content: 'Updated instructions text' }),
  },
}));

jest.mock('../../memory/service', () => ({
  memoryService: {
    saveMemory: jest.fn().mockResolvedValue('memory-id'),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { applySuggestion, AutoApplyForbiddenError, StaleSuggestionError, hashInstructionState, MAX_TRAJECTORY_DRIFT } from '../suggestion-applier';

beforeEach(() => jest.clearAllMocks());

describe('applySuggestion', () => {
  it('applies suggestion and bumps entity_version', async () => {
    // Mock: suggestion found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1', suggestion: 'Improve email tone', evidence_refs: [] }] });
    // Mock: agent found with entity_version
    mockQuery.mockResolvedValueOnce({ rows: [{ system_prompt: '', user_instructions: 'Old instructions', entity_version: 3 }] });
    // Mock: UPDATE agents
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    // Mock: UPDATE reflection_suggestions
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const result = await applySuggestion('t1', 'a1', 's1');

    expect(result.newVersion).toBe(4); // 3 + 1
    expect(result.memoriesCreated).toBe(1);

    // Verify UPDATE agents uses entity_version (not current_version — REVIEW FIX DE-002)
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain('entity_version');
    expect(updateCall[0]).not.toContain('current_version');
  });

  it('throws when suggestion not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(applySuggestion('t1', 'a1', 'missing')).rejects.toThrow('Suggestion not found');
  });

  it('throws when agent not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1', suggestion: 'x', evidence_refs: [] }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(applySuggestion('t1', 'missing', 's1')).rejects.toThrow('Agent not found');
  });

  // Phase 5 gap fix: auto-apply path must refuse flagged_feedback-tagged rows.
  describe('Phase 5 auto-apply gate', () => {
    it('refuses auto-apply when suggestion.triggered_by is flagged_feedback', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 's1',
            suggestion: 'Stop sending reminders on weekends',
            evidence_refs: [],
            triggered_by: 'flagged_feedback',
          },
        ],
      });

      await expect(
        applySuggestion('t1', 'a1', 's1', { source: 'auto-apply' }),
      ).rejects.toBeInstanceOf(AutoApplyForbiddenError);

      // It must bail BEFORE touching the agents row, the UPDATE, or the
      // suggestion status transition.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('allows auto-apply when suggestion.triggered_by is a non-flagged trigger', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 's1',
            suggestion: 'Improve retry logic',
            evidence_refs: [],
            triggered_by: 'repeated_failures',
          },
        ],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ system_prompt: '', user_instructions: 'Old', entity_version: 1 }],
      });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await applySuggestion('t1', 'a1', 's1', { source: 'auto-apply' });

      expect(result.newVersion).toBe(2);
    });

    it('allows human-accept (default) even on flagged_feedback-tagged rows', async () => {
      // Human accept is the explicit review path. Must not be blocked.
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 's1',
            suggestion: 'Tone change requested',
            evidence_refs: [],
            triggered_by: 'flagged_feedback',
          },
        ],
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ system_prompt: '', user_instructions: 'Old', entity_version: 7 }],
      });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await applySuggestion('t1', 'a1', 's1');

      expect(result.newVersion).toBe(8);
    });
  });
});

// ── The two guards that stop an apply destroying somebody's work ────────────
//
// The reflection LLM call takes seconds, and the plan that comes out of it is a
// plan against the state as it was BEFORE it. Without these, an operator edit
// landing inside that window is silently overwritten, and a suggestion planned
// against behaviour the agent has moved past is applied anyway.
describe('the lost-update guard', () => {
  const AGENT_STATE = { system_prompt: 'sys', user_instructions: 'current', entity_version: 3 };
  const baselineOf = (s: typeof AGENT_STATE) => hashInstructionState({
    systemPrompt: s.system_prompt, userInstructions: s.user_instructions, entityVersion: s.entity_version,
  });

  it('applies when the agent has not moved since the plan', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: baselineOf(AGENT_STATE),
    }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(applySuggestion('t1', 'a1', 's1')).resolves.toBeDefined();
  });

  // The operator's change would otherwise simply disappear, with nothing
  // recording that it was ever made.
  it('refuses when the agent changed while the suggestion was being planned', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', suggestion: 'x', evidence_refs: [],
      baseline_hash: baselineOf({ ...AGENT_STATE, user_instructions: 'what it said BEFORE the operator edit' }),
    }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });   // status = 'stale'
    await expect(applySuggestion('t1', 'a1', 's1')).rejects.toBeInstanceOf(StaleSuggestionError);
  });

  // Kept, not discarded: the reflection that produced it is still there to
  // re-plan from.
  it('marks the refused suggestion stale rather than deleting it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: 'a-hash-that-no-longer-matches',
    }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await applySuggestion('t1', 'a1', 's1').catch(() => undefined);
    const statusWrite = mockQuery.mock.calls.find((c) => String(c[0]).includes("status = 'stale'"));
    expect(statusWrite).toBeDefined();
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('DELETE'))).toBe(false);
  });

  it('never writes to the agent when it refuses', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: 'stale',
    }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await applySuggestion('t1', 'a1', 's1').catch(() => undefined);
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('UPDATE agents SET user_instructions'))).toBe(false);
  });

  // Legacy rows predate baseline capture. They still apply — they are pending
  // work an operator already reviewed — but unguarded, which is worth saying.
  it('applies a suggestion with no baseline, unguarded', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: null }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(applySuggestion('t1', 'a1', 's1')).resolves.toBeDefined();
  });
});

describe('the stale-plan guard', () => {
  const AGENT_STATE = { system_prompt: 'sys', user_instructions: 'current', entity_version: 3 };

  it('refuses a suggestion the agent has run far past', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: null, trajectory_version: 10,
    }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    // The agent has run far more times since it was planned.
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: String(10 + MAX_TRAJECTORY_DRIFT + 1) }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(applySuggestion('t1', 'a1', 's1')).rejects.toBeInstanceOf(StaleSuggestionError);
  });

  // Not zero drift: a suggestion is planned asynchronously and an active agent
  // runs while a person reads it, so an exact match would make every suggestion
  // for a busy agent unappliable.
  it('allows the drift a review realistically takes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: null, trajectory_version: 10,
    }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockResolvedValueOnce({ rows: [{ cnt: String(10 + MAX_TRAJECTORY_DRIFT) }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(applySuggestion('t1', 'a1', 's1')).resolves.toBeDefined();
  });

  // An unreadable count means "cannot judge staleness", which must not become
  // "stale" — that would refuse every suggestion whenever the query failed.
  it('applies when the count cannot be read', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: null, trajectory_version: 10,
    }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(applySuggestion('t1', 'a1', 's1')).resolves.toBeDefined();
  });
});

describe('the revert material', () => {
  const AGENT_STATE = { system_prompt: 'sys', user_instructions: 'current', entity_version: 3 };

  // before_state is what a revert writes back; after_state is what it checks
  // against first. Without the pair, "revert refinement N" has to assume nothing
  // else touched the agent since.
  it('records both sides of the change when it applies', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1', suggestion: 'x', evidence_refs: [], baseline_hash: null }] });
    mockQuery.mockResolvedValueOnce({ rows: [AGENT_STATE] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await applySuggestion('t1', 'a1', 's1');

    const statusWrite = mockQuery.mock.calls.find((c) => String(c[0]).includes("status = 'accepted'"));
    expect(statusWrite).toBeDefined();
    expect(String(statusWrite![0])).toContain('before_state');
    expect(String(statusWrite![0])).toContain('after_state');
    const params = statusWrite![1] as unknown[];
    expect(JSON.parse(params[2] as string)).toEqual({
      systemPrompt: 'sys', userInstructions: 'current', entityVersion: 3,
    });
    expect(JSON.parse(params[3] as string).entityVersion).toBe(4);
  });
});
