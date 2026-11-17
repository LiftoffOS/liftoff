// Rolling conversation summaries for other services.
//
// This exists so the Chief AI Officer chat, which runs in workforce-service, can
// use the summarizer the insights chat and the agent team-chat already share
// (src/insights/conversation-summarization.ts) instead of carrying its own. It
// carried a stub that never called a model and wrote "Conversation with N
// messages (summary placeholder)" into the thread, so every long planning
// conversation lost its early context to a sentence counting the messages.
//
// The module is pure — an LLM call, redaction, and a logger, with no database
// access — so serving it over HTTP costs nothing but a hop and leaves exactly
// one implementation. Nothing in it is modified or duplicated here.
//
// Both halves of the decision live here on purpose: the caller sends the thread
// and gets back whether it was summarized, the structured summary, and the
// prompt text. That keeps the threshold rules and the prompt formatting single
// -sourced too, so workforce-service holds no copy of any part of this.
//
// Redaction runs inside generateRollingSummary, so a caller cannot forget it —
// which is precisely how the title path ended up unredacted.
//
// Auth: WORKFORCE_SERVICE_TOKEN. Mounted BEFORE authMiddleware in index.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  formatSummaryForPrompt,
  generateRollingSummary,
  shouldSummarize,
  type ConversationSummary,
} from '../insights/conversation-summarization';
import { log } from '../infrastructure/logging';
import { workforceServiceAuth } from './workforce-service-auth';

export const chatSummarizationInternalRouter = Router();

const summarySchema = z.object({
  userIntent: z.string(),
  keyFacts: z.array(z.string()),
  openQuestions: z.array(z.string()),
  previousFindings: z.array(z.string()),
  nextSteps: z.array(z.string()),
  summarizedThrough: z.string(),
  messageCount: z.number(),
});

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  /** Oldest first, as generateRollingSummary expects. */
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant']),
        content: z.string(),
        createdAt: z.string(),
      }),
    )
    .max(500),
  previousSummary: summarySchema.nullable().optional(),
  /** Cost-attribution bucket. The CAIO passes
   *  'caio_workforce_planning_summarization' so its summaries land in Workforce
   *  Planning rather than Platform Analytics. */
  purpose: z.string().max(120).optional(),
});

// POST /
// Returns: { summarized, summary, promptText }
chatSummarizationInternalRouter.post(
  '/',
  workforceServiceAuth,
  async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }

    const { tenantId, threadId, messages, previousSummary, purpose } = parsed.data;
    const input = {
      threadId,
      tenantId,
      allMessages: messages,
      previousSummary: (previousSummary ?? null) as ConversationSummary | null,
      ...(purpose ? { purpose } : {}),
    };

    try {
      if (!shouldSummarize(input)) {
        return res.json({ summarized: false, summary: null, promptText: null });
      }

      const summary = await generateRollingSummary(input);
      if (!summary) {
        return res.json({ summarized: false, summary: null, promptText: null });
      }

      return res.json({
        summarized: true,
        summary,
        promptText: formatSummaryForPrompt(summary),
      });
    } catch (err) {
      // generateRollingSummary already falls back to the previous summary on an
      // LLM failure, so reaching here means something structural. The caller
      // treats a non-200 as "keep the summary you have" and carries on; a
      // summary is never worth failing somebody's chat turn over.
      log.error(
        { threadId, tenantId, error: (err as Error).message },
        'internal chat summarization failed',
      );
      return res.status(500).json({ error: 'Summarization failed' });
    }
  },
);
