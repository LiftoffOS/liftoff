/**
 * A file goes on the wire from an id, never from a model.
 *
 * Asking a model for bytes means a file read into a context window and mangled
 * by whatever encoding it guessed. So an operation that takes a file takes the
 * ID of one already in the workspace — produced by an AI team, or attached by
 * a person — and the bytes are fetched at dispatch. That is what let Asana,
 * DocuSign and the rest connect: an upload endpoint stopped being a reason to
 * refuse an entire API.
 */
const readMock = jest.fn();

jest.mock('../workspace-files.js', () => ({
  readWorkspaceFile: (...a: unknown[]) => readMock(...a),
  WorkspaceFileError: class WorkspaceFileError extends Error {
    readonly reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  },
}));

import { buildFileBody } from '../file-body.js';

const FILE = {
  bytes: Buffer.from('%PDF-1.7 pretend'),
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
};

beforeEach(() => {
  jest.clearAllMocks();
  readMock.mockResolvedValue(FILE);
});

describe('a multipart body', () => {
  it('sends the file as bytes and the other fields beside it', async () => {
    const built = await buildFileBody({
      tenantId: 't1',
      body: { file: 'file-123', name: 'September invoice', parent: 'proj-9' },
      fileParams: ['file'],
      mediaType: 'multipart/form-data',
    });

    expect(readMock).toHaveBeenCalledWith({ tenantId: 't1', fileId: 'file-123' });
    const form = built.payload as FormData;
    expect(form.get('name')).toBe('September invoice');
    expect(form.get('parent')).toBe('proj-9');
    const sent = form.get('file') as File;
    expect(sent.name).toBe('invoice.pdf');
    expect(sent.type).toBe('application/pdf');
    expect(sent.size).toBe(FILE.bytes.length);
  });

  it('sets no content type, because the form carries its own boundary', async () => {
    const built = await buildFileBody({
      tenantId: 't1', body: { file: 'file-123' }, fileParams: ['file'], mediaType: 'multipart/form-data',
    });
    // One we wrote would be missing the boundary, and the provider would
    // reject the request.
    expect(built.contentType).toBeUndefined();
  });

  it('writes a structured field as JSON, the only reading a form has for one', async () => {
    const built = await buildFileBody({
      tenantId: 't1',
      body: { file: 'f1', options: { visible: true } },
      fileParams: ['file'],
      mediaType: 'multipart/form-data',
    });
    expect((built.payload as FormData).get('options')).toBe('{"visible":true}');
  });
});

describe('a raw binary body', () => {
  it('sends the bytes alone, under the type the specification declared', async () => {
    const built = await buildFileBody({
      tenantId: 't1', body: { file: 'file-123' }, fileParams: ['file'], mediaType: 'application/pdf',
    });
    expect(built.payload).toEqual(FILE.bytes);
    expect(built.contentType).toBe('application/pdf');
  });

  it('falls back to the type the stored file says it is', async () => {
    const built = await buildFileBody({
      tenantId: 't1', body: { file: 'file-123' }, fileParams: ['file'], mediaType: undefined,
    });
    expect(built.contentType).toBe('application/pdf');
  });
});

describe('what it refuses', () => {
  it('refuses contents pasted in place of an id', async () => {
    await expect(buildFileBody({
      tenantId: 't1', body: { file: '' }, fileParams: ['file'], mediaType: 'application/pdf',
    })).rejects.toThrow(/none was named|takes the id/);
    expect(readMock).not.toHaveBeenCalled();
  });

  it('refuses a non-string where an id belongs, rather than sending the words for it', async () => {
    await expect(buildFileBody({
      tenantId: 't1', body: { file: { bytes: 'AAAA' } }, fileParams: ['file'], mediaType: 'application/pdf',
    })).rejects.toThrow(/takes the id of a file/);
  });

  it('says which field wanted a file when none was given', async () => {
    await expect(buildFileBody({
      tenantId: 't1', body: { name: 'x' }, fileParams: ['attachment'], mediaType: 'application/pdf',
    })).rejects.toThrow(/attachment/);
  });
});
