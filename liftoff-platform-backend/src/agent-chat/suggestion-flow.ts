// Accepting and declining a proposal, in conversation (P1.3).
//
// The accept path is the load-bearing part: saying "yes" must produce a real
// routine, and it must do so the ONLY way routines are ever produced here —
// prose onto the team member's standing guidance, then distillation. That is
// what makes the result reviewable (a new version), reversible (rollback), and
// consistent with a routine the person wrote themselves.
//
// Nothing here writes a schedule directly.

import { log } from '../infrastructure/logging';
import { internalAgentService } from '../internal-agents/service';
import { redistillAgent } from '../internal-agents/redistill-service';
import { mentionedWeekdays, parseCadence, statedChangeAgrees } from '../internal-agents/cadence-parse';
import { latestUserMessageContent } from './chat-repository';
import { enqueueColleagueTask, enqueueRedistillAcceptTask } from './chat-turn-dispatch';
import {
  claimForAcceptance,
  classifyResponse,
  createSuggestion,
  getOpenSuggestion,
  listAcceptedRoutineProse,
  markDecided,
  markOffered,
  releaseClaim,
  type AgentSuggestion,
  type SuggestionAction,
} from './suggestion-service';

export interface SuggestionTurnOutcome {
  /** True when this turn was the answer to a proposal and has been fully
   *  handled here — the caller must NOT run a normal turn. */
  handled: boolean;
  /** What the team member replies. Only set when handled. */
  reply?: string;
}

/**
 * Fold an accepted routine into the team member's standing guidance and
 * redistill. Returns the confirmation to reply with, or null when it failed —
 * in which case the caller falls through to an ordinary turn rather than
 * claiming success.
 */
