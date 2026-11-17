// The output types a producer may register, and what each one is named on disk.
//
// 'gdoc' is a native Google Doc: it lives in the connector, has no bytes here
// and no extension, exactly as 'gslides' does for a native deck. The tenant
// runtime has sent it for a copied-and-edited Google Doc since that tool
// shipped, and the enum never held it — a 400 before the row was reached and a
// card that never appeared. It is NOT 'docx': the registration route names the
// file `${baseName}_v${n}.${ext}`, so a Google Doc registered as docx would
// card as `Report_v1.docx` beside a URL that opens a Google Doc.

import {
  documentOutputTypeSchema,
  outputTypeSchema,
  outputTypeToExt,
} from '../store';

describe('outputTypeSchema', () => {
  it('holds gdoc, the sibling of gslides', () => {
    expect(outputTypeSchema.options).toContain('gdoc');
    expect(outputTypeSchema.options).toContain('gslides');
  });

  it('accepts gdoc as a document a connector-native registration may name', () => {
    // The connector-native route validates against the document subset, so a
    // value in the base enum but not here would still be a 400 on that route.
    expect(documentOutputTypeSchema.safeParse('gdoc').success).toBe(true);
    expect(documentOutputTypeSchema.safeParse('media').success).toBe(false);
  });
});

describe('outputTypeToExt', () => {
  it('gives a native Google Doc no extension, like a native deck', () => {
    expect(outputTypeToExt('gdoc')).toBe('');
    expect(outputTypeToExt('gslides')).toBe('');
  });

  it('keeps the office formats on their own extensions', () => {
    expect(outputTypeToExt('docx')).toBe('docx');
    expect(outputTypeToExt('docx_redlined')).toBe('docx');
    expect(outputTypeToExt('pptx')).toBe('pptx');
    expect(outputTypeToExt('xlsx')).toBe('xlsx');
    expect(outputTypeToExt('pdf')).toBe('pdf');
  });
});
