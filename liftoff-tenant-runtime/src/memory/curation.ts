// Keeping the memory store a curated set rather than an accumulating one, and
// giving what an agent knows about a PERSON a shape of its own.
//
// Two problems, one rail.
//
// The first is that memory only ever grows. Every run can save; nothing ever
// removes. A tenant a year in has thousands of memories per agent, retrieval
// gets slower and less precise as the corpus dilutes, and the memories that
// actually shape behaviour are buried under a hundred one-off observations
// nobody has read since. Usefulness scores, usage counts and last-used
// timestamps have been recorded all along — nothing has ever read them to
// decide what to let go of.
//
// The second is that facts about the person the agent works with are the most
// valuable memories it holds and the least legible. They live as untyped rows
// among everything else: "prefers short answers" sits next to "the staging
// database is at 10.0.0.4", ranked by the same cosine distance, evicted by the
// same rules, and invisible as a category to anybody who wants to answer "what
// does this team member think it knows about me?".
//
// So:
//
//   * Memories carry a KIND, on the tag rail that already identifies them.
//     Not a new column and not a new store — the governance, the retrieval, the
//     dedup and the layer scoping all already work, and a parallel store would
//     have to re-earn every one of those.
//   * Eviction is by score, and never touches what a person authored or what
//     the agent knows about a person. Those two categories are the ones a
//     tenant would notice losing.
//   * A user model has FACETS, so "what do you know about me" has an answer
//     with a shape, and so a new observation about someone's working hours
//     supersedes the old one rather than sitting beside it.

/**
 * What eviction actually needs to see.
 *
 * Narrower than `Memory` on purpose: the content, the embedding and the
 * encrypted payload are none of eviction's business, and asking for them would
 * mean the prune query had to decrypt every row in a scope to decide which few
 * to let go of.
 */
export interface MemoryForEviction {
  id: string;
  tags: string[];
  supersededBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  usefulnessScore: number;
  usageCount: number;
}

/** What a memory is, on the tag rail that already carries this kind of thing
 *  (`type:preference`, `type:imported`, `type:alias` all predate this). */
export const MEMORY_KINDS = [
  /** How this person likes things done. */
  'preference',
  /** Something durable about the world. */
  'fact',
  /** What the agent has worked out about the person it works with. */
  'user_model',
  /** Brought in from a file or a chat, rather than observed. */
  'imported',
  /** A glossary entry. */
  'alias',
] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];

export function kindTag(kind: MemoryKind): string {
  return `type:${kind}`;
}

export function kindOf(tags: string[] | undefined): MemoryKind | null {
  for (const t of tags ?? []) {
    if (!t.startsWith('type:')) continue;
    const k = t.slice('type:'.length) as MemoryKind;
    if ((MEMORY_KINDS as readonly string[]).includes(k)) return k;
  }
  return null;
}

/** A memory a person wrote, or approved, rather than one the agent observed.
 *  Never evicted: a tenant who typed something and later found it gone would be
 *  right to conclude the feature does not work. */
export const CURATED_TAG = 'curated';

export function isCurated(memory: { tags?: string[] }): boolean {
  return memory.tags?.includes(CURATED_TAG) === true;
}

// ── User modelling ───────────────────────────────────────────────────────────

/**
 * The facets of what an agent knows about a person.
 *
 * A closed list on purpose. An open one becomes a dumping ground within a
 * month, and the point of the shape is that a new observation about somebody's
 * working hours REPLACES the old one instead of accumulating beside it —
 * which needs a name both observations agree on.
 *
 * Nothing here is a fact about the person's identity beyond how to work with
 * them. That boundary is deliberate: an agent noting that somebody prefers
 * bullet points is useful; an agent building a profile of them is not what
 * anybody asked for, and would be a data-protection question rather than a
 * feature.
 */
export const USER_MODEL_FACETS = [
  /** How they like to be written to: length, formality, bullets vs prose. */
  'communication_style',
  /** When they are around, and in what timezone. */
  'working_hours',
  /** What they do, in enough detail to pitch an answer at them. */
  'role',
  /** Tools and systems they work in. */
  'tooling',
  /** How much they want to be asked before something happens. */
  'autonomy_preference',
] as const;

export type UserModelFacet = typeof USER_MODEL_FACETS[number];

export function facetTag(facet: UserModelFacet): string {
  return `facet:${facet}`;
}

export function facetOf(tags: string[] | undefined): UserModelFacet | null {
  for (const t of tags ?? []) {
    if (!t.startsWith('facet:')) continue;
    const f = t.slice('facet:'.length) as UserModelFacet;
    if ((USER_MODEL_FACETS as readonly string[]).includes(f)) return f;
  }
  return null;
}

export function isUserModelFacet(v: string): v is UserModelFacet {
  return (USER_MODEL_FACETS as readonly string[]).includes(v);
}

/**
 * Tags for a user-model memory.
 *
 * The subject is on the tag rather than only the scope key so a memory about a
 * particular person is identifiable even when it was saved at a layer shared
 * with others.
 */
