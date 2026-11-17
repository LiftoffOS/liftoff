// The "TENANT DATA LANDSCAPE" section of the distillation prompt.
//
// The distiller writes an agent's permanent instructions knowing which systems
// it can reach and nothing about what is in them, so the instructions it
// produces describe systems generically: "search the CRM", "check the relevant
// channel". Given the actual shape — the channels by name, how many deals
// exist, how far back the record goes — it can name them.
//
// PLATFORM CONTEXT, NOT USER CONTENT. This is not fenced with the user-content
// nonce: it is counts and entity-type names read out of our own database, on
// the same footing as the connector catalog. Fencing it would tell the model to
// distrust its own platform's description of the workspace.
//
// TITLES ARE NOT INCLUDED. Entity titles are customer business data (a channel
// called "acme-renewal-risk" says something about a customer), and the value
// here comes from shape and scale, not from names. Counts and types only.

export interface DataLandscapeSummary {
  connectors: Array<{
    connectorType: string;
    entityCounts: Record<string, number>;
    hydratedCount: number;
    stubCount: number;
    oldestObservedAt: string | null;
    newestObservedAt: string | null;
  }>;
  indexedContext: { items: number; oldest: string | null; newest: string | null };
  knowledgeItems: number | null;
  truncated: boolean;
}

/** Entity types listed per connector. The distiller needs the shape, not an
 *  inventory, and a long tail of rare types buys nothing at prompt cost. */
const MAX_TYPES_LISTED = 8;

/**
 * Render the section. Returns '' when there is nothing useful to say, so the
 * caller can concatenate unconditionally.
 *
 * An empty landscape returns '' rather than "this workspace has no data": the
 * census may simply not have run yet, and telling the distiller a workspace is
 * empty would have it write instructions around an emptiness that is an
 * artifact of our own scheduling.
 */
export function buildDataLandscapeSection(landscape: DataLandscapeSummary | null): string {
  if (!landscape) return '';

  const hasCensus = landscape.connectors.some((c) => Object.keys(c.entityCounts).length > 0);
  const hasIndexed = landscape.indexedContext.items > 0;
  const hasKnowledge = landscape.knowledgeItems !== null && landscape.knowledgeItems > 0;

  // Suppress the section only when there is nothing to say from ANY source.
  // Gating on the connector census and the index alone made the knowledge line
  // below unreachable for a workspace whose only catalogued data is a knowledge
  // base, so the distiller wrote instructions in ignorance of a corpus the
  // agent can actually search.
  if (!hasCensus && !hasIndexed && !hasKnowledge) return '';

  const lines: string[] = [
    'TENANT DATA LANDSCAPE. What is actually in the systems this agent will be bound to.',
    'Counts are what has been catalogued so far, which is a FLOOR, not a total. Write instructions',
    'that suit this scale and shape. Never write an instruction that asserts something does not',
    'exist on the basis of these numbers.',
  ];

  for (const c of landscape.connectors) {
    const entries = Object.entries(c.entityCounts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;
    const shown = entries.slice(0, MAX_TYPES_LISTED)
      .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
      .join(', ');
    const rest = entries.length - Math.min(entries.length, MAX_TYPES_LISTED);
    const tail = rest > 0 ? `, and ${rest} other entity type${rest === 1 ? '' : 's'}` : '';
    const since = c.oldestObservedAt ? ` (record goes back to ${c.oldestObservedAt.slice(0, 10)})` : '';
    lines.push(`  ${c.connectorType}: ${shown}${tail}${since}`);
  }

  if (hasIndexed) {
    const from = landscape.indexedContext.oldest
      ? ` since ${landscape.indexedContext.oldest.slice(0, 10)}`
      : '';
    lines.push(
      `  Already-fetched content${from}: ${landscape.indexedContext.items} items, searchable with ` +
      '`search` at no cost to the connected system. Prefer it over a fresh fetch when the work only ' +
      'needs something already seen.',
    );
  }

  if (landscape.knowledgeItems !== null && landscape.knowledgeItems > 0) {
    lines.push(`  Knowledge base: ${landscape.knowledgeItems} items, searchable with \`corpus_search\`.`);
  }

  if (landscape.truncated) {
    lines.push('  (This summary was shortened; some systems or entity types are not listed.)');
  }

  return lines.join('\n');
}
