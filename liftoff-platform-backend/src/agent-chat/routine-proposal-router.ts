// POST /api/internal/agent-chat/routine-proposal
//
// The runtime's propose_routine tool lands here. A person asked their team
// member, in whatever words, for standing behaviour ("can you just do this
// every Monday?"), the turn model recognised the intent with the whole thread
// in view, and this route records the proposal on the consent rail — the same
// agent_suggestions row the teaching path and the proactive triggers write,
// answered by the same reply interception, folded into guidance and
// redistilled by the same accept path.
//
// Nothing is posted to the thread. The model asks for confirmation in its own
// reply, which is why registerRoutineProposal stamps the row as offered here
// instead of delivering a second copy of the question in a second voice.
//
// The refusals matter as much as the success: the one-open-proposal budget and
// the dedup latch still hold, and the model is told which one declined so it
// can say something true. A tool that cannot register must never let the model
// imply a schedule was set (INV-PB-004 is about exactly this shape).
//
// Auth: X-Service-Auth === PLATFORM_CALLBACK_TOKEN, the same TR->PB shared
// secret settle-turn and the escalation-thread route validate.

import { Router, type Request, type Response, json as expressJson } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { internalAgentService } from '../internal-agents/service';
import * as chatRepo from './chat-repository';
import { registerRoutineProposal } from './suggestion-flow';

export const routineProposalRouter = Router();
routineProposalRouter.use(expressJson({ limit: '64kb' }));

const routineProposalSchema = z.object({
  tenantId: z.string().uuid(),
  /** CONTROL-PLANE internal_agents.id. The runtime resolves it through
   *  internal_agent_runtime_mapping before calling (INV-TR-010); its own
   *  agents.id addresses nothing here and would register against no team. */
  internalAgentId: z.string().uuid(),
  /** The chat thread the ask happened in. Ours by construction: the tool
   *  refuses turns without a platform thread, and the reply interception
   *  admits an answer only from this thread. */
  threadId: z.string().uuid(),
  /** The schedule and the work in one sentence, in the person's terms. The
   *  cap matches what the distiller can usefully absorb as one guidance line.
   *  A stop composes its own prose from the resolved target. */
  routineProse: z.string().min(1).max(2000).optional(),
  /** What the proposal does (migration 429). Absent means start, so the
   *  runtime tool that predates this field keeps working unchanged. */
  action: z.enum(['start', 'change', 'stop']).default('start'),
  /** The routine as the person named it; required for change and stop. */
  target: z.string().min(1).max(300).optional(),
}).superRefine((value, ctx) => {
  if (value.action !== 'stop' && !value.routineProse) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['routineProse'],
      message: 'routineProse is required unless action is stop',
    });
  }
  if (value.action !== 'start' && !value.target) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'target is required for change and stop',
    });
  }
});

routineProposalRouter.post('/routine-proposal', async (req: Request, res: Response) => {
  if (!process.env.PLATFORM_CALLBACK_TOKEN
    || req.headers['x-service-auth'] !== process.env.PLATFORM_CALLBACK_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parsed = routineProposalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const { tenantId, internalAgentId, threadId, routineProse, action, target } = parsed.data;

  try {
    // An inactive team member has been deliberately taken out of service; a
    // routine proposed onto it would sit unanswerable. Wrong-space ids land
    // here too: they match zero rows, by design, with no error.
    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent || agent.status !== 'active') {
      return res.status(404).json({ error: 'No active team member matches that id in this tenant.' });
    }

    // The thread must be one of this tenant's AND one this team member is a
    // participant of: every creation path writes the participant row (it is
    // what makes a thread list under the team at all), and the stamp on the
    // suggestion row is what the reply interception later matches against.
    // One sentence for both misses, so a wrong pairing reads like an unknown
    // thread. getParticipants is called only after getThread has verified the
    // tenant, per that repository's own visibility rule.
    const thread = await chatRepo.getThread(threadId, tenantId);
    const participants = thread ? await chatRepo.getParticipants(thread.id) : [];
    if (!thread || !participants.some((p) => p.agentId === internalAgentId)) {
      return res.status(404).json({ error: 'No such conversation for this team member in this tenant.' });
    }

    const outcome = await registerRoutineProposal({
      tenantId,
      agentId: internalAgentId,
      threadId,
      routineProse,
      action,
      target,
    });
    return res.json(outcome);
  } catch (err) {
    log.error(
      { tenantId, internalAgentId, threadId, error: (err as Error).message },
      'routine-proposal route failed',
    );
    return res.status(500).json({ error: 'Could not register the proposal' });
  }
});
