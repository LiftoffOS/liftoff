// Platform-backend adapter for the shared thread-title-generation module.
//
// The core logic (prompt, truncation, JSON parsing, sanitization) lives in
// @liftoffos/service-runtime so it can be shared across services. This file
// injects llmClient.complete() as the LLM call and re-exports the public
// types callers depend on — they require no import changes.

import { maybeGenerateThreadTitle as sharedMaybeGenerateThreadTitle } from '@liftoffos/service-runtime';
import { redactSensitiveText } from '../common/redact';
import type { UpdateTitleFn } from '@liftoffos/service-runtime';
import { llmClient } from '../llm';
import type { JSONSchema } from '../llm/types';
import { log } from '../infrastructure/logging';

export type { UpdateTitleFn };

export interface TitleGenerationInput {
  threadId: string;
  tenantId: string;
  /** When set, the LLM cost is attributed to this agent's interactions bucket
   *  on /insights. Pass only from agent-chat; leave undefined for insights
   *  and CAIO (those costs belong in platformLLMOperations / workforcePlanning). */
  agentId?: string;
  /** Override the LLM usage purpose tag. CAIO passes
   *  'caio_workforce_planning_title_generation' so the cost routes to the
   *  Workforce Planning bucket. Defaults to 'thread_title_generation'. */
  purpose?: string;
  userMessage: string;
  assistantMessage: string;
  updateTitle: UpdateTitleFn;
}

const TITLE_MAX_TOKENS = 80;

const TITLE_JSON_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
  },
  required: ['title'],
};

export async function maybeGenerateThreadTitle(
  input: TitleGenerationInput,
): Promise<void> {
  return sharedMaybeGenerateThreadTitle({
    threadId: input.threadId,
    tenantId: input.tenantId,
    // E4: a generated title is stored and shown in every thread list, so a
    // credential pasted into the first message must not survive into it.
    userMessage: redactSensitiveText(input.userMessage),
    assistantMessage: redactSensitiveText(input.assistantMessage),
    updateTitle: input.updateTitle,
    llmComplete: async (systemPrompt, userContent) => {
      try {
        const response = await llmClient.complete(
          {
            messages: [
              // Constant across every thread on every surface: the shared
              // module hands back one literal, and the turn's own text is the
              // only part that changes. Marked so the prefix is cacheable, and
              // so it starts being cached if this prompt ever grows past the
              // vendor floor — at roughly 200 tokens on the small tier it is
              // well under it today. See LLMMessage.cacheControl.
              { role: 'system', content: systemPrompt, cacheControl: { type: 'ephemeral' } },
              { role: 'user', content: userContent },
            ],
            responseSchema: {
              name: 'thread_title',
              schema: TITLE_JSON_SCHEMA,
            },
            tier: 'small',
            maxTokens: TITLE_MAX_TOKENS,
          },
          undefined,
          {
            tenantId: input.tenantId,
            purpose: input.purpose ?? 'thread_title_generation',
            ...(input.agentId ? { agentId: input.agentId } : {}),
            threadId: input.threadId,
          },
        );
        return response.content;
      } catch (err) {
        log.warn(
          {
            threadId: input.threadId,
            tenantId: input.tenantId,
            agentId: input.agentId,
            error: (err as Error).message,
          },
          'Thread title generation failed — keeping placeholder',
        );
        throw err;
      }
    },
  });
}
