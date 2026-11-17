import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { log } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members/service';
import { TenantMemberRole, ROLE_HIERARCHY } from '../tenant-members/types';

export const memoriesRouter = Router();

// Local copy of requireMinRole — the function in internal-agents/router.ts is
// not exported. The logic is identical: verify the caller belongs to the tenant
// with at least the specified role before forwarding the request.
const accountService = new AccountService();

function requireMinRole(minRole: TenantMemberRole): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = (req.query.tenantId as string) || req.params.tenantId || req.body.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'Missing tenant context' });

    const firebaseUid = req.ctx?.userId;
    if (!firebaseUid) return res.status(401).json({ error: 'Authentication required' });

    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account) return res.status(401).json({ error: 'Account not found' });

    const membership = await tenantMembersService.getMembership(tenantId, account.id);
    if (!membership) return res.status(403).json({ error: 'Access denied to tenant resources' });

    if (ROLE_HIERARCHY[membership.role] < ROLE_HIERARCHY[minRole]) {
      return res.status(403).json({ error: `Requires at least ${minRole} role` });
    }

    next();
  };
}

// GET /api/memories
// List memories by layer. Required query param: tenantId.
// Optional: layer (global|role|individual), scopeKey, limit, cursor.
memoriesRouter.get('/', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const layer = req.query.layer as 'global' | 'role' | 'individual' | undefined;
    const scopeKey = req.query.scopeKey as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const cursor = req.query.cursor as string | undefined;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const result = await tenantRuntimeClient.listMemoriesByLayer(tenantId, { layer, scopeKey, limit, cursor });
    res.json(result);
  } catch (error) {
    log.error({ error }, 'Failed to list memories');
    res.status(502).json({ error: 'Could not load memories. Please try again.' });
  }
});

// GET /api/memories/:memoryId
memoriesRouter.get('/:memoryId', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const { memoryId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const memory = await tenantRuntimeClient.getMemoryById(tenantId, memoryId);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    res.json(memory);
  } catch (error) {
    log.error({ error, memoryId: req.params.memoryId }, 'Failed to get memory');
    res.status(502).json({ error: 'Could not load that memory. Please try again.' });
  }
});

// GET /api/memories/:memoryId/provenance
memoriesRouter.get('/:memoryId/provenance', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const { memoryId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const parsed = z.object({
      depth: z.coerce.number().int().min(1).max(20).default(10),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

    const chain = await tenantRuntimeClient.getMemoryProvenance(tenantId, memoryId, parsed.data.depth);
    res.json(chain);
  } catch (error) {
    const msg = (error as Error).message ?? '';
    if (msg.includes('HTTP 404')) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    log.error({ error, memoryId: req.params.memoryId }, 'Failed to get memory provenance');
    res.status(502).json({ error: 'Could not load where this memory came from. Please try again.' });
  }
});

// DELETE /api/memories/:memoryId
memoriesRouter.delete('/:memoryId', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const { memoryId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    await tenantRuntimeClient.deleteMemoryById(tenantId, memoryId);
    res.status(204).send();
  } catch (error) {
    const msg = (error as Error).message ?? '';
    if (msg.includes('HTTP 404')) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    log.error({ error, memoryId: req.params.memoryId }, 'Failed to delete memory');
    res.status(502).json({ error: 'Could not delete that memory. Please try again.' });
  }
});

// PATCH /api/memories/:memoryId
memoriesRouter.patch('/:memoryId', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const { memoryId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const parsed = z.object({ content: z.string().min(1).max(100000) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'content is required and must be a non-empty string' });
    }

    const updated = await tenantRuntimeClient.updateMemoryById(tenantId, memoryId, parsed.data.content);
    res.json(updated);
  } catch (error) {
    const msg = (error as Error).message ?? '';
    if (msg.includes('HTTP 404')) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    log.error({ error, memoryId: req.params.memoryId }, 'Failed to update memory');
    res.status(502).json({ error: 'Could not update that memory. Please try again.' });
  }
});
