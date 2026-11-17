// The deep scan is a security check on every saved memory. A failed scan used
// to delete the row anyway ("will retry on next tick", and nothing could), so
// a model outage silently skipped the check for everything saved during it.
// Now it is retried, a crashed worker's claims are taken back, and a full
// batch re-arms the scan instead of waiting for the daily pass.

const query = jest.fn();
const complete = jest.fn();
const armWatch = jest.fn();

jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query }) }));
jest.mock('../../llm/client', () => ({ llmClient: { complete: (...a: unknown[]) => complete(...a) } }));
jest.mock('../../infrastructure/logging', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../observability/scrub-logger', () => ({ scrubLogger: { warn: jest.fn() } }));
jest.mock('../../infrastructure/maintenance-tasks', () => ({
  armWatch: (...a: unknown[]) => armWatch(...a),
  MAINTENANCE_PATHS: { memoryDeepScan: '/api/internal/memory-deep-scan-tick' },
}));

import { runDeepScanTick } from '../deep-scan-worker';

function claims(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `q${i}`, memory_id: `m${i}`, tenant_id: 't' }));
}

function prime(claimed: ReturnType<typeof claims>) {
  query.mockReset().mockImplementation(async (sql: string) => {
    if (/^\s*UPDATE memories_pending_deep_scan\s+SET claimed_at = NOW\(\)/.test(sql)) return { rows: claimed };
    if (/SELECT content FROM memories/.test(sql)) return { rowCount: 1, rows: [{ content: 'note' }] };
    return { rowCount: 1, rows: [] };
  });
}

beforeEach(() => {
  complete.mockReset();
  armWatch.mockReset();
});

it('releases the claim on a failed scan instead of deleting the row', async () => {
  prime(claims(1));
  complete.mockRejectedValue(new Error('model unavailable'));

  await expect(runDeepScanTick()).resolves.toEqual({ scanned: 0, quarantined: 0 });

  const sql = query.mock.calls.map((c) => c[0] as string);
  expect(sql.some((s) => /DELETE FROM memories_pending_deep_scan/.test(s))).toBe(false);
  expect(sql.some((s) => /SET claimed_at = NULL, claimed_by = NULL/.test(s))).toBe(true);
  expect(armWatch).not.toHaveBeenCalled();
});

it('takes back claims a crashed worker left behind', async () => {
  prime([]);
  await runDeepScanTick();
  expect(query.mock.calls[0][0]).toMatch(/claimed_at IS NULL OR claimed_at < NOW\(\) - INTERVAL '15 minutes'/);
});

it('re-arms after a full batch that made progress', async () => {
  prime(claims(50));
  complete.mockResolvedValue({ text: '{"contains_secret": false}' });
  await runDeepScanTick();
  expect(armWatch).toHaveBeenCalledWith('memory-deep-scan', '/api/internal/memory-deep-scan-tick', { delayMs: 60_000 });
});

it('does not re-arm a partial batch: the queue is drained', async () => {
  prime(claims(3));
  complete.mockResolvedValue({ text: '{"contains_secret": false}' });
  await runDeepScanTick();
  expect(armWatch).not.toHaveBeenCalled();
});
