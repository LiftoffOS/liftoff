// Skill Feedback Service — dedup of newPitfallSkill candidates.
//
// All mocks are configured BEFORE importing skill-feedback-service so module
// initialization (which reads SKILL_DEDUP_* env vars) runs against the
// values set here. Each `describe` block toggles env via beforeAll +
// jest.isolateModules to get a clean module under the desired flag config.

import { jest } from '@jest/globals';

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.resetModules();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Shared mock factories. Tests assign per-case behavior on the returned
// jest.fn()s via the imported `setMockBehavior` helper.
// ─────────────────────────────────────────────────────────────────────────

const queryMock = jest.fn();
const embedMock = jest.fn();
const completeMock = jest.fn();
const getAgentSkillsMock = jest.fn();
const saveMemoryMock = jest.fn();
const publishEventMock = jest.fn();
const generateAndStoreEmbeddingMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { embed: embedMock },
}));

jest.mock('../../llm', () => ({
  llmClient: { complete: completeMock },
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getAgentSkills: getAgentSkillsMock,
    saveMemory: saveMemoryMock,
  },
}));

jest.mock('../events', () => ({
  publishEvent: publishEventMock,
}));

jest.mock('../embedding-service', () => ({
  generateAndStoreEmbedding: generateAndStoreEmbeddingMock,
}));

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

interface RuntimeSkill {
  id: string;
  name: string;
  description: string;
  instruction: string;
  tags: string[];
}

function setEnv(opts: { enabled: boolean; merge?: number; floor?: number }): void {
  process.env = {
    ...ORIGINAL_ENV,
    SKILL_DEDUP_ENABLED: opts.enabled ? 'true' : 'false',
    SKILL_DEDUP_MERGE_THRESHOLD: opts.merge !== undefined ? String(opts.merge) : '0.88',
    SKILL_DEDUP_FLOOR_THRESHOLD: opts.floor !== undefined ? String(opts.floor) : '0.75',
  };
}

function makeSkill(id: string, name: string, body: string, tags: string[] = []): RuntimeSkill {
  return { id, name, description: body, instruction: body, tags };
}

/** The body most candidates in this file carry, and the body the merge LLM is
 *  wired to return. Distinct from each other on purpose: two skills with the
 *  same text are the same point in embedding space, which would collapse the
 *  geometry these tests are built on. */
const CANDIDATE_TEXT = 'd\ni';
const MERGED_TEXT = 'merged desc\nmerged inst';

/** The text skill-similarity embeds for a skill: description then instruction. */
function textOf(s: { description: string; instruction: string }): string {
  return `${s.description}\n${s.instruction}`.trim();
}

/**
 * Wire the embedding vendor as a function of TEXT rather than of call order.
 *
 * Each declared text is placed on the unit circle at the angle whose cosine to
 * the reference is the number given, so the cosine between any two texts is the
 * same in every call — which is the property a real embedding model has and the
 * property the service relies on.
 *
 * Keyed on text because the number and shape of the vendor calls is not part of
 * the contract under test. skill-similarity asks the vendor only for texts
 * nothing has embedded yet, so a candidate compared against the same twenty
 * skills twenty times costs twenty-one vectors rather than four hundred and
 * twenty. An order-keyed mock encodes the old call pattern as though it were
 * the behaviour, and fails on a change that made the service cheaper without
 * changing a single cosine.
 *
 * Throws on an undeclared text. A test that forgets to declare a skill would
 * otherwise get a silent default vector and assert against a cosine nobody
 * chose.
 */
function embedWithCosines(reference: string, cosines: Array<[string, number]>): void {
  const angles = new Map<string, number>([[reference, 0]]);
  for (const [text, target] of cosines) {
    angles.set(text, Math.acos(Math.max(-1, Math.min(1, target))));
  }
  embedMock.mockImplementation(async (req: { input: string[] }) => ({
    embeddings: req.input.map((text) => {
      const theta = angles.get(text);
      if (theta === undefined) {
        throw new Error(`embed mock has no vector declared for ${JSON.stringify(text)}`);
      }
      return [Math.cos(theta), Math.sin(theta)];
    }),
    promptTokens: 0,
    model: 'gemini-embedding-001',
    provider: 'google',
  }));
}

