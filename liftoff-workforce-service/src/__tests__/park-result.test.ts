// What the Chief AI Officer reads in place of a tool result larger than one
// message — and, the half that matters most, what it reads when the park
// cannot happen.
//
// The rule and the store are platform-backend's; this asserts the seam: the
// bound is applied locally so an ordinary turn costs no request, the parked
// text comes back as the model's result, and EVERY failure — a 413, any other
// non-2xx, a timeout, a body with no text — ends in a bounded copy rather than
// the oversized payload the whole mechanism exists to keep out of the window.

const mockPbPostJson = jest.fn();
jest.mock('../infrastructure/platform-backend.js', () => ({
  pbPostJson: (...args: unknown[]) => mockPbPostJson(...args),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { TOOL_RESULT_PARK_CHARS, boundedInline, parkOrBoundToolResult } from '../platform-agent/park-result.js';

const ctx = { tenantId: 'tenant-1', threadId: 'thread-1' };
const data = { rows: [{ body: 'x'.repeat(60_000) }] };
const serialized = JSON.stringify(data);

beforeEach(() => {
  mockPbPostJson.mockReset();
});

describe('the bound is applied before the request', () => {
  it('returns an ordinary result unchanged and makes no request at all', async () => {
    const small = JSON.stringify({ ok: true });
    await expect(parkOrBoundToolResult(ctx, 'do_thing', { ok: true }, small)).resolves.toBe(small);
    expect(mockPbPostJson).not.toHaveBeenCalled();
  });

  it('does not reach for a result that is exactly at the bound', async () => {
    const atBound = 'y'.repeat(TOOL_RESULT_PARK_CHARS);
    await expect(parkOrBoundToolResult(ctx, 'do_thing', null, atBound)).resolves.toBe(atBound);
    expect(mockPbPostJson).not.toHaveBeenCalled();
  });
});

describe('parking an oversized result', () => {
  it('posts it under this conversation and returns the view', async () => {
    mockPbPostJson.mockResolvedValueOnce({ ok: true, json: { text: 'THE VIEW' } });
    await expect(parkOrBoundToolResult(ctx, 'do_thing', data, serialized)).resolves.toBe('THE VIEW');
    expect(mockPbPostJson).toHaveBeenCalledWith(
      '/api/internal/datasets/park',
      {
        tenantId: 'tenant-1',
        scopeKind: 'caio_thread',
        scopeId: 'thread-1',
        label: 'do_thing result',
        source: 'caio_tool',
        sourceRef: 'do_thing',
        text: serialized,
        payload: data,
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });
});

describe('every failure ends bounded, never with the payload', () => {
  const expectBounded = (out: string) => {
    expect(out).not.toBe(serialized);
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_PARK_CHARS);
    expect(out).toContain('could not be kept for querying');
  };

  it('a 413 — the payload was past the route\'s stated maximum', async () => {
    mockPbPostJson.mockResolvedValueOnce({ ok: false, status: 413, detail: 'too large' });
    expectBounded(await parkOrBoundToolResult(ctx, 'do_thing', data, serialized));
  });

  it('any other non-2xx', async () => {
    for (const status of [401, 500, 503]) {
      mockPbPostJson.mockResolvedValueOnce({ ok: false, status, detail: '' });
      expectBounded(await parkOrBoundToolResult(ctx, 'do_thing', data, serialized));
    }
  });

  it('a timeout, or any thrown request', async () => {
    mockPbPostJson.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
    expectBounded(await parkOrBoundToolResult(ctx, 'do_thing', data, serialized));
  });

  it('a 2xx whose body carries no text', async () => {
    mockPbPostJson.mockResolvedValueOnce({ ok: true, json: {} });
    expectBounded(await parkOrBoundToolResult(ctx, 'do_thing', data, serialized));
  });

  it('never throws, so a tool call that succeeded still succeeds', async () => {
    mockPbPostJson.mockRejectedValueOnce(new Error('boom'));
    await expect(parkOrBoundToolResult(ctx, 'do_thing', data, serialized)).resolves.toEqual(expect.any(String));
  });
});

describe('boundedInline', () => {
  it('cuts visibly and fits the bound it was given — a longer result is not a bound', () => {
    const text = 'z'.repeat(TOOL_RESULT_PARK_CHARS + 100);
    const out = boundedInline(text);
    expect(out).toMatch(/\[cut: \d+ more characters\]/);
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_PARK_CHARS);
  });

  it('leaves anything under the bound alone', () => {
    expect(boundedInline('short')).toBe('short');
  });
});
