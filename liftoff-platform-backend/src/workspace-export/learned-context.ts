// Each agent's Learned Context, as the Update Team page shows it.
//
// The page lists the team's OWN memories: the `agentId`-scoped, no-search
// branch of the runtime's memories route (tenant-runtime
// interactive-chat/tool-proxy-router.ts:319-372 → memoryService.listMemories
// (tenantId, { agentId })), which excludes anything expired or superseded and
// never reaches the global or role layers. The export asks through the SAME
// client call the page's route uses, `tenantRuntimeClient.listAgentMemories`
// (internal-agents/router.ts:2115), so the two cannot disagree about what
// Learned Context is; the runtime translates the internal agent id to its own
// (tool-proxy-router.ts:337-341). The page shows one page of 100; the export
// walks to the end, under the budget, and keeps what was learned at or before
// the cutoff.
//
// Each row is written the way the page renders it: the text after the page's
// own normalisation (formatMemoryContent, ported below with its source) and
// when it was learned. The page truncates for the list and shows the full text
// in a tooltip; the archive carries the full text.

import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { walkRemote, type ExportBudget } from './budget';
import type { TeamRow } from './queries';
import { TEAM_KEYS } from './labels';

/** One memory as the runtime lists it (tenant-runtime-client.ts:1527). */
export interface LearnedMemory {
  id: string;
  content: string;
  createdAt: string;
}

/** src/utils/formatMemoryContent.ts (Liftoff-React): `prettifyToolNames` then
 *  `formatMemoryContent`, byte for byte. A memory body carries markdown labels
 *  and MCP tool ids the page strips before a person sees it; the archive shows
 *  what the person sees. */
export function prettifyToolNames(text: string): string {
  return text.replace(/mcp__\S*__/g, '');
}

export function formatMemoryContent(raw: string): string {
  return prettifyToolNames(raw)
    .replace(/\*\*/g, '')            // drop markdown bold markers
    .replace(/\s*\n\s*/g, ' · ')     // former line breaks → a visible separator
    .replace(/[ \t]+/g, ' ')          // collapse redundant spaces
    .trim();
}

/**
 * The Learned Context of every team in the export, keyed by team id.
 *
 * One walk per team over the teams the export already loaded, each page
 * charged to the budget like every other remote row. A memory created after
 * the cutoff is left out; the route has no `asOf`, so the cutoff is applied
 * here. Any failure to read a team's memories is the runtime being
 * unavailable, the same 503 as the review feeds: the export has no honest
 * partial answer for a section it could not finish reading.
 */
export async function collectLearnedContext(
  tenantId: string,
  teams: readonly TeamRow[],
  asOf: Date,
  budget: ExportBudget,
): Promise<Map<string, LearnedMemory[]>> {
  const out = new Map<string, LearnedMemory[]>();
  const cutoff = asOf.getTime();
  for (const team of teams) {
    const memories = await walkRemote<LearnedMemory>('tenant_runtime', budget, async (cursor, limit) => {
      const page = await tenantRuntimeClient.listAgentMemories(tenantId, team.id, { limit, cursor });
      return {
        items: page.memories
          .filter((m) => new Date(m.createdAt).getTime() <= cutoff)
          .map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt })),
        nextCursor: page.nextCursor,
      };
    });
    out.set(team.id, memories);
  }
  return out;
}

// ── Projection ──────────────────────────────────────────────────────────

export interface LearnedContextEntry {
  [TEAM_KEYS.context]: string;
  [TEAM_KEYS.learned]: string;
}

/** Oldest first, as the rest of the archive orders; the page lists newest
 *  first, which is a display choice rather than a fact about the data. */
export function projectLearnedContext(memories: readonly LearnedMemory[]): LearnedContextEntry[] {
  return [...memories]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((m) => ({
      [TEAM_KEYS.context]: formatMemoryContent(m.content),
      [TEAM_KEYS.learned]: new Date(m.createdAt).toISOString(),
    }));
}