async function loadService(): Promise<typeof import('../skill-feedback-service')> {
  // Re-require under current env so module-level threshold reads see the
  // values set by setEnv().
  let mod!: typeof import('../skill-feedback-service');
  jest.isolateModules(() => {
    mod = require('../skill-feedback-service');
  });
  return mod;
}

function setupCommon(currentSkills: RuntimeSkill[]): void {
  // Idempotency log INSERT returns one row (not duplicate); agent SELECT
  // returns a stub agent row; agent_skill_metrics upsert and the post-publish
  // UPDATE/INSERTs all return empty.
  queryMock.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('skill_feedback_log')) {
      return Promise.resolve({ rows: [{ agent_id: AGENT_ID }] });
    }
    if (typeof sql === 'string' && sql.includes('FROM internal_agents')) {
      return Promise.resolve({ rows: [{ current_version: 1, role: 'TestRole' }] });
    }
    return Promise.resolve({ rows: [] });
  });
  getAgentSkillsMock.mockResolvedValue({ skills: currentSkills });
  saveMemoryMock.mockResolvedValue(undefined);
  publishEventMock.mockResolvedValue(undefined);
  generateAndStoreEmbeddingMock.mockResolvedValue(undefined);
}

function getDedupInserts(): Array<Record<string, unknown>> {
  return queryMock.mock.calls
    .filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO skill_dedup_events'))
    .map(([, params]) => {
      const p = params as unknown[];
      return {
        agentId: p[0],
        tenantId: p[1],
        taskId: p[2],
        candidateName: p[3],
        candidateRoleWide: p[4],
        originatingSkillId: p[5],
        decision: p[6],
        matchedSkillId: p[7],
        similarityScore: p[8],
      };
    });
}

function getRefreshUpdate(): { ids: string[] } | null {
  const call = queryMock.mock.calls.find(([sql]) =>
    typeof sql === 'string' && sql.includes('UPDATE agent_skill_metrics') && sql.includes('last_refined_at'),
  );
  if (!call) return null;
  const params = call[1] as unknown[];
  return { ids: params[1] as string[] };
}

