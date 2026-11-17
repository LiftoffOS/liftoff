// Ordering the system prompt so a prefix of it can actually be cached.
//
// Prompt caching only pays when a byte-identical PREFIX repeats. That makes the
// order of assembly a performance decision, not a stylistic one: one volatile
// block placed early invalidates every stable block after it, for the whole
// session.
//
// The audit that produced this found TR assembling the prompt in an order that
// defeated caching outright. Static directives — the response-format rules and
// the autonomous-operation directive, identical on every run of every agent —
// were appended AFTER the retrieved memories and the prior-run summary, which
// change every turn. So the longest stable prefix ended at the connector list,
// and everything after it was re-sent uncached every time.
//
// Three tiers, strictly ordered:
//
//   STABLE     identity, role, instructions, capabilities, the standing
//              directives. Byte-identical for the life of the session.
//   SESSION    things that hold for this conversation but not for all time:
//              the browser session, the standing task ledger.
//   VOLATILE   this turn only: retrieved skills (selected against THIS
//              objective), the objective, recalled memories, the prior run.
//
// Skills are volatile, and that is the point of the ordering: they are retrieved
// per objective, so putting them anywhere above the breakpoint would invalidate
// the cache on every turn even when nothing else moved.

export type PromptTier = 'stable' | 'session' | 'volatile';

export interface PromptSegment {
  tier: PromptTier;
  text: string;
}

/** Ordered so a prefix is cacheable. Anything appended out of tier order is a
 *  cache bug, not a style one. */
const TIER_ORDER: PromptTier[] = ['stable', 'session', 'volatile'];

export class TieredPrompt {
  private readonly segments: PromptSegment[] = [];

  add(tier: PromptTier, text: string | null | undefined): this {
    if (text && text.trim().length > 0) this.segments.push({ tier, text });
    return this;
  }

  /** Segments in tier order, stable first. Insertion order is preserved WITHIN
   *  a tier, so callers keep control of the reading order of related blocks. */
  ordered(): PromptSegment[] {
    return TIER_ORDER.flatMap((t) => this.segments.filter((s) => s.tier === t));
  }

  render(): string {
    return this.ordered().map((s) => s.text).join('\n\n');
  }

  /**
   * Where the cacheable prefix ends, in characters.
   *
   * Everything before this offset is byte-identical for the session, so a
   * provider that supports an explicit breakpoint can be told to cache exactly
   * this much. Returns 0 when there is no stable content, which is honest
   * rather than a cache marker on nothing.
   */
  cacheablePrefixLength(): number {
    const stable = this.ordered().filter((s) => s.tier === 'stable');
    if (stable.length === 0) return 0;
    return stable.map((s) => s.text).join('\n\n').length;
  }

  /** The stable prefix and the rest, for providers that take the system prompt
   *  as an array of blocks with a cache marker on one of them. */
  split(): { stable: string; rest: string } {
    const ordered = this.ordered();
    const stable = ordered.filter((s) => s.tier === 'stable').map((s) => s.text).join('\n\n');
    const rest = ordered.filter((s) => s.tier !== 'stable').map((s) => s.text).join('\n\n');
    return { stable, rest };
  }

  /** Per-tier character counts, for the telemetry that tells us whether the
   *  ordering is actually paying. */
  stats(): Record<PromptTier, number> {
    const out: Record<PromptTier, number> = { stable: 0, session: 0, volatile: 0 };
    for (const s of this.segments) out[s.tier] += s.text.length;
    return out;
  }
}
