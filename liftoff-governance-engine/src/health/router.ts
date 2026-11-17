// Standalone health router. The primary /health endpoint is mounted in
// server.ts before verifyServiceAuth (so Cloud Run probes don't need the
// service token). This router is exported for any consumer that wants to
// embed just the health route in an alternate Express app (e.g. local
// dev harnesses, contract-test setups).

import { Router } from 'express';

export const healthRouter: Router = Router();

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default healthRouter;
