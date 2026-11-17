/**
 * Phase 0 — @liftoffos/contract-tests round-trip tests.
 *
 * Each JSON schema validates against a canonical example AND rejects
 * known-bad inputs. Both ends of the cross-repo boundary run these
 * validators, so any drift fails CI on both sides.
 */

import {
  validateInternalAgentCreatedEvent,
  validateToolCatalogResponse,
  validateTenantManifestsResponse,
  validateCreateInternalAgentRequest,
  schemas,
} from '@liftoffos/contract-tests';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ENTITY_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const MANIFEST_ID = '44444444-4444-4444-4444-444444444444';

describe('Phase 0 — @liftoffos/contract-tests', () => {
  describe('internal-agent.created event envelope', () => {
    const baseEvent = {
      schema_version: 1,
      entityType: 'internal_agent',
      entityId: ENTITY_ID,
      entityVersion: 1,
      eventVersion: 1,
      eventType: 'tenant.internal_agent.created',
      tenantId: TENANT_ID,
      payload: {
        internalAgentId: AGENT_ID,
        name: 'Test agent',
        agentType: 'agent',
        triggerConfig: { type: 'manual' },
      },
    };

    it('accepts a canonical agent-type event', () => {
      const result = validateInternalAgentCreatedEvent(baseEvent);
      expect(result.valid).toBe(true);
    });

    it('accepts a canonical workflow-type event with required workflowSteps', () => {
      const result = validateInternalAgentCreatedEvent({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          agentType: 'workflow',
          triggerConfig: { type: 'cron', cronExpr: '0 9 * * *' },
          workflowSteps: [
            { stepId: 's1', description: 'read record', toolName: 'sf__read' },
          ],
        },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects legacy literal agentType="B"', () => {
      const result = validateInternalAgentCreatedEvent({
        ...baseEvent,
        payload: { ...baseEvent.payload, agentType: 'B' },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.some((e) => /allowed values/.test(e.message))).toBe(true);
      }
    });

    it('rejects agentType="workflow" without workflowSteps', () => {
      const result = validateInternalAgentCreatedEvent({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          agentType: 'workflow',
          triggerConfig: { type: 'cron', cronExpr: '0 9 * * *' },
        },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(
          result.errors.some((e) => /workflowSteps/.test(e.message)),
        ).toBe(true);
      }
    });

    it('rejects missing schema_version', () => {
      const { schema_version: _sv, ...rest } = baseEvent;
      const result = validateInternalAgentCreatedEvent(rest);
      expect(result.valid).toBe(false);
    });

    it('rejects malformed UUID', () => {
      const result = validateInternalAgentCreatedEvent({
        ...baseEvent,
        entityId: 'not-a-uuid',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects wrong eventType constant', () => {
      const result = validateInternalAgentCreatedEvent({
        ...baseEvent,
        eventType: 'something.else',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects workflowSteps exceeding the max length cap', () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => ({
        stepId: `s${i}`,
        description: 'step',
        toolName: 'x__y',
      }));
      const result = validateInternalAgentCreatedEvent({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          agentType: 'workflow',
          triggerConfig: { type: 'cron', cronExpr: '0 9 * * *' },
          workflowSteps: tooMany,
        },
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('tool-catalog response', () => {
    it('accepts a canonical per-tenant tool catalog response', () => {
      const result = validateToolCatalogResponse({
        schemaVersion: 1,
        connectorType: 'salesforce',
        alias: 'salesforce_prod',
        tools: [
          {
            name: 'salesforce_prod__read_record',
            description: 'Read a Salesforce record by SObject type and ID',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects a response with schemaVersion !== 1', () => {
      const result = validateToolCatalogResponse({
        schemaVersion: 2,
        connectorType: 'salesforce',
        alias: 'salesforce_prod',
        tools: [],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects tools with missing description', () => {
      const result = validateToolCatalogResponse({
        schemaVersion: 1,
        connectorType: 'salesforce',
        alias: 'salesforce_prod',
        tools: [{ name: 'x', input_schema: {} }],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('tenant-manifests response', () => {
    it('accepts a canonical tenant manifests response', () => {
      const result = validateTenantManifestsResponse({
        schemaVersion: 1,
        manifests: [
          {
            manifestId: MANIFEST_ID,
            connectorType: 'salesforce',
            alias: 'salesforce_prod',
            displayName: 'Salesforce (prod)',
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects missing alias field', () => {
      const result = validateTenantManifestsResponse({
        schemaVersion: 1,
        manifests: [
          {
            manifestId: MANIFEST_ID,
            connectorType: 'salesforce',
            displayName: 'Salesforce',
          },
        ],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('create-internal-agent request', () => {
    it('accepts a minimal agent-type request', () => {
      const result = validateCreateInternalAgentRequest({
        role: 'Customer success manager',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts a workflow-type request with required triggerConfig + workflowSteps', () => {
      const result = validateCreateInternalAgentRequest({
        role: 'Daily standup bot',
        agentType: 'workflow',
        triggerConfig: { type: 'cron', cronExpr: '0 9 * * *' },
        workflowSteps: [
          { stepId: 's1', description: 'read sheet', toolName: 'gs__read' },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects workflow-type request without workflowSteps', () => {
      const result = validateCreateInternalAgentRequest({
        role: 'Broken workflow',
        agentType: 'workflow',
        triggerConfig: { type: 'cron', cronExpr: '0 9 * * *' },
      });
      expect(result.valid).toBe(false);
    });

    it('rejects legacy literal agentType="A"', () => {
      const result = validateCreateInternalAgentRequest({
        role: 'Old type A',
        agentType: 'A',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('schema exports', () => {
    it('exports all four canonical schemas by name', () => {
      expect(schemas.internalAgentCreatedEvent).toBeDefined();
      expect(schemas.toolCatalogResponse).toBeDefined();
      expect(schemas.tenantManifestsResponse).toBeDefined();
      expect(schemas.createInternalAgentRequest).toBeDefined();
    });
  });
});
