// POST /api/internal/agent-chat/colleague-request
//
// The runtime's bring_in_colleague tool lands here. A team asked for one of
// the three platform assistants: the Chief AI Officer for a change to what the
// team IS, the Insights Manager for what the workspace's records hold, Liftoff
// for a question outside the team's role (colleague-request.ts).
//
// Three paths, one rule. A change is the Chief AI Officer's, whoever asks: it
// becomes a design proposal the person answers in the chat. A question to the
// other two is answered: out of turn into the chat when there is one, inline
// (the reply is this route's response) when the team is running unattended
// and there is no chat and no person. An unattended run cannot ask the Chief
// AI Officer, because nobody is there to say yes.
//
// Nothing is posted to the thread here. The team's own reply says what will
// happen, and the worker posts the colleague's words.
//
// Auth: X-Service-Auth === PLATFORM_CALLBACK_TOKEN, the same TR->PB shared
// secret the routine-proposal route validates.

import { Router, type Request, type Response, json as expressJson } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { internalAgentService } from '../internal-agents/service';
import * as chatRepo from './chat-repository';
import { registerColleagueQuestion, registerDesignChange } from './colleague-request';
import { answerInline } from './colleague-worker';

export const colleagueRequestRouter = Router();
colleagueRequestRouter.use(expressJson({ limit: '64kb' }));

const requestSchema = z.object({
  tenantId: z.string().uuid(),
  /** CONTROL-PLANE internal_agents.id, resolved by the runtime before calling. */
  internalAgentId: z.string().uuid(),
  /** The chat thread the ask happened in. Required for the Chief AI Officer;
   *  absent for a question asked from an unattended run. */
  threadId: z.string().uuid().optional(),
  colleague: z.enum(['liftoff', 'caio', 'insights']),
  /** The change or the question, in the person's terms. */
  request: z.string().min(1).max(2000),
  /** What a change touches, as the team understood it; wording only. */
  area: z.string().min(1).max(100).optional(),
});

colleagueRequestRouter.post('/colleague-request', async (req: Request, res: Response) => {
  if (!process.env.PLATFORM_CALLBACK_TOKEN
    || req.headers['x-service-auth'] !== process.env.PLATFORM_CALLBACK_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const { tenantId, internalAgentId, threadId, colleague, request, area } = parsed.data;

  try {
    // An inactive team member has been deliberately taken out of service;
    // wrong-space ids land here too, matching zero rows with no error.
    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent || agent.status !== 'active') {
      return res.status(404).json({ error: 'No active team member matches that id in this tenant.' });
    }

    if (threadId) {
      // The thread must be one of this tenant's AND one this team member sits
      // in, or the colleague's words land in a chat that never asked.
      const thread = await chatRepo.getThread(threadId, tenantId);
      const participants = thread ? await chatRepo.getParticipants(thread.id) : [];
      if (!thread || !participants.some((p) => p.agentId === internalAgentId)) {
        return res.status(404).json({ error: 'No such conversation for this team member in this tenant.' });
      }
      const outcome = colleague === 'caio'
        ? await registerDesignChange({ tenantId, agentId: internalAgentId, threadId, change: request, ...(area ? { area } : {}) })
        : await registerColleagueQuestion({ tenantId, agentId: internalAgentId, threadId, colleague, request });
      return res.json(outcome);
    }

    if (colleague === 'caio') {
      // Nobody is present to say yes, and the Chief AI Officer applies nothing
      // without one.
      return res.json({ registered: false, reason: 'needs_the_person' });
    }
    const answer = await answerInline({ tenantId, agentId: internalAgentId, colleague, request });
    return res.json(answer);
  } catch (err) {
    log.error(
      { tenantId, internalAgentId, threadId: threadId ?? null, colleague, error: (err as Error).message },
      'colleague-request route failed',
    );
    return res.status(500).json({ error: 'Could not bring the colleague in' });
  }
});
