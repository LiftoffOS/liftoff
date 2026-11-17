// Adapter over the shared thread-title generator in @liftoffos/service-runtime —
// the same one platform-backend's agent chat uses (src/shared/thread-title-generation.ts).
//
// This service used to carry its own copy of the prompt, the JSON parsing and
// the sanitization. That fork is why every plan thread read "Untitled Chat":
// the copy asked for prose and parsed it, and on a real exchange the model
// fences its JSON. The shared core is unchanged here; all this supplies is the
// LLM call, the persistence, and redaction of what goes in.
//
// It lives in its own module rather than inside chat-service so that the
// backfill over already-written threads runs *this* code and not a second
// arrangement of it. A one-shot script that titles rows a different way than
// live turns do is how the two drift apart.

import { maybeGenerateThreadTitle as sharedMaybeGenerateThreadTitle } from '@liftoffos/service-runtime';
import { redactSensitiveText } from '@liftoffos/redact';
import { log } from '../infrastructure/logging.js';
import { workforceLLMClient } from '../llm/workforce-llm-client.js';

export interface GenerateThreadTitleParams {
  threadId: string;
  tenantId: string;
  userMessage: string;
  assistantMessage: string;
  purpose: string;
  updateTitle: (threadId: string, tenantId: string, title: string) => Promise<void>;
}

export async function maybeGenerateThreadTitle(
  params: GenerateThreadTitleParams,
): Promise<void> {
  return sharedMaybeGenerateThreadTitle({
    threadId: params.threadId,
    tenantId: params.tenantId,
    // A generated title is stored and shown in every thread list, so a
    // credential pasted into a first message must not survive into it (E4).
    userMessage: redactSensitiveText(params.userMessage),
    assistantMessage: redactSensitiveText(params.assistantMessage),
    updateTitle: params.updateTitle,
    llmComplete: async (systemPrompt, userContent) => {
      try {
        return await workforceLLMClient.complete({
          systemPrompt,
          userContent,
          tier: 'small',
          maxTokens: 80,
          purpose: params.purpose,
          tenantId: params.tenantId,
          // Structured output, not prose. Without it the model fences its JSON
          // on a real conversation and the shared core's JSON.parse throws.
          responseSchema: {
            name: 'thread_title',
            schema: {
              type: 'object',
              properties: { title: { type: 'string' } },
              required: ['title'],
            },
          },
        });
      } catch (err) {
        log.warn(
          { threadId: params.threadId, error: (err as Error).message },
          'CAIO: thread title generation failed - leaving the thread untitled',
        );
        throw err;
      }
    },
  });
}
