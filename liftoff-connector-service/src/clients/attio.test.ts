// Hermetic tests for the Attio connector client.
// global.fetch is stubbed so no network I/O occurs.

import { AttioClient } from './attio.js';
import type { CredentialProvider } from './types.js';

function makeCredentialProvider(): CredentialProvider {
  return jest.fn().mockResolvedValue({ accessToken: 'attio-token' });
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('AttioClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('read', () => {
    it('fetches a person record by id', async () => {
      fetchSpy.mockResolvedValue(okResponse({ data: { id: { record_id: 'rec-1' }, updated_at: '2026-01-01T00:00:00Z' } }));
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.read('person', 'rec-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records/rec-1',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(res.id).toBe('rec-1');
    });

    it('fetches a company record by id', async () => {
      fetchSpy.mockResolvedValue(okResponse({ data: { id: { record_id: 'co-1' } } }));
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.read('company', 'co-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/companies/records/co-1',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(res.id).toBe('co-1');
    });

    it('queries a list via POST to records/query', async () => {
      fetchSpy.mockResolvedValue(okResponse({ data: [{ id: 'p1' }, { id: 'p2' }] }));
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.read('list', undefined, { object: 'companies', limit: 5 });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/companies/records/query',
        expect.objectContaining({ method: 'POST' }),
      );
      expect((res.data as { records: unknown[] }).records).toHaveLength(2);
    });

    it('throws on unsupported entity types', async () => {
      const client = new AttioClient(makeCredentialProvider());
      await expect(client.read('invoice', 'inv-1')).rejects.toThrow(/Unsupported Attio entity type/);
    });

    it('throws on API error', async () => {
      fetchSpy.mockResolvedValue(errorResponse(404, { message: 'not found' }));
      const client = new AttioClient(makeCredentialProvider());
      await expect(client.read('person', 'missing')).rejects.toThrow(/404/);
    });
  });

  describe('create', () => {
    it('creates a person and returns the new record_id', async () => {
      fetchSpy.mockResolvedValue(okResponse({ data: { id: { record_id: 'new-p' } } }));
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.create('person', { name: 'Alice' });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/people/records',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(res.success).toBe(true);
      expect(res.id).toBe('new-p');
    });

    it('creates a note and returns the note_id', async () => {
      fetchSpy.mockResolvedValue(okResponse({ data: { id: { note_id: 'note-1' } } }));
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.create('note', { title: 'Hello', content: 'World' });
      expect(res.success).toBe(true);
      expect(res.id).toBe('note-1');
    });

    it('returns success:false for unsupported entity types', async () => {
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.create('invoice', { amount: 100 });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Unsupported/);
    });

    it('returns success:false on API error', async () => {
      fetchSpy.mockResolvedValue(errorResponse(422, { message: 'validation error' }));
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.create('person', { name: '' });
      expect(res.success).toBe(false);
    });
  });

  describe('update', () => {
    it('patches a deal by id', async () => {
      fetchSpy.mockResolvedValue(okResponse({ data: {} }));
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.update('deal', 'deal-1', { status: 'won' });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/deals/records/deal-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
      expect(res.success).toBe(true);
    });

    it('returns success:false when entityId is missing', async () => {
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.update('person', undefined, { name: 'Bob' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/entityId required/);
    });

    it('returns success:false for unsupported entity types', async () => {
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.update('invoice', 'inv-1', { amount: 99 });
      expect(res.success).toBe(false);
    });
  });

  describe('delete', () => {
    it('deletes a company record', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 204, text: async () => '' } as unknown as Response);
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.delete('company', 'co-1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.attio.com/v2/objects/companies/records/co-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(res.success).toBe(true);
    });

    it('returns success:false when entityId is missing', async () => {
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.delete('person', undefined);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/entityId required/);
    });
  });

  describe('semanticInverse', () => {
    it('inverts a create by calling delete', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 204, text: async () => '' } as unknown as Response);
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.semanticInverse('person', 'create', 'rec-1', {});
      expect(res.success).toBe(true);
    });

    it('returns failure for delete inverse (unrecoverable)', async () => {
      const client = new AttioClient(makeCredentialProvider());
      const res = await client.semanticInverse('person', 'delete', 'rec-1', {});
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Cannot restore/i);
    });
  });
});
