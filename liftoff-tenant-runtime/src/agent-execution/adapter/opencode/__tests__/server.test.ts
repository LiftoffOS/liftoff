// The opencode server is spawned by this adapter, not the SDK, for one reason:
// the environment it starts with decides which API opencode reaches a provider
// over, and the SDK offers no way to set it. These pin what the spawn is given
// — the allow-list, the inline config, the provider variable — and that the
// readiness and failure protocol matches the SDK's own.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const spawnMock = jest.fn();
jest.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

const createOpencodeClientMock = jest.fn((cfg: unknown) => ({ boundTo: cfg }));
jest.mock('../../esm-import', () => ({
  esmImport: async () => ({ createOpencodeClient: (cfg: unknown) => createOpencodeClientMock(cfg) }),
}));

import { startOpencode } from '../server';

/** A child whose stdout/stderr and exit the test scripts. */
function fakeProc() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: jest.fn(() => { proc.exitCode = null; proc.signalCode = 'SIGTERM'; return true; }),
  });
  return proc;
}

const options = { hostname: '127.0.0.1', port: 0, timeout: 500, config: { provider: { xai: { options: { apiKey: 'k' } } } } };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PATH = '/usr/bin';
  process.env.HOME = '/root';
  process.env.DB_PASSWORD = 'never-for-a-child';
});
afterEach(() => { delete process.env.DB_PASSWORD; });

describe('startOpencode', () => {
  it('spawns `opencode serve` with the allow-listed environment, the config and the provider variable', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const started = startOpencode({ ...options, env: { XAI_API_KEY: 'k' } });
    proc.stdout.write('opencode server listening on http://127.0.0.1:43111\n');

    const { client, server } = await started;

    expect(spawnMock).toHaveBeenCalledWith('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
    const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/root');
    expect(env.XAI_API_KEY).toBe('k');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual(options.config);
    // Never this process's environment: the runtime's own secrets stay here.
    expect(env).not.toHaveProperty('DB_PASSWORD');
    expect(server.url).toBe('http://127.0.0.1:43111');
    expect(createOpencodeClientMock).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:43111' });
    expect(client).toEqual({ boundTo: { baseUrl: 'http://127.0.0.1:43111' } });
  });

  it('passes the config log level through as the SDK does, and nothing else from the config', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const started = startOpencode({ ...options, config: { ...options.config, logLevel: 'DEBUG' } });
    proc.stdout.write('opencode server listening on http://127.0.0.1:1\n');
    await started;

    expect(spawnMock.mock.calls[0][1]).toEqual(['serve', '--hostname=127.0.0.1', '--port=0', '--log-level=DEBUG']);
  });

  it('reads the URL off a readiness line that arrives in pieces', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const started = startOpencode(options);
    proc.stdout.write('opencode server lis');
    proc.stdout.write('tening on http://127.0.0.1:5\n');

    await expect(started).resolves.toMatchObject({ server: { url: 'http://127.0.0.1:5' } });
  });

  it('fails with the server output when it exits before it is ready', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const started = startOpencode(options);
    proc.stderr.write('ServeError: address in use\n');
    proc.exitCode = 1;
    proc.emit('exit', 1);

    await expect(started).rejects.toThrow(/Server exited with code 1[\s\S]*ServeError: address in use/);
    expect(createOpencodeClientMock).not.toHaveBeenCalled();
  });

  it('kills the server and fails when it never reports its URL in time', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);

    await expect(startOpencode({ ...options, timeout: 20 })).rejects.toThrow('Timeout waiting for server to start after 20ms');
    expect(proc.kill).toHaveBeenCalled();
  });

  it('fails on a spawn error', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const started = startOpencode(options);
    proc.emit('error', new Error('spawn opencode ENOENT'));

    await expect(started).rejects.toThrow('spawn opencode ENOENT');
  });

  it('closes by killing a live server, and leaves an exited one alone', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    const started = startOpencode(options);
    proc.stdout.write('opencode server listening on http://127.0.0.1:7\n');
    const { server } = await started;

    server.close();
    expect(proc.kill).toHaveBeenCalledTimes(1);

    proc.signalCode = null;
    proc.exitCode = 0;
    server.close();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it('stops the server when the client cannot be built', async () => {
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);
    createOpencodeClientMock.mockImplementationOnce(() => { throw new Error('no client'); });
    const started = startOpencode(options);
    proc.stdout.write('opencode server listening on http://127.0.0.1:9\n');

    await expect(started).rejects.toThrow('no client');
    expect(proc.kill).toHaveBeenCalled();
  });
});
