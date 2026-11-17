// Adapter unit tests — pure helpers + end-to-end with a synthetic client.

import type { CompensationClient } from './types.js';
import type { ExecutorContext } from '../rpc/execute-dispatcher.js';
import {
  inferCrudOp,
  extractEntityId,
  credentialProviderFromContext,
  makeClientExecutor,
} from './adapter.js';

function fakeClient(): CompensationClient {
  return {
    connector: 'fake',
    async read(type, id) {
      return { id: id ?? '', data: { type, op: 'read' } };
    },
    async list() {
      return { records: [], hasMore: false };
    },
    async create(type, data) {
      return { success: true, id: 'new-id', data: { type, received: data } };
    },
    async update(type, id, data) {
      return { success: true, versionToken: 'v2', data: { type, id, data } };
    },
    async delete() {
      return { success: true };
    },
    async restore() {
      return { success: true };
    },
    async semanticInverse() {
      return { success: true };
    },
  };
}

const baseCtx: ExecutorContext = {
  tenantId: 't',
  connectorId: 'c',
  connectorType: 'slack',
  connectorConfig: {},
  functionName: '',
  input: {},
  idempotencyKey: 'k',
  traceId: 'tr',
  credentials: { flowKind: 'api_key', apiKey: 'x' },
};

describe('adapter.inferCrudOp', () => {
  it('category: destructive → delete', () => {
    expect(
      inferCrudOp('archive_thing', {
        name: 'archive_thing',
        description: '',
        inputSchema: { type: 'object', properties: {} },
        categories: ['destructive'],
      }),
    ).toBe('delete');
  });

  it('category: read → read', () => {
    expect(
      inferCrudOp('fetch_the_thing', {
        name: 'fetch_the_thing',
        description: '',
        inputSchema: { type: 'object', properties: {} },
        categories: ['read'],
      }),
    ).toBe('read');
  });

  it('write + update-prefix → update', () => {
    expect(
      inferCrudOp('update_deal', {
        name: 'update_deal',
        description: '',
        inputSchema: { type: 'object', properties: {} },
        categories: ['write'],
      }),
    ).toBe('update');
  });

  it('outbound + send prefix → create', () => {
    expect(
      inferCrudOp('send_email', {
        name: 'send_email',
        description: '',
        inputSchema: { type: 'object', properties: {} },
        categories: ['outbound'],
      }),
    ).toBe('create');
  });

  it('prefix-fallback works without registry entry', () => {
    expect(inferCrudOp('get_whatever', undefined)).toBe('read');
    expect(inferCrudOp('remove_whatever', undefined)).toBe('delete');
    expect(inferCrudOp('patch_whatever', undefined)).toBe('update');
    expect(inferCrudOp('compose_whatever', undefined)).toBe('create');
  });
});

describe('adapter.extractEntityId', () => {
  it('prefers id then targetRef then entityId', () => {
    expect(extractEntityId({ id: 'A', targetRef: 'B' })).toBe('A');
    expect(extractEntityId({ targetRef: 'B' })).toBe('B');
    expect(extractEntityId({ entityId: 'C' })).toBe('C');
  });

  it('returns undefined when none present', () => {
    expect(extractEntityId({})).toBeUndefined();
  });

  it('ignores non-string ids', () => {
    expect(extractEntityId({ id: 42 as unknown as string })).toBeUndefined();
  });
});

describe('adapter.credentialProviderFromContext', () => {
  it('returns accessToken when present', async () => {
    const creds = await credentialProviderFromContext({
      ...baseCtx,
      credentials: { flowKind: 'static_oauth', accessToken: 'AT' },
    })();
    expect(creds.accessToken).toBe('AT');
  });

  it('falls back to apiKey when no accessToken', async () => {
    const creds = await credentialProviderFromContext({
      ...baseCtx,
      credentials: { flowKind: 'api_key', apiKey: 'KEY' },
    })();
    expect(creds.accessToken).toBe('KEY');
  });

  it('forwards instanceUrl', async () => {
    const creds = await credentialProviderFromContext({
      ...baseCtx,
      credentials: { flowKind: 'static_oauth', accessToken: 'x', instanceUrl: 'https://i' },
    })();
    expect(creds.instanceUrl).toBe('https://i');
  });
});

describe('adapter.makeClientExecutor', () => {
  it('routes "get_channel" (slack registry) → client.read', async () => {
    const exec = makeClientExecutor('slack', () => fakeClient());
    const out = await exec({ ...baseCtx, functionName: 'get_channel', input: { id: 'C123' } });
    expect(out.result).toMatchObject({ id: 'C123' });
  });

  it('routes "post_message" (slack registry, write) → client.create', async () => {
    const exec = makeClientExecutor('slack', () => fakeClient());
    const out = await exec({
      ...baseCtx,
      functionName: 'post_message',
      input: { channel: 'C', text: 'hi' },
    });
    expect(out.result).toMatchObject({ success: true, id: 'new-id' });
  });

  it('routes "update_message" → client.update', async () => {
    const exec = makeClientExecutor('slack', () => fakeClient());
    const out = await exec({
      ...baseCtx,
      functionName: 'update_message',
      input: { id: 'c:1', text: 'x' },
    });
    expect(out.result).toMatchObject({ success: true, versionToken: 'v2' });
  });

  it('unknown function name still dispatches by prefix', async () => {
    const exec = makeClientExecutor('slack', () => fakeClient());
    const out = await exec({
      ...baseCtx,
      functionName: 'find_mystery',
      input: { id: 'x' },
    });
    expect(out.result).toMatchObject({ id: 'x' });
  });
});