function getPublishedSkills(): RuntimeSkill[] {
  expect(publishEventMock).toHaveBeenCalled();
  const arg = publishEventMock.mock.calls[publishEventMock.mock.calls.length - 1][0] as { payload: { skills: RuntimeSkill[] } };
  return arg.payload.skills;
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('processSkillFeedback — dedup of newPitfallSkill (SKILL_DEDUP_ENABLED=true)', () => {
  const existing: RuntimeSkill = makeSkill('skill-existing-1', 'Existing skill A', 'guidance about A');
  const reflectionOriginating: RuntimeSkill = makeSkill('skill-origin', 'Origin', 'origin body');

  beforeEach(() => {
    setEnv({ enabled: true, merge: 0.88, floor: 0.75 });
    setupCommon([existing, reflectionOriginating]);
  });

  it('appends when candidate is far (cosine < FLOOR)', async () => {
    embedWithCosines(textOf({ description: 'distinct desc', instruction: 'distinct inst' }), [
      [textOf(existing), 0.4],
      [textOf(reflectionOriginating), 0.2],
    ]);
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'New distinct skill', description: 'distinct desc', instruction: 'distinct inst' },
      }],
    });

    const events = getDedupInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'appended', matchedSkillId: null });
    expect(events[0].similarityScore).toBeCloseTo(0.4, 5);
    expect(getPublishedSkills()).toHaveLength(3);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('refuses when candidate is similar but below MERGE (FLOOR <= sim < MERGE)', async () => {
    embedWithCosines(CANDIDATE_TEXT, [
      [textOf(existing), 0.80],
      [textOf(reflectionOriginating), 0.2],
    ]);
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Refuseable candidate', description: 'd', instruction: 'i' },
      }],
    });

    const events = getDedupInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'refused', matchedSkillId: 'skill-existing-1' });
    expect(events[0].similarityScore).toBeCloseTo(0.80, 5);
    expect(getPublishedSkills()).toHaveLength(2);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('merges happy path (sim >= MERGE, verification passes)', async () => {
    // The merged skill sits close to the candidate and, by construction, close
    // to the existing one too: both verification cosines clear MERGE_VERIFY_FLOOR.
    embedWithCosines(CANDIDATE_TEXT, [
      [textOf(existing), 0.92],
      [textOf(reflectionOriginating), 0.2],
      [MERGED_TEXT, 0.98],
    ]);
    completeMock.mockResolvedValueOnce({
      content: '', model: 'm', provider: 'anthropic',
      toolCalls: [{ id: 'c1', name: 'emit_merged_skill', input: { name: 'Merged name', description: 'merged desc', instruction: 'merged inst' } }],
    });
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Mergeable candidate', description: 'd', instruction: 'i' },
      }],
    });

    const events = getDedupInserts();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'merged', matchedSkillId: 'skill-existing-1' });

    const published = getPublishedSkills();
    expect(published).toHaveLength(2);
    const target = published.find(s => s.id === 'skill-existing-1');
    expect(target?.name).toBe('Merged name');
    expect(target?.instruction).toBe('merged inst');

    // last_refined_at should bump the merge target, not just mutation.skillId.
    const refresh = getRefreshUpdate();
    expect(refresh?.ids).toEqual(expect.arrayContaining(['skill-existing-1', 'skill-origin']));
  });

  it('appends when merge LLM passes but verification fails', async () => {
    // The merge LLM answered, but what it produced is nowhere near either input:
    // both verification cosines fall under MERGE_VERIFY_FLOOR (0.85).
    embedWithCosines(CANDIDATE_TEXT, [
      [textOf(existing), 0.92],
      [textOf(reflectionOriginating), 0.2],
      [MERGED_TEXT, 0.5],
    ]);
    completeMock.mockResolvedValueOnce({
      content: '', model: 'm', provider: 'anthropic',
      toolCalls: [{ id: 'c1', name: 'emit_merged_skill', input: { name: 'Lossy merged', description: 'merged desc', instruction: 'merged inst' } }],
    });
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Mergeable candidate', description: 'd', instruction: 'i' },
      }],
    });

    const events = getDedupInserts();
    expect(events[0]).toMatchObject({ decision: 'appended' });
    expect(events[0].similarityScore).toBeCloseTo(0.92, 5);
    expect(getPublishedSkills()).toHaveLength(3);
  });

  it('appends when merge LLM returns null (no tool call)', async () => {
    embedWithCosines(CANDIDATE_TEXT, [
      [textOf(existing), 0.92],
      [textOf(reflectionOriginating), 0.2],
    ]);
    completeMock.mockResolvedValueOnce({ content: '', model: 'm', provider: 'anthropic', toolCalls: [] });
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Mergeable candidate', description: 'd', instruction: 'i' },
      }],
    });

    const events = getDedupInserts();
    expect(events[0]).toMatchObject({ decision: 'appended' });
    expect(events[0].similarityScore).toBeCloseTo(0.92, 5);
  });

  it('skips embed when role-wide candidate has only individual peers', async () => {
    const individual = makeSkill('s1', 'Individual', 'similar body');
    setupCommon([individual]);
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Role-wide pitfall', description: 'd', instruction: 'i', tags: ['role-wide'] },
      }],
    });

    // No comparable skills → findNearestSkill returns null without calling embed.
    expect(embedMock).not.toHaveBeenCalled();
    expect(getDedupInserts()[0]).toMatchObject({ decision: 'appended', candidateRoleWide: true });
  });

  it('name-exact short-circuits (no embed)', async () => {
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Existing skill A', description: 'd', instruction: 'i' },
      }],
    });

    expect(embedMock).not.toHaveBeenCalled();
    const events = getDedupInserts();
    expect(events[0]).toMatchObject({ decision: 'refused' });
    expect(events[0].similarityScore).toBe(1.0);
  });

  it('appends on embed failure (fail-open)', async () => {
    embedMock.mockRejectedValueOnce(new Error('embed boom'));
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Candidate after embed fail', description: 'd', instruction: 'i' },
      }],
    });

    const events = getDedupInserts();
    expect(events[0]).toMatchObject({ decision: 'appended', similarityScore: null });
  });

  it('respects MAX_MERGES_PER_TASK = 5: 6th candidate appends', async () => {
    // 6 candidates, all cosine 0.92 against the same existing skill. Each
    // dedup decision calls embed once for findNearestSkill plus twice for
    // verification on a merge (so 5 merges → 5+2*5 = 15 embed calls).
    // The 6th candidate is over-cap → embed once, no merge LLM, no verify.
    const candidatesCount = 6;
    // The merged skill is declared at the SAME distance as the existing one, so
    // each successive candidate meets a target at 0.92 whether it is comparing
    // against the original skill or against what the previous merge left behind.
    // That is what makes the sixth candidate's recorded similarity the same 0.92
    // as the first, which is the number this test asserts.
    embedWithCosines(CANDIDATE_TEXT, [
      [textOf(existing), 0.92],
      [textOf(reflectionOriginating), 0.2],
      [MERGED_TEXT, 0.92],
    ]);
    for (let i = 0; i < 5; i++) {
      completeMock.mockResolvedValueOnce({
        content: '', model: 'm', provider: 'anthropic',
        toolCalls: [{ id: `c${i}`, name: 'emit_merged_skill', input: { name: `Merged ${i}`, description: 'merged desc', instruction: 'merged inst' } }],
      });
    }
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: Array.from({ length: candidatesCount }, (_, i) => ({
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure' as const,
        newPitfallSkill: { name: `Cand ${i}`, description: 'd', instruction: 'i' },
      })),
    });

    expect(completeMock).toHaveBeenCalledTimes(5);
    const events = getDedupInserts();
    const merged = events.filter(e => e.decision === 'merged');
    const appended = events.filter(e => e.decision === 'appended');
    expect(merged).toHaveLength(5);
    expect(appended).toHaveLength(1);
    expect(appended[0].similarityScore).toBeCloseTo(0.92, 5);
  });

  it('writes a merge-decision memory referencing the post-merge name', async () => {
    embedWithCosines(CANDIDATE_TEXT, [
      [textOf(existing), 0.92],
      [textOf(reflectionOriginating), 0.2],
      [MERGED_TEXT, 0.98],
    ]);
    completeMock.mockResolvedValueOnce({
      content: '', model: 'm', provider: 'anthropic',
      toolCalls: [{ id: 'c1', name: 'emit_merged_skill', input: { name: 'Merged name', description: 'merged desc', instruction: 'merged inst' } }],
    });
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Mergeable candidate', description: 'd', instruction: 'i' },
      }],
    });

    // The merge-decision memory write references both the candidate name
    // AND the post-merge target name. There may be other saveMemory calls
    // (e.g. newPitfallSkill memory variant) so we filter to the merge one.
    const mergeMemory = saveMemoryMock.mock.calls.find(([, payload]) =>
      typeof (payload as { content?: string }).content === 'string' &&
      ((payload as { content: string }).content).includes('merged into existing skill'),
    );
    expect(mergeMemory).toBeDefined();
    const content = (mergeMemory![1] as { content: string }).content;
    expect(content).toContain('Mergeable candidate');
    expect(content).toContain('Merged name');
  });

  it('unions tags on merge', async () => {
    const existingWithTag = makeSkill('skill-existing-1', 'Existing skill A', 'body', ['gmail']);
    setupCommon([existingWithTag, reflectionOriginating]);
    embedWithCosines(CANDIDATE_TEXT, [
      [textOf(existingWithTag), 0.92],
      [textOf(reflectionOriginating), 0.2],
      [MERGED_TEXT, 0.98],
    ]);
    completeMock.mockResolvedValueOnce({
      content: '', model: 'm', provider: 'anthropic',
      toolCalls: [{ id: 'c1', name: 'emit_merged_skill', input: { name: 'Merged name', description: 'merged desc', instruction: 'merged inst' } }],
    });
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Mergeable candidate', description: 'd', instruction: 'i', tags: ['urgent'] },
      }],
    });

    const published = getPublishedSkills();
    const target = published.find(s => s.id === 'skill-existing-1');
    expect(target?.tags.sort()).toEqual(['gmail', 'urgent']);
  });
});

