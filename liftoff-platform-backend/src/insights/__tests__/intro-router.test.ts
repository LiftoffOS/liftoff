// Intro router tests
//
// Mirrors observation-router.test.ts. Tests the handler directly
// (bypassing Express) with mocked dependencies. Verifies input
// validation, SSE headers + flushHeaders, event forwarding, and the
// "degrade silently" contract when the service returns null.

import type { Request, Response } from 'express';

const mockGenerateIntro = jest.fn();
jest.mock('../intro-service', () => ({
  generateInsightsIntro: (...args: unknown[]) => mockGenerateIntro(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { introRouter } from '../intro-router';

const TENANT_A = '00000000-0000-0000-0000-000000000001';

interface RouterStackLayer {
  route?: {
    path: string;
    stack: Array<{ method: string; handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

function getRouteHandler(
  path: string,
): (req: Request, res: Response) => Promise<void> {
  const stack = (introRouter as unknown as { stack: RouterStackLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.stack.filter(l => l.method === 'get');
      if (handlers.length > 0) return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error(`Route not found: GET ${path}`);
}

interface MockResponseState {
  statusCode: number;
  headers: Record<string, string>;
  writtenChunks: string[];
  ended: boolean;
  flushedHeaders: boolean;
  res: Response;
}

function createMockResponse(): MockResponseState {
  const state: MockResponseState = {
    statusCode: 200,
    headers: {},
    writtenChunks: [],
    ended: false,
    flushedHeaders: false,
    res: {} as Response,
  };

  const resMock = {
    statusCode: 200,
    writableEnded: false,
    status: jest.fn((code: number) => {
      state.statusCode = code;
      return resMock;
    }),
    json: jest.fn((body: unknown) => {
      state.writtenChunks.push(JSON.stringify(body));
      state.ended = true;
      resMock.writableEnded = true;
      return resMock;
    }),
    setHeader: jest.fn((name: string, value: string) => {
      state.headers[name.toLowerCase()] = value;
      return resMock;
    }),
    flushHeaders: jest.fn(() => {
      state.flushedHeaders = true;
    }),
    write: jest.fn((chunk: string) => {
      state.writtenChunks.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      state.ended = true;
      resMock.writableEnded = true;
    }),
  };

  state.res = resMock as unknown as Response;
  return state;
}

function createMockRequest(query: Record<string, string>): Request {
  const listeners: Record<string, Array<() => void>> = {};
  const req = {
    query,
    ctx: { userId: 'firebase-uid', tenantId: TENANT_A },
    on: jest.fn((event: string, handler: () => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
      return req;
    }),
    off: jest.fn((event: string, handler: () => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler);
      }
      return req;
    }),
  } as unknown as Request;
  return req;
}

const FAKE_INTRO =
  'Salesforce Sync owned the week, handling 420 of your 725 completed tasks while costs ticked down 7% — your AI throughput is improving.';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /report/intro — validation', () => {
  const handler = getRouteHandler('/report/intro');

  it('returns 400 when tenantId is missing', async () => {
    const req = createMockRequest({});
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(400);
  });

  it('returns 400 when tenantId is not a UUID', async () => {
    const req = createMockRequest({ tenantId: 'not-a-uuid' });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(400);
  });

  it('accepts a valid tenantId with the default period', async () => {
    mockGenerateIntro.mockResolvedValue(FAKE_INTRO);
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.flushedHeaders).toBe(true);
    expect(mockGenerateIntro).toHaveBeenCalledWith(
      TENANT_A,
      { preset: 'this_week' },
    );
  });

  it('accepts a custom period preset', async () => {
    mockGenerateIntro.mockResolvedValue(null);
    const req = createMockRequest({ tenantId: TENANT_A, period: 'last_quarter' });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockGenerateIntro).toHaveBeenCalledWith(
      TENANT_A,
      { preset: 'last_quarter' },
    );
  });

  it('accepts start/end date overrides', async () => {
    mockGenerateIntro.mockResolvedValue(null);
    const req = createMockRequest({
      tenantId: TENANT_A,
      start: '2026-03-01T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
    });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockGenerateIntro).toHaveBeenCalledWith(TENANT_A, {
      start: '2026-03-01T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
    });
  });
});

describe('GET /report/intro — SSE streaming', () => {
  const handler = getRouteHandler('/report/intro');

  it('sets the expected SSE headers and flushes them', async () => {
    mockGenerateIntro.mockResolvedValue(FAKE_INTRO);
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);

    expect(state.headers['content-type']).toBe('text/event-stream');
    expect(state.headers['cache-control']).toBe('no-cache');
    expect(state.headers['x-accel-buffering']).toBe('no');
    expect(state.headers['content-encoding']).toBe('identity');
    expect(state.flushedHeaders).toBe(true);
    expect(state.ended).toBe(true);
  });

  it('emits thinking → intro → complete events with hasIntro=true', async () => {
    mockGenerateIntro.mockResolvedValue(FAKE_INTRO);
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);

    const combined = state.writtenChunks.join('');
    expect(combined).toContain('event: thinking');
    expect(combined).toContain('event: intro');
    expect(combined).toContain('"content":"Salesforce Sync owned the week');
    expect(combined).toContain('event: complete');
    expect(combined).toContain('"hasIntro":true');

    // Order check: thinking → intro → complete
    const thinkingIdx = combined.indexOf('event: thinking');
    const introIdx = combined.indexOf('event: intro');
    const completeIdx = combined.indexOf('event: complete');
    expect(thinkingIdx).toBeLessThan(introIdx);
    expect(introIdx).toBeLessThan(completeIdx);
  });

  it('emits thinking + complete with hasIntro=false when service returns null', async () => {
    mockGenerateIntro.mockResolvedValue(null);
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);

    const combined = state.writtenChunks.join('');
    expect(combined).toContain('event: thinking');
    expect(combined).toContain('event: complete');
    expect(combined).toContain('"hasIntro":false');
    expect(combined).not.toContain('event: intro');
  });

  it('emits an error SSE event if generateInsightsIntro throws unexpectedly', async () => {
    mockGenerateIntro.mockRejectedValue(new Error('unexpected boom'));
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);

    const combined = state.writtenChunks.join('');
    expect(combined).toContain('event: error');
    expect(combined).toContain('"code":"INTERNAL"');
    expect(state.ended).toBe(true);
  });
});
