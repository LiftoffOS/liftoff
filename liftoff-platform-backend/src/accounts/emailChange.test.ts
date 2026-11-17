// Email Change Domain Restriction Tests
// Per implementation plan 1f: test initiateEmailChange rejects non-whitelisted domains

import { AccountService } from './service';
import { AccountRepository } from './repository';
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

describe('AccountService email change domain restriction', () => {
  let service: AccountService;
  let mockRepository: jest.Mocked<AccountRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    _setCachedDomains(['example.com', 'acme.com']);

    mockRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      findByFirebaseUid: jest.fn(),
      findAll: jest.fn(),
      update: jest.fn(),
      updateStripeCustomerId: jest.fn(),
      softDelete: jest.fn(),
      setPendingEmailChange: jest.fn(),
      findByVerificationToken: jest.fn(),
      confirmEmailChange: jest.fn(),
      cancelPendingEmailChange: jest.fn(),
    } as unknown as jest.Mocked<AccountRepository>;

    (AccountRepository as jest.Mock).mockImplementation(() => mockRepository);
    service = new AccountService();
  });

  afterAll(() => {
    _stopRefreshTimer();
  });

  describe('initiateEmailChange', () => {
    it('should reject non-whitelisted domain', async () => {
      await expect(
        service.initiateEmailChange('acc_1', 'person@example.org', 'https://example.com')
      ).rejects.toThrow('Email must use a company domain');
    });

    it('should allow whitelisted-to-whitelisted change', async () => {
      const account = createMockAccount({ id: 'acc_1', email: 'user@example.com' });
      mockRepository.findByEmail.mockResolvedValue(null);
      mockRepository.findById.mockResolvedValue(account);
      mockRepository.setPendingEmailChange.mockResolvedValue(account);

      await expect(
        service.initiateEmailChange('acc_1', 'user@acme.com', 'https://example.com')
      ).resolves.not.toThrow();
    });

    it('should still reject email already in use even if domain is whitelisted', async () => {
      const existingAccount = createMockAccount({ id: 'acc_2', email: 'other@example.com' });
      mockRepository.findByEmail.mockResolvedValue(existingAccount);

      await expect(
        service.initiateEmailChange('acc_1', 'other@example.com', 'https://example.com')
      ).rejects.toThrow('Email address is already in use');
    });
  });

  describe('confirmEmailChange', () => {
    it('should reject if pending email domain was de-listed', async () => {
      const account = createMockAccount({
        id: 'acc_1',
        pendingEmail: 'user@removed-domain.com',
        emailVerificationToken: 'valid-token',
        emailVerificationExpiry: new Date(Date.now() + 86400000),
      });
      mockRepository.findByVerificationToken.mockResolvedValue(account);
      mockRepository.cancelPendingEmailChange.mockResolvedValue(account);

      await expect(
        service.confirmEmailChange('valid-token')
      ).rejects.toThrow('Email domain is no longer allowed');

      expect(mockRepository.cancelPendingEmailChange).toHaveBeenCalledWith('acc_1');
    });

    it('should succeed if pending email domain is still whitelisted', async () => {
      const account = createMockAccount({
        id: 'acc_1',
        pendingEmail: 'newuser@example.com',
        emailVerificationToken: 'valid-token',
        emailVerificationExpiry: new Date(Date.now() + 86400000),
      });
      const updatedAccount = createMockAccount({
        ...account,
        email: 'newuser@example.com',
        pendingEmail: null,
      });
      mockRepository.findByVerificationToken.mockResolvedValue(account);
      mockRepository.confirmEmailChange.mockResolvedValue(updatedAccount);

      const result = await service.confirmEmailChange('valid-token');

      expect(result.email).toBe('newuser@example.com');
    });
  });
});
