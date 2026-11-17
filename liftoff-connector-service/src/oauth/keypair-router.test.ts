// Tests for the keypair router — provider-config validation, RSA key
// generation + fingerprint, and the verify path.

import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { jest } from '@jest/globals';

// Stub the audit publisher so the setup handler's
// publishAuditEvent(connector.keypair_setup_started) call doesn't try to
// reach Pub/Sub and stall the test until jest timeout. ts-jest hoists
// jest.mock() above imports at module-init time, so this still mocks
// before `keypair-router.js` resolves its `publishAuditEvent` import.
jest.mock('../events/audit-publisher.js', () => ({
  publishAuditEvent: jest.fn(() => Promise.resolve()),
}));

import { keypairRouter, usesKeyPairAuth } from './keypair-router.js';
import * as ops from './connector-ops.js';
import { credentialService } from '../credentials/service.js';

function makeServer(): Promise<{ server: http.Server; url: string }> {
  const app = express();
  app.use('/api/connectors/keypair', express.json(), keypairRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

describe('keypair-router — helpers', () => {
  it('usesKeyPairAuth is true for snowflake', () => {
    expect(usesKeyPairAuth('snowflake')).toBe(true);
  });
  it('usesKeyPairAuth is false for everything else', () => {
    expect(usesKeyPairAuth('github')).toBe(false);
    expect(usesKeyPairAuth('databricks')).toBe(false);
  });
});

describe('keypair-router — HTTP endpoints', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('setup rejects unsupported connector type', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/github/setup')
        .set('x-account-id', 'a1')
        .send({ tenantId: 't1' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('setup rejects missing tenantId', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/snowflake/setup')
        .set('x-account-id', 'a1')
        .send({ accountIdentifier: 'acme', username: 'alice' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('setup rejects missing provider config fields', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/snowflake/setup')
        .set('x-account-id', 'a1')
        .send({ tenantId: 't1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/accountIdentifier/);
    } finally {
      server.close();
    }
  });

  it('setup rejects missing x-account-id', async () => {
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/snowflake/setup')
        .send({ tenantId: 't1', accountIdentifier: 'acme', username: 'alice' });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('happy path: generates PEM keypair, persists credential, returns fingerprint', async () => {
    jest.spyOn(ops, 'createConnector').mockResolvedValue({
      id: 'sn-1',
      tenantId: 't1',
      type: 'snowflake',
      name: 'Snowflake',
      status: 'pending',
      config: {},
      apiKeyHint: null,
    });
    const storeSpy = jest.spyOn(credentialService, 'storeCredentials').mockResolvedValue(undefined);

    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/snowflake/setup')
        .set('x-account-id', 'a1')
        .send({
          tenantId: 't1',
          accountIdentifier: 'acme-123',
          username: 'alice',
        });
      expect(res.status).toBe(200);
      expect(res.body.connectorId).toBe('sn-1');
      expect(res.body.publicKey).toContain('BEGIN PUBLIC KEY');
      expect(res.body.fingerprint).toMatch(/^SHA256:/);
      expect(Array.isArray(res.body.instructions)).toBe(true);
      expect(res.body.instructions.join(' ')).toContain('alice');

      // credentialService received the generated private key
      expect(storeSpy).toHaveBeenCalled();
      const storeArgs = storeSpy.mock.calls[0];
      expect(storeArgs[0]).toBe('t1');
      expect(storeArgs[1]).toBe('sn-1');
      expect(storeArgs[2]).toBe('keypair');
      expect((storeArgs[3] as { privateKey?: string }).privateKey).toContain('BEGIN PRIVATE KEY');
    } finally {
      server.close();
    }
  });

  it('verify: 404 when connector does not exist', async () => {
    jest.spyOn(ops, 'getConnectorById').mockResolvedValue(null);
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/snowflake/verify')
        .set('x-account-id', 'a1')
        .send({ connectorId: 'missing', tenantId: 't1' });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('verify: 400 when connector type mismatches', async () => {
    jest.spyOn(ops, 'getConnectorById').mockResolvedValue({
      id: 'x-1',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub',
      status: 'active',
      config: {},
      apiKeyHint: null,
    });
    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/snowflake/verify')
        .set('x-account-id', 'a1')
        .send({ connectorId: 'x-1', tenantId: 't1' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('verify: flips status to pending and returns 200', async () => {
    jest.spyOn(ops, 'getConnectorById').mockResolvedValue({
      id: 'sn-1',
      tenantId: 't1',
      type: 'snowflake',
      name: 'Snowflake',
      status: 'active',
      config: {},
      apiKeyHint: null,
    });
    const statusSpy = jest.spyOn(ops, 'updateConnectorStatus').mockResolvedValue({
      id: 'sn-1',
      tenantId: 't1',
      type: 'snowflake',
      name: 'Snowflake',
      status: 'pending',
      config: {},
      apiKeyHint: null,
    });

    const { server, url } = await makeServer();
    try {
      const res = await request(url)
        .post('/api/connectors/keypair/snowflake/verify')
        .set('x-account-id', 'a1')
        .send({ connectorId: 'sn-1', tenantId: 't1' });
      expect(res.status).toBe(200);
      expect(res.body.connectorId).toBe('sn-1');
      expect(statusSpy).toHaveBeenCalledWith('t1', 'sn-1', 'pending');
    } finally {
      server.close();
    }
  });
});
