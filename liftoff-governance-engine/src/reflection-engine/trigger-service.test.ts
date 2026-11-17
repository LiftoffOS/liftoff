// Reflection trigger publishes governance events to Pub/Sub.
// These tests mock the publisher module and assert the trigger methods
// forward to the correct event publishers.

jest.mock('../infrastructure/logging', () => {
  const silent = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { logger: silent, log: silent };
});

const mockPublishLateFeedback = jest.fn().mockResolvedValue(undefined);
const mockPublishActionCompensated = jest.fn().mockResolvedValue(undefined);
jest.mock('../events/publisher', () => ({
  publishLateFeedbackFlagged: (...args: unknown[]) =>
    mockPublishLateFeedback(...args),
  publishActionCompensated: (...args: unknown[]) =>
    mockPublishActionCompensated(...args),
  publishCorrectionCaptured: jest.fn().mockResolvedValue(undefined),
}));

import { ReflectionTriggerService } from './trigger-service';

describe('ReflectionTriggerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('onLateFeedbackFlagged publishes via publishLateFeedbackFlagged', async () => {
    const svc = new ReflectionTriggerService();
    await svc.onLateFeedbackFlagged('agent-1', 'tenant-1', 'fb-1');

    expect(mockPublishLateFeedback).toHaveBeenCalledTimes(1);
    expect(mockPublishLateFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        feedbackId: 'fb-1',
        decision: 'rejected',
      }),
    );
  });

  it('onActionCompensated publishes via publishActionCompensated', async () => {
    const svc = new ReflectionTriggerService();
    await svc.onActionCompensated('agent-1', 'tenant-1', 'act-1');

    expect(mockPublishActionCompensated).toHaveBeenCalledTimes(1);
    expect(mockPublishActionCompensated).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        actionId: 'act-1',
      }),
    );
  });
});
