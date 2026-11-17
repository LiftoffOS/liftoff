// P1.0 — skill provenance merge.
//
// The behaviour under test is the one that used to be broken: a redistill must
// replace the distilled slice and preserve everything the flywheel or a human
// authored. These assert the contract (what relates to what), not a snapshot of
// any particular skill list.

import { mergeSkillsByProvenance, normalizeSkillProvenance, skillsForRuntime } from '../skill-provenance';
import type { Skill } from '../types';

jest.mock('../skill-similarity', () => ({
  findNearestSkill: jest.fn(),
}));

import { findNearestSkill } from '../skill-similarity';

const mockFindNearest = findNearestSkill as jest.MockedFunction<typeof findNearestSkill>;

const opts = { tenantId: 't1', agentId: 'a1' };

function skill(name: string, provenance?: Skill['provenance'], extra: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `${name} description`,
    instruction: `${name} instruction`,
    ...(provenance ? { provenance } : {}),
    ...extra,
  };
}

beforeEach(() => {
  mockFindNearest.mockReset();
  mockFindNearest.mockResolvedValue(null);
});

describe('normalizeSkillProvenance', () => {
  it('treats a skill written before provenance existed as distilled', () => {
    expect(normalizeSkillProvenance(skill('legacy'))).toBe('distilled');
  });
});

describe('mergeSkillsByProvenance — distilled caller (redistill / Optimize)', () => {
  it('replaces the distilled slice', async () => {
    const current = [skill('old-distilled', 'distilled')];
    const incoming = [skill('new-distilled')];

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'distilled',
    });

    expect(result.skills.map((s) => s.name)).toEqual(['new-distilled']);
    expect(result.stats.replaced).toBe(1);
  });

  it('preserves learned skills the incoming set does not name', async () => {
    const current = [skill('old-distilled', 'distilled'), skill('learned-one', 'learned')];
    const incoming = [skill('new-distilled')];

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'distilled',
    });

    expect(result.skills.map((s) => s.name).sort()).toEqual(['learned-one', 'new-distilled']);
    expect(result.stats.preservedLearned).toBe(1);
  });

  it('preserves operator skills the incoming set does not name', async () => {
    const current = [skill('operator-one', 'operator', { protected: true })];
    const incoming = [skill('new-distilled')];

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'distilled',
    });

    expect(result.skills.map((s) => s.name).sort()).toEqual(['new-distilled', 'operator-one']);
    expect(result.stats.preservedOperator).toBe(1);
  });

  it('leaves a protected skill untouched even when the incoming set names it', async () => {
    const current = [skill('shared-name', 'operator', { protected: true, instruction: 'human wrote this' })];
    const incoming = [skill('shared-name')];

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'distilled',
    });

    const survivor = result.skills.find((s) => s.name === 'shared-name');
    expect(survivor?.instruction).toBe('human wrote this');
    expect(survivor?.provenance).toBe('operator');
  });

  it('drops a fresh distilled skill that duplicates a preserved learned skill', async () => {
    const current = [skill('learned-one', 'learned')];
    const incoming = [skill('near-duplicate'), skill('genuinely-new')];

    mockFindNearest.mockImplementation(async (candidate) =>
      candidate.description.startsWith('near-duplicate')
        ? {
            matchedSkill: {
              id: 'x',
              name: 'learned-one',
              description: 'd',
              instruction: 'i',
              tags: [],
            },
            similarity: 0.97,
          }
        : null,
    );

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'distilled',
    });

    expect(result.skills.map((s) => s.name).sort()).toEqual(['genuinely-new', 'learned-one']);
    expect(result.stats.deduped).toBe(1);
  });

  it('keeps both when the similarity check fails (fail-open, never drops a learned skill)', async () => {
    mockFindNearest.mockResolvedValue(null);

    const result = await mergeSkillsByProvenance(
      [skill('learned-one', 'learned')],
      [skill('maybe-duplicate')],
      { ...opts, incomingProvenance: 'distilled' },
    );

    expect(result.skills).toHaveLength(2);
    expect(result.stats.deduped).toBe(0);
  });

  it('preserves learned skills when the distiller returns nothing', async () => {
    const result = await mergeSkillsByProvenance(
      [skill('learned-one', 'learned'), skill('old-distilled', 'distilled')],
      [],
      { ...opts, incomingProvenance: 'distilled' },
    );

    expect(result.skills.map((s) => s.name)).toEqual(['learned-one']);
  });
});

