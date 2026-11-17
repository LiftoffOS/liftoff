import {
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
  validateGovernanceListApprovalsRequest,
  validateGovernanceListApprovalsResponse,
} from './index.js';

describe('ConnectorService.Warm', () => {
  it('accepts a valid request', () => {
    expect(
      validateConnectorWarmRequest({
        tenantId: 't',
        connectorTypes: ['slack', 'github'],
      }).valid,
    ).toBe(true);
  });

  it('rejects missing tenantId', () => {
    expect(
      validateConnectorWarmRequest({ connectorTypes: ['slack'] }).valid,
    ).toBe(false);
  });

  it('accepts response with warmed list + failures', () => {
    expect(
      validateConnectorWarmResponse({
        warmedConnectorTypes: ['slack'],
        failures: [{ connectorType: 'github', reason: 'no credentials stored' }],
      }).valid,
    ).toBe(true);
  });

  it('rejects response missing failures', () => {
    expect(
      validateConnectorWarmResponse({
        warmedConnectorTypes: ['slack'],
      }).valid,
    ).toBe(false);
  });

  it('rejects response with malformed failure entry', () => {
    expect(
      validateConnectorWarmResponse({
        warmedConnectorTypes: [],
        failures: [{ connectorType: 'github' }], // missing reason
      }).valid,
    ).toBe(false);
  });
});

describe('ConnectorService.GetCredentials', () => {
  it('accepts a valid request', () => {
    expect(
      validateConnectorGetCredentialsRequest({ tenantId: 't', connectorId: 'c' }).valid,
    ).toBe(true);
  });

  it('accepts oauth response', () => {
    expect(
      validateConnectorGetCredentialsResponse({
        flowKind: 'static_oauth',
        oauth: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresAtEpochSec: 9999999999,
          scopes: ['read', 'write'],
        },
      }).valid,
    ).toBe(true);
  });

  it('accepts api_key response', () => {
    expect(
      validateConnectorGetCredentialsResponse({
        flowKind: 'api_key',
        apiKey: { apiKey: 'xyz' },
      }).valid,
    ).toBe(true);
  });

  it('accepts keypair response', () => {
    expect(
      validateConnectorGetCredentialsResponse({
        flowKind: 'keypair',
        keypair: { publicKey: 'pub', privateKey: 'priv', keyId: 'kid' },
      }).valid,
    ).toBe(true);
  });

  it('rejects unknown flow kind', () => {
    expect(
      validateConnectorGetCredentialsResponse({ flowKind: 'unknown' }).valid,
    ).toBe(false);
  });

  it('rejects response missing required field inside discriminator', () => {
    expect(
      validateConnectorGetCredentialsResponse({
        flowKind: 'api_key',
        apiKey: {}, // missing apiKey string
      }).valid,
    ).toBe(false);
  });
});

describe('ConnectorService.GetFunctionalTypes', () => {
  it('accepts an empty request (platform-wide list)', () => {
    expect(validateConnectorGetFunctionalTypesRequest({}).valid).toBe(true);
  });

  it('accepts a request scoped by tenantContext', () => {
    expect(
      validateConnectorGetFunctionalTypesRequest({
        tenantContext: { tenantId: 't-1', agentId: 'ag-1' },
      }).valid,
    ).toBe(true);
  });

  it('accepts a request with idempotencyKey', () => {
    expect(
      validateConnectorGetFunctionalTypesRequest({
        idempotencyKey: 'k-1',
      }).valid,
    ).toBe(true);
  });

  it('rejects a tenantContext missing tenantId but present', () => {
    expect(
      validateConnectorGetFunctionalTypesRequest({
        tenantContext: { tenantId: '' },
      }).valid,
    ).toBe(false);
  });

  it('rejects additional top-level properties', () => {
    expect(
      validateConnectorGetFunctionalTypesRequest({ mystery: 1 }).valid,
    ).toBe(false);
  });

  it('accepts an empty-list response', () => {
    expect(
      validateConnectorGetFunctionalTypesResponse({ connectorTypes: [] }).valid,
    ).toBe(true);
  });

  it('accepts a populated-list response', () => {
    expect(
      validateConnectorGetFunctionalTypesResponse({
        connectorTypes: ['github', 'slack', 'google_mail', 'salesforce'],
      }).valid,
    ).toBe(true);
  });

  it('rejects response missing connectorTypes', () => {
    expect(validateConnectorGetFunctionalTypesResponse({}).valid).toBe(false);
  });

  it('rejects duplicates in connectorTypes', () => {
    expect(
      validateConnectorGetFunctionalTypesResponse({
        connectorTypes: ['slack', 'slack'],
      }).valid,
    ).toBe(false);
  });
});