export function userModelTags(facet: UserModelFacet, subjectAccountId: string): string[] {
  return [kindTag('user_model'), facetTag(facet), `subject:${subjectAccountId}`];
}

// Finding the memory a new observation supersedes is NOT done here.
//
// It was, briefly — an in-memory scan over an already-loaded list. But the
// service does it in SQL, scoped by tag, as part of the save. Two
// implementations of "which memory does this replace" is one more than can
// stay correct: the loser drifts, and because the drift only shows up as an
// extra live memory nobody notices, it would drift for a long time.
//
// See `supersedePriorUserModel` in service.ts. The helpers above (`kindOf`,
// `facetOf`, `userModelTags`) are what both the tag construction and that query
// agree on, which is where the shared understanding belongs.

// ── Bounding the store ───────────────────────────────────────────────────────

/** Live memories kept per (agent, layer). Past this the weakest are let go.
 *
 *  Two hundred is well beyond what any retrieval reads in a turn, so the cap
 *  never costs an agent something it would have used — it only stops the
 *  corpus diluting to the point where the good ones stop surfacing. */
export const MAX_MEMORIES_PER_SCOPE = Number(process.env.MAX_MEMORIES_PER_SCOPE ?? 200);

/** Below this age a memory is never evicted, whatever its score. A memory saved
 *  an hour ago has not had the chance to prove itself useful, and evicting it
 *  on a usefulness score it never had a chance to earn would mean the newest
 *  thing an agent learned is the first thing it forgets. */
export const EVICTION_GRACE_MS = Number(process.env.MEMORY_EVICTION_GRACE_MS ?? 7 * 24 * 60 * 60 * 1000);

export interface EvictionScore {
  memoryId: string;
  score: number;
  reason: string;
}

/**
 * How much a memory has earned its place.
 *
 * Three signals, all already recorded: how useful it has proved when retrieved,
 * how often it has been used, and how recently. Multiplicative rather than
 * additive, so a memory that scores well on one and terribly on the others does
 * not survive on that one — a memory retrieved fifty times a year ago and never
 * since is not more valuable than one used twice last week.
 */
export function retentionScore(memory: MemoryForEviction, now = Date.now()): number {
  const usefulness = Math.max(0, memory.usefulnessScore ?? 0);
  const usage = Math.log1p(Math.max(0, memory.usageCount ?? 0));
  const lastUsed = memory.lastUsedAt?.getTime() ?? memory.createdAt.getTime();
  const ageDays = Math.max(0, (now - lastUsed) / (24 * 60 * 60 * 1000));
  // Halves every 30 days unused.
  const recency = 1 / (1 + ageDays / 30);
  // The +0.1 floors each term so a zero on one signal weakens a memory rather
  // than zeroing it outright — a memory nobody has retrieved yet is unproven,
  // not worthless.
  return (usefulness + 0.1) * (usage + 0.1) * (recency + 0.1);
}

export interface EvictionPlan {
  /** Memories to supersede, weakest first. */
  evict: EvictionScore[];
  /** Memories that were over the cap but protected from eviction. Reported so
   *  a scope that never shrinks is explicable rather than mysterious. */
  protectedCount: number;
}

/**
 * Choose what to let go of.
 *
 * Never evicts:
 *   * anything a person authored or approved (`curated`)
 *   * anything the agent knows about a person (`user_model`) — a tenant would
 *     notice their team member forgetting how they like to work, and the whole
 *     value of those memories is that they persist
 *   * anything younger than the grace window, which has not had the chance to
 *     prove itself
 *
 * Returns an empty plan when the scope is under the cap, so the common case
 * costs one comparison.
 */
export function planEviction(
  memories: MemoryForEviction[],
  cap = MAX_MEMORIES_PER_SCOPE,
  now = Date.now(),
): EvictionPlan {
  const live = memories.filter((m) => m.supersededBy === null);
  if (live.length <= cap) return { evict: [], protectedCount: 0 };

  const protectedFrom = (m: MemoryForEviction): string | null => {
    if (isCurated(m)) return 'a person authored or approved this';
    if (kindOf(m.tags) === 'user_model') return 'this is what the team member knows about a person';
    if (now - m.createdAt.getTime() < EVICTION_GRACE_MS) return 'too new to have proved itself';
    return null;
  };

  const evictable: MemoryForEviction[] = [];
  let protectedCount = 0;
  for (const m of live) {
    if (protectedFrom(m)) protectedCount++;
    else evictable.push(m);
  }

  const overBy = live.length - cap;
  const ranked = evictable
    .map((m) => ({ memory: m, score: retentionScore(m, now) }))
    .sort((a, b) => a.score - b.score);

  // Only as many as the scope is actually over by. Evicting to a low-water mark
  // would throw away memories the cap did not ask for.
  const evict = ranked.slice(0, Math.min(overBy, ranked.length)).map((r) => ({
    memoryId: r.memory.id,
    score: r.score,
    reason: 'lowest retention score in a scope over its cap',
  }));

  return { evict, protectedCount };
}
