// Conversational routine proposals (P1.3).
//
// A team member offers to take something on, in its own chat, at the moments a
// thoughtful colleague would speak up:
//
//   * a connector was just bound to it — it can now see something it could
//     watch on a schedule
//   * the same request has come up repeatedly — it could just do it
//   * the person described a schedule while talking to it (P1.2 routes here
//     rather than changing behaviour silently)
//
// Accepting is replying "yes". The accept path appends the routine as prose to
// the team member's guidance and redistills, so the schedule is authored the
// only way schedules are ever authored here — by the distiller, versioned, and
// reversible with a rollback. Nothing in this file writes a cron.
//
// Restraint is the feature. At most ONE open proposal per team member, only at
// those moments, never auto-created, and a decline is remembered forever.

import { randomUUID } from 'crypto';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { llmClient } from '../llm';
import type { JSONSchema, LLMToolDefinition } from '../llm/types';
import * as chatRepo from './chat-repository';
import { pushOutOfTurnMessage } from './out-of-turn-delivery';

export const SUGGESTION_MESSAGE_TYPE = 'suggestion';

/** What accepting this proposal DOES with the prose (migration 429): append a
 *  new routine line, replace an existing one, or take one out. The trigger set
 *  is re-derived from the resulting prose either way. */
export type SuggestionAction = 'start' | 'change' | 'stop';

/** Which accept path a yes takes (migration 487): a routine folds its prose
 *  into guidance and redistills; a design change is carried to the Chief AI
 *  Officer, who applies it as the person. */
export type SuggestionKind = 'routine' | 'design';

export interface AgentSuggestion {
  id: string;
  tenantId: string;
  agentId: string;
  dedupKey: string;
  source: 'integration' | 'usage' | 'chat';
  proposalText: string;
  routineProse: string;
  provenanceNote: string | null;
  status: 'pending' | 'accepted' | 'dismissed' | 'cooldown';
  threadId: string | null;
  action: SuggestionAction;
  proposalKind: SuggestionKind;
  /** The routine as the person named it, for wording and audit. */
  targetLabel: string | null;
  /** The exact guidance line the accept rewrites or removes, when the target
   *  is one this rail wrote. Null for distill-born cadences, which get a
   *  superseding amendment instead. */
  replacesProse: string | null;
}

interface SuggestionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  dedup_key: string;
  source: 'integration' | 'usage' | 'chat';
  proposal_text: string;
  routine_prose: string;
  provenance_note: string | null;
  status: 'pending' | 'accepted' | 'dismissed' | 'cooldown';
  thread_id: string | null;
  action: SuggestionAction;
  proposal_kind: SuggestionKind | null;
  target_label: string | null;
  replaces_prose: string | null;
}

function mapRow(row: SuggestionRow): AgentSuggestion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    dedupKey: row.dedup_key,
    source: row.source,
    proposalText: row.proposal_text,
    routineProse: row.routine_prose,
    provenanceNote: row.provenance_note,
    status: row.status,
    threadId: row.thread_id,
    action: row.action ?? 'start',
    proposalKind: row.proposal_kind === 'design' ? 'design' : 'routine',
    targetLabel: row.target_label ?? null,
    replacesProse: row.replaces_prose ?? null,
  };
}

