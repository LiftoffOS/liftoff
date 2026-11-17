import { detectUsedMemories } from '../relevance-detector';

const mem = (id: string, content: string, tags: string[]) => ({ id, content, tags });

describe('detectUsedMemories', () => {
  describe('H1: tag/tool-call overlap', () => {
    it('matches tag in tool call name', () => {
      expect(detectUsedMemories(
        [mem('m1', 'Use slack for notifications', ['slack'])],
        [{ name: 'slack_send_message', input: {} }],
        '',
      )).toContain('m1');
    });
    it('matches tag in tool call input', () => {
      expect(detectUsedMemories(
        [mem('m1', 'Use general channel', ['general'])],
        [{ name: 'send', input: { channel: 'general' } }],
        '',
      )).toContain('m1');
    });
    it('ignores tags with 2 or fewer chars', () => {
      expect(detectUsedMemories(
        [mem('m1', 'Use it', ['it'])],
        [{ name: 'iterate', input: {} }],
        '',
      )).not.toContain('m1');
    });
  });

  describe('H2: keyword/content match in output', () => {
    it('matches at >= 40% significant word overlap', () => {
      expect(detectUsedMemories(
        [mem('m1', 'authenticate using oauth tokens', [])],
        [],
        'We will authenticate using the oauth provider',
      )).toContain('m1');
    });
    it('does not match at < 40%', () => {
      expect(detectUsedMemories(
        [mem('m1', 'authenticate using oauth tokens endpoint retry', [])],
        [],
        'completely unrelated response about spreadsheets',
      )).not.toContain('m1');
    });
  });

  describe('H3: tag verbatim in output', () => {
    it('matches tag in output text', () => {
      expect(detectUsedMemories(
        [mem('m1', 'Rate limit config', ['rate-limit'])],
        [],
        'The rate-limit was exceeded',
      )).toContain('m1');
    });
  });

  it('deduplicates when multiple heuristics fire for the same memory', () => {
    const result = detectUsedMemories(
      [mem('m1', 'slack notifications rate-limit', ['slack'])],
      [{ name: 'slack_notify', input: {} }],
      'sent slack notification',
    );
    expect(result.filter(id => id === 'm1').length).toBe(1);
  });

  it('returns empty array when nothing matches', () => {
    expect(detectUsedMemories(
      [mem('m1', 'database indexing strategy', ['postgres'])],
      [{ name: 'send_email', input: { to: 'a@b.com' } }],
      'email sent',
    )).toHaveLength(0);
  });
});
