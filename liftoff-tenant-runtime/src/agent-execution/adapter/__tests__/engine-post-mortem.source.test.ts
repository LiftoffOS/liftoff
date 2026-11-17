/**
 * When the engine server dies, something says so.
 *
 * Every listener on the process was gated on startup having finished:
 *
 *   proc.stdout?.on('data', (chunk) => { if (settled) return; … });
 *   proc.stderr?.on('data', (chunk) => { if (!settled) output += …; });
 *   proc.on('exit',  (code)  => settle(() => reject(…)));   // no-op once settled
 *   proc.on('error', (error) => settle(() => reject(error)));
 *
 * and `launch` returned `{ url, close }`, so the adapter could not observe the
 * process either. A server that died mid-run took its exit code and its last
 * words with it, and the only remaining signal was a request failing with
 * `TypeError: fetch failed` some time later — which is equally what a request
 * timeout looks like. Telling those two apart took reading undici's source.
 *
 * The engine cannot be started here, so this pins the structure, like the other
 * `*.source.test.ts` contracts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER = readFileSync(join(__dirname, '..', 'opencode', 'server.ts'), 'utf8');
const ADAPTER = readFileSync(join(__dirname, '..', 'opencode', 'index.ts'), 'utf8');

describe('the engine process is observed after startup', () => {
  it('keeps the tail of what it said', () => {
    // A ring, not a log line per chunk: the process is chatty and only its
    // last words matter.
    expect(SERVER).toContain('OUTPUT_TAIL_CHARS');
    expect(SERVER).toContain('ring = (ring + text).slice(-OUTPUT_TAIL_CHARS)');
  });

  it('no longer discards stdout once the server is up', () => {
    // The defect exactly: `if (settled) return` BEFORE anything was kept.
    const stdout = SERVER.slice(SERVER.indexOf('proc.stdout?.on('));
    const tailAt = stdout.indexOf('tail(');
    const bailAt = stdout.indexOf('if (settled) return;');
    expect(tailAt).toBeGreaterThan(-1);
    expect(tailAt).toBeLessThan(bailAt);
  });

  it('warns when the process exits while a run is using it', () => {
    expect(SERVER).toContain("event: 'opencode_server_exited'");
    expect(SERVER).toContain('exitCode');
    expect(SERVER).toContain('signal');
  });

  it('stays quiet when WE killed it', () => {
    // close() ends every run. A signalled exit during shutdown is expected and
    // a warn on each one would train the reader to ignore the real ones.
    expect(SERVER).toContain('stopping = true');
    expect(SERVER).toContain('if (settled && !stopping)');
  });

  it('exposes the post-mortem to its caller', () => {
    // The handle used to be `{ url, close }`, so even a caller that wanted to
    // ask had nothing to ask.
    expect(SERVER).toContain('diagnostics()');
    expect(SERVER).toMatch(/alive:\s/);
  });
});

describe('a failed request says whether the server is still there', () => {
  it('reads the post-mortem on a prompt failure', () => {
    const branch = ADAPTER.slice(ADAPTER.indexOf('if (promptError) {'));
    expect(branch.slice(0, 1600)).toContain('server.diagnostics()');
  });

  it('puts the exit on the reason, not only in a log', () => {
    // The reason is what reaches the invocation row and the person. A log line
    // helps whoever goes looking; the reason is what says where to look.
    const branch = ADAPTER.slice(ADAPTER.indexOf('if (promptError) {'));
    expect(branch.slice(0, 1600)).toContain('server exited code=');
  });
});
