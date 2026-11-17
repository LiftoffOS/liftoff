// Tests for naming the authoring team on code-host comments.
//
// The tool names here follow the real vendor shapes: a single review run can
// post via add_comment_to_pending_review, add_issue_comment AND
// pull_request_review_write, all namespaced with the connector instance id. That is why matching is by server prefix plus body
// shape rather than by an allowlist of names.

const mockQuery = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  applyCommentAuthorship,
  authorshipPrefix,
  _resetAuthorshipCacheForTesting,
} from '../comment-authorship';

const CTX = { tenantId: 'tenant-1', invocationId: 'inv-1' };
const REVIEWER = { rows: [{ role: 'Code Reviewer' }] };

beforeEach(() => {
  mockQuery.mockReset();
  _resetAuthorshipCacheForTesting();
});

describe('applyCommentAuthorship', () => {
  it.each([
    'mcp__github-dd4c4689__add_comment_to_pending_review',
    'mcp__github-dd4c4689__add_issue_comment',
    'mcp__github-dd4c4689__pull_request_review_write',
    'mcp__gitlab-abc123__create_merge_request_note',
  ])('names the team on %s', async (toolName) => {
    mockQuery.mockResolvedValue(REVIEWER);

    const out = await applyCommentAuthorship(toolName, { body: '[BLOCKING] wrong' }, CTX);

    expect(out?.body).toBe('**Code Reviewer** · Liftoff\n\n[BLOCKING] wrong');
  });

  it('leaves every other argument untouched', async () => {
    mockQuery.mockResolvedValue(REVIEWER);

    const out = await applyCommentAuthorship(
      'mcp__github-dd4c4689__add_issue_comment',
      { body: 'x', owner: 'acme', repo: 'webapp', issue_number: 42 },
      CTX,
    );

    expect(out).toMatchObject({ owner: 'acme', repo: 'webapp', issue_number: 42 });
  });

  it('ignores tools that are not code-host tools, without hitting the database', async () => {
    const args = { body: 'a Slack message' };

    const out = await applyCommentAuthorship('mcp__liftoff-tool-gateway__send_message', args, CTX);

    expect(out).toBe(args);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('ignores code-host tools that carry no body, such as reads', async () => {
    const args = { owner: 'acme', repo: 'webapp', pullNumber: 42 };

    const out = await applyCommentAuthorship('mcp__github-dd4c4689__pull_request_read', args, CTX);

    expect(out).toBe(args);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('does not stamp twice when a call is retried or a run resumes', async () => {
    mockQuery.mockResolvedValue(REVIEWER);
    const once = await applyCommentAuthorship(
      'mcp__github-dd4c4689__add_issue_comment', { body: 'finding' }, CTX,
    );

    const twice = await applyCommentAuthorship(
      'mcp__github-dd4c4689__add_issue_comment', once!, CTX,
    );

    expect(twice!.body).toBe(`${authorshipPrefix('Code Reviewer')}\n\nfinding`);
  });

  it('queries once per invocation however many comments it posts', async () => {
    mockQuery.mockResolvedValue(REVIEWER);

    await applyCommentAuthorship('mcp__github-1__add_issue_comment', { body: 'a' }, CTX);
    await applyCommentAuthorship('mcp__github-1__add_comment_to_pending_review', { body: 'b' }, CTX);
    await applyCommentAuthorship('mcp__github-1__pull_request_review_write', { body: 'c' }, CTX);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('posts unstamped rather than failing when the team cannot be resolved', async () => {
    mockQuery.mockRejectedValue(new Error('pool exhausted'));

    const out = await applyCommentAuthorship(
      'mcp__github-dd4c4689__add_issue_comment', { body: 'finding' }, CTX,
    );

    // A cosmetic loss is acceptable; losing the review is not.
    expect(out!.body).toBe('finding');
  });

  it('posts unstamped when the invocation resolves to no role', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const out = await applyCommentAuthorship(
      'mcp__github-dd4c4689__add_issue_comment', { body: 'finding' }, CTX,
    );

    expect(out!.body).toBe('finding');
  });

  it('skips an empty or whitespace body', async () => {
    const args = { body: '   ' };

    const out = await applyCommentAuthorship('mcp__github-1__add_issue_comment', args, CTX);

    expect(out).toBe(args);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('bounds the cache so a long-lived process does not accumulate a row per run', async () => {
    mockQuery.mockResolvedValue(REVIEWER);
    // One more than the cap, so the first invocation must have been evicted.
    for (let i = 0; i < 501; i++) {
      await applyCommentAuthorship(
        'mcp__github-1__add_issue_comment', { body: 'x' },
        { tenantId: 'tenant-1', invocationId: `inv-${i}` },
      );
    }
    const queriesAfterFill = mockQuery.mock.calls.length;

    await applyCommentAuthorship(
      'mcp__github-1__add_issue_comment', { body: 'x' },
      { tenantId: 'tenant-1', invocationId: 'inv-0' },
    );

    expect(mockQuery.mock.calls.length).toBe(queriesAfterFill + 1);
  });

  it('is inert with no invocation id', async () => {
    const args = { body: 'finding' };

    const out = await applyCommentAuthorship(
      'mcp__github-1__add_issue_comment', args, { tenantId: 't', invocationId: null },
    );

    expect(out).toBe(args);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
