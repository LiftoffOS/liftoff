// Unit tests for enqueueNotification (plan §10a rows 1-4):
//   • type-toggle off → no row inserted
//   • type=escalation, cadence=weekly → row inserted with cadence='realtime', email sent inline, delivered_at set
//   • type=task_update, cadence=daily → row inserted with cadence='daily', delivered_at NULL
//   • Resend 500 → row inserted, delivery_error populated, no throw

import { createMockAccount } from '../../test-utils/mocks';

// Stub the AccountRepository before importing the service.
const findByIdMock = jest.fn();
jest.mock('../../accounts/repository', () => ({
  AccountRepository: jest.fn().mockImplementation(() => ({ findById: findByIdMock })),
}));

// Stub the notifications repository.
const insertMock = jest.fn();
const markDeliveredMock = jest.fn();
const markFailedMock = jest.fn();
jest.mock('../repository', () => ({
  insertNotification: (...args: unknown[]) => insertMock(...args),
  markDelivered: (...args: unknown[]) => markDeliveredMock(...args),
  markFailed: (...args: unknown[]) => markFailedMock(...args),
  fetchPendingForAccount: jest.fn(),
  tryReservePerfRecap: jest.fn(),
}));

// Stub the realtime sender.
const sendRealtimeMock = jest.fn();
jest.mock('../email', () => ({
  sendRealtimeNotificationEmail: (...args: unknown[]) => sendRealtimeMock(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import AFTER mocks are registered.
import { enqueueNotification } from '../service';

const ACCT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';

const ROW_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NOTIFICATION_DELIVERY_ENABLED = 'true';
  insertMock.mockResolvedValue({
    id: ROW_ID,
    accountId: ACCT_ID,
    tenantId: TENANT_ID,
    type: 'task_update',
    payload: {},
    cadence: 'daily',
    createdAt: new Date(),
    deliveredAt: null,
    deliveryError: null,
  });
  sendRealtimeMock.mockResolvedValue('resend-id-abc');
  markDeliveredMock.mockResolvedValue(undefined);
  markFailedMock.mockResolvedValue(undefined);
});

describe('enqueueNotification', () => {
  it('returns early when NOTIFICATION_DELIVERY_ENABLED is not "true"', async () => {
    process.env.NOTIFICATION_DELIVERY_ENABLED = 'false';
    await enqueueNotification({
      accountId: ACCT_ID,
      tenantId: TENANT_ID,
      type: 'task_update',
      payload: {},
    });
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns early when the account is soft-deleted', async () => {
    findByIdMock.mockResolvedValue(createMockAccount({ deletedAt: new Date() }));
    await enqueueNotification({
      accountId: ACCT_ID,
      tenantId: TENANT_ID,
      type: 'task_update',
      payload: {},
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns without inserting when the type toggle is off', async () => {
    findByIdMock.mockResolvedValue(
      createMockAccount({
        preferences: { notificationTypes: { taskUpdates: false }, notificationFrequency: 'daily' },
      }),
    );
    await enqueueNotification({
      accountId: ACCT_ID,
      tenantId: TENANT_ID,
      type: 'task_update',
      payload: {},
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns without inserting when cadence is "none" (even for escalations)', async () => {
    findByIdMock.mockResolvedValue(
      createMockAccount({
        preferences: {
          notificationTypes: { escalations: true },
          notificationFrequency: 'none',
        },
      }),
    );
    await enqueueNotification({
      accountId: ACCT_ID,
      tenantId: TENANT_ID,
      type: 'escalation',
      payload: { internalAgentName: 'X' },
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('inserts a row with cadence="realtime" for escalations even when user cadence is weekly', async () => {
    findByIdMock.mockResolvedValue(
      createMockAccount({
        preferences: {
          notificationTypes: { escalations: true },
          notificationFrequency: 'weekly',
        },
      }),
    );
    await enqueueNotification({
      accountId: ACCT_ID,
      tenantId: TENANT_ID,
      type: 'escalation',
      payload: { internalAgentName: 'X' },
    });
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'escalation', cadence: 'realtime' }),
    );
    // Realtime path: send + mark delivered.
    expect(sendRealtimeMock).toHaveBeenCalledTimes(1);
    expect(markDeliveredMock).toHaveBeenCalledWith([ROW_ID]);
  });

  it('inserts a row with cadence="daily" for task_update and leaves delivered_at NULL', async () => {
    findByIdMock.mockResolvedValue(
      createMockAccount({
        preferences: {
          notificationTypes: { taskUpdates: true },
          notificationFrequency: 'daily',
        },
      }),
    );
    await enqueueNotification({
      accountId: ACCT_ID,
      tenantId: TENANT_ID,
      type: 'task_update',
      payload: { internalAgentName: 'X' },
    });
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_update', cadence: 'daily' }),
    );
    // NOT realtime — must not send or mark delivered.
    expect(sendRealtimeMock).not.toHaveBeenCalled();
    expect(markDeliveredMock).not.toHaveBeenCalled();
  });

  it('marks the row failed (does NOT throw) when Resend rejects the realtime send', async () => {
    findByIdMock.mockResolvedValue(
      createMockAccount({
        preferences: {
          notificationTypes: { escalations: true },
          notificationFrequency: 'realtime',
        },
      }),
    );
    sendRealtimeMock.mockRejectedValue(new Error('Resend API error: 500 - server fail'));
    await expect(
      enqueueNotification({
        accountId: ACCT_ID,
        tenantId: TENANT_ID,
        type: 'escalation',
        payload: { internalAgentName: 'X' },
      }),
      // Resolves rather than rejecting: the caller's transaction must not roll
      // back because Resend was down. The result now says so explicitly instead
      // of leaving it to an absent return value.
    ).resolves.toEqual({ pushedDevices: 0, emailed: false });
    expect(markDeliveredMock).not.toHaveBeenCalled();
    expect(markFailedMock).toHaveBeenCalledWith(
      ROW_ID,
      expect.stringContaining('Resend API error'),
    );
  });
});
