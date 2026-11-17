// Merges two semantically-overlapping skills into one consolidated skill.
// Called only when findNearestSkill returns similarity >= MERGE_THRESHOLD.
// One LLM call per merge event. Caller bounds total merges per (tenantId, taskId).
//
// Purpose 'reflection' routes the call through the 'reflective-services'
// Anthropic API key group (see src/llm/client.ts:21-47 purposeToGroup) so
// merge tokens land in the right billing dashboard segment.

import { llmClient } from '../llm';
import { log } from '../infrastructure/logging';
import type { JSONSchema } from '../llm/types';

export interface SkillContent {
  name: string;
  description: string;
  instruction: string;
  tags: string[];
}

export interface MergedSkillResult {
  name: string;
  description: string;
  instruction: string;
  tags: string[];
}

const MERGE_RESPONSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 120 },
    description: { type: 'string', maxLength: 500 },
    instruction: { type: 'string', maxLength: 2000 },
  },
  required: ['name', 'description', 'instruction'],
};

const MERGE_SYSTEM = `You consolidate two overlapping skills from an AI agent's skill library into one.
You are given two skills that have been judged semantically near-duplicate by a similarity check.
Your job: produce a single replacement skill that fully covers both, without losing any specific edge case or condition from either input.

Rules:
- The merged "instruction" must preserve every distinct caveat, condition, or example from both inputs. If a phrase appears in only one input, it must still appear (or be subsumed by a more general phrasing that demonstrably covers it) in the merged instruction.
- The merged "description" is for retrieval matching — a one-sentence summary, not exposition.
- Match the voice and tone of the inputs. Do not introduce new vocabulary, new tools, or new external references.
- If the two skills genuinely cannot be merged without losing specificity, return the EXISTING skill verbatim. The caller will treat that as a no-op merge.

Output via the emit_merged_skill tool.`;

// Few-shot examples included inline in the user message so the model sees
// concrete examples of good vs. bad consolidation behavior. Drives variance
// down on a production-mutating call.
const FEW_SHOT_EXAMPLES = `Examples of good merges:

EXAMPLE 1
Existing: "Confirm before sending email"
  Description: "Pause for user confirmation before sending any outbound email."
  Instruction: "Before calling send_email, post the draft in chat and wait for the user to say 'send' or equivalent."
New candidate: "Verify recipient before send"
  Description: "Check the recipient email address is correct before sending."
  Instruction: "Re-read the To: address from the draft; if it was inferred from chat context, confirm it explicitly with the user."
Good merge:
  Name: "Confirm draft and recipient before sending email"
  Description: "Pause for user confirmation of both content and recipient before sending any outbound email."
  Instruction: "Before calling send_email: (1) post the draft in chat, (2) explicitly call out the To: address (especially if inferred from chat context), (3) wait for the user to say 'send' or equivalent."

EXAMPLE 2 — bad merge (do NOT do this)
Existing: "Always cite sources when summarizing a document"
New candidate: "Quote the exact passage when asked for specifics"
Bad merge (loses specificity):
  Name: "Be careful with documents"
  Instruction: "When working with documents, be thorough."
Why bad: the merged instruction loses both inputs' actionable conditions. A correct merge would preserve both "cite sources on summary" AND "quote exact passage on specifics."`;

export async function mergeSkills(
  existing: SkillContent,
  candidate: SkillContent,
  attribution: { tenantId: string; agentId: string; agentRole: string },
): Promise<MergedSkillResult | null> {
  const userMsg = `${FEW_SHOT_EXAMPLES}

Agent role: ${attribution.agentRole}

Existing skill:
NAME: ${existing.name}
DESCRIPTION: ${existing.description}
INSTRUCTION: ${existing.instruction}

New candidate:
NAME: ${candidate.name}
DESCRIPTION: ${candidate.description}
INSTRUCTION: ${candidate.instruction}

Emit the merged skill via emit_merged_skill.`;

  let response;
  try {
    response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: MERGE_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        tier: 'large',
        maxTokens: 2048,
        temperature: 0.2,
        responseSchema: {
          name: 'emit_merged_skill',
          description: 'Emit the merged skill that consolidates the two inputs.',
          schema: MERGE_RESPONSE_SCHEMA,
        },
      },
      undefined,
      {
        tenantId: attribution.tenantId,
        agentId: attribution.agentId,
        purpose: 'reflection',
      },
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agentId: attribution.agentId },
      'skill-merge: llm call failed',
    );
    return null;
  }

  const toolCall = response.toolCalls?.[0];
  if (!toolCall || toolCall.name !== 'emit_merged_skill') {
    log.warn(
      { agentId: attribution.agentId },
      'skill-merge: llm did not emit a tool call',
    );
    return null;
  }
  const input = toolCall.input as { name?: unknown; description?: unknown; instruction?: unknown };
  if (
    typeof input.name !== 'string' ||
    typeof input.description !== 'string' ||
    typeof input.instruction !== 'string'
  ) {
    log.warn(
      { agentId: attribution.agentId, input },
      'skill-merge: tool call payload malformed',
    );
    return null;
  }

  // Tag union — never drop a tag that one input carried. Role-wide /
  // individual boundary is enforced upstream by the caller; this just
  // preserves anything else (e.g. connector tags).
  const tags = Array.from(new Set([...existing.tags, ...candidate.tags]));

  return {
    name: input.name,
    description: input.description,
    instruction: input.instruction,
    tags,
  };
}
