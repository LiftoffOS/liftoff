// toResponse / computeAccess Tests
// Per implementation plan 1f: truth table tests for access computation

import { AccountService } from './service';
import { AccountRepository } from './repository';
import { TenantMembersRepository } from '../tenant-members/repository';
import { createMockAccount } from '../test-utils/mocks';
import { _setCachedDomains, _stopRefreshTimer } from '../config/allowedDomains';

// Mock external dependencies
jest.mock('../infrastructure/database');
jest.mock('stripe', () => {
  const mockStripeInstance = {
    customers: { create: jest.fn(), update: jest.fn() },
    subscriptions: { create: jest.fn(), update: jest.fn(), cancel: jest.fn() },
  };
  return { __esModule: true, default: jest.fn(() => mockStripeInstance) };
});
jest.mock('./repository');
jest.mock('../tenant-members/repository');
jest.mock('../tenants/repository');
jest.mock('../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_mock'),
}));
jest.mock('../infrastructure/email', () => ({
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
}));

describe('AccountService.computeAccess / toResponse', () => {
  let service: AccountService;
  let mockTenantMembersRepo: jest.Mocked<TenantMembersRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockTenantMembersRepo = {
      hasNonOwnerMembership: jest.fn(),
    } as unknown as jest.Mocked<TenantMembersRepository>;

    (TenantMembersRepository as jest.Mock).mockImplementation(() => mockTenantMembersRepo);
    (AccountRepository as jest.Mock).mockImplementation(() => ({
      create: jest.fn(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      findByFirebaseUid: jest.fn(),
      findAll: jest.fn(),
      update: jest.fn(),
      updateStripeCustomerId: jest.fn(),
      softDelete: jest.fn(),
    }));

    service = new AccountService();
  });

  afterAll(() => {
    _stopRefreshTimer();
  });

  describe('computeAccess', () => {
    it('should return {true, domain} for whitelisted domain — short-circuits, no membership query', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'user@example.com' });

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: true, accessReason: 'domain' });
      expect(mockTenantMembersRepo.hasNonOwnerMembership).not.toHaveBeenCalled();
    });

    it('should return {true, invitation} for non-whitelisted domain with non-owner membership', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'person@example.org' });
      mockTenantMembersRepo.hasNonOwnerMembership.mockResolvedValue(true);

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: true, accessReason: 'invitation' });
      expect(mockTenantMembersRepo.hasNonOwnerMembership).toHaveBeenCalledWith(account.id);
    });

    it('should return {false, null} for non-whitelisted domain with only owner membership', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'person@example.org' });
      mockTenantMembersRepo.hasNonOwnerMembership.mockResolvedValue(false);

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: false, accessReason: null });
    });

    it('should be case-insensitive for domain check', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'user@EXAMPLE.COM' });

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: true, accessReason: 'domain' });
    });

    it('should return {false, null} for malformed email', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'notanemail' });
      mockTenantMembersRepo.hasNonOwnerMembership.mockResolvedValue(false);

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: false, accessReason: null });
    });

    it('should return {true, approved} for an admin-approved account (email-level whitelist)', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'person@example.org', accessStatus: 'approved' });

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: true, accessReason: 'approved' });
      // 'approved' short-circuits before the membership query.
      expect(mockTenantMembersRepo.hasNonOwnerMembership).not.toHaveBeenCalled();
    });

    it('should prefer domain over an approved status when both apply', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'user@example.com', accessStatus: 'approved' });

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: true, accessReason: 'domain' });
    });

    it('should return {false, null} for a waitlisted non-domain account', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'person@example.org', accessStatus: 'waitlisted' });
      mockTenantMembersRepo.hasNonOwnerMembership.mockResolvedValue(false);

      const result = await service.computeAccess(account);

      expect(result).toEqual({ accessGranted: false, accessReason: null });
    });
  });

  describe('toResponse', () => {
    it('should extend account with accessGranted and accessReason', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'user@example.com' });

      const response = await service.toResponse(account);

      expect(response.id).toBe(account.id);
      expect(response.email).toBe(account.email);
      expect(response.accessGranted).toBe(true);
      expect(response.accessReason).toBe('domain');
    });

    it('should use cached access when provided', async () => {
      const account = createMockAccount({ email: 'person@example.org' });
      const cachedAccess = { accessGranted: true as const, accessReason: 'invitation' as const };

      const response = await service.toResponse(account, cachedAccess);

      expect(response.accessGranted).toBe(true);
      expect(response.accessReason).toBe('invitation');
      expect(mockTenantMembersRepo.hasNonOwnerMembership).not.toHaveBeenCalled();
    });

    it('should compute access fresh when no cache provided', async () => {
      _setCachedDomains(['example.com']);
      const account = createMockAccount({ email: 'person@example.org' });
      mockTenantMembersRepo.hasNonOwnerMembership.mockResolvedValue(false);

      const response = await service.toResponse(account);

      expect(response.accessGranted).toBe(false);
      expect(response.accessReason).toBeNull();
      expect(mockTenantMembersRepo.hasNonOwnerMembership).toHaveBeenCalled();
    });
  });
});
