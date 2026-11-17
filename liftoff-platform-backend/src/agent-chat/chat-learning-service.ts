// Teaching a team member in conversation (P1.2).
//
// "From now on, lead with the number." / "Here is how we do a QBR — learn
// this." Today those sentences change nothing: the turn answers, the thread
// scrolls, and the next session starts over. This service routes them onto the
// rails that already exist, so a person can teach the way they would teach a
// colleague.
//
// Routing, by what was actually said:
//   technique / procedure → the skill rail (dedup + operator provenance)
//   preference            → memory, tagged so the redistill aggregator can
//                           later consolidate it into permanent instructions
//   durable fact          → memory
//   routine / config      → NOT applied. Changing standing behaviour needs
//                           consent, so it becomes a proposal instead (P1.3).
//
// Cost discipline: the vast majority of turns teach nothing, and this runs on
// every one of them. So a free regex gate runs first and only a turn that trips
// it pays for a classification call.

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';
import { screenPersistedContent } from '../injection-detection/gating';
import type { JSONSchema, LLMToolDefinition } from '../llm/types';
import { redactSensitiveText } from '../common/redact';
import { applyImportedSkills } from '../internal-agents/skill-import-service';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';

/** Memory tags. Identification is by tag rather than by a new layer or column:
 *  the memory store already accepts arbitrary tags, and the redistill
 *  preference aggregator selects on this one. */
/** Marks the out-of-turn row that says what was just learned. Untyped
 *  pass-through on the client, so it renders as an ordinary message. */
export const LEARNING_CONFIRMATION_MESSAGE_TYPE = 'learning_confirmation';

export const PREFERENCE_MEMORY_TAG = 'type:preference';
export const TAUGHT_FACT_MEMORY_TAG = 'type:taught-fact';

/**
 * Free pre-filter. Deliberately generous — a false positive costs one small
 * classification call, a false negative costs the lesson entirely. Anchored on
 * teaching VERBS rather than on any bossy phrasing, so ordinary requests
 * ("remember to send it by five" as a one-off task) still reach the classifier
 * to be judged properly rather than being silently treated as a lesson.
 */
const TEACHING_PHRASES = [
  /\blearn (?:this|that|from|it)\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bin future\b/i,
  /\bin the future\b/i,
  /\balways\b[^.?!]{0,80}\bwhen\b/i,
  /\bnever\b[^.?!]{0,80}\bwhen\b/i,
  /\bremember (?:that|this|to|:)/i,
  /\bkeep in mind\b/i,
  /\bstop (?:doing|saying|using|formatting)\b/i,
  /\bdon'?t\b[^.?!]{0,40}\b(?:again|any ?more)\b/i,
  /\bhere'?s how (?:we|i|you)\b/i,
  /\bthe way we do\b/i,
  /\bour process for\b/i,
  /\bmake sure you\b/i,
  /\bprefer(?:s|red)? (?:that|it|to)\b/i,
  /\bi prefer\b/i,
  /\bwe prefer\b/i,
];

export function looksLikeTeaching(message: string): boolean {
  if (!message || message.length < 8) return false;
  return TEACHING_PHRASES.some((re) => re.test(message));
}

export type LearningKind = 'technique' | 'preference' | 'fact' | 'routine' | 'none';

export interface LearningClassification {
  kind: LearningKind;
  /** For `technique`. */
  skill?: { name: string; description: string; instruction: string };
  /** For `preference` and `fact` — one self-contained sentence. */
  statement?: string;
  /** For `routine` — the schedule in the person's own words, handed to the
   *  proposal flow rather than applied. */
  routineProse?: string;
}

const CLASSIFY_TOOL_NAME = 'classify_lesson';

const ANTI_CAPTURE_RULES = `
Do NOT record any of the following. Each becomes a permanent, self-imposed
constraint that outlives the situation that produced it:
- Environment-dependent failures ("the export failed", "the credential expired").
- Negative capability claims ("that tool does not work").
- Unresolved failures written up as procedure.
- One-off task instructions. "Send this by five today" is a request, not a
  lesson. "Always send the weekly report by five" is a lesson.
When the exchange contains a problem AND its fix, record the fix only.`;

function buildTool(): LLMToolDefinition {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['technique', 'preference', 'fact', 'routine', 'none'],
        description: [
          'technique: a reusable procedure for a class of task.',
          'preference: how this person wants work done or presented.',
          'fact: a durable fact about the person, team, or business.',
          'routine: something that should happen on a schedule from now on.',
          'none: an ordinary request, question, or one-off instruction.',
        ].join(' '),
      },
      skill: {
        type: 'object',
        description: 'Only for kind=technique.',
        properties: {
          name: { type: 'string', description: 'Class-level name. Not a date, not a one-off task.' },
          description: { type: 'string', description: 'One sentence: when this applies. The retrieval anchor.' },
          instruction: { type: 'string', description: 'The procedure, in the person\'s own words where possible.' },
        },
        required: ['name', 'description', 'instruction'],
      },
      statement: {
        type: 'string',
        description: 'Only for kind=preference or kind=fact. One self-contained sentence, written so it still makes sense months later with no surrounding conversation.',
      },
      routineProse: {
        type: 'string',
        description: 'Only for kind=routine. The schedule and the work, in one sentence.',
      },
    },
    required: ['kind'],
  };
  return {
    name: CLASSIFY_TOOL_NAME,
    description: 'Decide whether this exchange taught the team member something durable, and in what form.',
    input_schema: schema,
  };
}

