// One run, one outward action.
//
// The sibling of `announce-gating.ts` next door. That rule says an announcement
// must be conditional on the work having landed; this one says an outward act
// must not happen twice in the same run. A graph containing two steps that call
// the same posting tool with no `condition` between them posts twice on every
// run, however the agent's own responsibilities are worded.
//
// WHY A DISTILLER RULE AND NOT A RUNTIME GUARD. A runtime guard would have to
// decide that two calls MEAN the same thing, which is a judgement. A graph that
// contains one summary step rather than two is a fact, checkable before the
// agent runs, and the graph language already expresses everything needed to say
// it. A prompt preference is weaker still: a soft rule the distiller may ignore.
//
// WHAT THIS CANNOT SEE, so a green distillation is not read as more than it is:
//
//   1. A model calling the same tool twice INSIDE one `llm_reason` step. The
//      graph says "reason here"; how many tool calls that takes is the model's.
//      Closing that needs idempotency at dispatch — `WorkflowStep.idempotencyKey`
//      is where it would go — not a rule about graph shape.
//   2. An agent with no graph. `agents.workflow_steps` is unset for many agents,
//      which run the conversational branch instead; this reaches them only once
//      they are redistilled.
//
// Background: docs/design/defect-3-reactive-pr-events.md §6.

import type { WorkflowStep } from './types';
import { isAnnounceTool } from './announce-gating';

/**
 * Posting a review, a comment or a note on somebody's work item.
 *
 * These carry `write` in the catalog but not `outbound` — `outbound` marks
 * customer-facing sends, and a pull-request review is neither that nor an
 * internal bookkeeping write. Without them the rule misses the review and
 * comment tools entirely.
 *
 * Both name shapes are matched. A vendor MCP tool arrives aliased
 * (`github-7d07a896__create_and_submit_pull_request_review`); matching only the
 * bare form is how the level-2 destructive gate ended up inert for every
 * connector tool.
 *
 * Verb-anchored on purpose: `get_review_comments`, `list_pull_requests` and
 * `pull_request_read` must not match. The second pattern exists because the
 * GitHub MCP puts the verb LAST (`pull_request_review_write`).
 */
const WORK_ITEM_POST_PATTERNS: RegExp[] = [
  /(^|__)(create|submit|add|post|write|reply)_[a-z0-9_]*(review|comment|note)[a-z0-9_]*$/,
  /(^|__)[a-z0-9_]*(review|comment|note)_write$/,
];

export interface ActionRepetitionCatalogEntry {
  categories?: string[];
}

/**
 * Does this step tell someone outside the run that something happened?
 *
 * Three sources, deliberately in this order — the catalog's own classification
 * first, because it is the authoritative statement, and the name patterns only
 * as the fallback for tools it does not classify.
 */
function isOutwardAction(
  step: WorkflowStep,
  catalog?: Map<string, ActionRepetitionCatalogEntry>,
): boolean {
  if ((step.type ?? 'tool_call') !== 'tool_call') return false;
  const toolName = step.toolName;
  if (!toolName) return false;

  const cats = (catalog?.get(toolName)?.categories ?? []).map((c) => String(c).toLowerCase());
  if (cats.includes('outbound')) return true;

  if (isAnnounceTool(toolName)) return true;
  return WORK_ITEM_POST_PATTERNS.some((re) => re.test(toolName));
}

export interface ActionRepetitionProblem {
  /** The second occurrence — the one the model should remove or gate. */
  stepId: string;
  /** The first occurrence on the same guaranteed path. */
  firstStepId: string;
  toolName: string;
  /** True when the repeat is a cycle back into the same step. */
  cycle: boolean;
  message: string;
}

/**
 * Outward actions that are guaranteed to happen more than once in one run.
 *
 * Reports only when the repeat is CERTAIN: the second occurrence is reachable
 * from the first along `onSuccess` edges with no `condition` anywhere on the
 * path. A condition means the author has expressed a choice, and second-guessing
 * it here would turn a real property into noise — the same restraint
 * `findUngatedAnnouncements` takes when a step is already gated.
 *
 * `onFailure` edges are deliberately not followed: a fallback that re-posts
 * after a failure is a retry, which is a different thing and has `retry` for it.
 *
 * A step carrying `loop` is skipped. Repetition there is declared, bounded by
 * `maxIterations`, and usually the correct construct — one comment per changed
 * file is a loop, not a defect.
 *
 * A step carrying `condition` is skipped as a STARTING point too, symmetrically
 * with the check on steps further down the path. A conditional first post is not
 * guaranteed to happen, so the pair is not guaranteed to double — and the real
 * graphs that shape describes are legitimate: post inline comments when there
 * are findings, then always post one summary. Reporting those would make the
 * message ("every run performs that outward action twice") untrue and cost a
 * retry on a correct graph.
 */
export function findRepeatedOutwardActions(
  steps: WorkflowStep[],
  catalog?: Map<string, ActionRepetitionCatalogEntry>,
): ActionRepetitionProblem[] {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const out: ActionRepetitionProblem[] = [];

  for (const step of steps) {
    if (!isOutwardAction(step, catalog)) continue;
    if (step.loop) continue;
    if (step.condition) continue;

    const seen = new Set<string>([step.stepId]);
    let cur: WorkflowStep = step;

    for (;;) {
      const nextId = cur.onSuccess;
      if (!nextId) break;
      const next = byId.get(nextId);
      // A dangling reference is `findWorkflowStepProblems`'s to report, and
      // guessing what it pointed at would invent a repeat that may not exist.
      if (!next) break;

      if (next.stepId === step.stepId) {
        out.push({
          stepId: step.stepId,
          firstStepId: step.stepId,
          toolName: String(step.toolName),
          cycle: true,
          message:
            `Step ${step.stepId} calls \`${step.toolName}\`, which tells someone outside this run `
            + `that something happened, and the success path from it leads back to ${step.stepId} `
            + `with nothing conditional in between. That is not a retry — it posts again every time `
            + `round, without bound. If the loop is meant to cover several items, express it as a `
            + `\`loop\` on ${step.stepId} with a \`maxIterations\`; if it is meant to run once, end `
            + `the path instead of routing back to it.`,
        });
        break;
      }

      // From a conditional step onward the path is a choice, not a guarantee.
      if (next.condition) break;
      if (seen.has(next.stepId)) break;
      seen.add(next.stepId);

      if (!next.loop && next.toolName === step.toolName && isOutwardAction(next, catalog)) {
        out.push({
          stepId: next.stepId,
          firstStepId: step.stepId,
          toolName: String(step.toolName),
          cycle: false,
          message:
            `Steps ${step.stepId} and ${next.stepId} both call \`${step.toolName}\`, and `
            + `${next.stepId} is reachable from ${step.stepId} with no condition on the path — so `
            + `every run performs that outward action twice, whatever the responsibilities say `
            + `about doing it once. Keep ONE of these steps; if the second is meant to happen `
            + `only in some cases, give it a \`condition\` reading a field an earlier step `
            + `declares (with an \`onFailure\` for the other branch); if it is meant to run once `
            + `per item, replace both with a single step carrying \`loop\`.`,
        });
        break;
      }

      cur = next;
    }
  }

  return out;
}
