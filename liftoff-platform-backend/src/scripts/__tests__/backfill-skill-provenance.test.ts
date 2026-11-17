// The skill-provenance backfill must not downgrade the provenance it exists to
// establish.
//
// The sweep syncs `internal_agents.skills` from the runtime's live set and
// tags each skill from `agent_skill_metrics.origin`, keyed on skill id. But the
// runtime does not persist the ids we send it — `agent_skills.id` is generated
// on every write — so a flywheel skill comes back under a fresh uuid, misses
// the metrics lookup, and resolves to `distilled`.
//
// If the column already said `learned`, that write is a downgrade, and it is
// invisible to a presence check: the skill is still there, only its provenance
// changed. The column is authoritative (ADR-043), so a non-default provenance it
// already carries wins over anything recomputed here.

// The module under test imports the runtime client for its main() path, which
// drags in the generated proto client. Stubbed so this suite exercises the
// merge rule alone.
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getAgentSkills: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({
  closePools: jest.fn(),
  initDatabase: jest.fn(),
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveMergedSkills } from '../backfill-skill-provenance';
import type { Skill } from '../../internal-agents/types';

const RUNTIME_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

function runtimeSkill(over: Partial<Skill> = {}) {
  return {
    id: RUNTIME_ID,
    name: 'E2E learned probe skill',
    description: 'probe',
    instruction: 'do the thing',
    tags: [] as string[],
    ...over,
  };
}

describe('provenance precedence', () => {
  it('keeps a learned skill learned when the runtime returns it under a new id', () => {
    const column: Skill[] = [{
      id: 'reflection:439c91d4-2b71-4ebe-bdf9-7c80fa241b68:e2e-origin',
      name: 'E2E learned probe skill',
      description: 'probe',
      instruction: 'do the thing',
      provenance: 'learned',
    }];

    const { merged, preservedFromColumn } = resolveMergedSkills(
      [runtimeSkill()],
      column,
      new Map(),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].provenance).toBe('learned');
    expect(preservedFromColumn).toBe(1);
  });

  it('keeps an operator skill operator, and keeps it protected', () => {
    const column: Skill[] = [{
      name: 'E2E learned probe skill',
      description: 'probe',
      instruction: 'do the thing',
      provenance: 'operator',
      protected: true,
    }];

    const { merged } = resolveMergedSkills([runtimeSkill()], column, new Map());

    expect(merged[0].provenance).toBe('operator');
    expect(merged[0].protected).toBe(true);
  });

  it('still tags from metrics origin when the column says nothing', () => {
    const { merged, learnedTagged } = resolveMergedSkills(
      [runtimeSkill()],
      [],
      new Map([[RUNTIME_ID, 'reflection']]),
    );

    expect(merged[0].provenance).toBe('learned');
    expect(learnedTagged).toBe(1);
  });

  it('defaults to distilled when nothing knows better', () => {
    const { merged, preservedFromColumn } = resolveMergedSkills([runtimeSkill()], [], new Map());
    expect(merged[0].provenance).toBe('distilled');
    expect(preservedFromColumn).toBe(0);
  });

  it('carries archived skills across and does not count them as erased', () => {
    const column: Skill[] = [{
      name: 'retired skill', description: 'x', instruction: 'y', archived: true,
    }];

    const { merged, droppedFromColumn } = resolveMergedSkills([runtimeSkill()], column, new Map());

    expect(merged.map((s) => s.name)).toEqual(['E2E learned probe skill', 'retired skill']);
    expect(droppedFromColumn).toHaveLength(0);
  });

  it('reports a non-archived column skill the runtime does not have as erased', () => {
    // Not silently dropped: the column can legitimately be ahead of the runtime
    // now that the merge path is live, so the caller has to be told.
    const column: Skill[] = [{
      name: 'distilled but not yet synced', description: 'x', instruction: 'y',
    }];

    const { merged, droppedFromColumn } = resolveMergedSkills([runtimeSkill()], column, new Map());

    expect(merged.map((s) => s.name)).toEqual(['E2E learned probe skill']);
    expect(droppedFromColumn.map((s) => s.name)).toEqual(['distilled but not yet synced']);
  });
});