/**
 * Classify one exchange. Returns `{ kind: 'none' }` on any failure — a
 * classifier outage must never surface as a chat error.
 */
export async function classifyLesson(params: {
  tenantId: string;
  agentId: string;
  userMessage: string;
  assistantMessage: string;
}): Promise<LearningClassification> {
  const prompt = `A person is talking to their agent member. Decide whether this exchange taught it something durable.

Most exchanges teach nothing. Answer "none" unless the person is clearly stating how things should be done from now on, or handing over a procedure.
${ANTI_CAPTURE_RULES}

<exchange>
<person>${redactSensitiveText(params.userMessage).slice(0, 6000)}</person>
<team-member>${redactSensitiveText(params.assistantMessage).slice(0, 3000)}</team-member>
</exchange>`;

  try {
    const response = await llmClient.complete(
      {
        messages: [{ role: 'user', content: prompt }],
        tier: 'small',
        maxTokens: 1024,
        temperature: 0,
        tools: [buildTool()],
        toolChoice: { name: CLASSIFY_TOOL_NAME },
      },
      undefined,
      { tenantId: params.tenantId, agentId: params.agentId, purpose: 'chat_learning_classification' },
    );
    const call = response.toolCalls?.find((c) => c.name === CLASSIFY_TOOL_NAME);
    if (!call) return { kind: 'none' };
    return call.input as unknown as LearningClassification;
  } catch (err) {
    log.warn(
      { tenantId: params.tenantId, agentId: params.agentId, error: (err as Error).message },
      'chat-learning: classification failed — treating the turn as ordinary',
    );
    return { kind: 'none' };
  }
}

export interface LearningOutcome {
  kind: LearningKind;
  /** What the team member should say it learned. Empty when nothing was
   *  recorded, in which case the turn says nothing extra. */
  confirmation: string;
  /** For kind=routine: the proposal text to route through the consent flow. */
  routineProse?: string;
}

/**
 * Route a classified lesson to its home. Never throws.
 *
 * Product voice: the confirmation says plainly what was recorded and where it
 * lives, with no contractions and without calling the team member an "agent".
 */
export async function applyLesson(params: {
  tenantId: string;
  agentId: string;
  classification: LearningClassification;
}): Promise<LearningOutcome> {
  const { tenantId, agentId, classification } = params;

  // E2: everything below writes somewhere durable — a skill retrieved on
  // future runs, or a memory recalled into future prompts. Screened once here
  // rather than at each branch, on whichever text is about to be persisted.
  const persistText = classification.skill
    ? `${classification.skill.name}\n${classification.skill.description}\n${classification.skill.instruction}`
    : classification.statement ?? '';
  if (persistText) {
    const screen = await screenPersistedContent(
      classification.kind === 'technique' ? 'skill' : 'memory',
      persistText,
      { tenantId, agentId },
    );
    if (screen.block) {
      log.warn(
        { tenantId, agentId, kind: classification.kind },
        'chat-learning: not recorded — content was flagged by injection screening',
      );
      return { kind: 'none', confirmation: '' };
    }
  }

  try {
    switch (classification.kind) {
      case 'technique': {
        if (!classification.skill) break;
        const result = await applyImportedSkills(tenantId, agentId, [classification.skill]);
        if (result.imported > 0) {
          return {
            kind: 'technique',
            confirmation: `I have saved this as a skill called "${classification.skill.name}". You can review or change it on my settings page.`,
          };
        }
        if (result.skippedAsDuplicate > 0) {
          return {
            kind: 'technique',
            confirmation: 'I already know this one, so I have left my existing skill in place.',
          };
        }
        break;
      }

      case 'preference': {
        if (!classification.statement) break;
        const saved = await tenantRuntimeClient.saveAgentMemory(
          tenantId,
          agentId,
          'individual',
          classification.statement,
          [PREFERENCE_MEMORY_TAG],
        );
        if (!saved.memoryId) break;
        return {
          kind: 'preference',
          confirmation: 'Noted. I will work that way from now on, and you can review it on my settings page.',
        };
      }

      case 'fact': {
        if (!classification.statement) break;
        const saved = await tenantRuntimeClient.saveAgentMemory(
          tenantId,
          agentId,
          'individual',
          classification.statement,
          [TAUGHT_FACT_MEMORY_TAG],
        );
        if (!saved.memoryId) break;
        return {
          kind: 'fact',
          confirmation: 'I have made a note of that.',
        };
      }

      case 'routine':
        // Standing behaviour is never changed without an explicit yes. The
        // proposal flow (P1.3) asks, and only then does it become a routine.
        return {
          kind: 'routine',
          confirmation: '',
          ...(classification.routineProse ? { routineProse: classification.routineProse } : {}),
        };

      case 'none':
      default:
        break;
    }
  } catch (err) {
    log.warn(
      { tenantId, agentId, error: (err as Error).message },
      'chat-learning: apply failed — the turn is unaffected',
    );
  }

  return { kind: 'none', confirmation: '' };
}
