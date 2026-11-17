// What browse lists when the caller names no entityType.
//
// This pins a defect that is easy to ship. The browse route once carried
// a per-vendor if/else, and each branch quietly supplied its own default:
// Drive listed 'file', Zendesk 'category', Confluence 'space'. Refactoring the
// dispatch away collapsed all of them into one `?? 'folder'`, which reads as a
// harmless tidy-up and is not:
//
//   - Google Drive's client treats 'folder' as a mimeType FILTER, so the
//     knowledge file picker listed folders and no files. A customer could not
//     select a file at all.
//   - No wiki or help-centre client has a 'folder' entity, so every one of them
//     returned unsupported and the picker said we could not list anything.
//
// Nothing failed. The 1618 tests passed, lint passed, the build passed, and CI
// was green, because the defaults lived in an HTTP route nothing exercised.
// These assertions are cheap and they are the only thing standing between a
// one-word default and a dead picker.

import { defaultBrowseEntity, DEFAULT_BROWSE_ENTITY } from '../router.js';

describe('defaultBrowseEntity', () => {
  it('lists FILES for storage connectors, not folders', () => {
    // The regression, stated directly: 'folder' here hides every file behind a
    // mimeType filter and breaks the knowledge picker.
    for (const type of ['google_drive', 'microsoft_onedrive', 'dropbox', 'box']) {
      expect(defaultBrowseEntity(type)).toBe('file');
    }
  });

  it('gives each wiki and help centre its own top-level container', () => {
    expect(defaultBrowseEntity('zendesk')).toBe('category');
    expect(defaultBrowseEntity('intercom')).toBe('collection');
    expect(defaultBrowseEntity('atlassian_confluence')).toBe('space');
    expect(defaultBrowseEntity('notion')).toBe('page');
    expect(defaultBrowseEntity('microsoft_onenote')).toBe('notebook');
    expect(defaultBrowseEntity('microsoft_sharepoint')).toBe('site');
  });

  it('lists documents alongside folders for Google Docs', () => {
    // Defaulting this to 'folder' filtered every document out of the picker, so
    // one modal on one connection could offer a folder to write into and show
    // nothing at all to someone choosing a document to read. Browse shows what
    // is there; what a pick MEANS belongs to the picker.
    expect(defaultBrowseEntity('google_docs')).toBe('file');
  });

  it('keeps the spreadsheet default that names a table', () => {
    expect(defaultBrowseEntity('google_sheets')).toBe('spreadsheet');
  });

  it('never answers with an entity the connector cannot enumerate', () => {
    // Every default must be a real entity for its connector. A default that no
    // client handles returns unsupported, which tells the customer we cannot
    // list their data when the truth is we asked the wrong question.
    const KNOWN_ENTITIES = new Set([
      'file', 'folder', 'spreadsheet', 'category', 'collection', 'space',
      'page', 'notebook', 'site',
    ]);
    for (const [type, entity] of Object.entries(DEFAULT_BROWSE_ENTITY)) {
      expect({ type, entity, known: KNOWN_ENTITIES.has(entity) })
        .toEqual({ type, entity, known: true });
    }
  });

  it('prefers a poll spec entity over the blanket fallback', () => {
    const spec = { entities: [{ entityType: 'Deal' }, { entityType: 'Contact' }] };
    expect(defaultBrowseEntity('some_specd_connector', spec)).toBe('Deal');
  });

  it('falls back to file for an unknown connector', () => {
    // Storage-shaped connectors dominate what is left, and 'file' is the
    // permissive answer: it lists files and folders rather than hiding one.
    expect(defaultBrowseEntity('a_connector_nobody_mapped')).toBe('file');
  });
});
