// Tenant Members Router
// API endpoints per Section 1.4

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  tenantMembersService,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
} from './service';
import { AccountService } from '../accounts/service';
import { logAudit } from '../infrastructure/logging';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { TenantMemberRole } from './types';

export const tenantMembersRouter = Router();
const accountService = new AccountService();

// [BE-011] Input validation schemas
const inviteSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(['admin', 'member', 'viewer']),
});

const updateRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

// [BE-008] Rate limiting per plan using express-rate-limit
// Rate limit invite endpoint: 10/hour per tenant
const inviteRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => `invite:${req.params.tenantId}`,
  message: { error: 'Too many invitations. Try again later.' },
});

// Rate limit token lookup: 10/min per IP [BE-003+SE-003]
const tokenLookupLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many requests' },
});

// Helper to get account ID from Firebase UID
async function getAccountId(req: Request): Promise<string | null> {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) return null;

  const account = await accountService.getByFirebaseUid(firebaseUid);
  return account?.id || null;
}

// Error handler helper
function handleServiceError(error: unknown, res: Response): void {
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
  } else if (error instanceof ConflictError) {
    res.status(409).json({ error: error.message });
  } else if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
  } else {
    // Log unexpected errors for debugging
    const err = error as Error;
    console.error('[tenant-members] Unexpected error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
}

// GET /tenant-members/my-memberships
// Get all tenants the current user is a member of
// Returns TenantWithRole[] matching frontend interface
tenantMembersRouter.get('/my-memberships', async (req: Request, res: Response) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const memberships = await tenantMembersService.getMyMemberships(accountId);

    // Transform to TenantWithRole[] format expected by frontend
    const tenantsWithRole = memberships.map((m) => ({
      // Spread tenant fields
      id: m.tenant.id,
      accountId: m.tenant.accountId,
      name: m.tenant.name,
      status: m.tenant.status,
      gcpProjectId: m.tenant.gcpProjectId,
      databaseName: m.tenant.databaseName,
      migrationStatus: m.tenant.migrationStatus,
      hasCreatedInternalAgent: m.tenant.hasCreatedInternalAgent,
      onboardingStep: m.tenant.onboardingStep,
      onboardingPersona: m.tenant.onboardingPersona,
      onboardingCompletedAt: m.tenant.onboardingCompletedAt,
      createdAt: m.tenant.createdAt,
      updatedAt: m.tenant.updatedAt,
      // Add role
      role: m.role,
    }));

    // Return array directly (not wrapped in { tenants: [...] })
    res.json(tenantsWithRole);
  } catch (error) {
    handleServiceError(error, res);
  }
});

// GET /tenant-members/invitations/:token
// [BE-003+SE-003] Get invitation by token (auth required, rate limited)
tenantMembersRouter.get(
  '/invitations/:token',
  tokenLookupLimiter,
  async (req: Request, res: Response) => {
    try {
      const { token } = req.params;

      const invitation = await tenantMembersService.getInvitationByToken(token);

      if (!invitation) {
        return res.status(404).json({ error: 'Invitation not found' });
      }

      // Return safe subset of invitation data
      res.json({
        id: invitation.id,
        tenantId: invitation.tenantId,
        tenantName: invitation.tenantName,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        invitedBy: invitation.invitedByAccount,
        expiresAt: invitation.expiresAt,
      });
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// POST /tenant-members/accept-invite
// [SE-005] Accept invitation (email verified)
tenantMembersRouter.post('/accept-invite', async (req: Request, res: Response) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    const result = await tenantMembersService.acceptInvitation(token, accountId);

    logAudit('tenant_member.invitation_accepted', req.ctx, {
      memberId: result.member.id,
      tenantId: result.tenantId,
    });

    res.json({
      member: result.member,
      tenantId: result.tenantId,
    });
  } catch (error) {
    handleServiceError(error, res);
  }
});

// GET /tenant-members/:tenantId
// [BE-006] List members (paginated)
tenantMembersRouter.get(
  '/:tenantId',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const { tenantId } = req.params;
    try {
      const cursor = req.query.cursor as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      console.log('[tenant-members] listMembers called', { tenantId, cursor, limit });
      const result = await tenantMembersService.listMembers(tenantId, { cursor, limit });
      console.log('[tenant-members] listMembers result', { membersCount: result.members.length });
      res.json(result);
    } catch (error) {
      console.error('[tenant-members] listMembers error', { tenantId, error: (error as Error).message, stack: (error as Error).stack });
      handleServiceError(error, res);
    }
  }
);

