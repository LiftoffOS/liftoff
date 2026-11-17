// P1.0 — skill identity across a rewrite.
//
// The control plane now sends stable skill ids so `agent_skill_metrics` and
// usefulness scores stay attached to a skill that survives a redistill. Two
// things have to be true for that to work, and the second one is easy to miss:
//
//  1. A UUID id from the control plane is persisted verbatim.
//  2. The insert tolerates the row already being there. Superseding is an
//     UPDATE, not a delete, so the previous row for that id is STILL in the
//     table when the insert runs — without ON CONFLICT this violates the
//     primary key and fails every skills write after ids start flowing.

import { InternalAgentInstructionService } from '../internal-agent-instruction-service';

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../skill-embedding', () => ({
  generateSkillEmbeddingWithRetry: jest.fn().mockResolvedValue(null),
}));
jest.mock('../embedding-provider', () => ({
  getProviderModel: () => 'test-model',
  getDefaultProvider: () => 'google',
}), { virtual: true });

const UUID = '11111111-2222-3333-4444-555555555555';

/** Every agent_skills INSERT the service issued. */
function skillInserts(): Array<{ sql: string; params: unknown[] }> {
  return query.mock.calls
    .filter(([sql]) => typeof sql === 'string' && /INSERT INTO agent_skills/.test(sql))
    .map(([sql, params]) => ({ sql: sql as string, params: (params ?? []) as unknown[] }));
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ id: 'ci-1' }], rowCount: 1 });
});

describe('updateAgentSkillsOnly', () => {
  const service = new InternalAgentInstructionService();

  async function writeSkills(skills: unknown[]) {
    await service.updateAgentSkillsOnly({
      tenantId: '00000000-0000-0000-0000-0000000000aa',
      agentId: '00000000-0000-0000-0000-0000000000bb',
      skills,
    } as unknown as Parameters<typeof service.updateAgentSkillsOnly>[0]);
  }

  it('supersedes the previous active rows without deleting them', async () => {
    await writeSkills([{ name: 'S', description: 'd', instruction: 'i' }]);
    const supersede = query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && /UPDATE agent_skills SET status = 'superseded'/.test(sql));
    expect(supersede).toBeDefined();
  });

  it('tolerates the superseded row still holding the id it is re-inserting', async () => {
    await writeSkills([{ id: UUID, name: 'S', description: 'd', instruction: 'i' }]);
    const [insert] = skillInserts();
    // Without this the write throws on agent_skills_pkey and the agent loses
    // every skill it just learned.
    expect(insert.sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
    expect(insert.sql).toMatch(/status = 'active'/);
  });

  it('persists a UUID id verbatim, so metrics stay attached', async () => {
    await writeSkills([{ id: UUID, name: 'S', description: 'd', instruction: 'i' }]);
    expect(skillInserts()[0].params).toContain(UUID);
  });

  it('generates an id when the control plane sent a non-UUID one', async () => {
    // The flywheel mints transient `reflection:<uuid>:<origin>` ids, which are
    // not UUIDs and must not be forced into a uuid column.
    await writeSkills([
      { id: 'reflection:11111111-2222-3333-4444-555555555555:abc', name: 'S', description: 'd', instruction: 'i' },
    ]);
    const insert = skillInserts()[0];
    expect(insert.sql).toMatch(/COALESCE\(\$10::uuid, gen_random_uuid\(\)\)/);
    expect(insert.params[9]).toBeNull();
  });

  it('carries provenance and protection into the runtime', async () => {
    await writeSkills([
      { id: UUID, name: 'S', description: 'd', instruction: 'i', provenance: 'learned', protected: true },
    ]);
    const insert = skillInserts()[0];
    expect(insert.params[10]).toBe('learned');
    expect(insert.params[11]).toBe(true);
  });

  it('defaults a payload with no provenance to distilled and unprotected', async () => {
    await writeSkills([{ name: 'S', description: 'd', instruction: 'i' }]);
    const insert = skillInserts()[0];
    expect(insert.params[10]).toBe('distilled');
    expect(insert.params[11]).toBe(false);
  });
});