describe('processSkillFeedback — dedup OFF (SKILL_DEDUP_ENABLED unset)', () => {
  const existing: RuntimeSkill = makeSkill('skill-existing-1', 'Existing skill A', 'guidance about A');

  beforeEach(() => {
    setEnv({ enabled: false });
    setupCommon([existing]);
  });

  it('appends every candidate without embedding; no dedup_events written', async () => {
    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-1',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Some candidate', description: 'd', instruction: 'i' },
      }],
    });

    expect(embedMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    // skill_dedup_events is for recorded dedup DECISIONS. With the kill
    // switch off there is no decision to record (no embed, no similarity).
    expect(getDedupInserts()).toHaveLength(0);
    expect(getPublishedSkills()).toHaveLength(2);
  });
});

describe('processSkillFeedback — publish-fail consistency', () => {
  const existing: RuntimeSkill = makeSkill('skill-existing-1', 'Existing skill A', 'guidance about A');

  beforeEach(() => {
    setEnv({ enabled: true, merge: 0.88, floor: 0.75 });
    setupCommon([existing]);
  });

  it('does NOT write skill_dedup_events when publishEvent throws', async () => {
    // `publishEvent` for entityType='internal_agent' SHOULD swallow outbox-
    // enqueue failures in real code (verified in publisher.ts:88-94). But IF
    // the service ever re-introduced a throwing path, the post-publishSucceeded
    // guard must keep telemetry consistent: no skill_dedup_events row, no
    // last_refined_at bump. This test pins that contract.
    embedWithCosines(CANDIDATE_TEXT, [[textOf(existing), 0.4]]);
    publishEventMock.mockRejectedValueOnce(new Error('outbox enqueue failed'));

    const { processSkillFeedback } = await loadService();

    await processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-publish-fail',
      feedback: [{
        skillId: 'skill-origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Some candidate', description: 'd', instruction: 'i' },
      }],
    });

    // Publish was attempted and failed.
    expect(publishEventMock).toHaveBeenCalledTimes(1);

    // No dedup_events INSERTs (would have run AFTER publishSucceeded).
    expect(getDedupInserts()).toHaveLength(0);

    // No last_refined_at UPDATE either — same post-publish guard.
    expect(getRefreshUpdate()).toBeNull();
  });
});

