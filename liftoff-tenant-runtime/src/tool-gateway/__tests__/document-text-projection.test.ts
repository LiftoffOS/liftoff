/**
 * A document read returns the document, not its typography.
 *
 * The fixture below is the shape a live `get_document` returns for an EMPTY
 * document: one newline of content, and 13,347 characters in total.
 * A step with an 8,192-character budget that must read the document whole,
 * because it is about to append to it, has no legal way to pass the value on,
 * so the run stops — and the remaining steps read the hole where the digest
 * should have been and tell the person their report is already current.
 *
 * The wrapping is bigger than the budget on its own, so that step could never
 * have succeeded for any document, empty or not.
 */
import { projectDocumentText } from '../document-text-projection';

/** The live shape, trimmed in volume but not in kind. */
const EMPTY_DOC_RESPONSE = {
  documentId: '1380NW8OfdUuM3nHVRVys0ZAtdBmLuDDwJ_Z_LpP7Z9o',
  title: 'Acme competitor digest',
  body: {
    content: [
      { endIndex: 1, sectionBreak: { sectionStyle: { sectionType: 'CONTINUOUS', contentDirection: 'LEFT_TO_RIGHT', columnSeparatorStyle: 'NONE' } } },
      {
        endIndex: 2,
        startIndex: 1,
        paragraph: {
          elements: [{ textRun: { content: '\n', textStyle: {} }, endIndex: 2, startIndex: 1 }],
          paragraphStyle: { alignment: 'START', direction: 'LEFT_TO_RIGHT', indentEnd: { unit: 'PT' }, indentStart: { unit: 'PT' }, namedStyleType: 'NORMAL_TEXT', indentFirstLine: { unit: 'PT' } },
        },
      },
    ],
  },
  // Real documents carry one of these per list style ever used, each with nine
  // nesting levels. Sized to the 13,347 characters the live response measured,
  // because the whole point is that it does not fit an 8,192 budget.
  lists: Object.fromEntries(['kix.6w8l8a0g8bq', 'kix.9ab2c0dd1ef', 'kix.3zz7y1qq4mn'].map((id) => [id, {
    listProperties: {
      nestingLevels: Array.from({ length: 9 }, (_, i) => ({
        textStyle: { underline: false }, glyphFormat: `%${i}`, glyphSymbol: ['●', '○', '■'][i % 3],
        indentStart: { unit: 'PT', magnitude: 36 * (i + 1) }, startNumber: 1,
        bulletAlignment: 'START', indentFirstLine: { unit: 'PT', magnitude: 18 * (i + 1) },
      })),
    },
  }])),
  namedStyles: {
    styles: ['NORMAL_TEXT', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6', 'TITLE', 'SUBTITLE'].map((n) => ({
      namedStyleType: n,
      textStyle: { bold: false, italic: false, underline: false, fontSize: { unit: 'PT', magnitude: 11 }, weightedFontFamily: { fontFamily: 'Arial', weight: 400 }, foregroundColor: { color: { rgbColor: {} } } },
      paragraphStyle: { alignment: 'START', direction: 'LEFT_TO_RIGHT', lineSpacing: 100, indentEnd: { unit: 'PT' }, indentStart: { unit: 'PT' }, spaceAbove: { unit: 'PT' }, spaceBelow: { unit: 'PT' }, keepLinesTogether: false, keepWithNext: false, avoidWidowAndOrphan: true, borderTop: {}, borderBottom: {}, borderLeft: {}, borderRight: {}, borderBetween: {} },
    })),
  },
  documentStyle: { background: { color: {} }, pageSize: { height: { unit: 'PT', magnitude: 792 }, width: { unit: 'PT', magnitude: 612 } }, marginTop: { unit: 'PT', magnitude: 72 }, marginBottom: { unit: 'PT', magnitude: 72 } },
  revisionId: 'ALm37BX...',
};

