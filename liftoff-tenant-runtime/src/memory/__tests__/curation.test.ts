// Keeping the memory store a curated set, and giving what an agent knows about
// a PERSON a shape of its own.
//
// Eviction is the dangerous half. A cap that quietly removes the wrong thing is
// worse than no cap: the agent forgets something a person told it, nobody can
// see why, and the only symptom is behaviour that used to be right. So most of
// what follows is about what eviction refuses to touch.

import {
  CURATED_TAG,
  EVICTION_GRACE_MS,
  MAX_MEMORIES_PER_SCOPE,
  MEMORY_KINDS,
  USER_MODEL_FACETS,
  facetOf,
  isCurated,
  kindOf,
  kindTag,
  planEviction,
  retentionScore,
  userModelTags,
  type MemoryForEviction,
} from '../curation';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function mem(over: Partial<MemoryForEviction> = {}): MemoryForEviction {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    tags: [],
    supersededBy: null,
    // Comfortably outside the grace window unless a test says otherwise.
    createdAt: new Date(NOW - 90 * DAY),
    lastUsedAt: new Date(NOW - 10 * DAY),
    usefulnessScore: 0.5,
    usageCount: 3,
    ...over,
  };
}

describe('what a memory is', () => {
  it('reads its kind off the tag rail that already carries this', () => {
    expect(kindOf(['type:preference'])).toBe('preference');
    expect(kindOf(['other', 'type:user_model'])).toBe('user_model');
  });

  it('is null for a memory with no declared kind', () => {
    expect(kindOf(['random'])).toBeNull();
    expect(kindOf(undefined)).toBeNull();
  });

  it('ignores a tag that only looks like a kind', () => {
    // Otherwise anything could claim to be a user model, which is the one kind
    // eviction refuses to touch.
    expect(kindOf(['type:whatever'])).toBeNull();
  });

  it('covers the kinds that already existed', () => {
    // These tags predate this module; a kind list that did not include them
    // would silently reclassify every memory already saved.
    for (const k of ['preference', 'imported', 'alias']) {
      expect(MEMORY_KINDS).toContain(k);
    }
  });
});

describe('user modelling', () => {
  it('tags a memory with its facet and its subject', () => {
    const tags = userModelTags('working_hours', 'acct-1');
    expect(tags).toContain(kindTag('user_model'));
    expect(tags).toContain('facet:working_hours');
    expect(tags).toContain('subject:acct-1');
  });

  it('reads the facet back', () => {
    expect(facetOf(userModelTags('communication_style', 'a'))).toBe('communication_style');
  });

  it('keeps the facet list closed', () => {
    // An open list becomes a dumping ground within a month, and the point of
    // the shape is that two observations of the same thing agree on a name.
    expect(facetOf(['facet:favourite_colour'])).toBeNull();
    expect(USER_MODEL_FACETS.length).toBeLessThan(10);
  });

  it('leaves finding the superseded memory to the one place that does it', () => {
    // Two implementations of "which memory does this replace" is one more than
    // can stay correct, and the drift only shows up as an extra live memory
    // nobody notices — so it would drift for a long time. The service does it
    // in SQL as part of the save; this module owns only the tags they agree on.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'curation.ts'), 'utf8',
    ) as string;
    expect(src).not.toMatch(/export function findSupersededUserModel/);
    expect(src).toMatch(/See `supersedePriorUserModel` in service\.ts/);
  });
});

describe('what has earned its place', () => {
  it('prefers a memory that has proved useful', () => {
    expect(retentionScore(mem({ usefulnessScore: 0.9 }), NOW))
      .toBeGreaterThan(retentionScore(mem({ usefulnessScore: 0.1 }), NOW));
  });

  it('prefers one used recently over one used long ago', () => {
    expect(retentionScore(mem({ lastUsedAt: new Date(NOW - DAY) }), NOW))
      .toBeGreaterThan(retentionScore(mem({ lastUsedAt: new Date(NOW - 365 * DAY) }), NOW));
  });

  it('does not let one strong signal carry a memory on its own', () => {
    // Fifty retrievals a year ago is not worth more than two last week.
    const staleButPopular = mem({ usageCount: 50, lastUsedAt: new Date(NOW - 400 * DAY), usefulnessScore: 0.2 });
    const freshAndUseful = mem({ usageCount: 2, lastUsedAt: new Date(NOW - DAY), usefulnessScore: 0.8 });
    expect(retentionScore(freshAndUseful, NOW)).toBeGreaterThan(retentionScore(staleButPopular, NOW));
  });

  it('treats an unproven memory as weak, not worthless', () => {
    // A memory nobody has retrieved yet has not failed — it has not been tried.
    expect(retentionScore(mem({ usefulnessScore: 0, usageCount: 0 }), NOW)).toBeGreaterThan(0);
  });
});

