// Tests for the API-key router — config endpoint, validation, and the
// happy path that stores secrets + upserts the credential row.

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';

// Stub the audit publisher so the connect handler's audit fire doesn't
// stall the test against an unreachable Pub/Sub topic. ts-jest hoists
// jest.mock() above imports at module-init time, so the mock is in
// place before `apikey-router.js` resolves its publisher import.
jest.mock('../events/audit-publisher.js', () => ({
  publishAuditEvent: jest.fn(() => Promise.resolve()),
}));

import { apikeyRouter, usesApiKeyAuth, API_KEY_CONNECTOR_CONFIGS } from './apikey-router.js';
import { CONNECTORS } from '../catalog/connectors.js';
import * as ops from './connector-ops.js';
import { credentialService } from '../credentials/service.js';

function makeServer(): Promise<{ server: http.Server; url: string }> {
  const app = express();
  app.use('/api/connectors/apikey', express.json(), apikeyRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

describe('apikey-router — config map', () => {
  it('usesApiKeyAuth is true for supported providers', () => {
    expect(usesApiKeyAuth('sendgrid')).toBe(true);
    expect(usesApiKeyAuth('trello')).toBe(true);
    expect(usesApiKeyAuth('bamboohr')).toBe(true);
    expect(usesApiKeyAuth('cal_com')).toBe(true);
  });

  it('usesApiKeyAuth is false for OAuth connectors', () => {
    expect(usesApiKeyAuth('github')).toBe(false);
    expect(usesApiKeyAuth('slack')).toBe(false);
    expect(usesApiKeyAuth('unknown-type')).toBe(false);
  });

  // A Composio toolkit whose auth mode is BASIC (username + password) must carry
  // composioAuthScheme: 'BASIC', or the connect submits AuthScheme.APIKey and
  // fails only at connect time — every build stays green. Pinned here for the
  // toolkits known to be BASIC.
  it('BASIC-auth Composio toolkits declare composioAuthScheme BASIC with username + password fields', () => {
    for (const type of ['mixpanel', 'clicksend', 'dataforseo']) {
      const cfg = API_KEY_CONNECTOR_CONFIGS[type];
      expect(cfg).toBeDefined();
      expect(cfg.composioAuthScheme).toBe('BASIC');
      expect(cfg.fields.map((f) => f.composioField)).toEqual(['username', 'password']);
      expect(cfg.fields.every((f) => f.required)).toBe(true);
    }
  });

  it('every supported provider has at least one required field', () => {
    for (const [name, cfg] of Object.entries(API_KEY_CONNECTOR_CONFIGS)) {
      expect(cfg.fields.length).toBeGreaterThan(0);
      expect(cfg.fields.some((f) => f.required)).toBe(true);
      expect(typeof cfg.displayName).toBe('string');
      // sanity: name key exists
      expect(name.length).toBeGreaterThan(0);
    }
  });

  // Regression guard for the "Unable to load configuration for this connector"
  // modal error. A status:'available', auth.kind:'api_key', no-MCP connector is a
  // native REST connector whose Connect modal loads its form from
  // API_KEY_CONNECTOR_CONFIGS via GET /:type/config. Missing here → the endpoint
  // 400s, the modal cannot render a form, and the connector cannot be connected at
  // all. pdl/hunterio/saperly/warp all shipped that way. (composio_managed api_key
  // connectors keep their own entries; internal/coming_soon are not user-connectable.)
  it('every user-connectable native api_key connector has a connect-form config', () => {
    const missing = Object.values(CONNECTORS)
      .filter((c) => c.status === 'available' && c.auth?.kind === 'api_key' && !c.mcp)
      .map((c) => c.type)
      .filter((t) => !(t in API_KEY_CONNECTOR_CONFIGS))
      .sort();
    expect(missing).toEqual([]);
  });
});

describe('apikey-router — HTTP endpoints', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GET config returns the field definitions', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url).get('/api/connectors/apikey/sendgrid/config');
      expect(res.status).toBe(200);
      expect(res.body.connectorType).toBe('sendgrid');
      expect(res.body.fields[0].name).toBe('apiKey');
    } finally {
      server.close();
    }
  });

  it('GET config carries the connect modal sentence for a connector whose credential is not an API key, and none for the rest', async () => {
    const { server, url } = await makeServer();
    try {
      const onepassword = await request(url).get('/api/connectors/apikey/onepassword/config');
      expect(onepassword.status).toBe(200);
      expect(onepassword.body.description).toBe(API_KEY_CONNECTOR_CONFIGS.onepassword.description);
      expect(onepassword.body.description).toContain('service account token');
      expect(onepassword.body.fields).toEqual([
        { name: 'apiKey', label: 'Service Account Token', type: 'password', required: true, placeholder: 'ops_...' },
      ]);
      const sendgrid = await request(url).get('/api/connectors/apikey/sendgrid/config');
      expect(sendgrid.body).not.toHaveProperty('description');
    } finally {
      server.close();
    }
  });

  it('GET config returns 400 for unsupported connector', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url).get('/api/connectors/apikey/nope/config');
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('POST connect rejects missing tenantId', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/sendgrid/connect')
        .set('x-account-id', 'acct_1')
        .send({ apiKey: 'SG.abcd' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tenantId/);
    } finally {
      server.close();
    }
  });

  it('POST connect rejects missing x-account-id', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/sendgrid/connect')
        .send({ tenantId: 't1', apiKey: 'SG.abcd' });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('POST connect rejects empty API key (required field)', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/sendgrid/connect')
        .set('x-account-id', 'acct_1')
        .send({ tenantId: 't1', apiKey: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/API Key is required/);
    } finally {
      server.close();
    }
  });

  it('POST connect rejects unsupported connector type', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/nope/connect')
        .set('x-account-id', 'acct_1')
        .send({ tenantId: 't1', apiKey: 'x' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('happy path: stores secret + upserts credential row', async () => {
    jest.spyOn(ops, 'findConnectorByTenantAndType').mockResolvedValue(null);
    const created = {
      id: 'c-42',
      tenantId: 't1',
      type: 'sendgrid',
      name: 'SendGrid',
      status: 'pending' as const,
      config: {},
      apiKeyHint: null,
    };
    jest.spyOn(ops, 'createConnector').mockResolvedValue(created);
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({
      ...created,
      status: 'active',
    });
    const hintSpy = jest.spyOn(ops, 'updateApiKeyHint').mockResolvedValue(undefined);
    const storeSpy = jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/sendgrid/connect')
        .set('x-account-id', 'acct_1')
        .send({ tenantId: 't1', apiKey: 'SG.abcdef1234' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.connectorId).toBe('c-42');
      expect(storeSpy).toHaveBeenCalledWith(
        't1',
        'c-42',
        'api_key',
        expect.objectContaining({ apiKey: 'SG.abcdef1234' }),
        [],
      );
      // hint is •••1234 (last 4)
      expect(hintSpy).toHaveBeenCalledWith('t1', 'c-42', expect.stringContaining('1234'));
    } finally {
      server.close();
    }
  });

  it('reconnect via connectorId body param targets that row and never stores connectorId as a credential', async () => {
    const target = {
      id: 'c-target',
      tenantId: 't1',
      type: 'sendgrid',
      name: 'SendGrid',
      status: 'error' as const,
      config: {},
      apiKeyHint: null,
    };
    const getSpy = jest.spyOn(ops, 'getConnectorById').mockResolvedValue(target);
    const findSpy = jest.spyOn(ops, 'findConnectorByTenantAndType');
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({ ...target, status: 'pending' });
    jest.spyOn(ops, 'updateApiKeyHint').mockResolvedValue(undefined);
    const storeSpy = jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);
    const createSpy = jest.spyOn(ops, 'createConnector');

    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/sendgrid/connect')
        .set('x-account-id', 'acct_1')
        // connectorId in the body is the reconnect target (routing), NOT a credential.
        .send({ tenantId: 't1', connectorId: 'c-target', apiKey: 'SG.abcdef1234' });
      expect(res.status).toBe(200);
      expect(res.body.connectorId).toBe('c-target');
      expect(getSpy).toHaveBeenCalledWith('t1', 'c-target'); // reconnect target reused
      expect(findSpy).not.toHaveBeenCalled(); // reconnectId short-circuits the type lookup
      expect(createSpy).not.toHaveBeenCalled();
      // A4: connectorId must not leak into the persisted credential blob.
      const blob = storeSpy.mock.calls[0]?.[3] as {
        metadata?: { extraFields?: Record<string, unknown> };
      };
      expect(blob.metadata?.extraFields ?? {}).not.toHaveProperty('connectorId');
    } finally {
      server.close();
    }
  });

  it('a different account of a type gets its own row, whatever rows the type already has', async () => {
    // Databricks derives its identity from the workspace URL with no network
    // call. No row carries this workspace, so the connect creates one; that
    // the tenant already has a Databricks row (say, a disconnected one) is
    // not the connect's concern — rows are one per account, not one per type.
    const byAccount = jest.spyOn(ops, 'findConnectorByTenantTypeAndExternalAccountId').mockResolvedValue(null);
    const created = {
      id: 'c-second',
      tenantId: 't1',
      type: 'databricks',
      name: 'Databricks',
      status: 'pending' as const,
      config: { externalAccountId: 'https://second.cloud.databricks.com', externalAccountLabel: 'https://second.cloud.databricks.com' },
      apiKeyHint: null,
    };
    const createSpy = jest.spyOn(ops, 'createConnectorReusingOnAccountConflict').mockResolvedValue(created);
    const legacyFind = jest.spyOn(ops, 'findConnectorByTenantAndType');
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({ ...created, status: 'pending' });
    jest.spyOn(ops, 'updateApiKeyHint').mockResolvedValue(undefined);
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/databricks/connect')
        .set('x-account-id', 'acct_1')
        .send({ tenantId: 't1', workspaceUrl: 'https://second.cloud.databricks.com', patToken: 'dapi-second' });
      expect(res.status).toBe(200);
      expect(res.body.connectorId).toBe('c-second');
      expect(byAccount).toHaveBeenCalledWith('t1', 'databricks', 'https://second.cloud.databricks.com');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 't1', type: 'databricks', name: 'Databricks' }),
        'https://second.cloud.databricks.com',
      );
      // The identity decides; the single-row-per-type lookup is never consulted.
      expect(legacyFind).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('reconnect path reuses existing connector id', async () => {
    const existing = {
      id: 'c-old',
      tenantId: 't1',
      type: 'sendgrid',
      name: 'SendGrid',
      status: 'active' as const,
      config: {},
      apiKeyHint: null,
    };
    jest.spyOn(ops, 'findConnectorByTenantAndType').mockResolvedValue(existing);
    jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({
      ...existing,
      status: 'pending',
    });
    jest.spyOn(ops, 'updateApiKeyHint').mockResolvedValue(undefined);
    jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);
    const createSpy = jest.spyOn(ops, 'createConnector');

    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/apikey/sendgrid/connect')
        .set('x-account-id', 'acct_1')
        .send({ tenantId: 't1', apiKey: 'SG.abcdef1234' });
      expect(res.status).toBe(200);
      expect(res.body.connectorId).toBe('c-old');
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
