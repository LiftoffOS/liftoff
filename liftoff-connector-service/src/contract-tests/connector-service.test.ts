// Callee-side contract tests for ConnectorService.
//
// Platform-backend's @liftoffos/contract-tests package publishes the
// canonical JSON-schema fixtures for every cross-service boundary.
// Those fixtures are copied byte-for-byte into ./fixtures/ and must
// stay in sync — drift on either side fails BOTH sides' CI, which is
// exactly the contract-test invariant we want.
//
// This suite asserts that typical payloads the connector-service emits
// or accepts on each of the six RPCs still match the published contract.
// Every RPC gets at least one request-shape assertion and one
// response-shape assertion; negative cases (wrong type, missing field,
// out-of-enum value) prove the validators actually catch drift.
//
// If the connector-service ever changes the wire shape of a response,
// the fixture here must be updated AND the matching fixture in
// platform-backend's packages/contract-tests/fixtures/ must be updated
// — otherwise the caller-side tests fail first and force the fix.

import {
  validateConnectorExecuteRequest,
  validateConnectorExecuteResponse,
  validateConnectorExecuteBatchRequest,
  validateConnectorExecuteBatchResponse,
  validateConnectorWarmRequest,
  validateConnectorWarmResponse,
  validateConnectorGetCredentialsRequest,
  validateConnectorGetCredentialsResponse,
  validateConnectorGetFunctionalTypesRequest,
  validateConnectorGetFunctionalTypesResponse,
  validateConnectorGetCapabilitiesRequest,
  validateConnectorGetCapabilitiesResponse,
  validateConnectorListToolsRequest,
  validateConnectorListToolsResponse,
  validateConnectorListTenantConnectorsRequest,
  validateConnectorListTenantConnectorsResponse,
} from './validators.js';

