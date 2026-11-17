// Every charged purpose lands in a bucket on the per-agent breakdown.
//
// `buildAgentLLMMap` has a `default:` branch that logs an error and adds the
// cost to nothing. It is reachable, and cost can go missing through it: a
// purpose such as `skill_dedup` that is charged and consumes Operating Units
// would be absent from both the Cost Breakdown table and the metric card above
// it, for as long as nobody reads the error log. Every new charged purpose
// (contract_check, memory_used, browser_step, …) widens the same hole.
//
// The error log is the wrong enforcement: it fires in production, once, at the
// moment a customer is already looking at an understated number. This fires in
// CI instead. `_chargedPurposesByName` is the classifier's own list of what a
// workspace pays for by name, so adding a purpose there and forgetting the
// switch is now a failing test rather than a quiet omission.
//
// The second list is the purposes that reach the map through the classifier's
// defensive "has an agent id, charge it" branch. They cannot be derived — that
// branch names nothing — so they are frozen here as debt: every one is mapped,
// and a new one has to be added deliberately.

import { RUNTIME_SET_IDS } from '../../typesafe/questions';
import { buildAgentLLMMap } from '../report-service';
import {
  _chargedPurposesByName,
  isPlatformAbsorbedPurpose,
  PLATFORM_ASSISTANT_PURPOSES,
} from '../../cost-attribution/event-classification';

/** Charged purposes that carry an agent id without being named by the
 *  classifier. */
const CHARGED_BY_FALLTHROUGH = [
  'skill_dedup',
  'suggestion_generation',
  'suggestion_response_classification',
  'conversation_recall_query',
  'knowledge_embedding_query',
  'capability_embedding_query',
];

/** Charged, and read by a DIFFERENT provider, so this switch never sees them.
 *  Voice rows are written with `event_type` 'voice_stt' / 'voice_tts';
 *  `getAgentLLMCosts` asks for `llm_invocation` only, and `getAgentVoiceCosts`
 *  renders them on the per-agent "Voice" line. Named here so the exclusion is
 *  a decision with a reason rather than a gap. */
const READ_BY_THE_VOICE_PROVIDER = new Set(['voice_dictation', 'voice_speech']);

/** Charged, and carrying NO agent id, so `getAgentLLMCosts` (which asks for
 *  `agent_id IS NOT NULL`) never returns them and this switch never sees them.
 *  They are the three platform assistants' own model calls; `getAgentlessLLMCosts`
 *  reads them and `buildCostModel` renders each on its assistant's line.
 *
 *  Derived from the classifier's own set rather than listed again here, so a
 *  purpose added there cannot quietly become an exemption. */
const READ_BY_THE_ASSISTANT_PROVIDER = PLATFORM_ASSISTANT_PURPOSES;

function bucketed(purpose: string): { total: number; buckets: Record<string, number> } {
  const { usd } = buildAgentLLMMap([{
    agentId: 'agent-1',
    purpose,
    totalInputTokens: 100,
    totalOutputTokens: 10,
    estimatedCostUsd: 0.25,
    rawModelCostUsd: 0.2,
    ouConsumed: 3,
    failedAttemptsCostUsd: 0,
  }]);
  const buckets = usd['agent-1'] as unknown as Record<string, number>;
  return { total: Object.values(buckets).reduce((a, b) => a + b, 0), buckets };
}