// GET /tenant-members/:tenantId/invitations
// List invitations (admin/owner only)
tenantMembersRouter.get(
  '/:tenantId/invitations',
  tenantAuthMiddleware('inviteMembers'),
  async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const cursor = req.query.cursor as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const result = await tenantMembersService.listInvitations(tenantId, { cursor, limit });
      res.json(result);
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// POST /tenant-members/:tenantId/invite
// [BE-008] Invite member (rate limited)
tenantMembersRouter.post(
  '/:tenantId/invite',
  inviteRateLimiter,
  tenantAuthMiddleware('inviteMembers'),
  async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const actorAccountId = (req as any).actorAccountId;

      // Validate input [BE-011]
      const parseResult = inviteSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const { invitation, inviteUrl, emailSent } = await tenantMembersService.inviteMember(
        tenantId,
        parseResult.data,
        actorAccountId
      );

      logAudit('tenant_member.invited', req.ctx, {
        invitationId: invitation.id,
        email: invitation.email,
        role: invitation.role,
        tenantId,
      });

      // The link comes back with the invitation. It used to be withheld
      // because the email was the only delivery path; with no mail provider
      // configured that made the invitation undeliverable and invisible. The
      // caller holds `inviteMembers` on this tenant, so the link is theirs to
      // pass on. `emailSent` tells the UI whether to show it.
      res.status(201).json({
        inviteUrl,
        emailSent,
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
      });
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// DELETE /tenant-members/:tenantId/invitations/:invitationId
// Revoke invitation
tenantMembersRouter.delete(
  '/:tenantId/invitations/:invitationId',
  tenantAuthMiddleware('inviteMembers'),
  async (req: Request, res: Response) => {
    try {
      const { tenantId, invitationId } = req.params;
      const actorAccountId = (req as any).actorAccountId;

      await tenantMembersService.revokeInvitation(tenantId, invitationId, actorAccountId);

      logAudit('tenant_member.invitation_revoked', req.ctx, {
        invitationId,
        tenantId,
      });

      res.status(204).send();
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// PATCH /tenant-members/:tenantId/invitations/:invitationId/role
// Update pending invitation role
tenantMembersRouter.patch(
  '/:tenantId/invitations/:invitationId/role',
  tenantAuthMiddleware('inviteMembers'),
  async (req: Request, res: Response) => {
    try {
      const { tenantId, invitationId } = req.params;
      const actorAccountId = (req as any).actorAccountId;

      const parseResult = inviteSchema.pick({ role: true }).safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const invitation = await tenantMembersService.updateInvitationRole(
        tenantId,
        invitationId,
        parseResult.data.role as TenantMemberRole,
        actorAccountId
      );

      logAudit('tenant_member.invitation_role_updated', req.ctx, {
        invitationId,
        tenantId,
        newRole: parseResult.data.role,
      });

      res.json(invitation);
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// PATCH /tenant-members/:tenantId/members/:accountId/role
// [SE-001] Update member role (owner only for owner modifications)
tenantMembersRouter.patch(
  '/:tenantId/members/:accountId/role',
  tenantAuthMiddleware('changeRole'),
  async (req: Request, res: Response) => {
    try {
      const { tenantId, accountId } = req.params;
      const actorAccountId = (req as any).actorAccountId;

      // Validate input
      const parseResult = updateRoleSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      // Get the member to update
      const membership = await tenantMembersService.getMembership(tenantId, accountId);
      if (!membership) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const member = await tenantMembersService.updateMemberRole(
        tenantId,
        membership.id,
        parseResult.data.role as TenantMemberRole,
        actorAccountId
      );

      logAudit('tenant_member.role_changed', req.ctx, {
        memberId: member.id,
        accountId,
        newRole: member.role,
        tenantId,
      });

      res.json(member);
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// DELETE /tenant-members/:tenantId/members/:accountId
// [SE-004] Remove member (IDOR protected)
tenantMembersRouter.delete(
  '/:tenantId/members/:accountId',
  tenantAuthMiddleware('removeMember'),
  async (req: Request, res: Response) => {
    try {
      const { tenantId, accountId } = req.params;
      const actorAccountId = (req as any).actorAccountId;

      // Allow self-removal for any member
      const isSelfRemoval = accountId === actorAccountId;
      if (!isSelfRemoval) {
        // Check if actor has permission to remove others
        const actorMembership = (req as any).membership;
        if (!tenantMembersService.hasPermission(actorMembership.role, 'removeMember')) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
      }

      // Get the member to remove
      const membership = await tenantMembersService.getMembership(tenantId, accountId);
      if (!membership) {
        return res.status(404).json({ error: 'Member not found' });
      }

      await tenantMembersService.removeMember(tenantId, membership.id, actorAccountId);

      logAudit('tenant_member.removed', req.ctx, {
        accountId,
        tenantId,
        selfRemoval: isSelfRemoval,
      });

      res.status(204).send();
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// [SE-007] Ownership Transfer with Confirmation (two-step process)

// POST /tenant-members/:tenantId/transfer-ownership/initiate
// Step 1: Initiate transfer (creates pending transfer, sends email to current owner for confirmation)
tenantMembersRouter.post(
  '/:tenantId/transfer-ownership/initiate',
  tenantAuthMiddleware('transferOwnership'),
  async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const actorAccountId = (req as any).actorAccountId;

      const { newOwnerId } = req.body;
      if (!newOwnerId || typeof newOwnerId !== 'string') {
        return res.status(400).json({ error: 'newOwnerId is required' });
      }

      const pendingTransfer = await tenantMembersService.initiateOwnershipTransfer(
        tenantId,
        newOwnerId,
        actorAccountId
      );

      logAudit('tenant_member.ownership_transfer_initiated', req.ctx, {
        tenantId,
        currentOwnerId: actorAccountId,
        newOwnerId,
        transferId: pendingTransfer.id,
      });

      res.status(201).json({
        message: 'Ownership transfer initiated. Check your email to confirm.',
        transferId: pendingTransfer.id,
        expiresAt: pendingTransfer.expiresAt,
      });
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);

// POST /tenant-members/:tenantId/transfer-ownership/confirm
// Step 2: Confirm transfer (from email link)
tenantMembersRouter.post(
  '/:tenantId/transfer-ownership/confirm',
  async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      const accountId = await getAccountId(req);

      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { confirmationToken } = req.body;
      if (!confirmationToken || typeof confirmationToken !== 'string') {
        return res.status(400).json({ error: 'confirmationToken is required' });
      }

      const result = await tenantMembersService.confirmOwnershipTransfer(
        tenantId,
        confirmationToken,
        accountId
      );

      logAudit('tenant_member.ownership_transferred', req.ctx, {
        tenantId,
        previousOwnerId: result.previousOwnerId,
        newOwnerId: result.newOwner.accountId,
      });

      res.json({
        message: 'Ownership transferred successfully',
        newOwner: result.newOwner,
      });
    } catch (error) {
      handleServiceError(error, res);
    }
  }
);