describe('choosing what to let go of', () => {
  const many = (n: number, over: Partial<MemoryForEviction> = {}) =>
    Array.from({ length: n }, (_, i) => mem({ id: `m${i}`, ...over }));

  it('does nothing under the cap', () => {
    const plan = planEviction(many(MAX_MEMORIES_PER_SCOPE), MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict).toEqual([]);
  });

  it('lets go of exactly the overflow, not down to a low-water mark', () => {
    // Evicting further would throw away memories the cap did not ask for.
    const plan = planEviction(many(MAX_MEMORIES_PER_SCOPE + 5), MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict).toHaveLength(5);
  });

  it('lets go of the weakest first', () => {
    const memories = [
      ...many(MAX_MEMORIES_PER_SCOPE, { usefulnessScore: 0.9, usageCount: 20 }),
      mem({ id: 'weakest', usefulnessScore: 0, usageCount: 0, lastUsedAt: new Date(NOW - 400 * DAY) }),
    ];
    const plan = planEviction(memories, MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict.map((e) => e.memoryId)).toEqual(['weakest']);
  });

  it('never lets go of what a person authored', () => {
    // Somebody who typed something and later found it gone would be right to
    // conclude the feature does not work.
    const memories = [
      ...many(MAX_MEMORIES_PER_SCOPE, { usefulnessScore: 0.9 }),
      mem({ id: 'typed-by-a-person', tags: [CURATED_TAG], usefulnessScore: 0, usageCount: 0 }),
    ];
    const plan = planEviction(memories, MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict.map((e) => e.memoryId)).not.toContain('typed-by-a-person');
  });

  it('never lets go of what it knows about a person', () => {
    // A tenant would notice their team member forgetting how they like to
    // work, and persisting is the entire value of those memories.
    const memories = [
      ...many(MAX_MEMORIES_PER_SCOPE, { usefulnessScore: 0.9 }),
      mem({ id: 'about-ada', tags: userModelTags('working_hours', 'acct-1'), usefulnessScore: 0, usageCount: 0 }),
    ];
    const plan = planEviction(memories, MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict.map((e) => e.memoryId)).not.toContain('about-ada');
  });

  it('never lets go of one too new to have proved itself', () => {
    // Otherwise the newest thing an agent learned is the first thing it
    // forgets, on a usefulness score it never had a chance to earn.
    const memories = [
      ...many(MAX_MEMORIES_PER_SCOPE, { usefulnessScore: 0.9 }),
      mem({ id: 'learned-today', createdAt: new Date(NOW - 1000), usefulnessScore: 0, usageCount: 0 }),
    ];
    const plan = planEviction(memories, MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict.map((e) => e.memoryId)).not.toContain('learned-today');
  });

  it('evicts one just outside the grace window', () => {
    const memories = [
      ...many(MAX_MEMORIES_PER_SCOPE, { usefulnessScore: 0.9, usageCount: 20 }),
      mem({
        id: 'just-old-enough',
        createdAt: new Date(NOW - EVICTION_GRACE_MS - 1000),
        usefulnessScore: 0, usageCount: 0, lastUsedAt: null,
      }),
    ];
    expect(planEviction(memories, MAX_MEMORIES_PER_SCOPE, NOW).evict.map((e) => e.memoryId))
      .toContain('just-old-enough');
  });

  it('says when a scope is over its cap and everything is protected', () => {
    // A scope that never shrinks is otherwise a mystery, and "all of it is
    // protected" is the answer.
    const memories = many(MAX_MEMORIES_PER_SCOPE + 5, { tags: [CURATED_TAG] });
    const plan = planEviction(memories, MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict).toEqual([]);
    expect(plan.protectedCount).toBe(MAX_MEMORIES_PER_SCOPE + 5);
  });

  it('ignores memories that were already retired', () => {
    const memories = [
      ...many(50),
      ...many(MAX_MEMORIES_PER_SCOPE, { supersededBy: 'x' }),
    ];
    expect(planEviction(memories, MAX_MEMORIES_PER_SCOPE, NOW).evict).toEqual([]);
  });

  it('says why, so an operator can see what happened', () => {
    const plan = planEviction(many(MAX_MEMORIES_PER_SCOPE + 1), MAX_MEMORIES_PER_SCOPE, NOW);
    expect(plan.evict[0].reason).toBeTruthy();
  });
});

