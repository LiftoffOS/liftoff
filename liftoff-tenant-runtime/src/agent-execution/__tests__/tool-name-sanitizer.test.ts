import {
  LLM_TOOL_NAME_REGEX,
  composeToolName,
  sanitizeToolNameSegment,
} from '../tool-name-sanitizer';

describe('LLM_TOOL_NAME_REGEX', () => {
  it.each([
    'slack',
    'slack__create_channel',
    'gmail__send_email',
    'memory_save',
    'web_research',
    'a-b-c',
    'A1_B2',
  ])('accepts %s', (name) => {
    expect(name).toMatch(LLM_TOOL_NAME_REGEX);
  });

  it.each([
    'slack__slack.create_channel',
    'gmail__google_mail.send_email',
    'has space',
    'has/slash',
    'has:colon',
    'has.dot',
    '',
  ])('rejects %s', (name) => {
    expect(name).not.toMatch(LLM_TOOL_NAME_REGEX);
  });
});

describe('sanitizeToolNameSegment', () => {
  it.each([
    ['slack.create_channel', 'slack_create_channel'],
    ['google_mail.send_email', 'google_mail_send_email'],
    ['has space', 'has_space'],
    ['has/slash', 'has_slash'],
    ['multiple..dots..here', 'multiple__dots__here'],
    ['has:multiple.bad chars', 'has_multiple_bad_chars'],
  ])('replaces invalid chars in %s -> %s', (input, expected) => {
    expect(sanitizeToolNameSegment(input)).toBe(expected);
  });

  it.each(['already_clean', 'a-b-c', 'A1_B2'])(
    'returns clean segment %s unchanged',
    (clean) => {
      expect(sanitizeToolNameSegment(clean)).toBe(clean);
    },
  );

  it('returns empty string unchanged (caller must guard against empty)', () => {
    expect(sanitizeToolNameSegment('')).toBe('');
  });
});

describe('composeToolName', () => {
  it('produces the documented `alias__function` shape on clean input', () => {
    expect(composeToolName('slack', 'create_channel')).toBe(
      'slack__create_channel',
    );
  });

  it('repairs a dotted function name', () => {
    // A dotted function name makes every Slack-bound agent fail; the
    // connector-service drops the dotted prefix at source, and even with
    // stale dotted data, the sanitizer keeps the LLM API happy.
    expect(composeToolName('slack', 'slack.create_channel')).toBe(
      'slack__slack_create_channel',
    );
    expect(composeToolName('slack', 'slack.create_channel')).toMatch(
      LLM_TOOL_NAME_REGEX,
    );
  });

  it('sanitizes a dirty alias and clean function', () => {
    expect(composeToolName('Help Center MCP', 'search_articles')).toBe(
      'Help_Center_MCP__search_articles',
    );
    expect(composeToolName('Help Center MCP', 'search_articles')).toMatch(
      LLM_TOOL_NAME_REGEX,
    );
  });

  it('every output for every realistic input passes the LLM regex', () => {
    // Belt + braces: throw a wide variety of bad data at it and assert the
    // output is always LLM-safe. Catches future encoding mistakes too.
    const aliases = ['slack', 'gmail', 'Help Center', 'connector.1', 'A B C'];
    const fnNames = [
      'create_channel',
      'slack.create_channel',
      'google_mail.send_email',
      'list/channels',
      'has space',
      'multiple.dots.here',
    ];
    for (const a of aliases) {
      for (const f of fnNames) {
        expect(composeToolName(a, f)).toMatch(LLM_TOOL_NAME_REGEX);
      }
    }
  });
});
