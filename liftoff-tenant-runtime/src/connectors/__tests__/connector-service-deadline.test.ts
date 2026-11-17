// A connector-service RPC ends when its deadline passes, over the REAL
// transport the runtime uses (HTTP/2, buildTransportOptions), against a server
// that accepts the stream and never answers. The gateway passes the deadline
// per call; this pins that the transport actually enforces it and releases the
// stream rather than waiting on it.

import http2 from 'http2';
import type { AddressInfo } from 'net';
import { createClient, ConnectError, Code } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { ConnectorService } from '@liftoffos/proto-gen';
import { buildTransportOptions } from '../connector-service-client';

describe('connector-service RPC deadline over the real transport', () => {
  let server: http2.Http2Server;
  let url: string;
  let openStreams = 0;
  let seen = 0;
  let cancelledByClient = false;
  const sessions = new Set<http2.ServerHttp2Session>();

  beforeAll(async () => {
    server = http2.createServer();
    server.on('session', (session) => {
      sessions.add(session);
      session.on('close', () => sessions.delete(session));
    });
    server.on('stream', (stream) => {
      seen += 1;
      openStreams += 1;
      stream.on('close', () => {
        openStreams -= 1;
        // The client reset the stream: it gave up on it rather than leaving it open.
        cancelledByClient = stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR;
      });
      // A client reset surfaces here as an error event; it is the expected outcome.
      stream.on('error', () => undefined);
      stream.resume(); // read the request, never respond
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // The transport keeps its HTTP/2 session alive between RPCs; end it here.
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects with DeadlineExceeded within the deadline and closes the stream', async () => {
    const client = createClient(ConnectorService, createConnectTransport(buildTransportOptions(url, [])));

    const startedAt = Date.now();
    const err = await client.execute(
      { connectorId: 'c', functionName: 'f', idempotencyKey: 'k', traceId: 't' } as never,
      { timeoutMs: 200 },
    ).catch((e: unknown) => e);

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.DeadlineExceeded);
    expect(seen).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(openStreams).toBe(0);
    expect(cancelledByClient).toBe(true);
  });
});
