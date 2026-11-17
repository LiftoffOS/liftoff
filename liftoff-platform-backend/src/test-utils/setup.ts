/// <reference types="jest" />
// Jest Setup File
// Global test configuration and mocks

// Suppress console output during tests (optional, comment out for debugging)
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
//   error: jest.fn(),
// };

// Set test environment variables
import net from 'net';
import http from 'http';
import https from 'https';

// ── Test servers never bind inside the ephemeral port range ──────────────
//
// This is the fix for a flake that failed ~1 full-suite run in 6 under load,
// in a different HTTP suite every time, with three faces: `socket hang up`,
// a 404 from a route that exists, and a 10s timeout. All three are one bug.
//
// Route tests bind a fresh server per request — `supertest(app)` calls
// `app.listen(0)` — and there are ~120 such call sites, so a full run binds
// hundreds of servers. `listen(0)` takes a port from the OS ephemeral range
// (49152-65535 here), which is the SAME pool client sockets draw from, and
// closed connections sit in TIME_WAIT for 2*MSL (30s here; ~558 were lingering
// when this was diagnosed). Node sets SO_REUSEADDR, so binding a port that
// still has a TIME_WAIT entry SUCCEEDS rather than failing — and then a stale
// segment from the previous connection reaches the new listener. Depending on
// timing that is an RST (socket hang up), a request answered by a server that
// has never heard of the route (404), or a segment that simply never arrives
// (timeout).
//
// So: keep test servers out of the ephemeral range entirely. Each jest worker
// gets its own 1000-port band well below 49152, and ports are handed out
// monotonically within it, so a port is not reused until ~1000 binds later —
// far longer than any TIME_WAIT window. A client socket can never collide with
// a listener because the two now live in disjoint ranges.
//
// Only the "any free port" forms are rewritten. An explicit port, a unix
// socket path, or a handle passes through untouched. A clash retries on the next
// band port rather than on port 0, so the band cannot be escaped by the very
// pressure it is there to survive; port 0 remains the last resort only after the
// band has genuinely been walked.
const WORKER_ID = Number.parseInt(process.env.JEST_WORKER_ID ?? '1', 10) || 1;
const PORT_BAND_SIZE = 1000;
const PORT_BAND_START = 20000 + (WORKER_ID - 1) * PORT_BAND_SIZE;

// Seeded from the pid, not from zero. `workerIdleMemoryLimit` recycles a worker
// mid-run and the replacement keeps the same JEST_WORKER_ID, so it inherits this
// band. Starting every process at the band start means the fresh process rebinds
// the ports the previous one just released, which are still in TIME_WAIT — and
// SO_REUSEADDR lets that bind succeed, which is the whole failure this band
// exists to prevent. The pid moves the entry point so a recycled worker does not
// walk the same ports in the same order.
let portCursor = process.pid % PORT_BAND_SIZE;

function nextTestPort(): number {
  const port = PORT_BAND_START + (portCursor % PORT_BAND_SIZE);
  portCursor += 1;
  return port;
}

// `net.Server.listen` is heavily overloaded, so the wrapper takes the argument
// list untyped and re-dispatches to the original. The narrowing below is what
// makes that safe: anything that is not an "any free port" call is forwarded
// byte-for-byte.
type ListenFn = (...args: unknown[]) => net.Server;
const originalListen = net.Server.prototype.listen as unknown as ListenFn;

function wantsAnyPort(args: unknown[]): boolean {
  if (args.length === 0) return true;
  const first = args[0];
  if (first === 0 || first === undefined || first === null) return true;
  if (typeof first === 'object') {
    const opts = first as Record<string, unknown>;
    if ('path' in opts || 'fd' in opts || 'handle' in opts) return false;
    return opts.port === 0 || opts.port === undefined;
  }
  return false;
}

(net.Server.prototype as unknown as { listen: ListenFn }).listen = function patchedListen(
  this: net.Server,
  ...args: unknown[]
): net.Server {
  if (!wantsAnyPort(args)) return originalListen.apply(this, args);

  const first = args[0];
  const isOptionsForm = typeof first === 'object' && first !== null;
  const rest = args.slice(1).filter((a) => a !== undefined);

  // A taken band port retries on the NEXT band port, not on real port 0. Falling
  // back to 0 re-enters the ephemeral range and reproduces the exact flake this
  // band prevents, so the escape hatch used to undo the fix precisely when the
  // band was under pressure. Bounded so a genuinely exhausted band still cannot
  // hang: after that many misses, port 0 is the lesser evil against not
  // listening at all.
  let retriesLeft = 32;
  const onError = (err: NodeJS.ErrnoException): void => {
    // Anything that is not a port clash is not ours to absorb. Detach and
    // re-emit so the caller sees it: merely having a listener attached stops
    // Node throwing, so returning quietly here would swallow the failure.
    if (err?.code !== 'EADDRINUSE') {
      this.removeListener('error', onError);
      this.emit('error', err);
      return;
    }
    if (retriesLeft > 0) {
      retriesLeft -= 1;
      const retryPort = nextTestPort();
      originalListen.apply(this, isOptionsForm
        ? [{ ...(first as Record<string, unknown>), port: retryPort }, ...rest]
        : [retryPort, ...rest]);
      return;
    }
    this.removeListener('error', onError);
    originalListen.apply(this, isOptionsForm
      ? [{ ...(first as Record<string, unknown>), port: 0 }, ...rest]
      : [0, ...rest]);
  };
  // `on`, not `once`: each retry can clash again, and a `once` handler would be
  // gone after the first one.
  this.on('error', onError);
  this.once('listening', () => this.removeListener('error', onError));

  const assigned = nextTestPort();
  return originalListen.apply(this, isOptionsForm
    ? [{ ...(first as Record<string, unknown>), port: assigned }, ...rest]
    : [assigned, ...rest]);
};

// Superagent already opts out of connection pooling (agent: false), but the
// global agents are keep-alive by default on Node 19+; forcing a fresh socket
// removes any chance of a pooled connection outliving the server it was opened
// against.
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });

process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'test';
process.env.GCP_PROJECT_ID = 'test-project';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key';
process.env.DB_PASSWORD = 'test_password';

// The deployment's own identity — its frontend and its sending address. Neither
// has a default in the product (src/infrastructure/frontend-url.ts,
// src/infrastructure/mail-identity.ts) because a default is a link or an
// envelope pointing at a host this install does not own, which fails silently.
// The suite therefore has to supply them, exactly as a deployment does.
//
// `??=`, so a test that wants to assert the unset behaviour can delete them.
process.env.FRONTEND_URL ??= 'https://app.test.invalid';
process.env.MAIL_FROM_ADDRESS ??= 'noreply@test.invalid';

// Increase timeout for async operations if needed
jest.setTimeout(10000);

// Global beforeEach to reset any shared state
beforeEach(() => {
  jest.clearAllMocks();
});
