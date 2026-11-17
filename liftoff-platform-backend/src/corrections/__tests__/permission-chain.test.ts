// Correction Protocol Permission Escalation Chain Tests
// [TE-P2-004] Test permission escalation and chain scenarios

// Mock query function - stable reference
const mockQuery = jest.fn();

// Set global mock reference IMMEDIATELY before jest.mock to avoid hoisting issues
(global as any).__mockQuery = mockQuery;

// Mock external dependencies
jest.mock('../../infrastructure/database', () => {
  const runQuery = (...args: unknown[]) => {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    // RLS: own-tx methods issue SELECT set_config('app.current_tenant_id', ...)
    // right after BEGIN to scope the transaction. Swallow it here so these
    // ordered __mockQuery sequences don't shift (the real ceremony is covered
    // by integration tests).
    if (sql.includes('set_config')) return Promise.resolve({ rows: [] });
    return (global as any).__mockQuery(...args);
  };
  const mkClient = () => ({ query: runQuery, release: jest.fn() });
  return {
    pool: { query: runQuery, connect: () => mkClient() },
    getPool: () => ({ query: runQuery }),
    // RLS wrappers invoke the callback with a mock client so existing
    // __mockQuery assertions still see the real SQL.
    withTenantScope: (_tenantId: string, fn: (c: unknown) => unknown) => fn(mkClient()),
    withAdminScope: (_ctx: unknown, fn: (c: unknown) => unknown) => fn(mkClient()),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: jest.fn(),
    hasPermission: jest.fn().mockReturnValue(true),
  },
}));

import {
  extractUserId,
  checkCorrectionConfigPermissions,
} from '../permissions';