describe('every charged purpose reaches a bucket', () => {
  const named = _chargedPurposesByName()
    .filter((p) => !isPlatformAbsorbedPurpose(p))
    .filter((p) => !READ_BY_THE_VOICE_PROVIDER.has(p))
    .filter((p) => !READ_BY_THE_ASSISTANT_PROVIDER.has(p));

  it('the classifier names some purposes to charge', () => {
    expect(named.length).toBeGreaterThan(5);
  });

  it.each(named)('%s is bucketed, not dropped', (purpose) => {
    expect(bucketed(purpose).total).toBeCloseTo(0.25, 10);
  });

  it.each(CHARGED_BY_FALLTHROUGH)('%s is bucketed, not dropped', (purpose) => {
    expect(bucketed(purpose).total).toBeCloseTo(0.25, 10);
  });

  it('an exempted purpose reaches no NAMED bucket here', () => {
    // Both exemption lists mean "another provider renders this", never "this
    // one does not matter". If one started landing in a named bucket here it
    // would be counted twice — once on the agent line and once on the voice or
    // assistant line — so the exemption has to stay true in both directions.
    //
    // `other` is excluded from the check because everything unmapped lands
    // there now. That is not a weakening: these purposes cannot reach this map
    // at all (getAgentLLMCosts asks for llm_invocation rows with an agent id,
    // and voice rows are voice_stt/voice_tts while assistant rows have no
    // agent), and if one ever did it would show as "Other" — visible and
    // uncategorised — rather than silently merged into a real category.
    for (const purpose of [...READ_BY_THE_VOICE_PROVIDER, ...READ_BY_THE_ASSISTANT_PROVIDER]) {
      const { buckets } = bucketed(purpose);
      const named = Object.entries(buckets)
        .filter(([name]) => name !== 'other')
        .reduce((sum, [, v]) => sum + v, 0);
      expect(named).toBe(0);
    }
  });

  it('a purpose nobody mapped is counted as Other, and still shouts', () => {
    // A default branch that adds the money to NOTHING and logs drops cost
    // silently. A log is the wrong enforcement for money: it fires once, in
    // production, while someone is already reading an understated number.
    //
    // It is counted now and still logged. The log is a cleanup signal; the
    // count is what keeps the page true in the meantime. The test above is
    // what makes sure a CHARGED purpose gets a real bucket rather than living
    // here.
    const { total, buckets } = bucketed('a_purpose_nobody_has_written_yet');
    expect(total).toBeCloseTo(0.25, 10);
    expect(buckets.other).toBeCloseTo(0.25, 10);
  });
});

describe('the buckets each purpose lands in', () => {
  it("a run's own model calls are run work, beside the runtime's invocation figure", () => {
    for (const purpose of ['browser_step', 'browser_task', 'browser_goal_check',
      'contract_check', 'ask_check', 'message_check', 'memory_save', 'memory_used',
      'untrusted_content']) {
      expect(bucketed(purpose).buckets.runWork).toBeCloseTo(0.25, 10);
    }
  });

  // Driven off the runtime's own vocabulary rather than a hand list beside
  // it. The hand list above says what each purpose means and is worth
  // keeping; it cannot say anything about a purpose nobody remembered to add
  // to it, and a purpose with no bucket is spend that reaches no reader.
  // `pane_target` and `work_done_check` both landed while that hole was open.
  it('every set id the runtime can post under has a bucket, not Other', () => {
    for (const setId of RUNTIME_SET_IDS) {
      const { buckets } = bucketed(setId);
      expect({ setId, other: buckets.other }).toEqual({ setId, other: 0 });
    }
  });

  it('a chat exchange is an interaction', () => {
    for (const purpose of ['agent_chat', 'suggestion_generation', 'suggestion_response_classification',
      'chat_learning_classification', 'conversation_recall_query', 'route_message']) {
      expect(bucketed(purpose).buckets.interactions).toBeCloseTo(0.25, 10);
    }
  });

  it('maintaining the skill set is an update', () => {
    expect(bucketed('skill_dedup').buckets.updates).toBeCloseTo(0.25, 10);
  });

  it('what the platform absorbs never reaches the map at all', () => {
    // getAgentLLMCosts filters cost_bucket='platform_overhead' in SQL, so these
    // are named here only to say why they are absent from the switch.
    for (const purpose of ['tool_classification', 'distill_bind', 'route_message_none', 'injection_guard']) {
      expect(isPlatformAbsorbedPurpose(purpose)).toBe(true);
    }
  });
});
