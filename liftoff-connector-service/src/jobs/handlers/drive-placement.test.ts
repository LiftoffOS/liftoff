// A native Docs or Slides file lands wherever Drive puts it; the folder the
// person asked for is one move after creation, and a failed move never costs
// the file. Pinned both ways: the move is made, and its failure is survived.

jest.mock('../../infra/logging.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { jest } from '@jest/globals';
import { placeInDriveFolder } from './drive-placement.js';
import { logger } from '../../infra/logging.js';

const ok = () => Promise.resolve(new Response('{"id":"f1","parents":["folder-7"]}', { status: 200 }));
const denied = () => Promise.resolve(new Response('{"error":"forbidden"}', { status: 403 }));

describe('placeInDriveFolder', () => {
  beforeEach(() => (logger.warn as jest.Mock).mockClear());

  it('does nothing when no folder was asked for', async () => {
    const gFetch = jest.fn(ok);
    await placeInDriveFolder(gFetch as never, 'f1', undefined, 'presentation');
    expect(gFetch).not.toHaveBeenCalled();
  });

  it('adds the file to the requested folder with one PATCH', async () => {
    const gFetch = jest.fn(ok);
    await placeInDriveFolder(gFetch as never, 'f1', 'folder-7', 'presentation');
    expect(gFetch).toHaveBeenCalledTimes(1);
    const [url, init] = (gFetch.mock.calls[0] as unknown as [string, RequestInit]);
    expect(url).toContain('/drive/v3/files/f1?addParents=folder-7');
    expect(init.method).toBe('PATCH');
  });

  it('keeps the file and warns, naming the folder, when the move is refused', async () => {
    const gFetch = jest.fn(denied);
    await expect(placeInDriveFolder(gFetch as never, 'f1', 'folder-7', 'document')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'f1', parentFolderId: 'folder-7', status: 403 }),
      expect.stringContaining('not moved'),
    );
  });

  it('keeps the file and warns when the move throws', async () => {
    const gFetch = jest.fn(() => Promise.reject(new Error('network')));
    await expect(placeInDriveFolder(gFetch as never, 'f1', 'folder-7', 'document')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'f1', parentFolderId: 'folder-7' }), expect.stringContaining('threw'));
  });
});
