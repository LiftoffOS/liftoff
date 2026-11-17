// Decide: ONE TypeSafe request per step, ported from jev-ultrafast model.py.
//
// A Choice `operation` over the operations the page supports (CLICK,
// TYPE_TEXT, SELECT when a target exists; SCROLL_UP / SCROLL_DOWN / WAIT when
// the snapshot offered them; DONE and BLOCKED always), and one SPECULATIVE
// target Choice per operation over the indexes compatible with it. The
// executor reads only the head the chosen operation names: an unused head
// cannot cause an action. One node receives one index even when it supports
// both clicking and typing; dropdown targets carry a code-owned option index.
//
// Answers are validated by SHAPE: the choice among the offered ids,
// probabilities present for every id, finite, in [0, 1], summing to one, the
// choice the argmax. An invalid answer executes nothing.
//
// The one divergence: `type_text_value`, a Choice over the task's literals
// plus `none`, in the same request (literals.ts). There are no probability
// thresholds; probability and confidence are recorded per step.

import { choice, type ChoiceQuestion, type Questions } from '@typesafe-ai/sdk';
import { NEXT_ACTION, TARGET, TEXT_VALUE_RULES, CONSTRAINT_RULES, BROWSER_STEP_SET, asEntry, type QuestionSet } from '../../../typesafe/questions';
import { RECENT_ACTIONS, type HistoryEntry, type Operation, type PageState, type SnapshotAction, type Decision } from './types';
import type { TaskLiterals } from './literals';

export interface ElementRow {
  index: string;
  label: string;
  operations: Operation[];
  role?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  options?: Array<{ index: string; label: string; value: string }>;
}

export interface ActionSpace {
  elements: ElementRow[];
  /** Per operation, the target index → the snapshot action it executes. */
  targets: Map<Operation, Map<string, SnapshotAction>>;
  /** SCROLL_UP / SCROLL_DOWN / WAIT, when the snapshot offered them. */
  controls: Map<Operation, SnapshotAction>;
}

const KIND_TO_OPERATION: Record<string, Operation> = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' };

/** One index per observed element; each operation has its own valid target
 *  choices. Verbatim in behaviour from the reference's action_space. */
export function actionSpace(actions: SnapshotAction[]): ActionSpace {
  const elements: ElementRow[] = [];
  const indices = new Map<number, string>();
  const targets = new Map<Operation, Map<string, SnapshotAction>>();
  const controls = new Map<Operation, SnapshotAction>();
  for (const action of actions) {
    const operation = KIND_TO_OPERATION[action.kind];
    if (!operation) {
      controls.set(action.id.toUpperCase() as Operation, action);
      continue;
    }
    const node = action.node as number;
    if (!indices.has(node)) {
      const index = String(elements.length + 1);
      indices.set(node, index);
      const element: ElementRow = { index, label: action.label.split(' → ')[0], operations: [] };
      for (const k of ['role', 'value', 'checked', 'selected', 'expanded'] as const) {
        if (action[k] !== undefined) element[k] = action[k];
      }
      if (action.kind === 'select') {
        element.value = action.current_value ?? '';
        element.options = [];
      }
      elements.push(element);
    }
    const index = indices.get(node)!;
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target = index;
    if (action.kind === 'select') {
      target = `${index}:${(element.options?.length ?? 0) + 1}`;
      element.options!.push({ index: target, label: action.label, value: action.value ?? '' });
    }
    if (!targets.has(operation)) targets.set(operation, new Map());
    targets.get(operation)!.set(target, action);
  }
  return { elements, targets, controls };
}

export interface ChoiceAnswerLike {
  choice?: unknown;
  confidence?: unknown;
  probabilities?: Record<string, unknown>;
}

/** Shape validation, verbatim in behaviour from the reference. Throws on an
 *  invalid answer; nothing executes. */
export function validateChoice(answer: ChoiceAnswerLike | undefined, ids: Iterable<string>): { choice: string; confidence: number; probabilities: Record<string, number> } {
  const idSet = new Set(ids);
  const invalid = new Error('Invalid TypeSafe response; no action executed.');
  if (!answer || typeof answer !== 'object') throw invalid;
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== 'object') throw invalid;
  const keys = Object.keys(probabilities);
  if (typeof answer.choice !== 'string' || !idSet.has(answer.choice)) throw invalid;
  if (keys.length !== idSet.size || !keys.every((k) => idSet.has(k))) throw invalid;
  const numbers = [...Object.values(probabilities), answer.confidence];
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) throw invalid;
  const values = Object.values(probabilities) as number[];
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) >= 0.02) throw invalid;
  const max = Math.max(...values);
  if ((probabilities[answer.choice] as number) < max - 1e-6) throw invalid;
  return { choice: answer.choice, confidence: answer.confidence as number, probabilities: probabilities as Record<string, number> };
}

const OPERATION_LABELS: Record<'CLICK' | 'TYPE_TEXT' | 'SELECT', string> = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field with a literal the task supplied.',
  SELECT: 'Select an observed dropdown value.',
};

export interface BuiltRequest {
  set: QuestionSet<Questions>;
  state: ReturnType<typeof asEntry>;
  space: ActionSpace;
  operations: string[];
  literalIds: string[];
}

