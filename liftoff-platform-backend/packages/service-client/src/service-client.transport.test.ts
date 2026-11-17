// Transport-level behaviour of ServiceClient against real local servers:
// the client never changes the process's global dispatcher, never offers
// HTTP/2, and a request that stops being answered (at the headers or halfway
// through the body) ends at the client's timeout instead of hanging.
//
// The HTTPS/HTTP/2 servers need a certificate. It is generated per run
// rather than committed, because a checked-in private key (even a throwaway
// one) trips the repository's secret scan. It is built in-process with
// node:crypto, not with the openssl CLI: CI runs jest in node:22-slim, which
// has no openssl binary, and the ENOENT error execFileSync throws there is
// self-referential (err.error === err), so jest-worker cannot even serialize
// the failure ("Converting circular structure to JSON").

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import tls from 'node:tls';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { Agent, getGlobalDispatcher } from 'undici';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  ServiceClient,
  getServiceClientDispatcher,
} from './service-client.js';

jest.mock('./oidc-auth.js', () => ({ buildOidcAuthHeader: async () => ({}) }));

let key: string;
let cert: string;
let certDir: string;

// ── A minimal self-signed X.509 (v1, CN=localhost, P-256/ECDSA-SHA256) ──
// DER is tag, length, value; these few constructors are all a certificate
// needs. Every client in this file skips verification, so no extensions.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len =
    n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
function utcTime(d: Date): Buffer {
  const t = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ -> YYMMDDHHMMSSZ
  return der(0x17, Buffer.from(t.slice(2, 4) + t.slice(5, 7) + t.slice(8, 10) + t.slice(11, 13) + t.slice(14, 16) + t.slice(17, 19) + 'Z'));
}

function selfSignedLocalhost(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('localhost')))));
  const now = Date.now();
  const tbs = seq(
    der(0x02, Buffer.from([0x01])), // serial
    ecdsaSha256,
    name, // issuer
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 24 * 3_600_000))),
    name, // subject
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey); // DER-encoded ECDSA
  const certDer = seq(tbs, ecdsaSha256, der(0x03, Buffer.from([0x00]), signature));
  const pem = certDer.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`,
  };
}

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'service-client-tls-'));
  ({ key, cert } = selfSignedLocalhost());
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

/** Everything a test opened, closed in afterEach whatever the outcome. */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function listen(server: http.Server | http2.Http2SecureServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** An HTTP/1.1 server; `handler` decides how (or whether) to answer. */
async function startHttp1(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = await listen(server);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}`;
}