/** The single open proposal for a team member, if it has one. */
export async function getOpenSuggestion(
  tenantId: string,
  agentId: string,
): Promise<AgentSuggestion | null> {
  const row = await withTenantScope(tenantId, async (client) => {
    const res = await client.query<SuggestionRow>(
      `SELECT * FROM agent_suggestions
       WHERE agent_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );
    return res.rows[0] ?? null;
  });
  return row ? mapRow(row) : null;
}

/**
 * Record a proposal. Returns null when the team member already has one open, or
 * when this exact idea was offered before — both of which are the restraint
 * rule, not an error.
 */
export async function createSuggestion(params: {
  tenantId: string;
  agentId: string;
  dedupKey: string;
  source: 'integration' | 'usage' | 'chat';
  proposalText: string;
  routineProse: string;
  provenanceNote?: string;
  action?: SuggestionAction;
  /** Absent means routine, the kind every earlier caller writes. */
  proposalKind?: SuggestionKind;
  targetLabel?: string;
  replacesProse?: string;
}): Promise<AgentSuggestion | null> {
  const { tenantId, agentId } = params;

  const existingOpen = await getOpenSuggestion(tenantId, agentId);
  if (existingOpen) {
    log.info({ tenantId, agentId }, 'suggestions: skipped — this team member already has an open proposal');
    return null;
  }

  try {
    const row = await withTenantScope(tenantId, async (client) => {
      const res = await client.query<SuggestionRow>(
        // A declined idea is latched forever — that is the point of the dedup
        // key. A "later" is not: it sets cooldown_until, and once that has
        // passed the same idea may be offered once more. Without this branch
        // the cooldown column would be written and never read, and "ask me
        // later" would quietly mean "never".
        `INSERT INTO agent_suggestions
           (id, tenant_id, agent_id, dedup_key, source, proposal_text, routine_prose, provenance_note,
            action, target_label, replaces_prose, proposal_kind, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
         ON CONFLICT (agent_id, dedup_key) DO UPDATE
           SET status = 'pending',
               proposal_text = EXCLUDED.proposal_text,
               routine_prose = EXCLUDED.routine_prose,
               provenance_note = EXCLUDED.provenance_note,
               action = EXCLUDED.action,
               target_label = EXCLUDED.target_label,
               replaces_prose = EXCLUDED.replaces_prose,
               proposal_kind = EXCLUDED.proposal_kind,
               decided_at = NULL,
               cooldown_until = NULL,
               offered_at = NULL,
               thread_id = NULL,
               updated_at = NOW()
           WHERE agent_suggestions.status = 'cooldown'
             AND agent_suggestions.cooldown_until IS NOT NULL
             AND agent_suggestions.cooldown_until <= NOW()
         RETURNING *`,
        [
          randomUUID(),
          tenantId,
          agentId,
          params.dedupKey,
          params.source,
          params.proposalText,
          params.routineProse,
          params.provenanceNote ?? null,
          params.action ?? 'start',
          params.targetLabel ?? null,
          params.replacesProse ?? null,
          params.proposalKind ?? 'routine',
        ],
      );
      return res.rows[0] ?? null;
    });
    if (!row) {
      // Already offered once, and not re-openable: a decline latches by design,
      // and a cooldown that has not expired yet is still a cooldown.
      log.info({ tenantId, agentId, dedupKey: params.dedupKey }, 'suggestions: skipped — already offered before');
      return null;
    }
    return mapRow(row);
  } catch (err) {
    log.error(
      { tenantId, agentId, error: (err as Error).message },
      'suggestions: could not record the proposal',
    );
    return null;
  }
}

/** Post the proposal into the team member's own chat thread and mark it offered. */
export async function deliverSuggestion(
  suggestion: AgentSuggestion,
  threadId: string,
): Promise<void> {
  try {
    // An out-of-turn assistant row (null turnId), the same way an oversight
    // decision is posted back into a thread. `messageType` is untyped
    // pass-through on the client, so this renders as an ordinary message with
    // no frontend change.
    await chatRepo.appendMessage(
      suggestion.tenantId,
      threadId,
      'assistant',
      suggestion.proposalText,
      suggestion.agentId,
      undefined,
      undefined,
      undefined,
      SUGGESTION_MESSAGE_TYPE,
    );
    // Slack and Teams do not read the transcript — their workers stream one
    // turn reply and stop. Without this push the proposal exists only in the
    // database, and the person is never asked the question.
    const delivery = await pushOutOfTurnMessage({
      tenantId: suggestion.tenantId,
      threadId,
      agentId: suggestion.agentId,
      text: suggestion.proposalText,
    });

    // A proposal nobody saw must not hold the one-open-proposal budget: the
    // team member would go quiet about everything else while waiting for an
    // answer to a question it never managed to ask. Release it and let the
    // trigger offer again later.
    if (delivery.pushed === false) {
      await withTenantScope(suggestion.tenantId, (client) =>
        client.query(
          `UPDATE agent_suggestions SET status = 'cooldown', cooldown_until = NOW(),
                  updated_at = NOW()
            WHERE id = $1 AND status = 'pending'`,
          [suggestion.id],
        ),
      );
      log.warn(
        { tenantId: suggestion.tenantId, agentId: suggestion.agentId, suggestionId: suggestion.id, channel: delivery.channel },
        'suggestions: proposal could not be delivered — released so it does not hold the open slot',
      );
      return;
    }

    await withTenantScope(suggestion.tenantId, (client) =>
      client.query(
        `UPDATE agent_suggestions
         SET thread_id = $1, offered_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [threadId, suggestion.id],
      ),
    );
    log.info(
      {
        tenantId: suggestion.tenantId, agentId: suggestion.agentId,
        suggestionId: suggestion.id, channel: delivery.channel, pushed: delivery.pushed,
      },
      'suggestions: proposal offered',
    );
  } catch (err) {
    log.error(
      { suggestionId: suggestion.id, error: (err as Error).message },
      'suggestions: delivery failed',
    );
  }
}

/** The routine lines this rail has written into the team member's guidance:
 *  every accepted chat proposal's prose, newest first. The change/stop target
 *  resolution matches against these because they are the only lines the accept
 *  path may rewrite or remove verbatim. */
export async function listAcceptedRoutineProse(
  tenantId: string,
  agentId: string,
): Promise<string[]> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query<{ routine_prose: string }>(
      `SELECT routine_prose FROM agent_suggestions
       WHERE agent_id = $1 AND source = 'chat' AND status = 'accepted' AND action != 'stop'
       ORDER BY created_at DESC
       LIMIT 20`,
      [agentId],
    ),
  );
  return result.rows.map((r) => r.routine_prose);
}