describe('mergeSkillsByProvenance — operator caller (edit / steering verbs)', () => {
  it('does not re-author the distilled slice', async () => {
    const current = [skill('distilled-one', 'distilled'), skill('distilled-two', 'distilled')];
    const incoming = [skill('distilled-one', 'distilled', { instruction: 'edited by a human' })];

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'operator',
    });

    expect(result.skills.map((s) => s.name).sort()).toEqual(['distilled-one', 'distilled-two']);
    expect(result.skills.find((s) => s.name === 'distilled-one')?.instruction).toBe('edited by a human');
  });

  it('marks an untagged incoming skill as operator-protected', async () => {
    const result = await mergeSkillsByProvenance([], [skill('hand-written')], {
      ...opts,
      incomingProvenance: 'operator',
    });

    expect(result.skills[0].provenance).toBe('operator');
    expect(result.skills[0].protected).toBe(true);
  });

  it('honours an explicit unprotect', async () => {
    const result = await mergeSkillsByProvenance(
      [],
      [skill('hand-written', 'operator', { protected: false })],
      { ...opts, incomingProvenance: 'operator' },
    );

    expect(result.skills[0].protected).toBe(false);
  });

  it('lets an operator overwrite a protected skill (only a human may)', async () => {
    const current = [skill('shared', 'operator', { protected: true, instruction: 'v1' })];
    const incoming = [skill('shared', 'operator', { protected: true, instruction: 'v2' })];

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'operator',
    });

    expect(result.skills.find((s) => s.name === 'shared')?.instruction).toBe('v2');
  });

  it('keeps a round-tripped distilled skill distilled', async () => {
    const result = await mergeSkillsByProvenance(
      [skill('from-distiller', 'distilled')],
      [skill('from-distiller', 'distilled')],
      { ...opts, incomingProvenance: 'operator' },
    );

    expect(result.skills[0].provenance).toBe('distilled');
    expect(result.skills[0].protected).toBeUndefined();
  });
});

describe('identity matching', () => {
  it('matches on id when present, so a rename is an edit rather than an addition', async () => {
    const current = [skill('old-name', 'operator', { id: 'skill-1', protected: false })];
    const incoming = [skill('new-name', 'operator', { id: 'skill-1', protected: false })];

    const result = await mergeSkillsByProvenance(current, incoming, {
      ...opts,
      incomingProvenance: 'operator',
    });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('new-name');
  });

  it('matches on name case-insensitively for legacy skills with no id', async () => {
    const result = await mergeSkillsByProvenance(
      [skill('Reporting Cadence', 'learned')],
      [skill('reporting cadence', 'learned')],
      { ...opts, incomingProvenance: 'operator' },
    );

    expect(result.skills).toHaveLength(1);
  });
});

describe('skillsForRuntime', () => {
  it('filters archived skills out of the runtime projection', () => {
    const skills = [skill('active'), skill('retired', 'operator', { archived: true })];
    expect(skillsForRuntime(skills).map((s) => s.name)).toEqual(['active']);
  });
});

