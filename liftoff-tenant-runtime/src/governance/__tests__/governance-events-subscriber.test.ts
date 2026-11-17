// Unit tests for the governance events dispatch table.
//
// The Pub/Sub wiring itself is deliberately thin — we test the dispatch
// function in isolation with synthetic payloads so we can assert routing
// without standing up a live subscription.

import {
  dispatchGovernanceEvent,
  governanceEventHandlers,
  GOVERNANCE_EVENT_TYPES,
  resetGovernanceEventsSubscriber,
} from '../governance-events-subscriber';

jest.mock('../preflight-cache', () => ({
  invalidatePreflight: jest.fn(),
}));

jest.mock('../../learning/correction-capture', () => ({
  captureFromGovernanceEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: {
    onLateFeedbackFlagged: jest.fn().mockResolvedValue(undefined),
    onActionCompensated: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { invalidatePreflight } = require('../preflight-cache');
const { captureFromGovernanceEvent } = require('../../learning/correction-capture');
const { reflectionTriggerService } = require('../../reflection-engine/trigger-service');
const { logger } = require('../../infrastructure/logging');

beforeEach(() => {
  jest.clearAllMocks();
  resetGovernanceEventsSubscriber();
});

describe('dispatchGovernanceEvent — routing', () => {
  it('routes governance.kill_switch_changed → invalidatePreflight', async () => {
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.KILL_SWITCH_CHANGED,
      { tenantId: 't1', switchName: 'global', state: {} },
      'msg-1',
    );
    expect(res.acked).toBe(true);
    expect(invalidatePreflight).toHaveBeenCalledWith('t1');
    expect(captureFromGovernanceEvent).not.toHaveBeenCalled();
    expect(reflectionTriggerService.onLateFeedbackFlagged).not.toHaveBeenCalled();
    expect(reflectionTriggerService.onActionCompensated).not.toHaveBeenCalled();
  });

  it('routes governance.correction_captured → captureFromGovernanceEvent', async () => {
    const payload = {
      tenantId: 't1',
      agentId: 'a1',
      actionId: 'act-1',
      correctionType: 'wrong_tool',
      correctionPayload: { reason: 'use gmail__draft instead' },
    };
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.CORRECTION_CAPTURED,
      payload,
      'msg-2',
    );
    expect(res.acked).toBe(true);
    expect(captureFromGovernanceEvent).toHaveBeenCalledWith(payload);
    expect(invalidatePreflight).not.toHaveBeenCalled();
    expect(reflectionTriggerService.onLateFeedbackFlagged).not.toHaveBeenCalled();
    expect(reflectionTriggerService.onActionCompensated).not.toHaveBeenCalled();
  });

  it('routes governance.late_feedback_flagged → reflectionTriggerService.onLateFeedbackFlagged', async () => {
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.LATE_FEEDBACK_FLAGGED,
      { tenantId: 't1', agentId: 'a1', feedbackId: 'fb-1' },
      'msg-3',
    );
    expect(res.acked).toBe(true);
    expect(reflectionTriggerService.onLateFeedbackFlagged).toHaveBeenCalledWith(
      'a1',
      't1',
      'fb-1',
    );
    expect(invalidatePreflight).not.toHaveBeenCalled();
    expect(captureFromGovernanceEvent).not.toHaveBeenCalled();
    expect(reflectionTriggerService.onActionCompensated).not.toHaveBeenCalled();
  });

  it('acks governance.action_compensated without routing it anywhere', async () => {
    // Deliberately unsubscribed. Its only handler existed to fire the
    // `repeated_undos` reflection trigger, which was retired: the counter behind
    // it read `actions.status='compensated'`, production holds zero such rows,
    // and compensation is reachable only through a coordinator API method. A
    // trigger that cannot fire reads as coverage.
    //
    // It must still ACK — an unhandled type that nacked would redeliver forever.
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.ACTION_COMPENSATED,
      { tenantId: 't1', agentId: 'a1', actionId: 'act-9' },
      'msg-4',
    );
    expect(res.acked).toBe(true);
    expect(res.reason).toBe('unknown_event_type');
    expect(invalidatePreflight).not.toHaveBeenCalled();
    expect(captureFromGovernanceEvent).not.toHaveBeenCalled();
    expect(reflectionTriggerService.onLateFeedbackFlagged).not.toHaveBeenCalled();
  });
});

describe('dispatchGovernanceEvent — error handling', () => {
  it('logs warn + acks when eventType is missing', async () => {
    const res = await dispatchGovernanceEvent(undefined, { tenantId: 't1' }, 'msg-x');
    expect(res.acked).toBe(true);
    expect(res.reason).toBe('missing_event_type');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'governance_event_missing_type' }),
      expect.any(String),
    );
    expect(invalidatePreflight).not.toHaveBeenCalled();
  });

  it('logs warn + acks on unknown eventType', async () => {
    const res = await dispatchGovernanceEvent(
      'governance.some_future_event',
      { tenantId: 't1' },
      'msg-y',
    );
    expect(res.acked).toBe(true);
    expect(res.reason).toBe('unknown_event_type');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'governance_event_unknown_type' }),
      expect.any(String),
    );
    expect(invalidatePreflight).not.toHaveBeenCalled();
    expect(captureFromGovernanceEvent).not.toHaveBeenCalled();
  });

  it('acks malformed envelope (null payload)', async () => {
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.KILL_SWITCH_CHANGED,
      null,
      'msg-z',
    );
    expect(res.acked).toBe(true);
    expect(res.reason).toBe('bad_envelope');
    expect(invalidatePreflight).not.toHaveBeenCalled();
  });

  it('acks envelope missing tenantId', async () => {
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.KILL_SWITCH_CHANGED,
      { switchName: 'global' },
      'msg-z2',
    );
    expect(res.acked).toBe(true);
    expect(res.reason).toBe('bad_envelope');
    expect(invalidatePreflight).not.toHaveBeenCalled();
  });

  it('nacks when a handler throws', async () => {
    (invalidatePreflight as jest.Mock).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.KILL_SWITCH_CHANGED,
      { tenantId: 't1' },
      'msg-err',
    );
    expect(res.acked).toBe(false);
    expect(res.reason).toBe('handler_error');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'governance_event_handler_failed' }),
      expect.any(String),
    );
  });

  it('late_feedback_flagged without agentId/feedbackId warns but still acks', async () => {
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.LATE_FEEDBACK_FLAGGED,
      { tenantId: 't1' },
      'msg-lfp',
    );
    expect(res.acked).toBe(true);
    expect(reflectionTriggerService.onLateFeedbackFlagged).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'governance_late_feedback_missing_fields' }),
      expect.any(String),
    );
  });

  it('acks an unsubscribed type rather than nacking it into a redelivery loop', async () => {
    const res = await dispatchGovernanceEvent(
      GOVERNANCE_EVENT_TYPES.ACTION_COMPENSATED,
      { tenantId: 't1' },
      'msg-ac',
    );
    expect(res.acked).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'governance_event_unknown_type' }),
      expect.any(String),
    );
  });
});

describe('governanceEventHandlers table', () => {
  it('has exactly the three subscribed event types', () => {
    // ACTION_COMPENSATED is intentionally absent — see the handler map.
    expect(Object.keys(governanceEventHandlers).sort()).toEqual(
      [
        GOVERNANCE_EVENT_TYPES.CORRECTION_CAPTURED,
        GOVERNANCE_EVENT_TYPES.KILL_SWITCH_CHANGED,
        GOVERNANCE_EVENT_TYPES.LATE_FEEDBACK_FLAGGED,
      ].sort(),
    );
  });
});
