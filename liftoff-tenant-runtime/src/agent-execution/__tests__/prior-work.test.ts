// An agent can report that no battle card exists for a competitor while one it
// wrote itself does: it runs several keyword searches, matches none, and
// reports the absence as a fact.
//
// These pin the rendering rules. The lookup fails soft and is exercised through
// its caller.

import {
  renderPriorWorkBlock,
  MAX_RENDERED_PRIOR_WORK,
  PRIOR_WORK_WINDOW_DAYS,
  type PriorArtifact,
} from '../prior-work';

const artifact = (o: Partial<PriorArtifact>): PriorArtifact => ({
  targetRef: 'google-docs:1aCLb-l2AXpQyLOzfFRkHTzk9tRxIXNmo9eGKmJzyP7I',
  connector: 'google-docs',
  actionType: 'create_document_markdown',
  createdAt: new Date('2026-08-27T09:14:00Z'),
  ...o,
});

describe('the record of prior work put in front of the model', () => {
  it('is null when the agent has produced nothing', () => {
    // Not an empty heading. A first run and a run whose ledger read failed must
    // not look alike, and a heading with no rows asserts the first.
    expect(renderPriorWorkBlock([])).toBeNull();
  });

  it('names the artifact and where it lives, so a name can be matched', () => {
    const out = renderPriorWorkBlock([
      artifact({ name: 'Battle Card: EstateAgent4Me', url: 'https://docs.google.com/document/d/1jeDMbf/edit' }),
    ])!;
    // The name is the whole point: the agent holds a competitor's name and is
    // trying to find what it made about it.
    expect(out).toContain('Battle Card: EstateAgent4Me');
    expect(out).toContain('https://docs.google.com/document/d/1jeDMbf/edit');
  });

  it('falls back to the target ref when the vendor response named nothing', () => {
    const out = renderPriorWorkBlock([artifact({ name: undefined, url: undefined })])!;
    expect(out).toContain('google-docs:1aCLb-l2AXpQyLOzfFRkHTzk9tRxIXNmo9eGKmJzyP7I');
  });

  it('tells the model a search miss is not an absence', () => {
    // The sentence that addresses the actual defect. An agent that searched and
    // found nothing concluded nothing existed; this is what contradicts that.
    const out = renderPriorWorkBlock([artifact({ name: 'Watch List' })])!;
    expect(out).toMatch(/search that finds\s+nothing means your search terms missed/);
    expect(out).toContain('before reporting');
  });

  it('states its own coverage, so the list is not read as everything', () => {
    const out = renderPriorWorkBlock([artifact({})])!;
    expect(out).toContain(String(PRIOR_WORK_WINDOW_DAYS));
    // The sandbox blind spot rides on the block for the same reason
    // have_i_acted_on carries it on every answer: a list that looks complete
    // and is not produces the very false absence this exists to prevent.
    expect(out).toContain('sandbox shell');
    expect(out).toContain('never a proof of absence');
  });

  it('states the overflow rather than silently truncating', () => {
    const many = Array.from({ length: MAX_RENDERED_PRIOR_WORK + 4 }, (_, i) =>
      artifact({ targetRef: `google-docs:doc-${i}`, name: `Doc ${i}` }));
    const out = renderPriorWorkBlock(many)!;
    expect(out).toContain(`Doc ${MAX_RENDERED_PRIOR_WORK - 1}`);
    expect(out).not.toContain(`Doc ${MAX_RENDERED_PRIOR_WORK}`);
    // "at least N more" and an explicit statement that the end of the list is
    // not the end of the work: a capped list read as exhaustive is the defect
    // again, one layer down.
    expect(out).toMatch(/and at least \d+ more not listed/);
    expect(out).toContain('its END is not the end of your work');
  });

  it('tells the model to update what is listed rather than make a second copy', () => {
    const out = renderPriorWorkBlock([artifact({ name: 'Weekly Digest' })])!;
    expect(out).toContain('rather than creating a second copy');
  });

  it('renders a date without a time, since the question is existence', () => {
    const out = renderPriorWorkBlock([artifact({ name: 'Watch List' })])!;
    expect(out).toContain('2026-08-27');
    expect(out).not.toContain('09:14');
  });
});

// An agent that posts through a shell leaves the ledger unable to see the one
// thing it most needs to remember. It can have a GitHub connector bound and
// read through it, and still prefer the shell for writing.
//
// A deny at the tool seam would risk breaking a working agent, and deriving ledger
// rows by parsing shell risks wrong targets, which the cross-run guard could
// then refuse real work over. So the block says what the shell costs, at the
// point where the choice is made.
describe('what the block says about the shell', () => {
  it('gives the reason to prefer a connector tool, not just the caveat', () => {
    const out = renderPriorWorkBlock([{
      targetRef: 'github:acme/webapp#42',
      connector: 'github',
      actionType: 'pull_request_review_write',
      createdAt: new Date('2026-09-03T10:00:00Z'),
    }])!;
    expect(out).toContain('prefer a connector tool over a shell command');
    expect(out).toContain('what you do through the shell you cannot');
  });
});
