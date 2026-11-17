// groundsOn: an agent's first read as a function of the request's SHAPE.
//
// An agent that has to decide, every turn, whether this question is the kind
// that needs the help centre will sometimes decide wrong — and when it decides
// wrong the answer is confidently unsourced, which is the worst failure mode
// available. The decision is not a judgment call: "what is your refund window"
// always wants the policy corpus, and "where is my ticket" always wants the
// work inbox.
//
// So it is declared here and evaluated by the host, not by the model. That is
// what makes it portable: every engine gets the same behaviour because no
// engine is asked to produce it. Native tool-forcing, where a vendor offers it,
// is an optimisation of a guarantee that already holds without it — never the
// mechanism the guarantee depends on.
//
// THE MATCHER LIVES IN THE RUNTIME, NOT HERE. This module DERIVES rules; the
// tenant runtime EVALUATES them, and a second matcher on this side would be a
// second answer to "did this turn match" — the two would agree until they did
// not, and the disagreement would surface as a rule that fires in testing and
// not in production. So the shape is declared here and interpreted there, once.
//
// DERIVED, NOT EMITTED. The model is not asked for this. Two universal shapes
// cover the cases worth having, both of them read off tools that are ALREADY in
// the catalog with categories the connector-service boot validator has checked:
//
//   policy / terms  -> the bound knowledge or help-centre read
//   record status   -> the bound work-inbox read
//
// Asking a model to nominate its own grounding tool invites exactly the error
// this removes: it would name a tool that reads well and answers the wrong
// question, and nothing downstream could tell.

import type { ToolCatalog } from './distill-service';

/** One declared grounding rule. Engine-neutral by construction: it names a
 *  tool and the shapes of request that need it, and says nothing about how any
 *  particular vendor might be persuaded to call it. */
export interface GroundsOnRule {
  /** Human-readable, for the prefetch's own labelled intro and for logs. */
  label: string;
  /** Whole-word subject terms. A turn matching one of these is about this. */
  terms: string[];
  /** Whole-word intent cues. Present so "refund" alone does not fire on
   *  "I refunded it yesterday" — a cue plus a term is a question, a term alone
   *  is often a statement. */
  cues: string[];
  /** The catalog tool name to read. */
  toolName: string;
  /** Off is a first-class state: a rule can be declared and disabled without
   *  being deleted, so turning it back on is not a redistill. */
  enabled: boolean;
}

/** Subject terms for the policy/terms shape. Deliberately about what a person
 *  ASKS, not what a corpus contains — the corpus's own vocabulary is the thing
 *  the asker does not have. */
const POLICY_TERMS = [
  'policy', 'policies', 'terms', 'refund', 'refunds', 'cancellation', 'cancel',
  'warranty', 'guarantee', 'return', 'returns', 'eligibility', 'entitled',
  'sla', 'agreement', 'contract', 'pricing', 'price', 'fee', 'fees', 'charge',
  'allowed', 'permitted', 'rule', 'rules', 'limit', 'deadline', 'window',
];

/** Subject terms for the record-status shape. */
const STATUS_TERMS = [
  'status', 'ticket', 'tickets', 'case', 'cases', 'request', 'requests',
  'issue', 'issues', 'order', 'orders', 'progress', 'update', 'updates',
  'outstanding', 'pending', 'open', 'unresolved', 'assigned', 'queue', 'backlog',
];

/** Intent cues. A term says what the turn is about; a cue says the turn is a
 *  QUESTION about it rather than a statement mentioning it. */
const QUESTION_CUES = [
  'what', 'when', 'how', 'why', 'which', 'who', 'where', 'can', 'could',
  'does', 'do', 'is', 'are', 'am', 'should', 'would', 'any', 'please',
  'check', 'find', 'tell', 'show', 'look', 'confirm', '?',
];

/**
 * Derive the grounding rules a hire's bound tools support.
 *
 * Returns `[]` when nothing suitable is bound, which is the common case and is
 * correct: a rule naming a tool the agent does not have would be evaluated on
 * every turn and never fire, costing a matcher pass per turn to produce
 * nothing.
 */
export function deriveGroundsOn(catalog: ToolCatalog): GroundsOnRule[] {
  const rules: GroundsOnRule[] = [];

  const knowledge = findKnowledgeRead(catalog);
  if (knowledge) {
    rules.push({
      label: 'the help centre',
      terms: POLICY_TERMS,
      cues: QUESTION_CUES,
      toolName: knowledge,
      enabled: true,
    });
  }

  const inbox = findWorkInboxRead(catalog);
  if (inbox) {
    rules.push({
      label: 'the work queue',
      terms: STATUS_TERMS,
      cues: QUESTION_CUES,
      toolName: inbox,
      enabled: true,
    });
  }

  return rules;
}

/** The bound knowledge / help-centre read.
 *
 *  `corpus_search` is the platform's own and is preferred when present: it is
 *  the one read whose corpus the workspace curates, so it answers about THIS
 *  business rather than about a vendor's documentation. */
function findKnowledgeRead(catalog: ToolCatalog): string | null {
  if (catalog.has('corpus_search')) return 'corpus_search';
  for (const [name, tool] of catalog) {
    const cats = (tool.categories ?? []).map((c) => String(c).toLowerCase());
    if (!cats.includes('read')) continue;
    if (/(^|__)(search|find|query)_(articles?|docs?|documents?|knowledge|help)/.test(name)) {
      return name;
    }
  }
  return null;
}

/** The bound work-inbox read — the same `workRole: 'inbox'` declaration the W1
 *  boot validator checks, so this cannot drift from what the runtime treats as
 *  an inbox. */
function findWorkInboxRead(catalog: ToolCatalog): string | null {
  for (const [name, tool] of catalog) {
    if ((tool as { workRole?: string }).workRole === 'inbox') return name;
  }
  return null;
}