// Archiving is a person's decision about whether a skill exists. A redistill
// re-authors the ACTIVE set; it must not quietly undo that decision, and it
// must not turn an archive into a delete.
describe('archived skills survive a redistill', () => {
  const archived = {
    name: 'Retired escalation path',
    description: 'old',
    instruction: 'old',
    provenance: 'distilled' as const,
    archived: true,
  };

  it('keeps an archived skill the distiller did not re-emit', async () => {
    const merged = await mergeSkillsByProvenance(
      [archived],
      [{ name: 'Fresh skill', description: 'd', instruction: 'i' }],
      { incomingProvenance: 'distilled', tenantId: 't', agentId: 'a', skipDedup: true },
    );
    const kept = merged.skills.find((s) => s.name === archived.name);
    expect(kept).toBeDefined();
    expect(kept?.archived).toBe(true);
  });

  it('does not un-archive a skill the distiller re-emitted', async () => {
    const merged = await mergeSkillsByProvenance(
      [archived],
      [{ name: archived.name, description: 'rewritten', instruction: 'rewritten' }],
      { incomingProvenance: 'distilled', tenantId: 't', agentId: 'a', skipDedup: true },
    );
    const kept = merged.skills.find((s) => s.name === archived.name);
    expect(kept?.archived).toBe(true);
    // The re-authored content still lands — only the archive flag is sticky.
    expect(kept?.instruction).toBe('rewritten');
  });

  it('lets an explicit restore clear the flag', async () => {
    const merged = await mergeSkillsByProvenance(
      [archived],
      [{ ...archived, archived: false }],
      { incomingProvenance: 'operator', tenantId: 't', agentId: 'a', skipDedup: true },
    );
    expect(merged.skills.find((s) => s.name === archived.name)?.archived).toBe(false);
  });

  it('keeps an archived skill through an unrelated operator edit', async () => {
    const merged = await mergeSkillsByProvenance(
      [archived, { name: 'Live skill', description: 'd', instruction: 'i', provenance: 'distilled' as const }],
      [{ name: 'Live skill', description: 'edited', instruction: 'edited' }],
      { incomingProvenance: 'operator', tenantId: 't', agentId: 'a', skipDedup: true },
    );
    expect(merged.skills.find((s) => s.name === archived.name)?.archived).toBe(true);
  });
});

// A client sends back the skills list it read, so provenance arrives from the
// client on every save. That makes it client input, and two claims must never
// be honoured: forging flywheel authorship, and downgrading something the
// flywheel or a person owns so the next redistill deletes it.
describe('client-asserted provenance', () => {
  const opts = { incomingProvenance: 'operator' as const, tenantId: 't', agentId: 'a', skipDedup: true };

  it('honours a genuine round-trip of a distilled skill', async () => {
    const stored = { name: 'S', description: 'd', instruction: 'i', provenance: 'distilled' as const };
    const merged = await mergeSkillsByProvenance([stored], [{ ...stored }], opts);
    const out = merged.skills.find((s) => s.name === 'S');
    expect(out?.provenance).toBe('distilled');
    // Round-tripped, not edited: it must NOT become operator-protected, or the
    // next redistill could no longer re-author it.
    expect(out?.protected).toBeUndefined();
  });

  it('honours a genuine round-trip of a learned skill', async () => {
    const stored = { name: 'S', description: 'd', instruction: 'i', provenance: 'learned' as const };
    const merged = await mergeSkillsByProvenance([stored], [{ ...stored }], opts);
    expect(merged.skills.find((s) => s.name === 'S')?.provenance).toBe('learned');
  });

  it('honours a learned claim on a skill the column has not recorded yet', async () => {
    // The skills GET labels a runtime skill the column has not caught up to as
    // `learned` — that is the platform's own statement, not the client's. When
    // this was refused, an ordinary settings save silently converted a live
    // flywheel skill to operator+protected and removed it from the flywheel.
    //
    // Refusing it protected nothing anyway: `operator` is freely claimable and
    // is the STRONGER claim (preserved AND protected), so `learned` grants a
    // caller strictly less.
    const merged = await mergeSkillsByProvenance(
      [],
      [{ name: 'Unsynced', description: 'd', instruction: 'i', provenance: 'learned' }],
      opts,
    );
    const out = merged.skills.find((s) => s.name === 'Unsynced');
    expect(out?.provenance).toBe('learned');
    expect(out?.protected).toBeUndefined();
  });

  it('lets a distilled skill be relabelled learned without protecting it', async () => {
    const stored = { name: 'S', description: 'd', instruction: 'i', provenance: 'distilled' as const };
    const merged = await mergeSkillsByProvenance(
      [stored],
      [{ ...stored, provenance: 'learned' as const }],
      opts,
    );
    expect(merged.skills.find((s) => s.name === 'S')?.provenance).toBe('learned');
  });

  it('refuses to downgrade a learned skill to distilled', async () => {
    // The dangerous one: a stale client sends back an old copy, the skill is
    // marked distilled, and the next redistill deletes what was learned.
    const stored = { name: 'S', description: 'd', instruction: 'i', provenance: 'learned' as const };
    const merged = await mergeSkillsByProvenance(
      [stored],
      [{ ...stored, provenance: 'distilled' as const }],
      opts,
    );
    expect(merged.skills.find((s) => s.name === 'S')?.provenance).not.toBe('distilled');
  });

  it('refuses to downgrade an operator skill to distilled', async () => {
    const stored = {
      name: 'S', description: 'd', instruction: 'i',
      provenance: 'operator' as const, protected: true,
    };
    const merged = await mergeSkillsByProvenance(
      [stored],
      [{ name: 'S', description: 'd', instruction: 'edited', provenance: 'distilled' as const }],
      opts,
    );
    expect(merged.skills.find((s) => s.name === 'S')?.provenance).toBe('operator');
  });

  it('still lets the distill-then-save path mark fresh output as distilled', async () => {
    // The legitimate new-skill claim: distiller output saved through the
    // operator-facing PUT must stay re-authorable by the next redistill.
    const merged = await mergeSkillsByProvenance(
      [],
      [{ name: 'Fresh', description: 'd', instruction: 'i', provenance: 'distilled' }],
      opts,
    );
    const out = merged.skills.find((s) => s.name === 'Fresh');
    expect(out?.provenance).toBe('distilled');
    expect(out?.protected).toBeUndefined();
  });
});