/** The request for one step: the operation head, one target head per
 *  operation with targets, and the type_text_value head when TYPE_TEXT is
 *  offered. State = { page: {url, title, text}, elements, recent_actions
 *  (last 10), omitted_actions } so the model knows what it cannot select. */
export function buildStepRequest(
  page: PageState,
  goal: string,
  history: HistoryEntry[],
  literals: TaskLiterals,
  constraints: readonly string[] = [],
  /** What an earlier run of this same task did, shown before this run's own
   *  actions so a resumed task does not repeat a step it already took. */
  priorActions: readonly HistoryEntry[] = [],
  /** What finishing looks like, when the caller said. The operation head
   *  chooses DONE against the same sentence the completion check judges it
   *  by, so the two cannot disagree about what finished means. */
  success = '',
): BuiltRequest {
  const space = actionSpace(page.actions);
  const operations: Record<string, string> = {};
  for (const op of space.targets.keys()) operations[op] = OPERATION_LABELS[op as keyof typeof OPERATION_LABELS];
  for (const [op, control] of space.controls) operations[op] = control.label;
  operations.DONE = 'Every requirement is visibly satisfied.';
  operations.BLOCKED = 'No supported operation can progress.';
  // Offered only when there is something to break. An operation that is
  // always on the list is one the model will eventually choose for the wrong
  // reason, and a task with no constraints has no such thing to choose.
  if (constraints.length > 0) {
    operations.CONSTRAINED = 'The action that would advance the goal from here is one the constraints do not allow.';
  }

  const questions: Record<string, ChoiceQuestion> = {
    operation: choice(
      {
        goal,
        ...(success ? { success } : {}),
        ...(constraints.length > 0 ? { constraints: [...constraints], rules: [NEXT_ACTION, CONSTRAINT_RULES] } : { rules: NEXT_ACTION }),
      },
      operations,
    ),
  };
  for (const [op, candidates] of space.targets) {
    const criteria: Record<string, Record<string, string>> = {};
    for (const [index, a] of candidates) {
      criteria[index] = {
        element: `[${index}] ${a.label}`,
        current_value: a.current_value ?? a.value ?? '',
        ...(a.role !== undefined ? { role: a.role } : {}),
        ...(a.checked !== undefined ? { checked: a.checked } : {}),
        ...(a.selected !== undefined ? { selected: a.selected } : {}),
        ...(a.expanded !== undefined ? { expanded: a.expanded } : {}),
      };
    }
    questions[`${op.toLowerCase()}_target`] = choice({ goal, operation: op, rules: [NEXT_ACTION, TARGET] }, criteria);
  }
  const literalIds = [...literals.byId.keys()];
  if (space.targets.has('TYPE_TEXT')) {
    const criteria: Record<string, string> = {};
    for (const [id, value] of literals.byId) criteria[id] = value;
    criteria.none = 'The field needs a value the task did not supply.';
    questions.type_text_value = choice({ goal, operation: 'TYPE_TEXT', rules: [NEXT_ACTION, TEXT_VALUE_RULES] }, criteria);
  }

  const state = asEntry({
    ...(constraints.length > 0 ? { constraints: [...constraints] } : {}),
    page: { url: page.url, title: page.title, text: page.text },
    elements: space.elements,
    recent_actions: [...priorActions, ...history].slice(-RECENT_ACTIONS)
      .map((h) => ({ action: h.action, kind: h.kind, text: h.typed ? '(typed)' : null, page_changed: h.pageChanged })),
    omitted_actions: page.omitted_actions,
  });
  return {
    set: { ...BROWSER_STEP_SET, questions },
    state,
    space,
    operations: Object.keys(operations),
    literalIds,
  };
}

export interface StepAnswers {
  [name: string]: ChoiceAnswerLike;
}

/**
 * Consume the answers: validate the operation head, then ONLY the target
 * head the chosen operation names (and the value head for TYPE_TEXT).
 * Returns the decision or throws on an invalid answer.
 */
export function chooseFromAnswers(
  built: BuiltRequest,
  answers: StepAnswers,
  meta: { latencyMs: number; model: string; usage: { inputTokens: number; outputTokens: number } },
): Decision {
  const op = validateChoice(answers.operation, built.operations);
  const operation = op.choice as Operation;
  let target: string | null = null;
  let choiceId: string;
  let probability: number;
  const targets = built.space.targets.get(operation);
  if (targets) {
    const t = validateChoice(answers[`${operation.toLowerCase()}_target`], targets.keys());
    target = t.choice;
    choiceId = targets.get(t.choice)!.id;
    probability = t.probabilities[t.choice];
  } else {
    const control = built.space.controls.get(operation);
    choiceId = control ? control.id : operation;
    probability = op.probabilities[operation];
  }
  let textId: string | null = null;
  if (operation === 'TYPE_TEXT') {
    const v = validateChoice(answers.type_text_value, [...built.literalIds, 'none']);
    textId = v.choice === 'none' ? null : v.choice;
  }
  return {
    choice: choiceId,
    operation,
    target,
    textId,
    confidence: op.confidence,
    probability,
    latencyMs: meta.latencyMs,
    model: meta.model,
    usage: meta.usage,
  };
}
