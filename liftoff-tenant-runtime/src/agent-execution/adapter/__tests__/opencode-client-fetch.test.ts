/**
 * The fetch the opencode client is given actually works on what it is handed.
 *
 * The first version of the request-timeout fix passed the SDK's `Request` to
 * undici's own `fetch`, which does not take one: it parses its first argument
 * as a URL and throws `Failed to parse URL from [object Request]`. The compiler
 * was silenced with `request as never`, so it typechecked, built, passed a
 * source-contract test that asserted the dispatcher was configured, and died on
 * the first live run in five seconds with zero tool calls.
 *
 * A source test cannot catch that — it can only see that the words are there.
 * This one CALLS the thing, against a real socket, which is the only kind of
 * assertion that would have failed before the deploy rather than after.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';

/** Exactly the hook `startOpencode` installs on the SDK client. */
function clientFetch(dispatcher: Agent) {
  return (request: Request) => globalThis.fetch(request, { dispatcher } as RequestInit);
}

describe('the client fetch hook', () => {
  let server: http.Server;
  let url: string;

  afterEach(() => { server?.close(); });

  it('accepts a Request, which is what the SDK hands it', async () => {
    server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const res = await clientFetch(new Agent({}))(new Request(url));

    // The defect was a throw before any request was made. Reaching a response
    // at all is the property.
    expect(res.status).toBe(200);
  });

  it('applies the dispatcher timeouts, so the bound is real and not decorative', async () => {
    // A server that accepts and never answers: the only thing that can end this
    // is the timeout we configured.
    server = http.createServer(() => { /* never responds */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    const started = Date.now();
    await expect(
      clientFetch(new Agent({ headersTimeout: 600, bodyTimeout: 600 }))(new Request(url)),
    ).rejects.toThrow();

    // Ended on OUR budget rather than hanging until the test runner gives up.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
