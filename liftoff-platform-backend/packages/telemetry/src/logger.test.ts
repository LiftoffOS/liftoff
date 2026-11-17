import { createLogger } from './logger.js';
import { withTraceContext } from './context.js';

describe('createLogger (custom backend)', () => {
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('writes a JSON line with timestamp + level + message', () => {
    const log = createLogger({ backend: 'custom' });
    log.info({ foo: 'bar' }, 'something happened');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = infoSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('something happened');
    expect(parsed.foo).toBe('bar');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('supports pino-style and tenant-runtime-style call shapes', () => {
    const log = createLogger({ backend: 'custom' });
    log.info({ a: 1 }, 'pino-style');
    log.info('tenant-style', { b: 2 });
    log.info('just a message');
    log.info({ onlyCtx: true });

    const lines = infoSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(lines[0].message).toBe('pino-style');
    expect(lines[0].a).toBe(1);
    expect(lines[1].message).toBe('tenant-style');
    expect(lines[1].b).toBe(2);
    expect(lines[2].message).toBe('just a message');
    expect(lines[3].onlyCtx).toBe(true);
  });

  it('automatically includes trace context fields', () => {
    const log = createLogger({ backend: 'custom' });
    withTraceContext(
      { tenantId: 't1', agentId: 'a1', traceId: 'tr1' },
      () => log.info('hello'),
    );

    const line = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(line.tenant_id).toBe('t1');
    expect(line.agent_id).toBe('a1');
    expect(line.trace_id).toBe('tr1');
  });

  it('adds Cloud Logging trace field when cloudTraceProjectId is set', () => {
    const log = createLogger({
      backend: 'custom',
      cloudTraceProjectId: 'my-proj',
    });
    withTraceContext({ traceId: 'tr1' }, () => log.info('hi'));

    const line = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(line['logging.googleapis.com/trace']).toBe('projects/my-proj/traces/tr1');
  });

  it('applies redact hook before emission', () => {
    const redact = jest.fn((entry) => ({ ...entry, password: '[REDACTED]' }));
    const log = createLogger({ backend: 'custom', redact });
    log.info({ password: 'hunter2' }, 'auth');

    expect(redact).toHaveBeenCalledTimes(1);
    const line = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(line.password).toBe('[REDACTED]');
  });

  it('respects level filter', () => {
    const log = createLogger({ backend: 'custom', level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('child() binds additional context without mutating the parent', () => {
    const log = createLogger({ backend: 'custom' });
    const child = log.child({ tenantId: 't-child' });
    child.info('from child');
    log.info('from parent');

    const childLine = JSON.parse(infoSpy.mock.calls[0][0] as string);
    const parentLine = JSON.parse(infoSpy.mock.calls[1][0] as string);
    expect(childLine.tenantId).toBe('t-child');
    expect(parentLine.tenantId).toBeUndefined();
  });

  it('routes error-level writes to console.error and warn to console.warn', () => {
    const log = createLogger({ backend: 'custom' });
    log.error('boom');
    log.warn('careful');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createLogger (pino backend)', () => {
  it('loads pino and emits entries with severity formatting', () => {
    const log = createLogger({ backend: 'pino', level: 'info' });
    expect(() => log.info({ foo: 'bar' }, 'hello')).not.toThrow();
    // Pino writes to stdout itself; we can't easily capture it here.
    // This test just verifies the adapter doesn't throw with real pino loaded.
  });
});
