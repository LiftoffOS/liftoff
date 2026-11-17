// Observation router tests — Phase 7
//
// Tests the handler directly (bypassing Express) with mocked dependencies.
// Verifies input validation, SSE headers + flushHeaders, event forwarding,
// and the "degrade silently" contract when the service returns [].

import type { Request, Response } from 'express';

const mockGenerateObservations = jest.fn();
jest.mock('../observation-service', () => ({
  generateInsightsObservations: (...args: unknown[]) =>
    mockGenerateObservations(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { observationRouter } from '../observation-router';
import type { ObservationBlock } from '../shared-types';

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
  const stack = (observationRouter as unknown as { stack: RouterStackLayer[] }).stack;
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

const FAKE_OBSERVATIONS: ObservationBlock[] = [
  { type: 'observation', icon: '+', content: 'Salesforce Sync tasks up 34% week-over-week' },
  { type: 'observation', icon: '!', content: 'External agent cost spiked' },
  { type: 'observation', icon: '-', content: 'Error rate climbing on Inbox Triage' },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /report/observations — validation', () => {
  const handler = getRouteHandler('/report/observations');

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
    mockGenerateObservations.mockResolvedValue(FAKE_OBSERVATIONS);
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.flushedHeaders).toBe(true);
    // Default period should be this_week
    expect(mockGenerateObservations).toHaveBeenCalledWith(
      TENANT_A,
      { preset: 'this_week' },
    );
  });

  it('accepts a custom period preset', async () => {
    mockGenerateObservations.mockResolvedValue([]);
    const req = createMockRequest({ tenantId: TENANT_A, period: 'last_month' });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockGenerateObservations).toHaveBeenCalledWith(
      TENANT_A,
      { preset: 'last_month' },
    );
  });

  it('accepts start/end date overrides', async () => {
    mockGenerateObservations.mockResolvedValue([]);
    const req = createMockRequest({
      tenantId: TENANT_A,
      start: '2026-03-01T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
    });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockGenerateObservations).toHaveBeenCalledWith(TENANT_A, {
      start: '2026-03-01T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
    });
  });
});

describe('GET /report/observations — SSE streaming', () => {
  const handler = getRouteHandler('/report/observations');

  it('sets the expected SSE headers and flushes them', async () => {
    mockGenerateObservations.mockResolvedValue(FAKE_OBSERVATIONS);
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

  it('emits thinking → observation × N → complete events in order', async () => {
    mockGenerateObservations.mockResolvedValue(FAKE_OBSERVATIONS);
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);

    const combined = state.writtenChunks.join('');
    expect(combined).toContain('event: thinking');
    expect(combined).toContain('event: observation');
    expect(combined).toContain('"icon":"+"');
    expect(combined).toContain('"icon":"!"');
    expect(combined).toContain('"icon":"-"');
    expect(combined).toContain('event: complete');
    expect(combined).toContain('"count":3');

    // Order check: thinking comes before observations, complete comes last
    const thinkingIdx = combined.indexOf('event: thinking');
    const firstObsIdx = combined.indexOf('event: observation');
    const completeIdx = combined.indexOf('event: complete');
    expect(thinkingIdx).toBeLessThan(firstObsIdx);
    expect(firstObsIdx).toBeLessThan(completeIdx);
  });

  it('emits thinking + complete with count 0 when no observations are generated', async () => {
    mockGenerateObservations.mockResolvedValue([]);
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);

    const combined = state.writtenChunks.join('');
    expect(combined).toContain('event: thinking');
    expect(combined).toContain('event: complete');
    expect(combined).toContain('"count":0');
    expect(combined).not.toContain('event: observation');
  });

  it('emits an error SSE event if generateInsightsObservations throws unexpectedly', async () => {
    // The service is designed to catch all errors internally, but a truly
    // unexpected throw (e.g. bad import, syntax error) should still be
    // caught by the router and surfaced as an error event.
    mockGenerateObservations.mockRejectedValue(new Error('unexpected boom'));
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);

    const combined = state.writtenChunks.join('');
    expect(combined).toContain('event: error');
    expect(combined).toContain('"code":"INTERNAL"');
    expect(state.ended).toBe(true);
  });
});