/**
 * Stamp where a proposal was asked, without posting anything.
 *
 * The runtime tool path (propose_routine) records the proposal while the
 * team member's own reply asks the question, so there is no message to
 * deliver. The columns are the ones deliverSuggestion writes after a
 * successful post, because handlePossibleSuggestionReply admits an answer
 * only from the thread the proposal is stamped with.
 */
export async function markOffered(
  tenantId: string,
  suggestionId: string,
  threadId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE agent_suggestions
       SET thread_id = $1, offered_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [threadId, suggestionId],
    ),
  );
}

/**
 * Take the proposal before doing the work of accepting it.
 *
 * Accepting appends prose to the team member's standing guidance and then
 * redistills — a slow operation that a Cloud Run scale-down or a Cloud Tasks
 * retry can land in the middle of. If the proposal were only marked decided
 * afterwards, the retry would find it still open and append the same routine a
 * second time, leaving duplicated guidance and two versions.
 *
 * Conditional on `status = 'pending'`, so exactly one caller can win.
 * Returns false when someone else already has it.
 */
export async function claimForAcceptance(
  tenantId: string,
  suggestionId: string,
): Promise<boolean> {
  const res = await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE agent_suggestions
          SET status = 'accepted', decided_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [suggestionId],
    ),
  );
  return (res.rowCount ?? 0) > 0;
}

/** Hand a claimed proposal back when the work behind it failed, so the person
 *  can answer again rather than the offer disappearing silently. */
export async function releaseClaim(tenantId: string, suggestionId: string): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE agent_suggestions
          SET status = 'pending', decided_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'accepted'`,
      [suggestionId],
    ),
  );
}

export async function markDecided(
  tenantId: string,
  suggestionId: string,
  status: 'accepted' | 'dismissed' | 'cooldown',
  cooldownDays = 30,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE agent_suggestions
       SET status = $1, decided_at = NOW(), updated_at = NOW(),
           cooldown_until = CASE WHEN $1 = 'cooldown' THEN NOW() + ($2 || ' days')::interval ELSE NULL END
       WHERE id = $3`,
      [status, String(cooldownDays), suggestionId],
    ),
  );
}

// ── Intent check on the reply ────────────────────────────────────────────

export type SuggestionIntent = 'accept' | 'decline' | 'later' | 'unrelated';

export interface SuggestionResponse {
  intent: SuggestionIntent;
  /** Any change the person asked for while accepting ("yes, but 8am"). Folded
   *  into the routine prose so the amendment is part of what gets distilled. */
  amendment?: string;
}