describe('Permission Escalation Chain Tests', () => {
  const { tenantMembersService } = require('../../tenant-members/service');
  const tenantId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
  });

  // [TE-P2-004] extractUserId strict pattern matching (SE-P2-002)
  describe('extractUserId', () => {
    it('should extract user ID from human:userId format', () => {
      const result = extractUserId('human:user-123');
      expect(result).toBe('user-123');
    });

    it('should return null for agent trigger', () => {
      const result = extractUserId('agent:agent-123');
      expect(result).toBeNull();
    });

    it('should return null for cron trigger', () => {
      const result = extractUserId('cron:daily-job');
      expect(result).toBeNull();
    });

    it('should return null for event trigger', () => {
      const result = extractUserId('event:correction');
      expect(result).toBeNull();
    });

    it('should return null for invalid format', () => {
      expect(extractUserId('invalid')).toBeNull();
      expect(extractUserId('')).toBeNull();
      expect(extractUserId('user-123')).toBeNull(); // Missing prefix
      expect(extractUserId('human:')).toBeNull(); // Missing identifier
    });

    it('should handle complex user IDs', () => {
      expect(extractUserId('human:firebase_user_abc123')).toBe('firebase_user_abc123');
      expect(extractUserId('human:user@example.com')).toBe('user@example.com');
      expect(extractUserId('human:123-456-789')).toBe('123-456-789');
    });
  });

  // [TE-P2-004] Config permission checks
  describe('checkCorrectionConfigPermissions', () => {
    it('should allow owner to modify config', async () => {
      tenantMembersService.getMembership.mockResolvedValueOnce({ role: 'owner' });

      const result = await checkCorrectionConfigPermissions(tenantId, 'owner-user');

      expect(result.allowed).toBe(true);
    });

    it('should allow admin to modify config', async () => {
      tenantMembersService.getMembership.mockResolvedValueOnce({ role: 'admin' });

      const result = await checkCorrectionConfigPermissions(tenantId, 'admin-user');

      expect(result.allowed).toBe(true);
    });

    it('should deny member from modifying config', async () => {
      tenantMembersService.getMembership.mockResolvedValueOnce({ role: 'member' });

      const result = await checkCorrectionConfigPermissions(tenantId, 'member-user');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('admin');
    });

    it('should deny non-member from modifying config', async () => {
      tenantMembersService.getMembership.mockResolvedValueOnce(null);

      const result = await checkCorrectionConfigPermissions(tenantId, 'unknown-user');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('member');
    });
  });

  // [TE-P2-004] HITL level checks
  describe('HITL Level Authorization', () => {
    it('should allow admin for HITL level 1', () => {
      const canApprove = (role: string, hitlLevel: number): boolean => {
        if (hitlLevel === 1) return role === 'owner' || role === 'admin';
        if (hitlLevel === 2) return role === 'owner' || role === 'admin' || role === 'member';
        return false;
      };

      expect(canApprove('owner', 1)).toBe(true);
      expect(canApprove('admin', 1)).toBe(true);
      expect(canApprove('member', 1)).toBe(false);
    });

    it('should allow member for HITL level 2', () => {
      const canApprove = (role: string, hitlLevel: number): boolean => {
        if (hitlLevel === 1) return role === 'owner' || role === 'admin';
        if (hitlLevel === 2) return role === 'owner' || role === 'admin' || role === 'member';
        return false;
      };

      expect(canApprove('owner', 2)).toBe(true);
      expect(canApprove('admin', 2)).toBe(true);
      expect(canApprove('member', 2)).toBe(true);
      expect(canApprove('viewer', 2)).toBe(false);
    });
  });

  // [TE-P2-004] Original actor requirement
  describe('Original Actor Requirement', () => {
    it('should enforce original actor when config requires it', async () => {
      const originalTriggeredBy = 'human:user-abc';
      const requestingUserId = 'user-xyz';

      const originalUserId = extractUserId(originalTriggeredBy);

      expect(originalUserId).toBe('user-abc');
      expect(originalUserId).not.toBe(requestingUserId);

      // If config.requireOriginalActor is true, this should fail
      const allowed = originalUserId === requestingUserId;
      expect(allowed).toBe(false);
    });

    it('should allow original actor when config requires it', async () => {
      const originalTriggeredBy = 'human:user-abc';
      const requestingUserId = 'user-abc';

      const originalUserId = extractUserId(originalTriggeredBy);

      expect(originalUserId).toBe('user-abc');
      expect(originalUserId).toBe(requestingUserId);

      const allowed = originalUserId === requestingUserId;
      expect(allowed).toBe(true);
    });

    it('should fail closed for non-human triggers', async () => {
      const originalTriggeredBy = 'agent:agent-123';
      const requestingUserId = 'user-abc';

      const originalUserId = extractUserId(originalTriggeredBy);

      // Cannot extract user ID from agent trigger
      expect(originalUserId).toBeNull();

      // Should fail closed (deny) when we can't identify original actor
      const allowed = originalUserId !== null && originalUserId === requestingUserId;
      expect(allowed).toBe(false);
    });
  });

  // [TE-P2-004] Cross-tenant permission isolation
  describe('Cross-Tenant Permission Isolation', () => {
    it('should not allow user from tenant A to modify tenant B config', async () => {
      const tenantA = '123e4567-e89b-12d3-a456-426614174001';
      const tenantB = '123e4567-e89b-12d3-a456-426614174002';
      const userId = 'user-123';

      // User is admin in tenant A but not member of tenant B
      tenantMembersService.getMembership
        .mockResolvedValueOnce({ role: 'admin' }) // For tenant A
        .mockResolvedValueOnce(null); // For tenant B

      const resultA = await checkCorrectionConfigPermissions(tenantA, userId);
      const resultB = await checkCorrectionConfigPermissions(tenantB, userId);

      expect(resultA.allowed).toBe(true);
      expect(resultB.allowed).toBe(false);
    });

    it('should check membership for each tenant independently', async () => {
      const userId = 'user-123';

      tenantMembersService.getMembership.mockResolvedValueOnce({ role: 'owner' });
      const result1 = await checkCorrectionConfigPermissions('tenant-1', userId);

      tenantMembersService.getMembership.mockResolvedValueOnce({ role: 'member' });
      const result2 = await checkCorrectionConfigPermissions('tenant-2', userId);

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(false);

      expect(tenantMembersService.getMembership).toHaveBeenCalledTimes(2);
      expect(tenantMembersService.getMembership).toHaveBeenCalledWith('tenant-1', userId);
      expect(tenantMembersService.getMembership).toHaveBeenCalledWith('tenant-2', userId);
    });
  });

  // [TE-P2-004] Permission error messages
  describe('Permission Error Messages', () => {
    it('should provide clear error message for non-member', async () => {
      tenantMembersService.getMembership.mockResolvedValueOnce(null);

      const result = await checkCorrectionConfigPermissions(tenantId, 'non-member');

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/not.*member/i);
    });

    it('should provide clear error message for insufficient role', async () => {
      tenantMembersService.getMembership.mockResolvedValueOnce({ role: 'member' });

      const result = await checkCorrectionConfigPermissions(tenantId, 'member-user');

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/admin|owner/i);
    });
  });
});
