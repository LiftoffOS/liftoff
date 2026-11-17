// The `internal:<type>` form resolves the platform's own identity for a
// vendor with no per-tenant row. It answers for a card whose status is
// 'internal' (nobody can connect it) and for a visible card the platform
// keeps serving beside a workspace's own connection (`platformServed`:
// strale and gloria run on the x402 wallet or a platform key for every
// workspace that did not bring a key). A visible card without that flag is
// still refused, because the type alone is ambiguous across its instances.

const mockGetCredentials = jest.fn();
const mockGetConnectorConfig = jest.fn();

jest.mock('../../credentials/service.js', () => ({
  credentialService: {
    getCredentials: (...a: unknown[]) => mockGetCredentials(...a),
    getConnectorConfig: (...a: unknown[]) => mockGetConnectorConfig(...a),
  },
  OAuthRefreshError: class OAuthRefreshError extends Error {},
}));

jest.mock('../../oauth/composio-client.js', () => ({
  getComposio: () => ({ tools: { execute: jest.fn() } }),
}));

jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CONNECTORS } from '../../catalog/connectors.js';
import {
  runConnectorExecution,
  registerConnectorExecutor,
  unregisterAllConnectorExecutors,
} from '../execute-dispatcher.js';

afterEach(() => {
  unregisterAllConnectorExecutors();
  jest.clearAllMocks();
});

async function runInternal(connectorType: string) {
  return runConnectorExecution({
    tenantId: 't1',
    connectorId: `internal:${connectorType}`,
    functionName: 'do_thing',
    input: {},
    idempotencyKey: 'k1',
    traceId: 'tr1',
  });
}

it('the two visible platform-served cards carry the flag and no other visible card does', () => {
  expect(CONNECTORS.strale.status).toBe('available');
  expect(CONNECTORS.strale.platformServed).toBe(true);
  expect(CONNECTORS.gloria.status).toBe('available');
  expect(CONNECTORS.gloria.platformServed).toBe(true);
  const others = Object.entries(CONNECTORS)
    .filter(([, def]) => def.status !== 'internal' && def.platformServed)
    .map(([type]) => type)
    .sort();
  expect(others).toEqual(['gloria', 'strale']);
});

it.each(['strale', 'gloria'])('resolves internal:%s on the platform identity, with no connector row read', async (type) => {
  const executor = jest.fn(async () => ({ result: { ok: true } }));
  registerConnectorExecutor(type, executor as never);
  const resp = await runInternal(type);
  expect(resp.success).toBe(true);
  expect(executor).toHaveBeenCalledTimes(1);
  const ctx = (executor.mock.calls[0] as unknown[])[0] as { connectorId: string; connectorType: string; credentials: { flowKind: string } };
  expect(ctx.connectorId).toBe(`internal:${type}`);
  expect(ctx.connectorType).toBe(type);
  expect(ctx.credentials.flowKind).toBe('api_key');
  expect(mockGetCredentials).not.toHaveBeenCalled();
  expect(mockGetConnectorConfig).not.toHaveBeenCalled();
});

it('still resolves a card whose status is internal', async () => {
  const internalType = Object.entries(CONNECTORS).find(([, def]) => def.status === 'internal')?.[0];
  expect(internalType).toBeDefined();
  const executor = jest.fn(async () => ({ result: { ok: true } }));
  registerConnectorExecutor(internalType as string, executor as never);
  expect((await runInternal(internalType as string)).success).toBe(true);
});

it('refuses a visible card the platform does not serve on its own identity', async () => {
  expect(CONNECTORS.slack.status).not.toBe('internal');
  expect(CONNECTORS.slack.platformServed).toBeUndefined();
  const executor = jest.fn(async () => ({ result: { ok: true } }));
  registerConnectorExecutor('slack', executor as never);
  await expect(runInternal('slack')).rejects.toThrow('no internal connector type slack');
  await expect(runInternal('no_such_vendor')).rejects.toThrow('no internal connector type no_such_vendor');
  expect(executor).not.toHaveBeenCalled();
});
