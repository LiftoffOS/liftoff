// Compose an agent's two authored prose fields from the spec's section slots.
//
// `responsibilities` and `additionalContext` are the free-text inputs the
// distiller reads, and both are markdown with a fixed set of `## ` headings.
// The section sets come from @liftoffos/workforce-types, shared with the
// template validator and the catalog so there is one definition.
//
// Composition happens here rather than in the model's tool arguments. A model
// asked to emit markdown will sometimes flatten a structure it was given —
// inlining headings as prose labels — and nothing downstream can tell that
// apart from prose the user genuinely wrote that way. Filling slots and
// rendering the headings in code removes the failure entirely: there is no
// format for the model to get wrong.

import {
  ADDITIONAL_CONTEXT_SECTIONS,
  RESPONSIBILITIES_SECTIONS,
  composeProseSections,
} from '@liftoffos/workforce-types';
import type { AgentProseSlots } from './types.js';

/** Slot → canonical heading, for the responsibilities field. */
const RESPONSIBILITIES_MAP: ReadonlyArray<[keyof AgentProseSlots, string]> = [
  ['responsibilities', '## Responsibilities'],
  ['goals', '## Goals'],
  ['workflows', '## Workflows'],
  ['instructions', '## Instructions'],
  ['outcomes', '## Outcomes'],
];

/** Slot → canonical heading, for the additionalContext field. */
const ADDITIONAL_CONTEXT_MAP: ReadonlyArray<[keyof AgentProseSlots, string]> = [
  ['specificInstructions', '## Specific instructions'],
  ['rules', '## Rules'],
  ['constraints', '## Constraints'],
  ['edgeCases', '## Edge cases'],
  ['anythingToAvoid', '## Anything to avoid'],
];

function render(
  map: ReadonlyArray<[keyof AgentProseSlots, string]>,
  order: readonly string[],
  slots: AgentProseSlots,
): string {
  const sections: Record<string, string | undefined> = {};
  for (const [slot, heading] of map) {
    sections[heading] = slots[slot];
  }
  return composeProseSections(order, sections);
}

/** Canonical markdown for `responsibilities`, or '' when no slot was filled. */
export function composeResponsibilities(slots: AgentProseSlots): string {
  return render(RESPONSIBILITIES_MAP, RESPONSIBILITIES_SECTIONS, slots);
}

/** Canonical markdown for `additionalContext`, or '' when no slot was filled. */
export function composeAdditionalContext(slots: AgentProseSlots): string {
  return render(ADDITIONAL_CONTEXT_MAP, ADDITIONAL_CONTEXT_SECTIONS, slots);
}