const INTENT_TOOL_NAME = 'classify_response';

function buildIntentTool(): LLMToolDefinition {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['accept', 'decline', 'later', 'unrelated'],
        description: [
          'accept: they agreed, with or without a change.',
          'decline: they said no.',
          'later: they want it another time ("not now", "ask me next week").',
          'unrelated: the message is about something else entirely.',
        ].join(' '),
      },
      amendment: {
        type: 'string',
        description: 'Only when accepting with a change — what they want different, in one phrase.',
      },
    },
    required: ['intent'],
  };
  return {
    name: INTENT_TOOL_NAME,
    description: 'Decide how the person answered the offer.',
    input_schema: schema,
  };
}

/**
 * Read the reply to an open proposal. Defaults to `unrelated` on any doubt or
 * failure: a misread that silently changes standing behaviour is far worse than
 * one that lets the message through as an ordinary turn.
 */
export async function classifyResponse(params: {
  tenantId: string;
  agentId: string;
  proposalText: string;
  reply: string;
}): Promise<SuggestionResponse> {
  try {
    const response = await llmClient.complete(
      {
        messages: [
          {
            role: 'user',
            content: `A team member offered to take on a recurring task. Decide how the person answered.

<offer>${params.proposalText}</offer>
<reply>${params.reply.slice(0, 2000)}</reply>

If the reply is about anything other than this offer, answer "unrelated".`,
          },
        ],
        tier: 'small',
        maxTokens: 512,
        temperature: 0,
        tools: [buildIntentTool()],
        toolChoice: { name: INTENT_TOOL_NAME },
      },
      undefined,
      { tenantId: params.tenantId, agentId: params.agentId, purpose: 'suggestion_response_classification' },
    );
    const call = response.toolCalls?.find((c) => c.name === INTENT_TOOL_NAME);
    if (!call) return { intent: 'unrelated' };
    return call.input as unknown as SuggestionResponse;
  } catch (err) {
    log.warn(
      { tenantId: params.tenantId, error: (err as Error).message },
      'suggestions: response classification failed — treating the message as an ordinary turn',
    );
    return { intent: 'unrelated' };
  }
}

// ── Proposal generation ─────────────────────────────────────────────────

// The two framings below are the constant half of each proposal call, split
// from the agent-specific lines so the marked block is byte-identical between
// calls: a role name interpolated into it would move the prefix every time.
//
// Each is ~120 tokens on the small tier, which is under every vendor's caching
// floor, so today the split buys correctness of shape rather than a hit. It is
// the shape that makes a hit possible at all, and these prompts grow.
const INTEGRATION_PROPOSAL_RULES = `A team member just gained access to a new tool. Decide whether there is one obviously useful recurring task it could now take on, and if so, offer it.

Rules:
- Offer at most one thing, and only if it is clearly useful for this role.
- It must be something that recurs on a schedule.
- It must stay silent when there is nothing to report. Say so in the offer.
- Speak in first person, plainly, without contractions, and never call yourself an agent.`;

const RECURRENCE_PROPOSAL_RULES = `Somebody keeps asking a team member for the same thing. Decide whether it is worth offering to do it on a schedule instead, and if so, offer it.

Rules:
- Only offer if this genuinely repeats on a rhythm. A request that merely happened several times while someone worked through a project is not a routine.
- Refer to what they actually asked for, so it is clear you were paying attention.
- It must stay silent when there is nothing to report. Say so in the offer.
- Speak in first person, plainly, without contractions, and never call yourself an agent.`;

const PROPOSE_TOOL_NAME = 'propose_routine';

function buildProposeTool(): LLMToolDefinition {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      worthProposing: {
        type: 'boolean',
        description: 'False when there is no genuinely useful recurring task here. Say false rather than inventing one.',
      },
      proposalText: {
        type: 'string',
        description: 'What the team member says, in first person, two sentences at most. State what it would do, how often, and that it will stay quiet when there is nothing to report. End by asking whether to start. Do not use contractions. Do not use the word "agent".',
      },
      routineProse: {
        type: 'string',
        description: 'The same routine written as an instruction to add to its standing guidance, one sentence, e.g. "Each weekday morning, review new deals in HubSpot and report any that are missing a next step; stay silent when there are none."',
      },
    },
    required: ['worthProposing'],
  };
  return {
    name: PROPOSE_TOOL_NAME,
    description: 'Propose at most one recurring task this team member could take on.',
    input_schema: schema,
  };
}