async function acceptSuggestion(
  suggestion: AgentSuggestion,
  amendment: string | undefined,
): Promise<string | null> {
  const { tenantId, agentId } = suggestion;

  // Take the proposal BEFORE doing anything durable. Appending guidance and
  // redistilling is slow enough to be interrupted, and a Cloud Tasks retry
  // would otherwise find the proposal still open and append the same routine
  // again. Losing the race means someone else is already handling it.
  if (!(await claimForAcceptance(tenantId, suggestion.id))) {
    log.info(
      { tenantId, agentId, suggestionId: suggestion.id },
      'suggestions: accept skipped — already claimed',
    );
    return null;
  }

  const agent = await internalAgentService.getById(agentId, tenantId);
  if (!agent) {
    await releaseClaim(tenantId, suggestion.id);
    return null;
  }

  // The amendment ("yes, but at 8am") is part of the instruction, not a
  // separate setting — it goes into the same sentence the distiller reads.
  const routineLine = amendment
    ? `${suggestion.routineProse} (${amendment})`
    : suggestion.routineProse;

  // What the yes does to the prose depends on the action (migration 429).
  // A line this rail wrote is rewritten or removed in place; a cadence born
  // in the distilled responsibilities cannot be string-edited safely, so it
  // gets a superseding line instead — and the distiller is told a line that
  // states it replaces or stops an earlier cadence wins.
  const existingGuidance = (agent.additionalContext ?? '').trim();
  const append = (line: string): string =>
    existingGuidance.length > 0 ? `${existingGuidance}\n\n${line}` : line;

  let nextGuidance: string;
  if (suggestion.action === 'change') {
    nextGuidance =
      suggestion.replacesProse && existingGuidance.includes(suggestion.replacesProse)
        ? existingGuidance.replace(suggestion.replacesProse, routineLine)
        : append(
            `${routineLine} This replaces the earlier ${suggestion.targetLabel ?? 'schedule'} instruction.`,
          );
  } else if (suggestion.action === 'stop') {
    nextGuidance =
      suggestion.replacesProse && existingGuidance.includes(suggestion.replacesProse)
        ? existingGuidance
            .replace(suggestion.replacesProse, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
        : append(routineLine);
  } else {
    nextGuidance = append(routineLine);
  }

  try {
    // Write the prose first so the routine text is durable even if the
    // distillation that follows fails; a retry then has something to work from.
    await internalAgentService.update(
      agentId,
      tenantId,
      { additionalContext: nextGuidance },
      undefined,
      'manual',
    );
  } catch (err) {
    log.error(
      { tenantId, agentId, suggestionId: suggestion.id, error: (err as Error).message },
      'suggestions: accept failed before the guidance landed',
    );
    await releaseClaim(tenantId, suggestion.id).catch(() => {});
    return null;
  }

  // The redistill that turns the prose into an actual trigger can take
  // minutes, so the person is not made to sit through it: acknowledge now, run
  // it on the chat-turns queue (post-response compute here is neither
  // CPU-guaranteed nor safe from reclaim), and confirm in-thread when it is
  // live. The worker owns the confirmation and the honest failure note.
  // The stamp is what admitted this answer (handlePossibleSuggestionReply
  // matches on it), so a null thread here should be impossible — but a
  // confirmation with nowhere to land is worth a synchronous turn, not a
  // poison task.
  try {
    if (!suggestion.threadId) throw new Error('accepted suggestion has no thread stamp');
    await enqueueRedistillAcceptTask(
      {
        tenantId,
        agentId,
        suggestionId: suggestion.id,
        threadId: suggestion.threadId,
        routineProse: routineLine,
        action: suggestion.action,
        targetLabel: suggestion.targetLabel ?? undefined,
        replacesProse: suggestion.replacesProse ?? undefined,
      },
      `redistill-accept:${suggestion.id}`,
    );
    log.info(
      { tenantId, agentId, suggestionId: suggestion.id, action: suggestion.action },
      'suggestions: accepted; redistill queued',
    );
    return suggestion.action === 'stop'
      ? (
        'I have written that into my standing guidance. Taking it out of my schedule '
        + 'takes a few minutes, and I will confirm here when it is done.'
      )
      : (
        'I have written that into my standing guidance. Folding it into my routine '
        + 'takes a few minutes, and I will confirm here when it is live.'
      );
  } catch (enqueueErr) {
    // No queue, no problem the person should feel: fall back to the
    // synchronous shape this path always had.
    log.warn(
      { tenantId, agentId, suggestionId: suggestion.id, error: (enqueueErr as Error).message },
      'suggestions: enqueue failed; redistilling synchronously',
    );
  }

  try {
    // Redistill turns the prose into an actual trigger. Same call the Optimize
    // button makes, so it lands as a normal distilled version with rollback.
    await redistillAgent(agentId, tenantId, undefined);

    // Already marked accepted by the claim above; nothing further to record.
    log.info(
      { tenantId, agentId, suggestionId: suggestion.id },
      'suggestions: accepted and distilled into a routine',
    );
    return 'Done. I have added that to my routine, and you can change or remove it on my settings page.';
  } catch (err) {
    log.error(
      { tenantId, agentId, suggestionId: suggestion.id, error: (err as Error).message },
      'suggestions: accept failed',
    );
    // Hand it back so the person can answer again. The guidance write may
    // already have landed — that is deliberate and stated in the comment above
    // it — but a redistill that failed should not silently swallow the offer.
    await releaseClaim(tenantId, suggestion.id).catch(() => {});
    return null;
  }
}

/**
 * Called at the start of a chat turn. When the team member has an open proposal
 * in this thread and the message answers it, this handles the turn end to end
 * and the caller skips the model.
 *
 * Anything ambiguous is left alone: the proposal stays open and the message is
 * treated as an ordinary turn.
 */
export async function handlePossibleSuggestionReply(params: {
  tenantId: string;
  agentId: string;
  threadId: string;
  content: string;
}): Promise<SuggestionTurnOutcome> {
  const { tenantId, agentId, threadId, content } = params;
  if (!content.trim()) return { handled: false };

  let suggestion: AgentSuggestion | null;
  try {
    suggestion = await getOpenSuggestion(tenantId, agentId);
  } catch (err) {
    log.warn({ tenantId, agentId, error: (err as Error).message }, 'suggestions: open-proposal lookup failed');
    return { handled: false };
  }
  // Only where the question was asked: a proposal offered in one thread must
  // not swallow a "yes" that meant something else in another.
  if (!suggestion || suggestion.threadId !== threadId) return { handled: false };

  const { intent, amendment } = await classifyResponse({
    tenantId,
    agentId,
    proposalText: suggestion.proposalText,
    reply: content,
  });

  // A design change is the Chief AI Officer's to apply, never this rail's:
  // the person's answer is carried to the Chief AI Officer's paired thread,
  // and what it did is posted back here by the worker. Nothing here touches
  // the team's guidance.
  if (suggestion.proposalKind === 'design') {
    return handleDesignChangeReply(suggestion, intent, amendment);
  }

  if (intent === 'accept') {
    const reply = await acceptSuggestion(suggestion, amendment);
    if (!reply) return { handled: false };
    // Persisting the reply belongs to the caller: it owns the turn id, and the
    // assistant row must be keyed to it (the turn-uniqueness index and the
    // settle backstop both depend on that).
    return { handled: true, reply };
  }

  if (intent === 'decline') {
    // Latched by dedup key: this idea is never offered again.
    await markDecided(tenantId, suggestion.id, 'dismissed');
    log.info({ tenantId, agentId, suggestionId: suggestion.id }, 'suggestions: declined');
    return { handled: false };
  }

  if (intent === 'later') {
    await markDecided(tenantId, suggestion.id, 'cooldown');
    return { handled: false };
  }

  // Unrelated — the proposal stays open and the message runs as a normal turn.
  return { handled: false };
}

async function handleDesignChangeReply(
  suggestion: AgentSuggestion,
  intent: 'accept' | 'decline' | 'later' | 'unrelated',
  amendment: string | undefined,
): Promise<SuggestionTurnOutcome> {
  const { tenantId, agentId } = suggestion;
  if (intent === 'unrelated') return { handled: false };
  if (intent === 'later') {
    await markDecided(tenantId, suggestion.id, 'cooldown');
    return { handled: false };
  }
  // Claimed before anything is enqueued, so a retry of this turn cannot ask
  // the Chief AI Officer to apply the same change twice.
  if (!(await claimForAcceptance(tenantId, suggestion.id))) {
    return { handled: false };
  }
  try {
    if (!suggestion.threadId) throw new Error('design proposal has no thread stamp');
    await enqueueColleagueTask(
      {
        tenantId,
        agentId,
        threadId: suggestion.threadId,
        colleague: 'caio',
        phase: 'apply',
        request: suggestion.routineProse,
        suggestionId: suggestion.id,
        decision: intent,
        ...(amendment ? { amendment } : {}),
      },
      `design-apply:${suggestion.id}:${intent}`,
    );
  } catch (err) {
    log.error(
      { tenantId, agentId, suggestionId: suggestion.id, error: (err as Error).message },
      'suggestions: could not carry the answer to the Chief AI Officer',
    );
    await releaseClaim(tenantId, suggestion.id).catch(() => {});
    return { handled: false };
  }
  return {
    handled: true,
    reply: intent === 'accept'
      ? 'Passing that to the Chief AI Officer now; it will confirm here once the change is applied.'
      : 'Understood; I have told the Chief AI Officer to leave it as it is.',
  };
}

/** One wording for a chat-born routine proposal, wherever it is asked from.
 *  The classifier reads it back against the person's reply, so the tool path
 *  and the lesson path must not drift apart. */
function routineProposalText(routineProse: string): string {
  return (
    `I can make that part of my routine: ${routineProse} `
    + 'I will stay quiet when there is nothing to report. Would you like me to start doing that?'
  );
}

/** Keyed on the routine itself so the same idea, described twice, is one
 *  proposal rather than two. The start key is EXACTLY the teaching path's key,
 *  which is what collapses the two rails when both fire on one turn; change
 *  and stop carry the action so a stop is never latched behind the start that
 *  created the routine. */
function routineDedupKey(action: SuggestionAction, text: string): string {
  const norm = text.trim().toLowerCase().slice(0, 200);
  return action === 'start' ? `chat:${norm}` : `chat:${action}:${norm}`;
}

// ── Change/stop target resolution ───────────────────────────────────────

/** The live trigger shape as stored: the TS TriggerConfig type predates
 *  companions, but the jsonb keeps them and parseJsonb hands them back. */
interface StoredTriggerConfig {
  type?: string;
  cronExpr?: string;
  reasoning?: string;
  companionCrons?: Array<{ label?: string; objective?: string; cronExpr?: string }>;
}

interface RoutineTargetCandidate {
  label: string;
  prose: string;
  /** Set only for lines this rail wrote: the exact guidance text the accept
   *  may rewrite or remove. */
  replacesProse: string | null;
  /** The cadence this routine runs on TODAY, when it is knowable
   *  deterministically: a companion's own cronExpr, the primary's cronExpr,
   *  or the parse of a chat-born guidance line. Null otherwise. Read by the
   *  auto-accept gate to tell a "from 8am" reference apart from a new time. */
  currentCronExpr: string | null;
}

export type RoutineTargetResolution =
  | {
      resolved: true;
      targetLabel: string;
      replacesProse: string | null;
      /** See RoutineTargetCandidate.currentCronExpr. */
      currentCronExpr: string | null;
    }
  | { resolved: false; candidates: string[] };

/** "friday-most-urgent-item" and "the Friday most urgent item" are the same
 *  name; separators and case are presentation, not identity. */
function normalizeHandle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function significantWords(text: string): string[] {
  return normalizeHandle(text)
    .split(' ')
    .filter((w) => w.length >= 4);
}

function matchesCandidate(target: string, candidate: RoutineTargetCandidate): boolean {
  const t = normalizeHandle(target);
  const label = normalizeHandle(candidate.label);
  if (t.length >= 3 && label.length >= 3 && (label.includes(t) || t.includes(label))) {
    return true;
  }
  const words = significantWords(target);
  if (words.length === 0) return false;
  const haystack = `${label} ${normalizeHandle(candidate.prose)}`;
  return words.every((w) => haystack.includes(w));
}

/**
 * Resolve "the Friday reminder" against what this team member actually runs:
 * its live trigger set (companion labels and objectives, the primary cron's
 * reasoning) and the routine lines this rail has written. Deterministic
 * matching only; exactly one hit resolves, anything else hands back the
 * candidates so the model can ask the person to name one.
 */
export async function resolveRoutineTarget(
  tenantId: string,
  agentId: string,
  target: string,
): Promise<RoutineTargetResolution> {
  const agent = await internalAgentService.getById(agentId, tenantId);
  const trigger = (agent?.triggerConfig ?? null) as StoredTriggerConfig | null;

  const candidates: RoutineTargetCandidate[] = [];
  for (const companion of trigger?.companionCrons ?? []) {
    candidates.push({
      label: companion.label ?? 'companion schedule',
      prose: companion.objective ?? '',
      replacesProse: null,
      currentCronExpr: companion.cronExpr ?? null,
    });
  }
  if (trigger?.type === 'cron') {
    candidates.push({
      label: 'primary schedule',
      prose: trigger.reasoning ?? '',
      replacesProse: null,
      currentCronExpr: trigger.cronExpr ?? null,
    });
  }
  // The guidance column is the source of truth for this rail's lines: an
  // accepted change rewrote its predecessor in place and an accepted stop
  // removed it, so a row whose text the guidance no longer carries is
  // history, not a routine anyone can still mean — offering it would leave
  // every changed routine permanently ambiguous. The line is acted on as the
  // whole block it lives in, so an amendment suffix or a superseding
  // sentence written beside it goes with it.
  const guidanceBlocks = (agent?.additionalContext ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim());
  for (const prose of await listAcceptedRoutineProse(tenantId, agentId)) {
    const block = guidanceBlocks.find((b) => b.includes(prose));
    if (!block) continue;
    candidates.push({
      label: prose.split(/\s+/).slice(0, 8).join(' '),
      prose: block,
      replacesProse: block,
      currentCronExpr: parseCadence(block)?.cronExpr ?? null,
    });
  }

  // A weekday in the target is a fact about the SCHEDULE, not a word to
  // fuzzy-match: "the monday one" can never mean a routine that runs
  // Thursday, however often its prose happens to mention Monday. Without
  // this, the midweek check's objective ("material moves since Monday")
  // outmatched the Monday primary for exactly that target, the person's yes
  // went to a mislabeled question, and the Thursday check was superseded
  // away. Candidates whose cadence is unknown keep prose matching — a day
  // the resolver cannot verify is not a day it may veto on.
  const targetDays = mentionedWeekdays(target);
  const dayCompatible = (c: RoutineTargetCandidate): boolean => {
    if (targetDays.size !== 1) return true;
    const cron = (c.currentCronExpr ?? '').trim().split(/\s+/);
    if (cron.length !== 5 || !/^\d+$/.test(cron[4])) return true;
    return targetDays.has(cron[4]);
  };
  const matches = candidates.filter((c) => dayCompatible(c) && matchesCandidate(target, c));
  // A chat-born routine appears twice: as the companion its acceptance
  // distilled AND as the guidance line this rail wrote. When exactly one
  // match carries the rewrite handle, that is the same routine seen from both
  // sides, and the handle side is strictly better to act on. The proposal the
  // person confirms names the resolved target in full, so a rare wrong pick
  // is visible before any yes.
  const resolvedMatch =
    matches.length === 1
      ? matches[0]
      : matches.filter((c) => c.replacesProse).length === 1
        ? matches.find((c) => c.replacesProse)!
        : null;
  if (resolvedMatch) {
    return {
      resolved: true,
      targetLabel: resolvedMatch.label,
      replacesProse: resolvedMatch.replacesProse,
      currentCronExpr: resolvedMatch.currentCronExpr,
    };
  }
  const pool = matches.length > 1 ? matches : candidates;
  return {
    resolved: false,
    candidates: Array.from(new Set(pool.map((c) => c.label))).slice(0, 6),
  };
}

/** One wording per action, single-sourced like the start wording above. */
function changeProposalText(routineProse: string): string {
  return (
    `I can change that routine to: ${routineProse} `
    + 'Would you like me to make that change?'
  );
}

function stopProposalText(targetLabel: string): string {
  return (
    `I can stop the ${targetLabel} routine so it no longer runs. `
    + 'Would you like me to stop it?'
  );
}

/** The prose a stop carries: it is what the accept appends when the cadence
 *  was born in the distilled responsibilities and cannot be string-removed. */
function stopProse(targetLabel: string): string {
  return `Stop the ${targetLabel} routine; it must no longer run.`;
}

/**
 * P1.2 → P1.3 bridge: the person described a schedule in conversation. That
 * changes standing behaviour, so it is offered back rather than applied.
 */
export async function proposeRoutineFromChat(params: {
  tenantId: string;
  agentId: string;
  threadId: string;
  routineProse: string;
}): Promise<void> {
  const { tenantId, agentId, threadId, routineProse } = params;

  const suggestion = await createSuggestion({
    tenantId,
    agentId,
    dedupKey: routineDedupKey('start', routineProse),
    source: 'chat',
    proposalText: routineProposalText(routineProse),
    routineProse,
    provenanceNote: 'You described this while we were talking.',
  });
  if (!suggestion) return;

  const { deliverSuggestion } = await import('./suggestion-service');
  await deliverSuggestion(suggestion, threadId);
}

/** Why a registration was refused, in words the model can act on. For
 *  'ambiguous_target' the candidates are the routines that could have been
 *  meant, so the model can ask the person to name one. */
export type RoutineProposalRegistration =
  /** autoAccepted: the person's own words stated exactly this change
   *  (statedChangeAgrees), so the platform applied it without the
   *  confirmation question — the ask itself was the consent. The model
   *  reports it as done and reversible instead of asking. */
  | { registered: true; autoAccepted?: true }
  | { registered: false; reason: 'open_proposal_exists' | 'already_offered' | 'not_recorded' }
  | { registered: false; reason: 'ambiguous_target'; candidates: string[] };

/**
 * The runtime tool path: the person asked the team member directly for
 * standing behaviour, the model called propose_routine, and the model's own
 * reply asks for confirmation. So the proposal is recorded and stamped as
 * offered in this thread, but nothing is posted — posting would put the same
 * question in the thread twice, once in each voice.
 *
 * The budget and the dedup latch still hold: createSuggestion answers null
 * for both, and the caller relays which one so the model can say something
 * true instead of promising a question it cannot ask.
 */
export async function registerRoutineProposal(params: {
  tenantId: string;
  agentId: string;
  threadId: string;
  /** Required for start and change; a stop composes its own prose from the
   *  resolved target. */
  routineProse?: string;
  action?: SuggestionAction;
  /** Required for change and stop: the routine as the person named it. */
  target?: string;
}): Promise<RoutineProposalRegistration> {
  const { tenantId, agentId, threadId } = params;
  const action: SuggestionAction = params.action ?? 'start';

  // Change and stop must name a real routine before anything is written: a
  // proposal against "whichever one you meant" would get a yes to the wrong
  // schedule.
  let targetLabel: string | undefined;
  let replacesProse: string | null | undefined;
  let currentCronExpr: string | null = null;
  if (action !== 'start') {
    const resolution = await resolveRoutineTarget(tenantId, agentId, params.target ?? '');
    if (!resolution.resolved) {
      return { registered: false, reason: 'ambiguous_target', candidates: resolution.candidates };
    }
    targetLabel = resolution.targetLabel;
    replacesProse = resolution.replacesProse;
    currentCronExpr = resolution.currentCronExpr;
  }

  const routineProse =
    action === 'stop' ? stopProse(targetLabel ?? 'named') : (params.routineProse ?? '');
  if (!routineProse) {
    return { registered: false, reason: 'not_recorded' };
  }

  const proposalText =
    action === 'change'
      ? changeProposalText(routineProse)
      : action === 'stop'
        ? stopProposalText(targetLabel ?? 'named')
        : routineProposalText(routineProse);

  const suggestion = await createSuggestion({
    tenantId,
    agentId,
    dedupKey: routineDedupKey(action, action === 'stop' ? (targetLabel ?? '') : routineProse),
    source: 'chat',
    proposalText,
    routineProse,
    provenanceNote: 'You described this while we were talking.',
    action,
    ...(targetLabel ? { targetLabel } : {}),
    ...(replacesProse ? { replacesProse } : {}),
  });
  if (!suggestion) {
    // createSuggestion logs which rule declined; the caller only needs to know
    // which sentence to say. An open proposal is the budget; anything else is
    // the latch.
    const open = await getOpenSuggestion(tenantId, agentId);
    return { registered: false, reason: open ? 'open_proposal_exists' : 'already_offered' };
  }

  try {
    await markOffered(tenantId, suggestion.id, threadId);
  } catch (err) {
    // A proposal that was never stamped can never be answered — the reply
    // interception matches on the thread — so it must not hold the
    // one-open-proposal budget. Same rule deliverSuggestion applies to a
    // proposal nobody saw: release it and let it be offered again.
    log.error(
      { tenantId, agentId, suggestionId: suggestion.id, error: (err as Error).message },
      'suggestions: could not stamp the tool-path proposal; releasing it',
    );
    await markDecided(tenantId, suggestion.id, 'cooldown', 0).catch(() => {});
    return { registered: false, reason: 'not_recorded' };
  }

  // Confirmation exists to catch INTERPRETATION: what gets written is the
  // model's restatement, and a wrong target or misheard time is durable. But
  // when the person's own message pins this exact change deterministically
  // (statedChangeAgrees never guesses — any ambiguity keeps the question),
  // asking "are you sure?" right after they said so is a second confirmation
  // of an explicit instruction. Changes only: a stop's words rarely carry a
  // parseable cadence, and a start's prose is substantially model-authored,
  // so both keep the question.
  if (action === 'change') {
    try {
      const userMessage = await latestUserMessageContent(tenantId, threadId);
      const proposedCron = parseCadence(routineProse)?.cronExpr ?? null;
      if (
        userMessage
        && statedChangeAgrees(userMessage, currentCronExpr, proposedCron)
      ) {
        const accepted = await acceptSuggestion({ ...suggestion, threadId }, undefined);
        if (accepted) {
          log.info(
            { tenantId, agentId, suggestionId: suggestion.id },
            'suggestions: change auto-accepted; the person\'s words stated it exactly',
          );
          return { registered: true, autoAccepted: true };
        }
      }
    } catch (err) {
      // The gate failing must never fail the registration: the proposal is
      // stamped and the ordinary confirmation flow stands ready.
      log.warn(
        { tenantId, agentId, suggestionId: suggestion.id, error: (err as Error).message },
        'suggestions: auto-accept gate errored; falling back to confirmation',
      );
    }
  }

  return { registered: true };
}
