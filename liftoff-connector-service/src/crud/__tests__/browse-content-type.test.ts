// contentType decides whether a row gets an expand chevron, so it must be read
// off the row and never assumed from the connector.
//
// google_docs hardcoded 'folder' for every row. That was true while the client
// returned folders and only folders, and became a lie the moment it also
// returned documents: the picker draws an expand affordance on anything typed
// 'folder', so every document in the list offered to open into children it does
// not have, sitting at the same level as real folders.
//
// The client also had to start requesting mimeType. Without it there was
// nothing on the row to decide from, which is why the connector type was
// standing in for it.

import { mapToBrowseResult } from '../router.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

const row = (data: Record<string, unknown>) => ({ id: 'x1', data });

describe('google_docs rows are typed individually', () => {
  it('types a folder as a folder', () => {
    const r = mapToBrowseResult('google_docs', row({ name: 'Marketing', mimeType: FOLDER }));
    expect(r.contentType).toBe('folder');
  });

  it('types a document as a document, so it gets no expand affordance', () => {
    const r = mapToBrowseResult('google_docs', row({ name: 'Positioning', mimeType: DOC }));
    expect(r.contentType).toBe('document');
  });

  it('does not call an unknown row a folder', () => {
    // The failure mode was defaulting TO folder. Anything unrecognised is a
    // leaf: an unexpandable row that looks expandable is worse than the
    // reverse, because clicking it goes nowhere.
    const r = mapToBrowseResult('google_docs', row({ name: 'Mystery' }));
    expect(r.contentType).toBe('document');
  });
});

describe('the other storage connectors type rows individually too', () => {
  it.each([
    ['google_drive', { mimeType: FOLDER }, { mimeType: DOC }],
    ['microsoft_onedrive', { folder: {} }, { file: {} }],
    ['dropbox', { '.tag': 'folder' }, { '.tag': 'file' }],
    ['box', { type: 'folder' }, { type: 'file' }],
  ])('%s separates folders from files', (type, folderRow, fileRow) => {
    expect(mapToBrowseResult(type, row({ name: 'F', ...folderRow })).contentType).toBe('folder');
    expect(mapToBrowseResult(type, row({ name: 'D', ...fileRow })).contentType).toBe('document');
  });
});
