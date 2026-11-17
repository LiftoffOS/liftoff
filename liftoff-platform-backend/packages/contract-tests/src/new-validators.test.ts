import {
  validateGovernancePreflightRequest,
  validateGovernancePreflightResponse,
  validateGovernanceAuthorizeRequest,
  validateGovernanceAuthorizeResponse,
  validateGovernanceRecordRequest,
  validateGovernanceRecordResponse,
  validateConnectorExecuteRequest,
  validateConnectorExecuteResponse,
  validateConnectorExecuteBatchRequest,
  validateConnectorExecuteBatchResponse,
} from './index.js';

// Round-trip validators catch schema drift in CI. Each service writes its
// fixtures here, and both caller and callee assert their payloads still
// match. A field rename or type change on one side fails the other side's
// CI immediately.

describe('GovernanceEngine contract validators', () => {
  describe('Preflight', () => {
    it('accepts a minimal valid request', () => {
      const r = validateGovernancePreflightRequest({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        connectorTypes: ['slack'],
      });
      expect(r.valid).toBe(true);
    });

    it('accepts a request with all optional fields', () => {
      const r = validateGovernancePreflightRequest({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        connectorTypes: ['slack', 'github'],
        capabilityTier: 'sandbox',
        executionEnvironment: 'managed',
      });
      expect(r.valid).toBe(true);
    });

    it('rejects a request missing required fields', () => {
      const r = validateGovernancePreflightRequest({ tenantId: 'tenant-1' });
      expect(r.valid).toBe(false);
    });

    it('rejects unknown capability tier', () => {
      const r = validateGovernancePreflightRequest({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        connectorTypes: [],
        capabilityTier: 'nonsense',
      });
      expect(r.valid).toBe(false);
    });

    it('accepts a valid response', () => {
      const r = validateGovernancePreflightResponse({
        admissionStatus: 'admitted',
        hitlLevel: 3,
        killSwitchState: { global: false },
        allowlists: [],
        preflightToken: 'token-abc',
        version: 1,
      });
      expect(r.valid).toBe(true);
    });

    it('rejects response with hitlLevel out of range', () => {
      const r = validateGovernancePreflightResponse({
        admissionStatus: 'admitted',
        hitlLevel: 99,
        killSwitchState: { global: false },
        allowlists: [],
        preflightToken: 'token-abc',
        version: 1,
      });
      expect(r.valid).toBe(false);
    });
  });

  describe('Authorize', () => {
    it('accepts a valid request', () => {
      const r = validateGovernanceAuthorizeRequest({
        preflightToken: 't',
        idempotencyKey: 'k',
        connector: 'slack',
        entityType: 'message',
        actionType: 'send',
      });
      expect(r.valid).toBe(true);
    });

    it('accepts allowed response', () => {
      const r = validateGovernanceAuthorizeResponse({ decision: 'allowed' });
      expect(r.valid).toBe(true);
    });

    it('accepts hitl_required response with approvalRequestId', () => {
      const r = validateGovernanceAuthorizeResponse({
        decision: 'hitl_required',
        approvalRequestId: 'req-1',
      });
      expect(r.valid).toBe(true);
    });

    it('accepts conflict response with conflict object', () => {
      const r = validateGovernanceAuthorizeResponse({
        decision: 'conflict',
        conflict: {
          conflictingActionId: 'act-1',
          resolution: 'wait',
        },
      });
      expect(r.valid).toBe(true);
    });

    it('rejects unknown decision value', () => {
      const r = validateGovernanceAuthorizeResponse({ decision: 'idk' });
      expect(r.valid).toBe(false);
    });
  });

  describe('Record', () => {
    it('accepts a valid request', () => {
      const r = validateGovernanceRecordRequest({
        preflightToken: 't',
        idempotencyKey: 'k',
        connector: 'slack',
        entityType: 'message',
        actionType: 'send',
        targetRef: 'C123/msg-1',
        durationMs: 42,
        status: 'completed',
      });
      expect(r.valid).toBe(true);
    });

    it('only accepts { accepted: true } in response', () => {
      expect(validateGovernanceRecordResponse({ accepted: true }).valid).toBe(true);
      expect(validateGovernanceRecordResponse({ accepted: false }).valid).toBe(false);
    });
  });
});

describe('ConnectorService contract validators', () => {
  describe('Execute', () => {
    it('accepts a valid request', () => {
      const r = validateConnectorExecuteRequest({
        tenantId: 'tenant-1',
        connectorId: 'conn-1',
        functionName: 'slack_send_message',
        input: { channel: 'C123', text: 'hi' },
        idempotencyKey: 'k1',
      });
      expect(r.valid).toBe(true);
    });

    it('rejects non-object input', () => {
      const r = validateConnectorExecuteRequest({
        tenantId: 'tenant-1',
        connectorId: 'conn-1',
        functionName: 'f',
        input: 'string',
        idempotencyKey: 'k',
      });
      expect(r.valid).toBe(false);
    });

    it('accepts success response', () => {
      const r = validateConnectorExecuteResponse({
        success: true,
        result: { ok: true },
        vendorLatencyMs: 180,
        costUsd: 0.001,
      });
      expect(r.valid).toBe(true);
    });

    it('accepts failure response with error string', () => {
      const r = validateConnectorExecuteResponse({
        success: false,
        error: 'rate limited',
      });
      expect(r.valid).toBe(true);
    });
  });

  describe('ExecuteBatch', () => {
    it('accepts a non-empty batch', () => {
      const r = validateConnectorExecuteBatchRequest({
        tenantId: 'tenant-1',
        operations: [
          {
            connectorId: 'conn-1',
            functionName: 'read',
            input: {},
            idempotencyKey: 'k1',
          },
        ],
      });
      expect(r.valid).toBe(true);
    });

    it('rejects an empty batch', () => {
      const r = validateConnectorExecuteBatchRequest({
        tenantId: 'tenant-1',
        operations: [],
      });
      expect(r.valid).toBe(false);
    });

    it('accepts a response with per-item success/error', () => {
      const r = validateConnectorExecuteBatchResponse({
        results: [
          { success: true, result: {} },
          { success: false, error: 'partial failure' },
        ],
      });
      expect(r.valid).toBe(true);
    });
  });
});