/** A TLS HTTP/2 server. `allowHTTP1` lets it also serve an HTTP/1.1 client. */
async function startHttp2(
  opts: { allowHTTP1: boolean },
  handler: (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void,
): Promise<string> {
  const server = http2.createSecureServer({ key, cert, allowHTTP1: opts.allowHTTP1 }, handler);
  const sessions = new Set<http2.ServerHttp2Session>();
  const sockets = new Set<Socket>();
  server.on('session', (s) => {
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
  });
  server.on('secureConnection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = await listen(server);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.destroy();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  );
  return `https://localhost:${port}`;
}

function insecureAgent(allowH2: boolean): Agent {
  const agent = new Agent({ allowH2, connect: { rejectUnauthorized: false } });
  cleanups.push(() => agent.destroy());
  return agent;
}

/** Trust the throwaway certificate for one test, for every client in the
 *  process (Node's built-in fetch and the npm undici both call tls.connect),
 *  and record the ALPN protocols each connection offered. */
function trustSelfSignedAndRecordAlpn(): string[][] {
  const offered: string[][] = [];
  const realConnect = tls.connect.bind(tls) as (o: tls.ConnectionOptions, cb?: () => void) => tls.TLSSocket;
  jest.spyOn(tls, 'connect').mockImplementation(((opts: tls.ConnectionOptions, cb?: () => void) => {
    offered.push(((opts.ALPNProtocols as string[] | undefined) ?? []).map(String));
    return realConnect({ ...opts, rejectUnauthorized: false }, cb);
  }) as typeof tls.connect);
  return offered;
}

describe('ServiceClient dispatcher is its own, never the process default', () => {
  it('constructing a ServiceClient leaves the global dispatcher untouched', () => {
    const before = getGlobalDispatcher();
    new ServiceClient({ resolveTargetUrl: async () => 'http://127.0.0.1:1' });
    expect(getGlobalDispatcher()).toBe(before);
    expect(getServiceClientDispatcher()).not.toBeNull();
    expect(getGlobalDispatcher()).not.toBe(getServiceClientDispatcher());
  });

  it('a plain fetch after using a ServiceClient still speaks HTTP/1.1, and so does the client', async () => {
    const offered = trustSelfSignedAndRecordAlpn();
    const seen: string[] = [];
    const base = await startHttp2({ allowHTTP1: true }, (req, res) => {
      seen.push(req.httpVersion);
      res.end('ok');
    });

    const client = new ServiceClient({ resolveTargetUrl: async () => base });
    const viaClient = await client.fetch('k', '/one');
    await viaClient.text();
    const plain = await fetch(`${base}/two`);
    await plain.text();
    // Control: the same server does negotiate HTTP/2 for a client that
    // offers it, so the two '1.1's above are the clients' choice.
    const h2 = await fetch(`${base}/three`, { dispatcher: insecureAgent(true) } as RequestInit);
    await h2.text();

    expect(seen).toEqual(['1.1', '1.1', '2.0']);
    // ALPN: neither of the first two connections even offered h2.
    expect(offered.map((protocols) => protocols.includes('h2'))).toEqual([false, false, true]);
  });

  it('hands its dispatcher and a signal to a custom fetchImpl', async () => {
    const impl = jest.fn(async () => new Response('ok'));
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
      fetchImpl: impl as unknown as typeof fetch,
    });
    await client.fetch('k', '/x', { breakerKey: 'k:x', idempotent: true, timeoutMs: 1_000 });
    const init = (impl.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(init.dispatcher).toBe(getServiceClientDispatcher());
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // ServiceClient-only options stay out of the request.
    expect(init).not.toHaveProperty('breakerKey');
    expect(init).not.toHaveProperty('idempotent');
    expect(init).not.toHaveProperty('timeoutMs');
  });

  it('dispatcher: null leaves the request on the global dispatcher', async () => {
    const impl = jest.fn(async () => new Response('ok'));
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
      fetchImpl: impl as unknown as typeof fetch,
      dispatcher: null,
    });
    await client.fetch('k', '/x');
    const init = (impl.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(init).not.toHaveProperty('dispatcher');
  });
});

describe('the process-wide effect, observed outside jest', () => {
  // Inside jest the test file runs in its own vm context, so a dispatcher
  // installed on that context's globalThis is invisible to Node's built-in
  // fetch, which reads the real one. The leak this package used to cause is
  // only observable in a plain Node process: build the package, construct a
  // ServiceClient there, then make an ordinary fetch.
  const pkgRoot = resolve(__dirname, '..');
  const repoNodeModules = resolve(pkgRoot, '..', '..', 'node_modules');
  let outDir: string;

  beforeAll(() => {
    outDir = join(certDir, 'dist');
    mkdirSync(outDir);
    for (const f of readdirSync(join(pkgRoot, 'src'))) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = readFileSync(join(pkgRoot, 'src', f), 'utf8');
      const out = ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      });
      writeFileSync(join(outDir, f.replace(/\.ts$/, '.js')), out.outputText);
    }
    writeFileSync(join(certDir, 'key.pem'), key);
    writeFileSync(join(certDir, 'cert.pem'), cert);
  });

  it('a plain fetch in a process that constructed a ServiceClient does not negotiate HTTP/2', () => {
    const script = `
      const http2 = require('node:http2');
      const fs = require('node:fs');
      const path = require('node:path');
      const { ServiceClient } = require(path.join(process.env.SC_DIST, 'index.js'));
      const server = http2.createSecureServer({
        key: fs.readFileSync(path.join(process.env.SC_CERTS, 'key.pem')),
        cert: fs.readFileSync(path.join(process.env.SC_CERTS, 'cert.pem')),
        allowHTTP1: true,
      }, (req, res) => res.end(req.httpVersion));
      server.listen(0, '127.0.0.1', async () => {
        new ServiceClient({ resolveTargetUrl: async () => 'http://127.0.0.1:1' });
        const res = await fetch('https://localhost:' + server.address().port + '/');
        process.stdout.write(await res.text());
        process.exit(0);
      });
    `;
    let out: string;
    try {
      out = execFileSync(process.execPath, ['-e', script], {
        env: {
          ...process.env,
          NODE_PATH: repoNodeModules,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          NODE_NO_WARNINGS: '1',
          SC_DIST: outDir,
          SC_CERTS: certDir,
        },
        encoding: 'utf8',
        timeout: 20_000,
      });
    } catch (err) {
      // Rethrow as a plain Error: execFileSync's own can be circular
      // (err.error === err on a spawn failure), which a jest worker cannot
      // serialize back to the parent, hiding the actual cause.
      const e = err as { message?: string; stderr?: unknown };
      // No `cause`: attaching the original would carry the circular object
      // right back into what the worker has to serialize.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`child process failed: ${e.message ?? String(err)}\n${String(e.stderr ?? '')}`);
    }
    expect(out).toBe('1.1');
  });
});

