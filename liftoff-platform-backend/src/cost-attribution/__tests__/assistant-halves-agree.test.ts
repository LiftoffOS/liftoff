// An assistant's tools are charged exactly like its conversation.
//
// This defect has now happened twice, in the same shape both times: the half of
// a platform assistant that TALKS billed while the half that DOES work was
// free.
//
//   Browser. A Liftoff or Chief AI Officer browser session always booked
//   cost_bucket='included' and drained Operating Units, while every model call
//   those assistants made was platform_overhead at $0.00. Nobody decided that;
//   it fell out of `browser_task` being named in CUSTOMER_PURPOSES_WITHOUT_AGENT
//   while `liftoff_chat` sat in PLATFORM_OVERHEAD_PURPOSES.
//
//   Datasets. Fixing the above charged the conversations and left
//   `*_dataset_extract` absorbed — so the split simply inverted. Seen live on
//   dev at 2026-09-23T04:13:59Z: insights_dataset_extract booked
//   platform_overhead and consumed 2.22 Operating Units on a deploy where
//   insights_chat was already charging. The tool descriptions in
//   `datasets/render.ts` and `datasets/tools.ts` tell the model dataset_extract
//   "uses the model and is metered like any answer", so the product copy
//   promised metering the code did not do.
//
// Both times the individual entries looked right in isolation. What was wrong
// was the RELATIONSHIP between them, which no per-purpose test can see. So the
// relationship is what this asserts: for each assistant, every purpose it emits
// is charged, unless it is one of the two page-load purposes the platform
// absorbs on purpose.

import {
  classifyChargeability,
  isPlatformAbsorbedPurpose,
  PLATFORM_ASSISTANT_PURPOSES,
} from '../event-classification';
import { assistantForPurpose, type AssistantKey } from '../../insights/platform-assistants';

/**
 * Opening a page is never billable; asking a question is. These two auto-run
 * when a person opens /insights, so charging them would bill someone for
 * arriving — and because absorbed also means ungated, it would take a
 * workspace with no plan off its own dashboard. ADR-053.
 */
const ABSORBED_ON_PURPOSE = new Set(['insights_intro', 'insights_observation']);

/** Every purpose each assistant emits, by the half of its work it represents. */
const ASSISTANT_WORK: Record<AssistantKey, { talks: string[]; does: string[] }> = {
  liftoff: {
    talks: ['liftoff_chat', 'liftoff_summarization'],
    does:  ['liftoff_dataset_extract'],
  },
  insights: {
    talks: ['insights_chat', 'insights_summarization'],
    does:  ['insights_dataset_extract'],
  },
  caio: {
    talks: [
      'caio_workforce_planning',
      'caio_workforce_planning_summarization',
      'caio_workforce_planning_title_generation',
    ],
    does: ['caio_dataset_extract'],
  },
};

/** An assistant carries NO agent id — that is what makes it one. */
const asAssistant = (purpose: string) =>
  classifyChargeability({ source: 'platform_llm', purpose, agentId: null });

describe("an assistant's two halves are charged the same way", () => {
  for (const [key, work] of Object.entries(ASSISTANT_WORK) as Array<[AssistantKey, { talks: string[]; does: string[] }]>) {
    it(`${key}: doing work costs what talking costs`, () => {
      const talking = work.talks.map(asAssistant);
      const doing   = work.does.map(asAssistant);
      // Not "both are charged" — both are THE SAME. If a future decision
      // absorbs an assistant outright, this still holds; what it forbids is
      // the split.
      for (const verdict of [...talking, ...doing]) {
        expect(verdict).toBe(talking[0]);
      }
    });
  }

  it('and that way is charged, for every purpose but the two page-load ones', () => {
    for (const work of Object.values(ASSISTANT_WORK)) {
      for (const purpose of [...work.talks, ...work.does]) {
        expect(asAssistant(purpose)).toBe('customer');
        expect(isPlatformAbsorbedPurpose(purpose)).toBe(false);
      }
    }
  });

  it('opening a page is still free', () => {
    for (const purpose of ABSORBED_ON_PURPOSE) {
      expect(asAssistant(purpose)).toBe('platform_overhead');
      expect(isPlatformAbsorbedPurpose(purpose)).toBe(true);
    }
  });
});

describe('the classifier and the page agree on who spent it', () => {
  it('every charged assistant purpose resolves to an assistant by name', () => {
    // A purpose that charges but maps to no assistant lands in "Unattributed"
    // on the Cost Breakdown — a workspace billed by nobody.
    for (const purpose of PLATFORM_ASSISTANT_PURPOSES) {
      expect(assistantForPurpose(purpose)).not.toBeNull();
    }
  });

  it('every purpose this test enumerates is one the classifier knows', () => {
    // Guards against the list above drifting into fiction: if a purpose is
    // renamed in the code, its entry here stops matching and this fails rather
    // than silently asserting nothing.
    const enumerated = Object.values(ASSISTANT_WORK).flatMap(w => [...w.talks, ...w.does]);
    for (const purpose of enumerated) {
      expect(PLATFORM_ASSISTANT_PURPOSES.has(purpose)).toBe(true);
    }
    expect([...PLATFORM_ASSISTANT_PURPOSES].sort()).toEqual(enumerated.sort());
  });
});
