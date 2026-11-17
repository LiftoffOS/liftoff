// Execute RPC ↔ registered-executor integration test.
//
// Wires a fake connector type ('test_echo') through createRouterTransport,
// a synthesized ExecuteRequest, and back. This proves the full dispatch
// path works end-to-end without a real DB or network — a regression alarm
// for any future refactor of execute-dispatcher or the Connect handler.

import { createRouterTransport, createClient } from '@connectrpc/connect';
import { ConnectorService } from '@liftoffos/proto-gen';
import { credentialService } from '../credentials/service.js';
import registerConnectorService from './router.js';
import {
  registerConnectorExecutor,
  unregisterAllConnectorExecutors,
} from './execute-dispatcher.js';

function ctx(tenantId: string) {
  return { tenantId, tier: '', projectId: '' };
}

describe('Execute RPC integration — fake client path', () => {
  beforeEach(() => {
    unregisterAllConnectorExecutors();
    jest.restoreAllMocks();
  });

  it('routes Execute through a fake connector client and returns its result', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({
      flowKind: 'api_key',
      apiKey: 'k',
    });
    jest
      .spyOn(credentialService, 'getConnectorConfig')
      .mockResolvedValue({ connectorType: 'test_echo', config: { foo: 'bar' } });

    registerConnectorExecutor('test_echo', async (ctxArg) => ({
      result: {
        functionName: ctxArg.functionName,
        input: ctxArg.input,
        tenantId: ctxArg.tenantId,
        connectorType: ctxArg.connectorType,
        configFoo: (ctxArg.connectorConfig as { foo?: string }).foo ?? '',
        apiKey: ctxArg.credentials.apiKey ?? '',
      },
      fundingSource: 'x402_wallet',
    }));

    const transport = createRouterTransport((router) => {
      registerConnectorService(router);
    });
    const client = createClient(ConnectorService, transport);

    const res = await client.execute({
      tenantContext: ctx('tenant-A'),
      connectorId: 'conn-123',
      functionName: 'echo_ping',
      input: { hello: 'world' },
      idempotencyKey: 'idem-1',
      traceId: 'trace-1',
    });

    expect(res.success).toBe(true);
    // The executor's funding report crosses the wire verbatim.
    expect(res.fundingSource).toBe('x402_wallet');
    expect(res.result).toMatchObject({
      functionName: 'echo_ping',
      input: { hello: 'world' },
      tenantId: 'tenant-A',
      connectorType: 'test_echo',
      configFoo: 'bar',
      apiKey: 'k',
    });
  });

  it('ExecuteBatch fans out to the same executor per operation', async () => {
    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({
      flowKind: 'api_key',
      apiKey: 'k',
    });
    jest
      .spyOn(credentialService, 'getConnectorConfig')
      .mockResolvedValue({ connectorType: 'test_echo', config: {} });

    let count = 0;
    registerConnectorExecutor('test_echo', async (c) => {
      count += 1;
      return { result: { i: count, name: c.functionName } };
    });

    const transport = createRouterTransport((router) => {
      registerConnectorService(router);
    });
    const client = createClient(ConnectorService, transport);

    const res = await client.executeBatch({
      tenantContext: ctx('t'),
      operations: [
        {
          tenantContext: ctx('t'),
          connectorId: 'c1',
          functionName: 'a',
          input: {},
          idempotencyKey: 'k1',
          traceId: 'tr1',
        },
        {
          tenantContext: ctx('t'),
          connectorId: 'c1',
          functionName: 'b',
          input: {},
          idempotencyKey: 'k2',
          traceId: 'tr2',
        },
      ],
    });

    expect(res.results).toHaveLength(2);
    expect(res.results[0].success).toBe(true);
    expect(res.results[1].success).toBe(true);
    expect(res.results[0].result).toMatchObject({ i: 1, name: 'a' });
    expect(res.results[1].result).toMatchObject({ i: 2, name: 'b' });
  });
});