describe('processSkillFeedback — idempotency', () => {
  beforeEach(() => {
    setEnv({ enabled: true });
  });

  it('short-circuits on duplicate taskId — no dedup decisions, no events', async () => {
    setupCommon([]);
    // First call: idempotency INSERT returns one row. Second call: returns
    // empty (ON CONFLICT DO NOTHING).
    queryMock.mockReset();
    let idempotencyCalls = 0;
    queryMock.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('skill_feedback_log')) {
        idempotencyCalls += 1;
        return Promise.resolve({ rows: idempotencyCalls === 1 ? [{ agent_id: AGENT_ID }] : [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM internal_agents')) {
        return Promise.resolve({ rows: [{ current_version: 1, role: 'TestRole' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    getAgentSkillsMock.mockResolvedValue({ skills: [] });
    publishEventMock.mockResolvedValue(undefined);
    generateAndStoreEmbeddingMock.mockResolvedValue(undefined);
    // No existing skills, so findNearestSkill returns before embedding anything.
    // Declared anyway so a change that starts embedding fails loudly here.
    embedWithCosines(CANDIDATE_TEXT, []);
    const { processSkillFeedback } = await loadService();

    const call = (): Promise<void> => processSkillFeedback({
      tenantId: TENANT_ID, agentId: AGENT_ID, taskId: 'task-dup',
      feedback: [{
        skillId: 'origin', skillName: 'Origin', outcome: 'failure',
        newPitfallSkill: { name: 'Cand', description: 'd', instruction: 'i' },
      }],
    });

    await call();
    await call();

    // Only the first call writes a skill_dedup_events row.
    expect(getDedupInserts()).toHaveLength(1);
    // Only the first call publishes.
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });
});
