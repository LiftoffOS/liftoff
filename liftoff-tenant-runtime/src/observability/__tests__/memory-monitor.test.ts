// Watching this process's own memory, between runs as well as during them.
//
// The thing that makes this worth having is that it writes BEFORE the kill. So
// the tests are about the guarantees around the write — that it happens on its
// own, that it cannot hold the process open, and that a missing container limit
// degrades to a plain reading rather than a nonsense percentage.

import {
  MEMORY_WARN_FRACTION,
  _resetMemoryMonitorForTesting,
  containerMemoryLimitBytes,
  isMemoryPressured,
  logMemorySample,
  sampleMemory,
  startMemoryMonitor,
  stopMemoryMonitor,
} from '../memory-monitor';

const warn = jest.fn();
const info = jest.fn();
jest.mock('../scrub-logger', () => ({
  scrubLogger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a), error: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  _resetMemoryMonitorForTesting();
  delete process.env.MEMORY_LIMIT_MB;
});

afterEach(() => {
  _resetMemoryMonitorForTesting();
  jest.useRealTimers();
});

describe('the limit', () => {
  it('prefers what the deployment declared', () => {
    // Terraform already knows the number it asked Cloud Run for; an explicit
    // value beats inferring one from the filesystem.
    process.env.MEMORY_LIMIT_MB = '2048';
    expect(containerMemoryLimitBytes()).toBe(2048 * 1024 * 1024);
  });

  it('is cached, so it is not a file read a minute', () => {
    process.env.MEMORY_LIMIT_MB = '512';
    expect(containerMemoryLimitBytes()).toBe(512 * 1024 * 1024);
    process.env.MEMORY_LIMIT_MB = '1024';
    expect(containerMemoryLimitBytes()).toBe(512 * 1024 * 1024);
  });

  it('ignores a value that is not a limit', () => {
    process.env.MEMORY_LIMIT_MB = 'lots';
    // Falls through to the cgroup, which on a dev machine is absent — either
    // way it must not return NaN, which every comparison would silently fail.
    const v = containerMemoryLimitBytes();
    expect(v === null || Number.isFinite(v)).toBe(true);
  });
});

describe('a sample', () => {
  it('reports the real numbers', () => {
    const s = sampleMemory();
    expect(s.rssBytes).toBeGreaterThan(0);
    expect(s.heapUsedBytes).toBeGreaterThan(0);
  });

  it('gives a fraction only when there is something to compare against', () => {
    process.env.MEMORY_LIMIT_MB = '4096';
    expect(sampleMemory().usedFraction).toBeGreaterThan(0);

    _resetMemoryMonitorForTesting();
    delete process.env.MEMORY_LIMIT_MB;
    const s = sampleMemory();
    // Null, not zero and not NaN: "no limit known" is a different fact from
    // "using none of it", and only one of them should stay quiet.
    expect(s.usedFraction === null || Number.isFinite(s.usedFraction)).toBe(true);
  });
});

describe('pressure', () => {
  it('is never claimed without a limit to be under', () => {
    expect(isMemoryPressured({
      rssBytes: 1e9, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0,
      limitBytes: null, usedFraction: null,
    })).toBe(false);
  });

  it('trips at the threshold', () => {
    const at = (f: number) => isMemoryPressured({
      rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 0,
      limitBytes: 100, usedFraction: f,
    });
    expect(at(MEMORY_WARN_FRACTION - 0.01)).toBe(false);
    expect(at(MEMORY_WARN_FRACTION)).toBe(true);
    expect(at(0.99)).toBe(true);
  });
});

describe('the line', () => {
  const sample = (usedFraction: number | null) => ({
    rssBytes: 500 * 1024 * 1024,
    heapUsedBytes: 300 * 1024 * 1024,
    heapTotalBytes: 400 * 1024 * 1024,
    externalBytes: 10 * 1024 * 1024,
    limitBytes: usedFraction === null ? null : 1024 * 1024 * 1024,
    usedFraction,
  });

  it('reports in megabytes, because a person reads it', () => {
    logMemorySample(sample(0.5));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ rss_mb: 500, heap_used_mb: 300 }));
  });

  it('carries a percentage when it can', () => {
    logMemorySample(sample(0.5));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ used_pct: 50 }));
  });

  it('leaves the percentage null rather than inventing one', () => {
    logMemorySample(sample(null));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ used_pct: null, limit_mb: null }));
  });

  it('warns rather than informs when close to the limit', () => {
    logMemorySample(sample(0.95));
    expect(warn).toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('is one stable event name, so a log filter finds every sample', () => {
    logMemorySample(sample(0.5));
    logMemorySample(sample(0.95));
    expect(info.mock.calls[0][0].event).toBe('runtime_memory');
    expect(warn.mock.calls[0][0].event).toBe('runtime_memory');
  });
});

describe('the timer', () => {
  it('writes one line immediately, before waiting a whole interval', () => {
    // A process that dies inside its first minute should still have said where
    // it started.
    jest.useFakeTimers();
    startMemoryMonitor();
    expect(info.mock.calls.length + warn.mock.calls.length).toBe(1);
  });

  it('keeps writing', () => {
    jest.useFakeTimers();
    startMemoryMonitor();
    const first = info.mock.calls.length + warn.mock.calls.length;
    jest.advanceTimersByTime(60_000 * 3);
    expect(info.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(first);
  });

  it('does not hold the process open', () => {
    // Without unref this timer is a live handle, and a clean shutdown becomes a
    // SIGKILL after the grace period — which is the exact failure this feature
    // exists to explain. Asserted by capturing the timer setInterval returned
    // and checking it was unref'd, because counting process handles cannot
    // tell ours apart from jest's.
    const real = global.setInterval;
    let created: NodeJS.Timeout | null = null;
    const spy = jest.fn((...args: Parameters<typeof setInterval>) => {
      created = real(...args);
      return created;
    });
    (global as unknown as { setInterval: unknown }).setInterval = spy;
    try {
      startMemoryMonitor();
      expect(created).not.toBeNull();
      expect((created as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
    } finally {
      stopMemoryMonitor();
      (global as unknown as { setInterval: unknown }).setInterval = real;
    }
  });

  it('is idempotent, so a re-init does not double the log volume', () => {
    jest.useFakeTimers();
    startMemoryMonitor();
    startMemoryMonitor();
    const after = info.mock.calls.length + warn.mock.calls.length;
    jest.advanceTimersByTime(60_000);
    // One start wrote one immediate line; the second start must not have added
    // a second line or a second timer.
    expect(after).toBe(1);
    expect(info.mock.calls.length + warn.mock.calls.length).toBe(2);
  });

  it('stops', () => {
    jest.useFakeTimers();
    startMemoryMonitor();
    stopMemoryMonitor();
    const after = info.mock.calls.length + warn.mock.calls.length;
    jest.advanceTimersByTime(60_000 * 5);
    expect(info.mock.calls.length + warn.mock.calls.length).toBe(after);
  });
});

describe('the wiring', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'index.ts'), 'utf8',
  ) as string;

  it('starts at boot', () => {
    expect(src).toMatch(/startMemoryMonitor\(\)/);
  });

  it('takes a last reading on the way down, which is the interesting one', () => {
    const shutdown = src.slice(src.indexOf('const shutdown = async'));
    expect(shutdown.slice(0, 600)).toMatch(/logMemorySample\(\)/);
    expect(shutdown.slice(0, 600)).toMatch(/stopMemoryMonitor\(\)/);
  });
});
