import { Router } from 'express';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { getWorkforce } from './service';

export const workforceRouter = Router();

workforceRouter.get(
  '/',
  tenantAuthMiddleware('viewDashboard'),
  async (req, res, next) => {
    try {
      const tenantId = req.query.tenantId as string;
      // Set by tenantAuthMiddleware; developer-proxy's service-call auth
      // requires the acting user's id in x-user-id.
      const actorAccountId = (req as unknown as { actorAccountId?: string }).actorAccountId;
      res.json(await getWorkforce(tenantId, actorAccountId));
    } catch (err) {
      next(err);
    }
  },
);