describe('curated', () => {
  it('recognises the tag', () => {
    expect(isCurated({ tags: [CURATED_TAG] })).toBe(true);
    expect(isCurated({ tags: [] })).toBe(false);
    expect(isCurated({})).toBe(false);
  });
});

describe('the wiring', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('prunes the scope after a save', () => {
    // A cap nothing enforces is a constant.
    expect(src).toMatch(/void this\.pruneScope\(/);
  });

  it('never lets pruning fail a save', () => {
    // A memory that was written must not disappear because tidying up failed.
    expect(src).toMatch(/memory scope prune failed \(non-fatal/);
  });

  it('prunes only after an insert, not after a dedup hit', () => {
    // A dedup hit added nothing, so there is nothing to prune and the query
    // would be pure cost on the hot path.
    const idx = src.indexOf('void this.pruneScope(');
    expect(src.slice(Math.max(0, idx - 400), idx)).toMatch(/is_insert/);
  });

  it('supersedes rather than deletes, so the audit trail survives', () => {
    expect(src).toMatch(/supersession_reason = 'evicted: scope over its cap'/);
  });

  it('does not decrypt content just to decide what to evict', () => {
    const prune = src.slice(src.indexOf('private async pruneScope'));
    const select = prune.slice(prune.indexOf('SELECT'), prune.indexOf('FROM memories'));
    expect(select).not.toMatch(/content/);
  });

  it('replaces the prior observation of a facet', () => {
    expect(src).toMatch(/supersedePriorUserModel\(/);
    expect(src).toMatch(/replaced by a newer observation of the same facet/);
  });

  it('matches a prior observation by facet, not by similarity', () => {
    // "Online 7am-3pm" and "not around after lunch" are semantically distant
    // and the same fact. Embedding dedup would keep both.
    const fn = src.slice(src.indexOf('private async supersedePriorUserModel'));
    expect(fn.slice(0, 1400)).toMatch(/tags @> ARRAY/);
  });
});

describe('the write path for what it knows about a person', () => {
  const handler = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'tools', 'standard-tool-handler.ts'), 'utf8',
  ) as string;
  const schema = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'tools', 'standard-tools.ts'), 'utf8',
  ) as string;

  it('is reachable from the tool the agent actually has', () => {
    // Without a producer, the facet helpers and the supersede logic are a
    // mechanism nothing ever triggers.
    expect(handler).toMatch(/userModelTags\(aboutPerson\.facet, aboutPerson\.account_id\)/);
  });

  it('is offered on the tool schema, or the model cannot use it', () => {
    expect(schema).toMatch(/about_person/);
    for (const f of USER_MODEL_FACETS) {
      expect(schema).toContain(`'${f}'`);
    }
  });

  it('validates the facet rather than trusting it', () => {
    // An unrecognised facet produces a memory that never supersedes and never
    // matches — which looks exactly like the feature silently not working.
    expect(handler).toMatch(/isUserModelFacet\(aboutPerson\.facet\)/);
    expect(handler).toMatch(/saved as an ordinary memory/);
  });

  it('tells the model that saving one REPLACES the last', () => {
    // Otherwise it will write a running history and be surprised when the
    // earlier entries stop coming back.
    expect(schema).toMatch(/REPLACES whatever you previously recorded/);
  });

  it('draws the line at working with someone, not profiling them', () => {
    expect(schema).toMatch(/Never use this for facts about a person beyond working with them/);
  });
});
