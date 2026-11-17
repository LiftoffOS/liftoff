// The seam the merge unit tests could not see.
//
// `skill-provenance.test.ts` covers the merge function and passes 27/27, but the
// merge is only ever as good as what is handed to it. The flywheel fetches the
// current skills from the RUNTIME, and the runtime's reply is not the authority
// on provenance — the column is (ADR-043).
//
// When that re-join was missing, two things broke at once and neither unit
// suite noticed, because both are integration facts:
//
//   * `isProtected()` read `protected` off runtime rows that never carried it,
//     so every operator-protected skill looked unprotected and the flywheel was
//     free to rewrite it.
//   * the column write-back persisted provenance-less skills, which
//     `normalizeSkillProvenance` reads as `distilled` — so the next redistill
//     deleted every learned skill, which is the precise loss P1.0 exists to
//     prevent.
//
// These tests assert the re-join, not the merge.

import { jest } from '@jest/globals';

const queryMock = jest.fn();
const getAgentSkillsMock = jest.fn();
const publishEventMock = jest.fn();
const embedMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@liftoffos/embedding', () => ({ embeddingClient: { embed: embedMock } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getAgentSkills: getAgentSkillsMock,
    saveAgentMemory: jest.fn(async () => ({ memoryId: 'm1' })),
    saveMemory: jest.fn(async () => ({ memoryId: 'm1' })),
  },
}));
jest.mock('../events', () => ({ publishEvent: publishEventMock }));
jest.mock('../../injection-detection/gating', () => ({
  screenPersistedStructure: jest.fn(async () => ({ block: false })),
}));
jest.mock('../embedding-service', () => ({ generateAndStoreEmbedding: jest.fn() }));

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const AGENT = '00000000-0000-0000-0000-0000000000bb';

/** The column's view: one learned skill and one operator-protected skill. */
const COLUMN_SKILLS = [
  { id: 's-learned', name: 'Learned one', description: 'd', instruction: 'i', tags: [], provenance: 'learned' },
  { id: 's-op', name: 'Operator one', description: 'd', instruction: 'i', tags: [], provenance: 'operator', protected: true },
  { id: 's-arch', name: 'Archived one', description: 'd', instruction: 'i', tags: [], provenance: 'operator', archived: true },
];

/** The runtime's view when it OMITS the fields — what the endpoint returned
 *  before it was fixed, and what a lagging runtime can still return. */
const RUNTIME_SKILLS = [
  { id: 's-learned', name: 'Learned one', description: 'd', instruction: 'i', tags: [] },
  { id: 's-op', name: 'Operator one', description: 'd', instruction: 'i', tags: [] },
];

/**
 * The runtime's view when it DISAGREES — which is the standing state, not an
 * edge case.
 *
 * TR's migration 334 defaulted every pre-existing `agent_skills` row to
 * `provenance='distilled'`, `protected=false`, and nothing backfills them. So
 * for every flywheel-authored skill older than that migration, the column says
 * `learned` and the runtime says `distilled` — and both fields are NOT NULL, so
 * the runtime always has a value to offer.
 *
 * Testing only the omission case is how the precedence bug survived: a re-join
 * written as `runtime ?? column` passes every omission test and never consults
 * the column once the runtime starts answering.
 */
const RUNTIME_SKILLS_DISAGREEING = [
  { id: 's-learned', name: 'Learned one', description: 'd', instruction: 'i', tags: [], provenance: 'distilled', protected: false },
  { id: 's-op', name: 'Operator one', description: 'd', instruction: 'i', tags: [], provenance: 'distilled', protected: false },
];

