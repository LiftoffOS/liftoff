// Message Routing Service — multi-agent thread routing
//
// Determines which agent(s) respond and which observe when a message
// arrives in a multi-agent thread. Single-agent (1-on-1) threads are
// the trivial case: the lone participant always responds.
//
// Routing rules (in priority order):
//
//   1. Explicit @mention → only mentioned agents respond, rest observe
//   2. Thread continuation → if no mention and a "lead" exists, lead responds
//   3. Suggested answerer → one selection request over the thread's
//      participants (route-suggestion.ts, Phase 9): the participant whose
//      role the message plainly calls for. `none`, sub-threshold or a
//      failed call falls to the ILIKE keyword match of the message against
//      each participant's responsibilities, which stays as the fallback so a
//      vendor outage leaves routing exactly as it was
//   4. Fallback → single participant always responds (1-on-1)
//
// No generation anywhere in this file. Rules 1, 2 and 4 are lookups of what a
// person said and cost nothing; rule 3 is one input-only selection request on
// the rare un-addressed, lead-less message in a multi-agent thread, and its
// own fallback is the deterministic ILIKE scorer.

import { getPool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { suggestAnswerer } from './route-suggestion';
import { ROUTE_CANDIDATE_CAP } from '../typesafe/questions';

// ── Types ──────────────────────────────────────────────────────────────

export interface RoutingDecision {
  respondingAgents: Array<{ agentId: string; reason: 'mentioned' | 'lead' | 'relevant' }>;
  observingAgents: Array<{ agentId: string }>;
}

export interface ThreadParticipantInfo {
  agentId: string;
  role: 'participant' | 'lead';
}

// ── Constants ──────────────────────────────────────────────────────────

// Common English stop words excluded from keyword extraction.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some',
  'them', 'than', 'its', 'over', 'also', 'that', 'other', 'into',
  'this', 'with', 'from', 'they', 'will', 'each', 'make', 'like',
  'just', 'about', 'could', 'would', 'should', 'what', 'when', 'where',
  'which', 'there', 'their', 'your', 'more', 'been', 'does', 'done',
  'very', 'here', 'were', 'being', 'those', 'then', 'only', 'come',
  'made', 'after', 'most', 'much', 'many', 'well', 'back', 'still',
  'want', 'give', 'need', 'know', 'take', 'thing', 'help', 'please',
]);

// Maximum keywords to extract from a message for relevance scoring.
const MAX_KEYWORDS = 5;

// UUID v4 pattern for mention extraction.
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MENTION_REGEX = new RegExp(`@\\[(${UUID_PATTERN})\\]`, 'gi');

// ── Main routing function ──────────────────────────────────────────────

/**
 * Route a message to the appropriate agent(s) in a multi-agent thread.
 *
 * Rules (in priority order):
 * 1. Explicit @mention → only mentioned agents respond, rest observe
 * 2. Thread continuation → if no mention and a "lead" exists, lead responds
 * 3. Relevance scoring → if no mention and no lead, score participants by
 *    responsibilities match
 * 4. Fallback → single participant always responds (1-on-1)
 */
export async function routeMessage(
  threadId: string,
  tenantId: string,
  message: string,
  participants: ThreadParticipantInfo[],
  mentionedAgentIds: string[],
): Promise<RoutingDecision> {
  // Rule 4 fast path: single participant always responds.
  if (participants.length <= 1) {
    const agent = participants[0];
    if (!agent) {
      return { respondingAgents: [], observingAgents: [] };
    }
    return {
      respondingAgents: [{ agentId: agent.agentId, reason: 'lead' }],
      observingAgents: [],
    };
  }

  const participantIds = new Set(participants.map((p) => p.agentId));

  // Rule 1: Explicit @mention — only mentioned agents that are participants respond.
  const validMentions = mentionedAgentIds.filter((id) => participantIds.has(id));
  if (validMentions.length > 0) {
    const mentionSet = new Set(validMentions);
    return {
      respondingAgents: validMentions.map((agentId) => ({
        agentId,
        reason: 'mentioned' as const,
      })),
      observingAgents: participants
        .filter((p) => !mentionSet.has(p.agentId))
        .map((p) => ({ agentId: p.agentId })),
    };
  }

  // Rule 2: Thread continuation — if a "lead" exists, they respond.
  const lead = participants.find((p) => p.role === 'lead');
  if (lead) {
    return {
      respondingAgents: [{ agentId: lead.agentId, reason: 'lead' }],
      observingAgents: participants
        .filter((p) => p.agentId !== lead.agentId)
        .map((p) => ({ agentId: p.agentId })),
    };
  }

  // Rule 3: the suggested answerer over the participants (already a bounded
  // list, no roster query beyond their own rows), then the ILIKE scorer as
  // the fallback on `none` or `null`.
  const suggested = await suggestAmongParticipants(tenantId, message, participants);
  if (suggested) {
    return {
      respondingAgents: [{ agentId: suggested, reason: 'relevant' }],
      observingAgents: participants
        .filter((p) => p.agentId !== suggested)
        .map((p) => ({ agentId: p.agentId })),
    };
  }
  const topAgent = await scoreByRelevance(tenantId, message, participants);
  if (topAgent) {
    return {
      respondingAgents: [{ agentId: topAgent, reason: 'relevant' }],
      observingAgents: participants
        .filter((p) => p.agentId !== topAgent)
        .map((p) => ({ agentId: p.agentId })),
    };
  }

  // Fallback: first participant responds (preserves add-order tie-breaking).
  const first = participants[0];
  return {
    respondingAgents: [{ agentId: first.agentId, reason: 'relevant' }],
    observingAgents: participants
      .slice(1)
      .map((p) => ({ agentId: p.agentId })),
  };
}