describe('ConnectorService.GetCapabilities', () => {
  it('accepts an empty request', () => {
    expect(validateConnectorGetCapabilitiesRequest({}).valid).toBe(true);
  });

  it('accepts a request with tenantContext + idempotencyKey', () => {
    expect(
      validateConnectorGetCapabilitiesRequest({
        tenantContext: { tenantId: 't-1' },
        idempotencyKey: 'k-1',
      }).valid,
    ).toBe(true);
  });

  it('rejects extra top-level properties', () => {
    expect(
      validateConnectorGetCapabilitiesRequest({ junk: true }).valid,
    ).toBe(false);
  });

  it('accepts a response with empty capability list', () => {
    expect(
      validateConnectorGetCapabilitiesResponse({ capabilities: [] }).valid,
    ).toBe(true);
  });

  it('accepts a response covering every capability enum value', () => {
    const r = validateConnectorGetCapabilitiesResponse({
      capabilities: [
        {
          capability: 'CONNECTOR_CAPABILITY_EMAIL_MARKETING',
          providers: [
            { connectorType: 'mailchimp', requiredScopes: ['readonly'] },
            { connectorType: 'sendgrid', requiredScopes: ['mail.send'] },
          ],
        },
        {
          capability: 'CONNECTOR_CAPABILITY_HRIS',
          providers: [{ connectorType: 'bamboohr', requiredScopes: ['employee:read'] }],
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
          providers: [{ connectorType: 'greenhouse', requiredScopes: ['candidates:read'] }],
        },
        {
          capability: 'CONNECTOR_CAPABILITY_CRM',
          providers: [{ connectorType: 'salesforce', requiredScopes: ['api'] }],
        },
        {
          capability: 'CONNECTOR_CAPABILITY_INCIDENT_MANAGEMENT',
          providers: [{ connectorType: 'pagerduty', requiredScopes: ['incidents.read'] }],
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
    });
    expect(r.valid).toBe(true);
  });

  it('rejects response missing capabilities array', () => {
    expect(validateConnectorGetCapabilitiesResponse({}).valid).toBe(false);
  });

  it('rejects unknown capability enum value', () => {
    const r = validateConnectorGetCapabilitiesResponse({
      capabilities: [
        {
          capability: 'CONNECTOR_CAPABILITY_MADE_UP',
          providers: [{ connectorType: 'x', requiredScopes: [] }],
        },
      ],
    });
    expect(r.valid).toBe(false);
  });

  it('rejects provider missing requiredScopes', () => {
    const r = validateConnectorGetCapabilitiesResponse({
      capabilities: [
        {
          capability: 'CONNECTOR_CAPABILITY_CRM',
          providers: [{ connectorType: 'salesforce' }],
        },
      ],
    });
    expect(r.valid).toBe(false);
  });

  it('rejects provider with empty connectorType', () => {
    const r = validateConnectorGetCapabilitiesResponse({
      capabilities: [
        {
          capability: 'CONNECTOR_CAPABILITY_CRM',
          providers: [{ connectorType: '', requiredScopes: [] }],
        },
      ],
    });
    expect(r.valid).toBe(false);
  });
});

describe('ConnectorService.ListTools', () => {
  it('accepts an empty request', () => {
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
    expect(
      validateConnectorListToolsResponse({
        version: 'abc1234567890def',
        unchanged: false,
        toolSets: [
          {
            connectorType: 'slack',
            displayName: 'Slack',
            tools: [
              {
                name: 'slack.postMessage',
                description: 'Post a message.',
                inputSchema: {
                  type: 'object',
                  properties: { channel: { type: 'string' } },
                },
                categories: ['write'],
                isWrite: true,
              },
              {
                name: 'slack.listChannels',
                description: 'List channels.',
                inputSchema: { type: 'object', properties: {} },
                categories: ['read'],
                isWrite: false,
              },
            ],
          },
        ],
      }).valid,
    ).toBe(true);
  });

  it('rejects response missing version', () => {
    expect(
      validateConnectorListToolsResponse({
        toolSets: [],
        unchanged: true,
      }).valid,
    ).toBe(false);
  });

  it('rejects tool missing isWrite', () => {
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
                name: 'slack.listChannels',
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

describe('ConnectorService.ListTenantConnectors', () => {
  it('accepts a minimal request with tenantContext', () => {
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

  it('rejects missing tenantContext', () => {
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

  it('accepts a response with oauth + api-key connectors side-by-side', () => {
    expect(
      validateConnectorListTenantConnectorsResponse({
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
      }).valid,
    ).toBe(true);
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

  it('rejects response missing createdAtEpochSec', () => {
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

describe('GovernanceEngine.ListApprovals', () => {
  it('accepts a minimal request', () => {
    expect(validateGovernanceListApprovalsRequest({ tenantId: 't' }).valid).toBe(true);
  });

  it('accepts request with pagination + filter', () => {
    expect(
      validateGovernanceListApprovalsRequest({
        tenantId: 't',
        statusFilter: 'pending',
        pageSize: 50,
        pageToken: 'tkn',
      }).valid,
    ).toBe(true);
  });

  it('rejects pageSize > 200', () => {
    expect(
      validateGovernanceListApprovalsRequest({ tenantId: 't', pageSize: 500 }).valid,
    ).toBe(false);
  });

  it('accepts response with empty approvals', () => {
    expect(
      validateGovernanceListApprovalsResponse({ approvals: [] }).valid,
    ).toBe(true);
  });

  it('accepts response with a fully-populated approval', () => {
    const r = validateGovernanceListApprovalsResponse({
      approvals: [
        {
          id: 'a1',
          tenantId: 't',
          workflowId: 'w',
          taskId: 'task',
          agentId: 'ag',
          hitlLevel: 2,
          toolCallsHash: 'hash',
          reason: 'review',
          status: 'pending',
          decidedBy: null,
          decidedByRole: null,
          decision: null,
          rejectionReason: null,
          decidedAt: null,
          expiresAt: '2026-05-01T00:00:00Z',
          createdAt: '2026-04-19T00:00:00Z',
          updatedAt: '2026-04-19T00:00:00Z',
        },
      ],
      nextPageToken: 'next',
    });
    expect(r.valid).toBe(true);
  });

  it('rejects hitlLevel out of range', () => {
    const r = validateGovernanceListApprovalsResponse({
      approvals: [
        {
          id: 'a1',
          tenantId: 't',
          workflowId: 'w',
          taskId: 'task',
          agentId: 'ag',
          hitlLevel: 10,
          status: 'pending',
          expiresAt: '2026-05-01T00:00:00Z',
          createdAt: '2026-04-19T00:00:00Z',
          updatedAt: '2026-04-19T00:00:00Z',
        },
      ],
    });
    expect(r.valid).toBe(false);
  });
});
