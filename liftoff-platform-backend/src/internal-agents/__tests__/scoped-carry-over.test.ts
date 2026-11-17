// The scoped rebuild's splice: the model owns the trigger, nothing else.
//
// Pinned sections must come through byte-for-byte (models retype prose
// inconsistently, which is the whole reason the splice is code), and fields
// the previous output did not have must not survive from the placeholder
// response.

import { applyScopedCarryOver, type DistillOutput } from '../distill-service';

const PREV: DistillOutput = {
  agentType: 'agent',
  summary: 'Chases overdue invoices weekly.',
  systemPrompt: 'You are the Weekly Vendor Chase team member. Every Monday at 9am you…',
  userInstructions: 'Read the Vendor Invoices Tracker sheet; never send the drafts.',
  instructionsMd: '# Vendor chase\nSteps…',
  triggerConfig: { type: 'cron', cronExpr: '0 9 * * 1' } as DistillOutput['triggerConfig'],
  skills: [{ name: 'Chase drafting', description: 'd', instruction: 'i' } as never],
  capabilityTier: 'connector_only',
};

function modelPlaceholder(): DistillOutput {
  return {
    agentType: 'agent',
    summary: 'PINNED',
    systemPrompt: 'PINNED',
    userInstructions: 'PINNED',
    instructionsMd: 'PINNED',
    triggerConfig: {
      type: 'cron',
      cronExpr: '0 9 * * 2',
      reasoning: 'Guidance moved the run to Tuesdays.',
    } as DistillOutput['triggerConfig'],
    skills: [],
    workflowSteps: [{ id: 'w1' } as never],
  };
}

it('keeps the model trigger and restores every other section byte-for-byte', () => {
  const result = modelPlaceholder();
  applyScopedCarryOver(result, PREV);

  expect((result.triggerConfig as { cronExpr?: string }).cronExpr).toBe('0 9 * * 2');
  expect(result.systemPrompt).toBe(PREV.systemPrompt);
  expect(result.userInstructions).toBe(PREV.userInstructions);
  expect(result.instructionsMd).toBe(PREV.instructionsMd);
  expect(result.summary).toBe(PREV.summary);
  expect(result.skills).toBe(PREV.skills);
  expect(result.capabilityTier).toBe('connector_only');
});

it('drops placeholder-only fields the previous output never had', () => {
  const result = modelPlaceholder();
  applyScopedCarryOver(result, PREV);
  // PREV carried no workflowSteps; a placeholder must not invent them.
  expect(result.workflowSteps).toBeUndefined();
});

it('does NOT carry over the decision record: it describes the trigger the scoped run changed', () => {
  // The record is the one non-trigger field that DEPENDS on the trigger.
  // Carrying prev's is what drifted it out of sync with the new trigger set
  // and let a FULL redistill resurrect a stopped routine from the stale
  // description. The caller has already rebuilt result.decisionRecord from
  // the spliced trigger; the splice must leave it alone.
  const prevWithRecord: DistillOutput = {
    ...PREV,
    decisionRecord: { trigger: { type: 'cron', reason: 'Mondays AND a Friday note' } } as never,
  };
  const result = modelPlaceholder();
  const freshlyDerived = { trigger: { type: 'cron', reason: 'Tuesdays only' } } as never;
  result.decisionRecord = freshlyDerived;

  applyScopedCarryOver(result, prevWithRecord);

  expect(result.decisionRecord).toBe(freshlyDerived);
  expect(result.decisionRecord).not.toBe(prevWithRecord.decisionRecord);
});