/** The JSON written to internal_agents.skills, parsed. */
function writtenColumn(): Array<Record<string, unknown>> | null {
  const call = queryMock.mock.calls.find(
    ([sql]) => typeof sql === 'string' && /UPDATE internal_agents SET skills/.test(sql),
  );
  if (!call) return null;
  return JSON.parse((call[1] as unknown[])[0] as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  getAgentSkillsMock.mockResolvedValue({ skills: RUNTIME_SKILLS });
  publishEventMock.mockResolvedValue(undefined);
  embedMock.mockResolvedValue({ embedding: new Array(768).fill(0.01) });

  queryMock.mockImplementation(async (sql: string) => {
    // Claim the idempotency row, or the service short-circuits as a duplicate
    // and never reaches the write-back this suite is about.
    if (/INSERT INTO skill_feedback_log/.test(sql)) {
      return { rows: [{ agent_id: AGENT }], rowCount: 1 };
    }
    if (/SELECT current_version, role, skills FROM internal_agents/.test(sql)) {
      return { rows: [{ current_version: 3, role: 'Engineer', skills: COLUMN_SKILLS }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

async function runFeedback(extra: Record<string, unknown>) {
  const { processSkillFeedback } = await import('../skill-feedback-service');
  await processSkillFeedback({
    tenantId: TENANT,
    agentId: AGENT,
    taskId: 'task-1',
    feedback: [{ skillId: 's-learned', skillName: 'Learned one', outcome: 'success', ...extra }],
  } as Parameters<typeof processSkillFeedback>[0]);
}

describe('provenance survives a flywheel run', () => {
  it('does not down-stamp a learned skill to distilled', async () => {
    await runFeedback({ refinedInstruction: 'a better instruction' });

    const written = writtenColumn();
    expect(written).not.toBeNull();
    const learned = written!.find((s) => s.id === 's-learned');
    // Provenance-less would be read as `distilled` by normalizeSkillProvenance,
    // and the next redistill would delete it.
    expect(learned?.provenance).toBe('learned');
  });

  it('keeps an operator skill operator, and still protected', async () => {
    await runFeedback({ refinedInstruction: 'a better instruction' });

    const op = writtenColumn()!.find((s) => s.id === 's-op');
    expect(op?.provenance).toBe('operator');
    expect(op?.protected).toBe(true);
  });

  it('still carries archived skills the runtime cannot see', async () => {
    await runFeedback({ refinedInstruction: 'a better instruction' });

    const arch = writtenColumn()!.find((s) => s.id === 's-arch');
    expect(arch).toBeDefined();
    expect(arch?.archived).toBe(true);
  });
});

describe('when the two stores disagree, the column wins', () => {
  // The loss chain this closes: reflection mutates anything → the flywheel
  // adopts the runtime's `distilled` → the write-back down-stamps the column →
  // the next redistill deletes the skill as replaceable output. Reachable today
  // for every skill that predates TR's migration 334.
  beforeEach(() => {
    getAgentSkillsMock.mockResolvedValue({ skills: RUNTIME_SKILLS_DISAGREEING });
  });

  it('keeps a learned skill learned when the runtime says distilled', async () => {
    await runFeedback({ refinedInstruction: 'a better instruction' });
    const written = writtenColumn();
    expect(written).not.toBeNull();
    expect(written!.find((s) => s.id === 's-learned')?.provenance).toBe('learned');
  });

  it('keeps an operator skill operator when the runtime says distilled', async () => {
    await runFeedback({ refinedInstruction: 'a better instruction' });
    expect(writtenColumn()!.find((s) => s.id === 's-op')?.provenance).toBe('operator');
  });

  it('keeps a protected skill protected when the runtime says it is not', async () => {
    // A runtime row defaulted to protected=false would otherwise unprotect a
    // skill an operator took ownership of, defeating the enforcement entirely.
    await runFeedback({ refinedInstruction: 'a better instruction' });
    expect(writtenColumn()!.find((s) => s.id === 's-op')?.protected).toBe(true);
  });

  it('still refuses to refine a protected skill the runtime reports unprotected', async () => {
    const { processSkillFeedback } = await import('../skill-feedback-service');
    await processSkillFeedback({
      tenantId: TENANT,
      agentId: AGENT,
      taskId: 'task-1',
      feedback: [{
        skillId: 's-op', skillName: 'Operator one', outcome: 'failure',
        refinedInstruction: 'the flywheel trying to rewrite an operator skill',
      }],
    } as Parameters<typeof processSkillFeedback>[0]);
    const written = writtenColumn();
    if (written) {
      expect(written.find((s) => s.id === 's-op')?.instruction)
        .not.toContain('the flywheel trying to rewrite');
    }
  });

  it('still carries archived skills, which the runtime cannot see at all', async () => {
    await runFeedback({ refinedInstruction: 'a better instruction' });
    expect(writtenColumn()!.some((s) => s.id === 's-arch')).toBe(true);
  });
});

describe('protection is enforced against the column, not the runtime reply', () => {
  it('refuses to refine an operator-protected skill', async () => {
    const { processSkillFeedback } = await import('../skill-feedback-service');
    await processSkillFeedback({
      tenantId: TENANT,
      agentId: AGENT,
      taskId: 'task-2',
      feedback: [{
        skillId: 's-op',
        skillName: 'Operator one',
        outcome: 'success',
        refinedInstruction: 'the flywheel trying to rewrite a human edit',
      }],
    } as Parameters<typeof processSkillFeedback>[0]);

    const op = writtenColumn()!.find((s) => s.id === 's-op');
    // The refinement must be dropped: a person took ownership of this skill and
    // nobody is present to consent to a rewrite.
    expect(op?.instruction).toBe('i');
  });

  it('still refines an unprotected skill', async () => {
    await runFeedback({ refinedInstruction: 'a better instruction' });
    const learned = writtenColumn()!.find((s) => s.id === 's-learned');
    expect(learned?.instruction).toBe('a better instruction');
  });
});
