// Unit tests for the citation-warning audit helpers.
//
// The semantics matter because a silent regression here means either:
//   (a) support agents silently send mail with no source URL (false-neg miss), or
//   (b) every agent's internal coordination email gets flagged (false-pos noise).
// The gates below — hasKnowledgeAccess + internalDomains + external recipient —
// are designed so the warning only fires when all four conditions of the rule
// hold simultaneously.

import {
  evaluateCitationWarning,
  detectErrorCode,
  stripConnectorAlias,
  extractRecipientDomains,
  deriveInternalDomains,
} from '../citation-warning';

describe('stripConnectorAlias', () => {
  it('returns the suffix after the last "__"', () => {
    expect(stripConnectorAlias('my_gmail__send_email')).toBe('send_email');
    expect(stripConnectorAlias('support_inbox__forward_email')).toBe('forward_email');
  });

  it('handles alias names that themselves contain underscores', () => {
    expect(stripConnectorAlias('outlook_v2__create_reply_draft')).toBe('create_reply_draft');
  });

  it('returns the input unchanged when no "__" separator is present (standard tools)', () => {
    expect(stripConnectorAlias('memory_save')).toBe('memory_save');
    expect(stripConnectorAlias('search')).toBe('search');
  });

  it('handles edge cases without throwing', () => {
    expect(stripConnectorAlias('')).toBe('');
    expect(stripConnectorAlias('__send_email')).toBe('send_email');
    expect(stripConnectorAlias('a__')).toBe('');
  });
});

describe('extractRecipientDomains', () => {
  it('parses bare addresses out of `to` / `cc` / `bcc` (string or array)', () => {
    expect(
      extractRecipientDomains({
        to: 'alice@acme.com',
        cc: ['bob@acme.com', 'carol@EXAMPLE.com'],
        bcc: 'dave@example.org',
      }),
    ).toEqual(expect.arrayContaining(['acme.com', 'example.com', 'example.org']));
  });

  it('handles "Name <addr>" wrappers and stray commas', () => {
    expect(
      extractRecipientDomains({
        to: 'Alice <alice@acme.com>, Bob <bob@acme.com>',
      }),
    ).toEqual(['acme.com']);
  });

  it('lower-cases domains so set membership is consistent', () => {
    const domains = extractRecipientDomains({ to: 'a@LiftOff.IO' });
    expect(domains).toEqual(['liftoff.io']);
  });

  it('returns [] for missing or non-string recipient fields', () => {
    expect(extractRecipientDomains({})).toEqual([]);
    expect(extractRecipientDomains({ to: 123 as any })).toEqual([]);
  });
});

describe('deriveInternalDomains', () => {
  it('collects domains from every sendAs config', () => {
    const out = deriveInternalDomains([
      { config: { sendAs: 'support@example.com' } },
      { config: { sendAs: 'ops@example.com' } },
      { config: { sendAs: 'team@liftoff.io' } },
    ]);
    expect(out.sort()).toEqual(['example.com', 'liftoff.io']);
  });

  it('skips integrations with no config or no sendAs', () => {
    const out = deriveInternalDomains([
      { config: {} },
      {},
      { config: { sendAs: 'support@example.com' } },
    ]);
    expect(out).toEqual(['example.com']);
  });

  it('lower-cases and trims the parsed domain', () => {
    const out = deriveInternalDomains([
      { config: { sendAs: 'support@LiftOff.IO ' } },
    ]);
    expect(out).toEqual(['liftoff.io']);
  });

  it('returns [] for an undefined or empty integrations list', () => {
    expect(deriveInternalDomains(undefined)).toEqual([]);
    expect(deriveInternalDomains([])).toEqual([]);
  });

  it('ignores malformed sendAs (no @ or @ at end)', () => {
    expect(
      deriveInternalDomains([
        { config: { sendAs: 'support' } },
        { config: { sendAs: 'support@' } },
        { config: { sendAs: 123 as any } },
      ]),
    ).toEqual([]);
  });
});

