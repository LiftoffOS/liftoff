// Which control on the page the caller means.
//
// The copilot primitives made the assistant do this itself: call
// `read_browser_session_controls`, read a list of every control on the page,
// pick one, send its reference back in a second call. Two round trips of a
// large model, holding the whole conversation in mind, to answer "which of
// these is the Download button".
//
// It is the same question the browser loop's `browser_step` set already
// answers on every step, and a model that does nothing else answers it in
// milliseconds. So the reference becomes the override rather than the
// requirement: a caller that already knows the reference passes it and
// nothing here runs.
//
// THE THRESHOLD IS THE POINT. Below it the runtime refuses and says to read
// the controls and name one. A click on a page a person is watching is not a
// cheap thing to get wrong, and a choice head always returns its best
// candidate however poor the field is — "most likely of these" is not "the
// one they meant".

import { choice, type ChoiceQuestion } from '@typesafe-ai/sdk';
import { sanitizeBrowserText } from '@liftoffos/redact';
import { logger } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import {
  asEntry, paneTargetSet, PANE_TARGET_RULES, PANE_TARGET_WHAT_MAX_CHARS,
} from '../typesafe/questions';

/** One row of the element table put to the model.
 *
 *  The same columns the reference loop shows — what the control is, what it
 *  is called, and what it currently holds:
 *
 *      [1] button    Change ticket type · Round trip
 *      [2] combobox  Where from?        · San Francisco
 *
 *  The current value is not decoration. It is what tells the origin field
 *  from the destination field when a page names both the same, and it is
 *  what the rule about not re-filling a satisfied field is judged on. A
 *  reading taken before these were kept has none and resolves on role and
 *  name alone. */
export interface TargetCandidate {
  ref: string;
  role: string;
  name: string;
  inputType?: string;
  valueState?: string;
  disabled?: boolean;
}

export interface TargetResolution {
  /** The chosen control's reference, or '' when nothing was chosen. */
  ref: string;
  /** Why nothing was chosen, model-facing. Empty when one was. */
  refusal: string;
  probability: number;
}

/** The most controls put to one request. A reading is already bounded by the
 *  pane's own paging; this is the second bound, so an enormous page cannot
 *  become an enormous request. */
export const MAX_CANDIDATES = 120;

/** Longest control name sent. Page-authored text, sanitized like any other. */
const CONTROL_NAME_CAP = 200;

/** Roles that take typed text, and roles that offer a value to choose. */
const TAKES_TEXT = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
const OFFERS_A_CHOICE = new Set(['combobox', 'listbox', 'menu', 'select']);

/** Whether this operation can be performed on this control at all. Clicking
 *  and hovering are not narrowed: anything on a page can be clicked, and a
 *  guess about what is clickable would drop the one control that was. */
function canTake(action: string, control: TargetCandidate): boolean {
  if (action === 'type') return TAKES_TEXT.has(control.role) || Boolean(control.inputType);
  if (action === 'select') return OFFERS_A_CHOICE.has(control.role);
  return true;
}

export interface ResolveTargetInput {
  what: string;
  action: string;
  page: { url: string; title?: string };
  controls: TargetCandidate[];
  tenantId: string;
  invocationId?: string;
  runtimeAgentId?: string;
  /** How long this may take. A resolution that outruns it answers a refusal,
   *  never a guess. */
  deadlineMs: number;
}

/**
 * Name one control, or refuse.
 *
 * Every control the reading holds is offered, including any the page has
 * disabled: the caller may well mean the disabled one, and hiding it here
 * would turn the real answer ("that button is not clickable yet") into "I
 * could not tell which one you meant". The act itself refuses a control that
 * cannot take the action, in its own words.
 */
export async function resolveTarget(input: ResolveTargetInput): Promise<TargetResolution> {
  const what = sanitizeBrowserText(input.what, PANE_TARGET_WHAT_MAX_CHARS).text.trim();
  if (!what) {
    return { ref: '', refusal: 'Say which control to act on, in words, or pass a reference from a reading of the page.', probability: 0 };
  }
  if (input.controls.length === 0) {
    return { ref: '', refusal: 'This page has no controls to act on.', probability: 0 };
  }
  // Only the controls the operation can actually be performed on, the way
  // the reference loop gives each operation its own head of compatible
  // elements: a request to type has no business offering a link. Narrower is
  // both faster and more accurate, but never at the cost of dropping the one
  // control the caller meant, so a filter that leaves nothing is not applied.
  const compatible = input.controls.filter((c) => canTake(input.action, c));
  const candidates = (compatible.length > 0 ? compatible : input.controls).slice(0, MAX_CANDIDATES);

  // Indexed by position rather than by reference: a reference is ours and
  // carries no meaning, and putting one in front of the model invites it to
  // reason about the shape of an identifier.
  const criteria: Record<string, Record<string, string>> = {};
  const byIndex = new Map<string, TargetCandidate>();
  candidates.forEach((control, i) => {
    const index = String(i + 1);
    byIndex.set(index, control);
    const name = sanitizeBrowserText(control.name, CONTROL_NAME_CAP).text;
    criteria[index] = {
      control: `${control.role}${name ? ` · ${name}` : ''}`,
      ...(control.inputType ? { input_type: control.inputType } : {}),
      ...(control.valueState ? { current_value: control.valueState } : {}),
      ...(control.disabled ? { state: 'This control is not currently enabled.' } : {}),
    };
  });

  const set = paneTargetSet();
  const questions: Record<string, ChoiceQuestion> = {
    target: choice(
      { request: what, operation: input.action, page: input.page, rules: PANE_TARGET_RULES },
      criteria as never,
    ),
  };

  const answered = await ask(
    { ...set, questions },
    asEntry({ page: input.page, request: what, operation: input.action, controls: criteria }),
    {
      deadlineMs: input.deadlineMs,
      tenantId: input.tenantId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      ...(input.runtimeAgentId ? { runtimeAgentId: input.runtimeAgentId } : {}),
    },
  );
  if (!answered) {
    return {
      ref: '',
      refusal: 'The page could not be read closely enough to tell which control you meant. Read the controls and name one by its reference.',
      probability: 0,
    };
  }

  const answer = answered.answers.target as { choice?: unknown; probabilities?: Record<string, unknown> } | undefined;
  const chosenIndex = typeof answer?.choice === 'string' ? answer.choice : '';
  const probability = Number(answer?.probabilities?.[chosenIndex] ?? 0);
  const control = byIndex.get(chosenIndex);
  const threshold = set.thresholds.TARGET_T as number;

  if (!control || !Number.isFinite(probability) || probability < threshold) {
    logger.info(
      {
        tenantId: input.tenantId, event: 'pane_target_unclear',
        probability: Number.isFinite(probability) ? probability : 0, candidates: candidates.length,
      },
      'the control the request named could not be told apart from the others',
    );
    return {
      ref: '',
      refusal: `It is not clear which control "${what}" means on this page. Read the controls and act on one by its reference.`,
      probability: Number.isFinite(probability) ? probability : 0,
    };
  }

  logger.info(
    { tenantId: input.tenantId, event: 'pane_target_resolved', probability, candidates: candidates.length },
    'the control the request named was chosen from the page',
  );
  return { ref: control.ref, refusal: '', probability };
}