/** A document with real content, in the same wrapping. */
const WRITTEN_DOC = {
  ...EMPTY_DOC_RESPONSE,
  body: {
    content: [
      { endIndex: 1, sectionBreak: { sectionStyle: {} } },
      { paragraph: { elements: [{ textRun: { content: '# Acme competitor digest\n', textStyle: { bold: true } } }], paragraphStyle: { namedStyleType: 'HEADING_1' } } },
      { paragraph: { elements: [{ textRun: { content: 'GetAgent raised a round.\n', textStyle: {} } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } },
    ],
  },
};

const size = (v: unknown) => JSON.stringify(v)!.length;

describe('a document read is projected to its text', () => {
  it('an EMPTY document projects to empty text, not to 13 KB of styles', () => {
    const out = projectDocumentText(EMPTY_DOC_RESPONSE) as { text: string };
    expect(out.text.trim()).toBe('');
  });

  it('collapses by more than an order of magnitude', () => {
    // The property that matters: the result must fit a step budget it could
    // never fit before. 8,192 is STEP_OUTPUT_BUDGET.
    const before = size(EMPTY_DOC_RESPONSE);
    const after = size(projectDocumentText(EMPTY_DOC_RESPONSE));
    // Before: does not fit, and never could. After: fits with room to spare.
    expect(before).toBeGreaterThan(8_192);
    expect(after).toBeLessThan(8_192);
    expect(after * 10).toBeLessThan(before);
  });

  it('keeps the content of a written document, in order', () => {
    const out = projectDocumentText(WRITTEN_DOC) as { text: string };
    expect(out.text).toContain('# Acme competitor digest');
    expect(out.text).toContain('GetAgent raised a round.');
    expect(out.text.indexOf('digest')).toBeLessThan(out.text.indexOf('GetAgent'));
  });

  it('keeps the identity of the document it read', () => {
    const out = projectDocumentText(EMPTY_DOC_RESPONSE) as { documentId: string; title: string };
    expect(out.documentId).toBe('1380NW8OfdUuM3nHVRVys0ZAtdBmLuDDwJ_Z_LpP7Z9o');
    expect(out.title).toBe('Acme competitor digest');
  });

  it('drops only presentation, and says how much', () => {
    const out = projectDocumentText(EMPTY_DOC_RESPONSE) as Record<string, unknown>;
    for (const k of ['lists', 'namedStyles', 'documentStyle', 'revisionId', 'body']) {
      expect(out).not.toHaveProperty(k);
    }
    expect(out.presentationCharsDropped as number).toBeGreaterThan(5_000);
  });

  it('reads text out of table cells, not just top-level paragraphs', () => {
    // A digest written as a table would otherwise project to empty, which is
    // indistinguishable from a wiped document.
    const withTable = {
      body: { content: [{ table: { tableRows: [{ tableCells: [
        { content: [{ paragraph: { elements: [{ textRun: { content: 'GetAgent' } }] } }] },
        { content: [{ paragraph: { elements: [{ textRun: { content: '£2.5M' } }] } }] },
      ] }] } }] },
    };
    const out = projectDocumentText(withTable) as { text: string };
    expect(out.text).toContain('GetAgent');
    expect(out.text).toContain('£2.5M');
  });
});

describe('what it must not touch', () => {
  it('returns anything that is not a document body unchanged', () => {
    for (const v of [
      null, undefined, 'a string', 42, [],
      { id: 'msg-1', subject: 'hello' },
      { body: 'a string body, not a docs tree' },
      { body: { content: 'not an array' } },
    ]) {
      expect(projectDocumentText(v)).toBe(v);
    }
  });

  it('keeps a field it has never heard of, rather than dropping it silently', () => {
    const out = projectDocumentText({ ...EMPTY_DOC_RESPONSE, someNewField: { keep: 'me' } }) as Record<string, unknown>;
    expect(out.someNewField).toEqual({ keep: 'me' });
  });

  it('is idempotent, so running it twice cannot lose the text', () => {
    const once = projectDocumentText(WRITTEN_DOC);
    expect(projectDocumentText(once)).toBe(once);
  });
});