// ── @mention extraction ────────────────────────────────────────────────

/**
 * Extract agent IDs from @mention syntax in a message.
 * Web: mentions come as `@[agentId]` format from the frontend.
 * Slack: mentions come as `<@BOT_USER_ID>` format — resolved to agentId
 * by the Slack adapter before calling this.
 *
 * Only returns IDs that are actual participants in the thread.
 */
export function extractMentionedAgentIds(
  message: string,
  participantAgentIds: string[],
): string[] {
  const participantSet = new Set(participantAgentIds);
  const mentioned = new Set<string>();

  // Match @[uuid] patterns (web frontend format).
  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(message)) !== null) {
    const id = match[1];
    if (participantSet.has(id)) {
      mentioned.add(id);
    }
  }

  // Also check if any participant UUID appears directly in the message
  // (covers cases where the adapter pre-resolved mentions).
  for (const agentId of participantAgentIds) {
    if (message.includes(agentId) && !mentioned.has(agentId)) {
      mentioned.add(agentId);
    }
  }

  return Array.from(mentioned);
}

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * The participants' `role` and `summary`, read from their own rows, handed to
 * the suggestion. A participant with no row (deleted between add and message)
 * is left out; a read failure or an empty roster yields null so the ILIKE
 * scorer runs as before.
 */
async function suggestAmongParticipants(
  tenantId: string,
  message: string,
  participants: ThreadParticipantInfo[],
): Promise<string | null> {
  if (participants.length > ROUTE_CANDIDATE_CAP) return null;
  const agentIds = participants.map((p) => p.agentId);
  let rows: Array<{ id: string; role: string | null; summary: string | null; responsibilities: string | null }>;
  try {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, role, summary, responsibilities
         FROM internal_agents
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [tenantId, agentIds],
    ));
    rows = result.rows as typeof rows;
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'participant roster read failed — falling back to the ILIKE scorer');
    return null;
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const candidates = participants
    .map((p) => byId.get(p.agentId))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => ({
      id: r.id,
      role: r.role ?? '',
      summary: r.summary?.trim() || r.responsibilities?.trim() || '',
    }));
  if (candidates.length === 0) return null;
  const suggestion = await suggestAnswerer({
    tenantId,
    message,
    channel: { kind: 'thread' },
    candidates,
    surface: 'dashboard',
  });
  return suggestion?.agentId ?? null;
}

/**
 * Extract significant keywords from a message for relevance matching.
 * Returns up to MAX_KEYWORDS words that are >3 chars and not stop words.
 */
function extractKeywords(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  // Deduplicate and take the first MAX_KEYWORDS.
  const unique = [...new Set(words)];
  return unique.slice(0, MAX_KEYWORDS);
}

/**
 * Score participants by ILIKE matching message keywords against their
 * responsibilities field in `internal_agents`. Returns the agentId with
 * the most keyword hits, or null if no matches.
 *
 * Tie-breaking: the participant added first (lowest index in the
 * participants array) wins — preserves the add-order from
 * `getParticipants()` which returns ORDER BY added_at ASC.
 */
async function scoreByRelevance(
  tenantId: string,
  message: string,
  participants: ThreadParticipantInfo[],
): Promise<string | null> {
  const keywords = extractKeywords(message);
  if (keywords.length === 0) return null;

  const agentIds = participants.map((p) => p.agentId);

  // Build a query that counts ILIKE hits per agent.
  // Each keyword generates a CASE WHEN ... THEN 1 ELSE 0 expression,
  // summed into a total score.
  const params: string[] = [tenantId];

  // $2 = agent IDs array
  params.push(agentIds as unknown as string); // placeholder — we use ANY($2::uuid[])

  const caseClauses = keywords.map((kw, i) => {
    const paramIndex = i + 3; // $3, $4, $5, ...
    params.push(`%${kw}%`);
    return `CASE WHEN responsibilities ILIKE $${paramIndex} THEN 1 ELSE 0 END`;
  });

  const scoreExpr = caseClauses.join(' + ');

  const sql = `
    SELECT id, (${scoreExpr}) AS score
    FROM internal_agents
    WHERE tenant_id = $1
      AND id = ANY($2::uuid[])
      AND deleted_at IS NULL
      AND responsibilities IS NOT NULL
    ORDER BY score DESC
  `;

  try {
    const result = await withTenantScope(tenantId, (client) => client.query(sql, params));

    if (result.rows.length === 0) return null;

    const topScore = result.rows[0].score as number;
    if (topScore === 0) return null;

    // Among agents with the top score, pick the one earliest in the
    // participants array (add-order tie-breaking).
    const topScorers = result.rows
      .filter((r) => (r.score as number) === topScore)
      .map((r) => r.id as string);

    const topScorerSet = new Set(topScorers);
    const winner = participants.find((p) => topScorerSet.has(p.agentId));
    return winner?.agentId ?? topScorers[0];
  } catch (err) {
    log.error(
      { tenantId, keywords, error: (err as Error).message },
      'Relevance scoring query failed — falling back to first participant',
    );
    return null;
  }
}