// ──────────────────────────────────────────────────────────────────────
// Execute
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.Execute contract', () => {
  it('accepts a realistic request payload', () => {
    const req = JSON.parse(
      JSON.stringify({
        tenantId: 'tenant-abc',
        connectorId: 'conn-slack-1',
        functionName: 'slack_send_message',
        input: { channel: 'C123', text: 'hello' },
        idempotencyKey: 'idem-1',
        traceId: 'trace-abc',
      }),
    );
    expect(validateConnectorExecuteRequest(req).valid).toBe(true);
  });

  it('rejects request with non-object input (protects vendor dispatch)', () => {
    expect(
      validateConnectorExecuteRequest({
        tenantId: 't',
        connectorId: 'c',
        functionName: 'f',
        input: 'nope',
        idempotencyKey: 'k',
      }).valid,
    ).toBe(false);
  });

  it('accepts a success response with latency + cost', () => {
    const res = JSON.parse(
      JSON.stringify({
        success: true,
        result: { id: 'msg-1', channel: 'C123' },
        vendorLatencyMs: 123,
        costUsd: 0.0004,
      }),
    );
    expect(validateConnectorExecuteResponse(res).valid).toBe(true);
  });

  it('accepts a failure response with error only', () => {
    expect(
      validateConnectorExecuteResponse({ success: false, error: 'rate limited' })
        .valid,
    ).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ExecuteBatch
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.ExecuteBatch contract', () => {
  it('accepts a batch of two ops', () => {
    const req = JSON.parse(
      JSON.stringify({
        tenantId: 't',
        operations: [
          {
            connectorId: 'c-1',
            functionName: 'read',
            input: {},
            idempotencyKey: 'k-1',
          },
          {
            connectorId: 'c-2',
            functionName: 'write',
            input: { body: 'hi' },
            idempotencyKey: 'k-2',
          },
        ],
      }),
    );
    expect(validateConnectorExecuteBatchRequest(req).valid).toBe(true);
  });

  it('rejects an empty operations array', () => {
    expect(
      validateConnectorExecuteBatchRequest({ tenantId: 't', operations: [] })
        .valid,
    ).toBe(false);
  });

  it('accepts a response with mixed partial failures', () => {
    const res = JSON.parse(
      JSON.stringify({
        results: [
          { success: true, result: { id: 'x' }, vendorLatencyMs: 30 },
          { success: false, error: 'vendor 500' },
        ],
      }),
    );
    expect(validateConnectorExecuteBatchResponse(res).valid).toBe(true);
  });

  it('rejects a response result missing success', () => {
    expect(
      validateConnectorExecuteBatchResponse({
        results: [{ result: { id: 'x' } }],
      }).valid,
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Warm
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.Warm contract', () => {
  it('accepts request with multiple connector types', () => {
    expect(
      validateConnectorWarmRequest({
        tenantId: 't',
        connectorTypes: ['slack', 'github', 'google_mail'],
      }).valid,
    ).toBe(true);
  });

  it('accepts response with warmed list + failures', () => {
    const res = JSON.parse(
      JSON.stringify({
        warmedConnectorTypes: ['slack', 'google_mail'],
        failures: [
          { connectorType: 'github', reason: 'no credentials stored' },
        ],
      }),
    );
    expect(validateConnectorWarmResponse(res).valid).toBe(true);
  });

  it('rejects response missing failures (empty array still required)', () => {
    expect(
      validateConnectorWarmResponse({ warmedConnectorTypes: ['slack'] }).valid,
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// GetCredentials
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.GetCredentials contract', () => {
  it('accepts a valid request', () => {
    expect(
      validateConnectorGetCredentialsRequest({
        tenantId: 't',
        connectorId: 'conn-1',
      }).valid,
    ).toBe(true);
  });

  it('accepts oauth response', () => {
    const res = JSON.parse(
      JSON.stringify({
        flowKind: 'static_oauth',
        oauth: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAtEpochSec: 1234567890,
          scopes: ['read', 'write'],
        },
      }),
    );
    expect(validateConnectorGetCredentialsResponse(res).valid).toBe(true);
  });

  it('accepts api_key response', () => {
    expect(
      validateConnectorGetCredentialsResponse({
        flowKind: 'api_key',
        apiKey: { apiKey: 'secret' },
      }).valid,
    ).toBe(true);
  });

  it('rejects an unknown flowKind', () => {
    expect(
      validateConnectorGetCredentialsResponse({ flowKind: 'wat' }).valid,
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// GetFunctionalTypes
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.GetFunctionalTypes contract', () => {
  it('accepts an empty request', () => {
    expect(validateConnectorGetFunctionalTypesRequest({}).valid).toBe(true);
  });

  it('accepts a request scoped by tenantContext', () => {
    expect(
      validateConnectorGetFunctionalTypesRequest({
        tenantContext: { tenantId: 't-1', agentId: 'ag-1' },
      }).valid,
    ).toBe(true);
  });

  it('accepts a populated-list response', () => {
    const res = JSON.parse(
      JSON.stringify({
        connectorTypes: [
          'github',
          'slack',
          'google_mail',
          'google_drive',
          'salesforce',
          'hubspot',
        ],
      }),
    );
    expect(validateConnectorGetFunctionalTypesResponse(res).valid).toBe(true);
  });

  it('rejects response with duplicate connector types', () => {
    expect(
      validateConnectorGetFunctionalTypesResponse({
        connectorTypes: ['slack', 'slack'],
      }).valid,
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// GetCapabilities
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.GetCapabilities contract', () => {
  it('accepts an empty request', () => {
    expect(validateConnectorGetCapabilitiesRequest({}).valid).toBe(true);
  });

  it('accepts a request with tenantContext + idempotencyKey', () => {
    expect(
      validateConnectorGetCapabilitiesRequest({
        tenantContext: { tenantId: 't' },
        idempotencyKey: 'k',
      }).valid,
    ).toBe(true);
  });

  it('accepts a response with every capability enum value', () => {
    const res = JSON.parse(
      JSON.stringify({
        capabilities: [
          {
            capability: 'CONNECTOR_CAPABILITY_EMAIL_MARKETING',
            providers: [
              { connectorType: 'mailchimp', requiredScopes: ['readonly'] },
            ],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_HRIS',
            providers: [
              { connectorType: 'bamboohr', requiredScopes: ['employee:read'] },
            ],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_ACCOUNTING',
            providers: [{ connectorType: 'quickbooks', requiredScopes: [] }],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_SUPPORT_TICKETING',
            providers: [{ connectorType: 'zendesk', requiredScopes: ['read'] }],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_ATS',
            providers: [
              { connectorType: 'greenhouse', requiredScopes: ['candidates:read'] },
            ],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_CRM',
            providers: [{ connectorType: 'salesforce', requiredScopes: ['api'] }],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_INCIDENT_MANAGEMENT',
            providers: [
              { connectorType: 'pagerduty', requiredScopes: ['incidents.read'] },
            ],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_ERROR_TRACKING',
            providers: [{ connectorType: 'sentry', requiredScopes: ['event:read'] }],
          },
          {
            capability: 'CONNECTOR_CAPABILITY_PROJECT_MANAGEMENT',
            providers: [{ connectorType: 'linear', requiredScopes: ['issues:read'] }],
          },
        ],
      }),
    );
    expect(validateConnectorGetCapabilitiesResponse(res).valid).toBe(true);
  });

  it('rejects response with unknown capability enum value', () => {
    expect(
      validateConnectorGetCapabilitiesResponse({
        capabilities: [
          {
            capability: 'CONNECTOR_CAPABILITY_MADE_UP',
            providers: [{ connectorType: 'x', requiredScopes: [] }],
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it('rejects provider missing requiredScopes', () => {
    expect(
      validateConnectorGetCapabilitiesResponse({
        capabilities: [
          {
            capability: 'CONNECTOR_CAPABILITY_CRM',
            providers: [{ connectorType: 'salesforce' }],
          },
        ],
      }).valid,
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ListTools
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.ListTools contract', () => {
  it('accepts an empty request (platform-wide tools, no cache hint)', () => {
    expect(validateConnectorListToolsRequest({}).valid).toBe(true);
  });

  it('accepts a request with connectorTypes + cachedVersion', () => {
    expect(
      validateConnectorListToolsRequest({
        tenantContext: { tenantId: 't-1' },
        connectorTypes: ['slack', 'google_mail'],
        cachedVersion: 'abc1234567890def',
      }).valid,
    ).toBe(true);
  });

  it('rejects duplicate connectorTypes', () => {
    expect(
      validateConnectorListToolsRequest({
        connectorTypes: ['slack', 'slack'],
      }).valid,
    ).toBe(false);
  });

  it('accepts an unchanged response (empty toolSets, unchanged=true)', () => {
    expect(
      validateConnectorListToolsResponse({
        toolSets: [],
        version: 'abc1234567890def',
        unchanged: true,
      }).valid,
    ).toBe(true);
  });

  it('accepts a populated response with mixed read + write tools', () => {
    const res = JSON.parse(
      JSON.stringify({
        version: 'abc1234567890def',
        unchanged: false,
        toolSets: [
          {
            connectorType: 'slack',
            displayName: 'Slack',
            tools: [
              {
                name: 'post_message',
                description: 'Post a message to a channel.',
                inputSchema: {
                  type: 'object',
                  properties: { channel: { type: 'string' } },
                  required: ['channel'],
                },
                categories: ['write'],
                isWrite: true,
              },
              {
                name: 'list_channels',
                description: 'List channels visible to the bot.',
                inputSchema: { type: 'object', properties: {} },
                categories: ['read'],
                isWrite: false,
              },
            ],
          },
        ],
      }),
    );
    expect(validateConnectorListToolsResponse(res).valid).toBe(true);
  });

  it('rejects a response missing version', () => {
    expect(
      validateConnectorListToolsResponse({
        toolSets: [],
        unchanged: true,
      }).valid,
    ).toBe(false);
  });

  it('rejects a tool missing isWrite', () => {
    expect(
      validateConnectorListToolsResponse({
        version: 'v',
        unchanged: false,
        toolSets: [
          {
            connectorType: 'slack',
            displayName: 'Slack',
            tools: [
              {
                name: 'list_channels',
                description: '',
                inputSchema: { type: 'object' },
                categories: ['read'],
              },
            ],
          },
        ],
      }).valid,
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ListTenantConnectors
// ──────────────────────────────────────────────────────────────────────
describe('ConnectorService.ListTenantConnectors contract', () => {
  it('accepts a minimal request with tenantContext only', () => {
    expect(
      validateConnectorListTenantConnectorsRequest({
        tenantContext: { tenantId: 't-1' },
      }).valid,
    ).toBe(true);
  });

  it('accepts a request with connectorTypes + statuses filters', () => {
    expect(
      validateConnectorListTenantConnectorsRequest({
        tenantContext: { tenantId: 't-1' },
        connectorTypes: ['slack', 'github'],
        statuses: ['active', 'disabled'],
      }).valid,
    ).toBe(true);
  });

  it('rejects missing tenantContext (tenant-scoped RPC)', () => {
    expect(
      validateConnectorListTenantConnectorsRequest({ connectorTypes: [] }).valid,
    ).toBe(false);
  });

  it('rejects unknown status enum value', () => {
    expect(
      validateConnectorListTenantConnectorsRequest({
        tenantContext: { tenantId: 't-1' },
        statuses: ['banana'],
      }).valid,
    ).toBe(false);
  });

  it('accepts an empty-list response', () => {
    expect(
      validateConnectorListTenantConnectorsResponse({ connectors: [] }).valid,
    ).toBe(true);
  });

  it('accepts a populated response with full fields', () => {
    const res = JSON.parse(
      JSON.stringify({
        connectors: [
          {
            id: 'c-1',
            connectorType: 'slack',
            displayName: 'Slack',
            name: 'Engineering Slack',
            status: 'active',
            flowKind: 'AUTH_FLOW_KIND_STATIC_OAUTH',
            apiKeyHint: '',
            lastSyncAtEpochSec: 1700000000,
            createdAtEpochSec: 1699999000,
            updatedAtEpochSec: 1700000500,
          },
          {
            id: 'c-2',
            connectorType: 'sendgrid',
            displayName: 'SendGrid',
            name: 'Prod SendGrid',
            status: 'active',
            flowKind: 'AUTH_FLOW_KIND_API_KEY',
            apiKeyHint: '•••abcd',
            lastSyncAtEpochSec: 0,
            createdAtEpochSec: 1700000000,
            updatedAtEpochSec: 1700000000,
          },
        ],
      }),
    );
    expect(validateConnectorListTenantConnectorsResponse(res).valid).toBe(true);
  });

  it('rejects unknown flowKind enum value', () => {
    expect(
      validateConnectorListTenantConnectorsResponse({
        connectors: [
          {
            id: 'c-1',
            connectorType: 'slack',
            displayName: 'Slack',
            name: 'Slack',
            status: 'active',
            flowKind: 'AUTH_FLOW_KIND_PSYCHIC',
            apiKeyHint: '',
            lastSyncAtEpochSec: 0,
            createdAtEpochSec: 0,
            updatedAtEpochSec: 0,
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it('rejects response missing required field (createdAtEpochSec)', () => {
    expect(
      validateConnectorListTenantConnectorsResponse({
        connectors: [
          {
            id: 'c-1',
            connectorType: 'slack',
            displayName: 'Slack',
            name: 'Slack',
            status: 'active',
            flowKind: 'AUTH_FLOW_KIND_STATIC_OAUTH',
            apiKeyHint: '',
            lastSyncAtEpochSec: 0,
            updatedAtEpochSec: 0,
          },
        ],
      }).valid,
    ).toBe(false);
  });
});