describe('ServiceClient request timeout', () => {
  it('defaults to five minutes', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(300_000);
  });

  it('ends a request to an HTTP/2 server that accepts the stream and never answers', async () => {
    // The failure mode this package used to create: an HTTP/2 connection
    // undici will not time out (client-h2.js has no stream timeout). Even
    // with a caller-supplied HTTP/2 dispatcher, the client's signal ends it.
    const base = await startHttp2({ allowHTTP1: false }, () => {
      /* accept the stream, never respond */
    });
    const client = new ServiceClient({
      resolveTargetUrl: async () => base,
      dispatcher: insecureAgent(true),
      defaultTimeoutMs: 300,
    });
    const started = Date.now();
    await expect(client.fetch('k', '/hang')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('ends a request to an HTTP/1.1 server that never sends headers, on the default dispatcher', async () => {
    const base = await startHttp1(() => {
      /* never respond */
    });
    const client = new ServiceClient({ resolveTargetUrl: async () => base, defaultTimeoutMs: 300 });
    const started = Date.now();
    await expect(client.fetch('k', '/hang')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('covers the body: a response that stalls mid-body ends with the same timeout', async () => {
    const base = await startHttp1((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial'); // then silence
    });
    const client = new ServiceClient({ resolveTargetUrl: async () => base, defaultTimeoutMs: 400 });
    const res = await client.fetch('k', '/stall');
    expect(res.status).toBe(200);
    const started = Date.now();
    await expect(res.text()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('a per-call timeoutMs overrides the client default', async () => {
    const base = await startHttp1(() => {
      /* never respond */
    });
    const client = new ServiceClient({ resolveTargetUrl: async () => base, defaultTimeoutMs: 60_000 });
    const started = Date.now();
    await expect(client.fetch('k', '/hang', { timeoutMs: 200 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a caller's own signal still applies alongside the timeout", async () => {
    const base = await startHttp1(() => {
      /* never respond */
    });
    const client = new ServiceClient({ resolveTargetUrl: async () => base });
    const ac = new AbortController();
    const pending = client.fetch('k', '/hang', { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('caller gave up')), 100);
    await expect(pending).rejects.toThrow('caller gave up');
  });

  it('timeoutMs: 0 sends no timer of its own', async () => {
    const impl = jest.fn(async () => new Response('ok'));
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
      fetchImpl: impl as unknown as typeof fetch,
    });
    await client.fetch('k', '/x', { timeoutMs: 0 });
    const init = (impl.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(init.signal).toBeUndefined();
  });

  it('a successful call is unaffected', async () => {
    const base = await startHttp1((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const client = new ServiceClient({ resolveTargetUrl: async () => base, defaultTimeoutMs: 2_000 });
    const res = await client.fetch('k', '/ok', { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({ ok: true });
  });
});