// A skill's FILES survive a re-author of its TEXT.
//
// Both a redistill and the reflection flywheel rewrite `instruction`. A skill
// whose wording improved has not thereby lost the scripts it ships with, and
// dropping them would leave the new text describing tools that are no longer
// there — the failure the bundle exists to prevent, arriving by a different
// door.
describe('bundles across a merge', () => {
  const bundle = {
    files: [
      {
        path: 'scripts/run.py',
        bytes: 12,
        sha256: 'a'.repeat(64),
        storageRef: 'skill-bundles/t1/s1/' + 'a'.repeat(64),
      },
    ],
  };

  // Matched by NAME, which is what a redistill produces: `identityKey` keys on
  // the id only when both sides carry one, and the distiller emits skills
  // without ids.
  it('carries the stored bundle onto a re-authored skill that brings none', async () => {
    const stored = skill('S', 'distilled', { bundle });

    const merged = await mergeSkillsByProvenance(
      [stored],
      [{ name: 'S', description: 'd', instruction: 'rewritten', provenance: 'distilled' as const }],
      opts,
    );

    expect(merged.skills.find((s) => s.name === 'S')?.bundle).toEqual(bundle);
  });

  // The same carry-across when both sides DO carry the id, which is the shape
  // the flywheel's write-back produces.
  it('carries the bundle when the skill is matched by id', async () => {
    const stored = skill('S', 'learned', { id: 's1', bundle });

    const merged = await mergeSkillsByProvenance(
      [stored],
      [{ id: 's1', name: 'S', description: 'd', instruction: 'rewritten', provenance: 'learned' as const }],
      { ...opts, incomingProvenance: 'learned' },
    );

    expect(merged.skills.find((s) => s.name === 'S')?.bundle).toEqual(bundle);
  });

  it('lets a re-import replace the bundle', async () => {
    const replacement = {
      files: [
        {
          path: 'scripts/new.py',
          bytes: 20,
          sha256: 'b'.repeat(64),
          storageRef: 'skill-bundles/t1/s1/' + 'b'.repeat(64),
        },
      ],
    };
    const stored = skill('S', 'operator', { id: 's1', bundle });

    const merged = await mergeSkillsByProvenance(
      [stored],
      [skill('S', 'operator', { id: 's1', bundle: replacement })],
      { ...opts, incomingProvenance: 'operator' },
    );

    expect(merged.skills.find((s) => s.name === 'S')?.bundle).toEqual(replacement);
  });

  it('leaves a text-only skill without a bundle', async () => {
    const merged = await mergeSkillsByProvenance(
      [skill('S', 'distilled', { id: 's1' })],
      [{ name: 'S', description: 'd', instruction: 'rewritten', provenance: 'distilled' as const }],
      opts,
    );

    expect(merged.skills.find((s) => s.name === 'S')?.bundle).toBeUndefined();
  });
});