describe('evaluateCitationWarning', () => {
  const base = {
    hasKnowledgeAccess: true,
    internalDomains: ['example.com'],
  } as const;

  it('returns {} when the agent has no knowledge access (no corpus_search)', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        hasKnowledgeAccess: false,
        actionType: 'my_gmail__send_email',
        toolInput: { to: 'customer@acme.com', body: 'no URL' },
      }),
    ).toEqual({});
  });

  it('returns {} when the action is not an outbound-mail variant', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        actionType: 'my_gmail__list_messages',
        toolInput: { to: 'customer@acme.com', body: 'no URL' },
      }),
    ).toEqual({});
  });

  it('returns {} when internalDomains is empty (we have no signal — refuse to guess)', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        internalDomains: [],
        actionType: 'my_gmail__send_email',
        toolInput: { to: 'customer@acme.com', body: 'no URL' },
      }),
    ).toEqual({});
  });

  it('returns {} when every recipient is internal', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        actionType: 'my_gmail__send_email',
        toolInput: { to: 'engineer@example.com', body: 'no URL' },
      }),
    ).toEqual({});
  });

  it('returns {} when there are no parseable recipients', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        actionType: 'my_gmail__send_email',
        toolInput: { body: 'no URL' },
      }),
    ).toEqual({});
  });

  it('returns {} when the body has any URL', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        actionType: 'my_gmail__send_email',
        toolInput: { to: 'customer@acme.com', body: 'see https://help.example.com' },
      }),
    ).toEqual({});
  });

  it('fires when all four conditions hold: knowledge + outbound + external + no URL', () => {
    const variants = [
      'my_gmail__send_email',
      'my_gmail__reply_email',
      'my_gmail__forward_email',
      'my_gmail__create_draft',
      'my_gmail__create_reply_draft',
    ];
    for (const action of variants) {
      const result = evaluateCitationWarning({
        ...base,
        actionType: action,
        toolInput: { to: 'customer@acme.com', body: 'Hi there, no link.' },
      });
      expect(result.errorCode).toBe('MISSING_CITATION_URL');
      expect(result.outputSummary).toMatch(/Outbound reply to external recipient contains no URL/);
    }
  });

  it('fires regardless of connector alias (Outlook, custom aliases, …)', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        actionType: 'support_outlook__send_email',
        toolInput: { to: 'customer@acme.com', body: 'no link' },
      }).errorCode,
    ).toBe('MISSING_CITATION_URL');

    expect(
      evaluateCitationWarning({
        ...base,
        actionType: 'team_inbox_v2__forward_email',
        toolInput: { to: 'customer@acme.com', body: 'no link' },
      }).errorCode,
    ).toBe('MISSING_CITATION_URL');
  });

  it('fires when ANY recipient is external (mixed cc list)', () => {
    expect(
      evaluateCitationWarning({
        ...base,
        actionType: 'my_gmail__send_email',
        toolInput: {
          to: 'engineer@example.com',
          cc: ['ops@example.com', 'partner@acme.com'],
          body: 'no URL',
        },
      }).errorCode,
    ).toBe('MISSING_CITATION_URL');
  });

  it('truncates the body preview to 200 characters', () => {
    const longBody = 'x'.repeat(500);
    const result = evaluateCitationWarning({
      ...base,
      actionType: 'my_gmail__send_email',
      toolInput: { to: 'customer@acme.com', body: longBody },
    });
    const preview = result.outputSummary!.split('Body preview: ')[1];
    expect(preview).toHaveLength(200);
  });

  it('treats a multi-domain internalDomains set correctly (any matching = internal)', () => {
    // Tenant operates two domains (example.com + liftoff.io). Mail sent
    // between them is internal.
    expect(
      evaluateCitationWarning({
        hasKnowledgeAccess: true,
        internalDomains: ['example.com', 'liftoff.io'],
        actionType: 'my_gmail__send_email',
        toolInput: { to: 'team@liftoff.io', body: 'no URL' },
      }),
    ).toEqual({});
  });
});

describe('detectErrorCode', () => {
  it('returns TOOL_CALL_FAILED for an empty / non-matching error', () => {
    expect(detectErrorCode(null)).toBe('TOOL_CALL_FAILED');
    expect(detectErrorCode('')).toBe('TOOL_CALL_FAILED');
    expect(detectErrorCode('Network timeout after 30s')).toBe('TOOL_CALL_FAILED');
    expect(detectErrorCode('Sheet not found')).toBe('TOOL_CALL_FAILED');
  });

  it('maps Google OAuth refresh failures to OAUTH_REFRESH_REQUIRED', () => {
    const cases = [
      'invalid_grant',
      'Token has been expired or revoked.',
      'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
      'Request had insufficient authentication scopes',
      'OAuthRefreshError: refresh failed',
    ];
    for (const msg of cases) {
      expect(detectErrorCode(msg)).toBe('OAUTH_REFRESH_REQUIRED');
    }
  });

  it('maps Microsoft Graph OAuth failures to OAUTH_REFRESH_REQUIRED', () => {
    const cases = [
      'InvalidAuthenticationToken: Access token has expired',
      'Insufficient privileges to complete the operation',
      'AADSTS65001: The user or administrator has not consented',
      'AADSTS70008: The provided authorization code or refresh token has expired',
      'AADSTS50079: User must complete multi-factor authentication',
    ];
    for (const msg of cases) {
      expect(detectErrorCode(msg)).toBe('OAUTH_REFRESH_REQUIRED');
    }
  });

  it('maps generic 401 / 403 status codes to OAUTH_REFRESH_REQUIRED', () => {
    expect(detectErrorCode('HTTP 401: Unauthorized')).toBe('OAUTH_REFRESH_REQUIRED');
    expect(detectErrorCode('Request failed with status 403')).toBe('OAUTH_REFRESH_REQUIRED');
  });

  it('matches case-insensitively', () => {
    expect(detectErrorCode('INVALID_GRANT')).toBe('OAUTH_REFRESH_REQUIRED');
    expect(detectErrorCode('insufficient permission')).toBe('OAUTH_REFRESH_REQUIRED');
  });

  it('does not false-positive on substrings inside unrelated words', () => {
    expect(detectErrorCode('Error code 4031')).toBe('TOOL_CALL_FAILED');
    expect(detectErrorCode('order 14012')).toBe('TOOL_CALL_FAILED');
  });
});