/**
 * Draft a proposal for a newly connected tool. Returns null when there is
 * nothing worth offering — the common case, and the right default.
 */
export async function draftIntegrationProposal(params: {
  tenantId: string;
  agentId: string;
  agentRole: string;
  responsibilities: string;
  connectorType: string;
}): Promise<{ proposalText: string; routineProse: string } | null> {
  try {
    const response = await llmClient.complete(
      {
        messages: [
          // The framing and the rules are the same bytes for every team and
          // every connector, so they are their own message and carry the cache
          // breakpoint. Only the three agent-specific lines sit after it.
          { role: 'system', content: INTEGRATION_PROPOSAL_RULES, cacheControl: { type: 'ephemeral' } },
          {
            role: 'user',
            content: `Role: ${params.agentRole}
What it is responsible for: ${params.responsibilities.slice(0, 2000)}
Newly connected tool: ${params.connectorType}`,
          },
        ],
        tier: 'small',
        maxTokens: 1024,
        temperature: 0.2,
        tools: [buildProposeTool()],
        toolChoice: { name: PROPOSE_TOOL_NAME },
      },
      undefined,
      { tenantId: params.tenantId, agentId: params.agentId, purpose: 'suggestion_generation' },
    );
    const call = response.toolCalls?.find((c) => c.name === PROPOSE_TOOL_NAME);
    if (!call) return null;
    const out = call.input as { worthProposing?: boolean; proposalText?: string; routineProse?: string };
    if (!out.worthProposing || !out.proposalText || !out.routineProse) return null;
    return { proposalText: out.proposalText, routineProse: out.routineProse };
  } catch (err) {
    log.warn(
      { tenantId: params.tenantId, agentId: params.agentId, error: (err as Error).message },
      'suggestions: proposal drafting failed',
    );
    return null;
  }
}

/**
 * Draft a proposal for something the person keeps asking for (P1.3 trigger 2).
 *
 * Distinct from the integration draft in what it is reasoning from: not "you
 * have a new tool, what could you do with it" but "this exact request keeps
 * arriving, should it just happen on its own". The offer therefore has to sound
 * like it was listening, so the ask itself is quoted back.
 */
export async function draftRecurrenceProposal(params: {
  tenantId: string;
  agentId: string;
  agentRole: string;
  responsibilities: string;
  recurringAsk: string;
  occurrences: number;
}): Promise<{ proposalText: string; routineProse: string } | null> {
  try {
    const response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: RECURRENCE_PROPOSAL_RULES, cacheControl: { type: 'ephemeral' } },
          {
            role: 'user',
            content: `Role: ${params.agentRole}
What it is responsible for: ${params.responsibilities.slice(0, 2000)}
What keeps being asked (${params.occurrences} times recently): ${params.recurringAsk.slice(0, 1000)}`,
          },
        ],
        tier: 'small',
        maxTokens: 1024,
        temperature: 0.2,
        tools: [buildProposeTool()],
        toolChoice: { name: PROPOSE_TOOL_NAME },
      },
      undefined,
      { tenantId: params.tenantId, agentId: params.agentId, purpose: 'suggestion_generation' },
    );
    const call = response.toolCalls?.find((c) => c.name === PROPOSE_TOOL_NAME);
    if (!call) return null;
    const out = call.input as { worthProposing?: boolean; proposalText?: string; routineProse?: string };
    if (!out.worthProposing || !out.proposalText || !out.routineProse) return null;
    return { proposalText: out.proposalText, routineProse: out.routineProse };
  } catch (err) {
    log.warn(
      { tenantId: params.tenantId, agentId: params.agentId, error: (err as Error).message },
      'suggestions: recurrence proposal drafting failed',
    );
    return null;
  }
}
