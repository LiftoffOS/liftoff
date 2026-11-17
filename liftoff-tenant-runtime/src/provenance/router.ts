import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireServiceAuth } from '../security/service-auth';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import * as provenanceService from '../memory/provenance-service';

export const provenanceRouter = Router();

provenanceRouter.use(requireServiceAuth());

provenanceRouter.delete('/connector/:connectorId', async (req: Request, res: Response) => {
  try {
    const parsed = z.object({
      tenantId: z.string().uuid(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

    const memoryIds = await provenanceService.findMemoriesByConnector(
      parsed.data.tenantId,
      req.params.connectorId,
    );

    if (memoryIds.length > 0) {
      await pool.query(
        `DELETE FROM memories WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [parsed.data.tenantId, memoryIds],
      );
    }

    res.json({ deleted: memoryIds.length });
  } catch (error) {
    log.error({ error, connectorId: req.params.connectorId }, 'provenance: connector erasure failed');
    res.status(500).json({ error: (error as Error).message });
  }
});
