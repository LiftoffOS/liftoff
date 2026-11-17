/**
 * A file a provider answered with is stored, attributed, and shown to nobody.
 *
 * Storing and publishing are separate acts. These bytes arrive because a model
 * asked an API a question; nothing yet knows whether a person will ever be
 * shown them, and most are read once and never mentioned again. So the file is
 * STAGED: it exists, it names the AI team that fetched it, and it goes on its
 * own unless somebody presents it. Presenting clears the lifetime.
 *
 * The thread is deliberately absent. Which conversation shows a file is decided
 * by where the reply goes, not by anything travelling with the bytes.
 */
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { storeWorkspaceFile, WorkspaceFileError } from '../workspace-files.js';

const OK = {
  ok: true,
  json: async () => ({ id: 'file-1', filename: 'invoice.pdf', mimeType: 'application/pdf' }),
};

function fieldsOf(): Record<string, string> {
  const form = fetchMock.mock.calls[0][1].body as FormData;
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BACKEND_URL = 'https://backend.example';
  process.env.PLATFORM_CALLBACK_TOKEN = 'tok';
  fetchMock.mockResolvedValue(OK);
});

describe('storing what a provider answered with', () => {
  it('stages the file rather than keeping it forever', async () => {
    await storeWorkspaceFile({
      tenantId: 't1', agentId: 'a1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', bytes: Buffer.from('%PDF'),
    });
    const fields = fieldsOf();
    expect(Number(fields.discardAfterSeconds)).toBe(7 * 24 * 60 * 60);
  });

  it('names the AI team that fetched it, because somebody performed this', async () => {
    await storeWorkspaceFile({
      tenantId: 't1', agentId: 'a1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', bytes: Buffer.from('%PDF'),
    });
    expect(fieldsOf()).toMatchObject({ tenantId: 't1', agentId: 'a1' });
  });

  it('sends no conversation, because a file carries none', async () => {
    await storeWorkspaceFile({
      tenantId: 't1', agentId: 'a1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', bytes: Buffer.from('%PDF'),
    });
    expect(fieldsOf()).not.toHaveProperty('conversationId');
  });

  it('calls a picture media and everything else a document', async () => {
    await storeWorkspaceFile({
      tenantId: 't1', agentId: 'a1', filename: 'chart.png',
      mimeType: 'image/png', bytes: Buffer.from('PNG'),
    });
    expect(fieldsOf().outputType).toBe('media');
  });

  it('refuses rather than filing a file under a fiction', async () => {
    // A file with no producer is one nobody can be asked about later, and
    // migration 393 made the column nullable precisely so no caller invents one.
    await expect(storeWorkspaceFile({
      tenantId: 't1', agentId: undefined, filename: 'invoice.pdf',
      mimeType: 'application/pdf', bytes: Buffer.from('%PDF'),
    })).rejects.toThrow(WorkspaceFileError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a handle and never the bytes', async () => {
    const stored = await storeWorkspaceFile({
      tenantId: 't1', agentId: 'a1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', bytes: Buffer.from('%PDF'),
    });
    expect(stored).toEqual({
      fileId: 'file-1', filename: 'invoice.pdf',
      mimeType: 'application/pdf', sizeBytes: 4,
    });
  });
});
