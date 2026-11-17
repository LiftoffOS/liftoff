// Bot Framework messaging endpoint for the Liftoff Teams bot.
//
// Mounted at POST /api/agent-chat/teams/messages AFTER the global
// express.json() and BEFORE authMiddleware (Bot Framework auth is the JWT in
// the Authorization header, validated by the CloudAdapter — no Firebase auth,
// no body-HMAC, unlike Slack events).

import { Router, type Request, type Response } from 'express';
import { getTeamsAdapter } from './teams-bot-adapter';
import { liftoffTeamsBot } from './teams-bot-handler';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const adapter = getTeamsAdapter();
  await adapter.process(req, res, (ctx) => liftoffTeamsBot.run(ctx));
});

export { router as teamsMessagesRouter };
