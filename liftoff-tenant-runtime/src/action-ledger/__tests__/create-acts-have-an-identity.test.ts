/**
 * An act that creates something is still an act, and two identical ones are one.
 *
 * `actKeyFor` returned null whenever the target had no path, and an act that
 * CREATES something has no target — the thing does not exist yet. So every
 * create, on every connector, carried a null `act_key` AND a null `target_ref`,
 * which is both of the things the duplicate guard can compare. Creates were
 * exempt from it entirely.
 *
 * What that costs: `create_document_markdown` can dispatch twice seconds apart
 * with a BYTE-IDENTICAL payload — once from a model-issued tool call, once from
 * a workflow step's synthesised one. Two documents, two ids, and an agent that
 * cannot say which of them is current.
 *
 * The identity of a create is what it creates. Creating two DIFFERENT things
 * stays two acts.
 */
import { actKeyFor, isContentActKey, directOperation, deriveTarget } from '../target-ref';

/** The payload from the live duplicate, trimmed to its shape. */
const WATCH_LIST = {
  title: 'Acme competitor watch list',
  markdown_text: '# PROPOSAL: corrections go in this document, not in a reply\n\n| Competitor |\n',
};
const CONNECTOR = 'google-docs-8fd9fc68';
const ACTION = 'create_document_markdown';

const keyFor = (payload: unknown) => actKeyFor(
  directOperation(CONNECTOR, ACTION),
  deriveTarget({ connector: CONNECTOR, actionType: ACTION, entityType: '', payload: payload as Record<string, unknown> }),
  payload,
);

describe('a create is keyed by what it writes', () => {
  it('two identical creates are one act', () => {
    // The live defect, in one line.
    expect(keyFor(WATCH_LIST)).toBe(keyFor({ ...WATCH_LIST }));
    expect(keyFor(WATCH_LIST)).not.toBeNull();
  });

  it('is a CONTENT key, so the lookup knows not to compare it by target', () => {
    expect(isContentActKey(keyFor(WATCH_LIST))).toBe(true);
  });

  it('two different creates stay two acts', () => {
    expect(keyFor(WATCH_LIST)).not.toBe(keyFor({ ...WATCH_LIST, title: 'Acme competitor snapshot' }));
    expect(keyFor(WATCH_LIST)).not.toBe(keyFor({ ...WATCH_LIST, markdown_text: '# Something else\n' }));
  });

  it('key order does not change the act', () => {
    expect(keyFor({ title: WATCH_LIST.title, markdown_text: WATCH_LIST.markdown_text }))
      .toBe(keyFor({ markdown_text: WATCH_LIST.markdown_text, title: WATCH_LIST.title }));
  });

  it('ignores the fields that differ between two attempts at one act', () => {
    // A retry re-sends its own token. Keying on it would make every repeat look
    // new, which is exactly what this digest exists to catch.
    expect(keyFor({ ...WATCH_LIST, idempotency_key: 'a', request_id: 'r1', nonce: '1' }))
      .toBe(keyFor({ ...WATCH_LIST, idempotency_key: 'b', request_id: 'r2', nonce: '2' }));
  });

  it('separates two connectors doing the same thing', () => {
    const other = actKeyFor(
      directOperation('notion-123', ACTION),
      deriveTarget({ connector: 'notion-123', actionType: ACTION, entityType: '', payload: WATCH_LIST }),
      WATCH_LIST,
    );
    expect(other).not.toBe(keyFor(WATCH_LIST));
  });

  it('holds for creates on every connector, not just documents', () => {
    // The guard is the shared one, so the property is about the shape of an
    // act, not about Google Docs.
    for (const [connector, action, payload] of [
      ['slack-1', 'send_message', { channel: '#x', text: 'hello' }],
      ['notion-1', 'create_page', { parent: 'db1', title: 'Q3' }],
      ['hubspot-1', 'create_contact', { email: 'a@b.test' }],
      ['linear-1', 'create_issue', { team: 'ENG', title: 'bug' }],
    ] as const) {
      const k = (p: unknown) => actKeyFor(
        directOperation(connector, action),
        deriveTarget({ connector, actionType: action, entityType: '', payload: p as Record<string, unknown> }),
        p,
      );
      expect(k(payload)).not.toBeNull();
      expect(k(payload)).toBe(k({ ...payload }));
      expect(k(payload)).not.toBe(k({ ...payload, title: 'different', text: 'different', email: 'z@b.test' }));
    }
  });
});

describe('what it must not change', () => {
  it('an act WITH a target is still keyed on the target, not on its content', () => {
    // The pre-existing property: the same outward act through two routes shares
    // a key, and that only works if the key is the target. A content key here
    // would split them.
    const payload = { document_id: 'doc-1', markdown_text: 'a' };
    const target = deriveTarget({ connector: CONNECTOR, actionType: 'update_document_markdown', entityType: '', payload });
    const key = actKeyFor(directOperation(CONNECTOR, 'update_document_markdown'), target, payload);
    expect(key).not.toBeNull();
    expect(isContentActKey(key)).toBe(false);
    // ...and editing the body does NOT make it a different act on the same doc.
    const key2 = actKeyFor(
      directOperation(CONNECTOR, 'update_document_markdown'),
      deriveTarget({ connector: CONNECTOR, actionType: 'update_document_markdown', entityType: '', payload: { ...payload, markdown_text: 'b' } }),
      { ...payload, markdown_text: 'b' },
    );
    expect(key2).toBe(key);
  });

  it('a caller that passes no payload behaves exactly as it did', () => {
    const target = deriveTarget({ connector: CONNECTOR, actionType: ACTION, entityType: '', payload: WATCH_LIST });
    expect(actKeyFor(directOperation(CONNECTOR, ACTION), target)).toBeNull();
  });

  it('an empty payload names no act', () => {
    expect(keyFor({})).toBeNull();
    expect(keyFor(null)).toBeNull();
  });
});
