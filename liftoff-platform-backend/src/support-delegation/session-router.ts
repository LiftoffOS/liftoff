// "What session am I in?" for the frontend banner.
//
// The operator's browser holds only an opaque ticket. It needs the target's
// email to label the banner, and it needs to learn whether the ticket is live
// BEFORE it renders a dashboard that would otherwise look like the customer's
// and fail on every request.
//
// Answering from the request rather than from a query: by the time this handler
// runs, supportDelegationMiddleware has already validated the session and put
// the target on req.user. So a 200 here is itself proof the ticket works.
//
// Mounted between the delegation middleware and accessGateMiddleware, the same
// window the notifications and push routers use, so a support session opened on
// a customer who is still behind the access gate can still label itself.

import { Router, type Request, type Response } from 'express';

export const supportDelegationSessionRouter = Router();

supportDelegationSessionRouter.get('/session', (req: Request, res: Response) => {
  if (!req.delegation) {
    // Not an error worth logging. An ordinary tab asking this question is the
    // frontend confirming it is NOT delegating.
    res.status(404).json({ error: 'Not acting on behalf of anyone', code: 'NO_DELEGATION' });
    return;
  }

  res.json({
    sessionId: req.delegation.sessionId,
    // req.user is the TARGET here: the middleware has already swapped it.
    targetEmail: req.user?.email ?? null,
    actorEmail: req.delegation.actorEmail,
  });
});
