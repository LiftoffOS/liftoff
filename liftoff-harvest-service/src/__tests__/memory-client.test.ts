/* eslint-disable @typescript-eslint/no-var-requires */

const mockQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockQuery })),
  closePool: jest.fn(),
}));

jest.mock('../connector-hints', () => ({
  CONNECTOR_ROLE_HINTS: { salesforce: 'sales' },
}));

jest.mock('../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockResolvedValue({}),
}));

jest.mock('../ttl', () => ({
  computeExpiresAt: jest.fn().mockReturnValue('2026-12-31T00:00:00.000Z'),
}));

const mockFetch = jest.fn();
(global as unknown as { fetch: jest.Mock }).fetch = mockFetch;

import { writeMemory } from '../memory-client';
import type { ClassificationResult, HarvestEvent } from '../types';

function makeResult(partial: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    worthy: true,
    memoryType: 'CONVENTION',
    confidence: 0.9,
    extractedContent: 'Use Postgres.',
    suggestedLayer: 'global',
    ...partial,
  };
}

function makeEvent(partial: Partial<HarvestEvent> = {}): HarvestEvent {
  return {
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
    connectorType: 'slack',
    entityType: 'Message',
    entityId: 'entity-1',
    data: {},
    messageId: 'msg-1',
    ...partial,
  };
}

// Default memory POST response — overridden per test when needed
let memoryPostResponse = {
  status: 201,
  ok: true,
  json: async () => ({ id: 'uuid-123' }),
  text: async () => '{"id":"uuid-123"}',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Route by URL so the module-level runtimeUrlCache doesn't break ordering.
  memoryPostResponse = {
    status: 201,
    ok: true,
    json: async () => ({ id: 'uuid-123' }),
    text: async () => '{"id":"uuid-123"}',
  };
  mockFetch.mockImplementation((url: string) => {
    if ((url as string).includes('runtime-url')) {
      return Promise.resolve({
        status: 200,
        ok: true,
        json: async () => ({ url: 'https://runtime.example.com' }),
        text: async () => '{"url":"https://runtime.example.com"}',
      });
    }
    // /api/memory POST
    return Promise.resolve(memoryPostResponse);
  });
});

describe('writeMemory', () => {
  it('includes scopeKey: roleHint in POST body when layer resolves to role', async () => {
    // 'salesforce' is in CONNECTOR_ROLE_HINTS → resolveLayer returns 'role', roleHint='sales'
    await writeMemory('tenant-1', makeResult({ suggestedLayer: 'global' }), makeEvent({ connectorType: 'salesforce' }));
    const postCall = mockFetch.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('/api/memory') && !((c[0] as string).includes('runtime-url')),
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as { body: string }).body);
    expect(body.scopeKey).toBe('sales');
    expect(body.layer).toBe('role');
  });

  it('includes scopeKey: "harvest" in POST body when layer resolves to global', async () => {
    await writeMemory('tenant-1', makeResult({ suggestedLayer: 'global' }), makeEvent());
    const postCall = mockFetch.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('/api/memory') && !((c[0] as string).includes('runtime-url')),
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as { body: string }).body);
    expect(body.scopeKey).toBe('harvest');
  });

  it('returns memoryId when response has id field', async () => {
    const result = await writeMemory('tenant-1', makeResult(), makeEvent());
    expect(result).toBe('uuid-123');
  });

  it('returns null when response has no id field', async () => {
    memoryPostResponse = {
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => '{}',
    };
    const result = await writeMemory('tenant-1', makeResult(), makeEvent());
    expect(result).toBeNull();
  });

  it('includes expiresAt field in POST body as ISO 8601 string', async () => {
    await writeMemory('tenant-1', makeResult(), makeEvent());
    const postCall = mockFetch.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('/api/memory') && !((c[0] as string).includes('runtime-url')),
    );
    const body = JSON.parse((postCall![1] as { body: string }).body);
    expect(body.expiresAt).toBe('2026-12-31T00:00:00.000Z');
  });

  it('throws when response is non-200', async () => {
    memoryPostResponse = {
      status: 500,
      ok: false,
      text: async () => 'Internal Server Error',
      json: async () => ({}),
    };
    await expect(writeMemory('tenant-1', makeResult(), makeEvent())).rejects.toThrow(
      'memory write failed 500',
    );
  });
});
