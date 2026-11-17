import { formatThreadAsMarkdown } from './thread-formatter';

describe('formatThreadAsMarkdown', () => {
  describe('slack thread', () => {
    const fixture = {
      channel: 'C01', ts: '1700000000.000', messageCount: 2,
      messages: [
        { ts: '1700000000.000', userId: 'U123', text: 'Hello', isThreadRoot: true,
          reactions: [{ name: 'thumbsup', count: 3 }], timestamp: '2023-11-14T22:13:20.000Z' },
        { ts: '1700000060.000', userId: 'U456', text: 'Reply', isThreadRoot: false,
          reactions: [], timestamp: '2023-11-14T22:14:20.000Z' },
      ],
    };
    it('includes header with message count', () =>
      expect(formatThreadAsMarkdown('slack', 'thread', fixture)).toContain('## Slack Thread (2 messages)'));
    it('formats userId and text', () =>
      expect(formatThreadAsMarkdown('slack', 'thread', fixture)).toContain('@U123: [root] Hello'));
    it('includes reactions', () =>
      expect(formatThreadAsMarkdown('slack', 'thread', fixture)).toContain(':thumbsup:×3'));
    it('marks root message', () =>
      expect(formatThreadAsMarkdown('slack', 'thread', fixture)).toContain('[root]'));
  });

  describe('jira comments', () => {
    const fixture = {
      issueKey: 'PROJ-42', total: 1,
      comments: [{
        id: 'c1',
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Needs fix' }] }] },
        author: { accountId: 'abc123', displayName: 'Jane Smith' },
        created: '2024-01-15T10:00:00.000Z',
      }],
    };
    it('includes issue key', () =>
      expect(formatThreadAsMarkdown('atlassian_jira', 'comments', fixture)).toContain('PROJ-42'));
    it('flattens ADF to plain text', () =>
      expect(formatThreadAsMarkdown('atlassian_jira', 'comments', fixture)).toContain('Needs fix'));
    it('shows displayName and date', () => {
      const out = formatThreadAsMarkdown('atlassian_jira', 'comments', fixture);
      expect(out).toContain('Jane Smith');
      expect(out).toContain('2024-01-15');
    });
  });

  it('truncates at 3000 chars and appends [truncated]', () => {
    const bigFixture = {
      channel: 'C', ts: '1', messageCount: 100,
      messages: Array.from({ length: 100 }, (_, i) => ({
        ts: String(i), userId: 'U1', text: 'x'.repeat(100), isThreadRoot: false,
        reactions: [], timestamp: '2024-01-01T00:00:00.000Z',
      })),
    };
    const out = formatThreadAsMarkdown('slack', 'thread', bigFixture);
    expect(out.length).toBeLessThanOrEqual(3015);
    expect(out).toContain('[truncated]');
  });

  it('returns JSON fallback for unknown connector', () => {
    const out = formatThreadAsMarkdown('mystery_connector', 'thread', { foo: 'bar' });
    expect(out).toContain('foo');
  });

  it('returns empty string for null/non-object data', () => {
    expect(formatThreadAsMarkdown('slack', 'thread', null)).toBe('');
    expect(formatThreadAsMarkdown('slack', 'thread', 'a string')).toBe('');
  });
});
