// Per-provider identity fetcher tests. We mock global.fetch so each fetcher
// is exercised against the canonical whoami response shape from its provider.
// Failures (non-2xx, throw, missing id) must always return null — the OAuth
// callback relies on that to safely fall back to single-instance behavior.

import {
  fetchExternalIdentity,
  providerSupportsMultiInstance,
  extractComposioIdentity,
} from './identity-fetchers';

function mockFetchOnce(handler: (url: string) => Response | Promise<Response>) {
  const original = global.fetch;
  global.fetch = jest.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    return handler(url);
  }) as unknown as typeof fetch;
  return () => {
    global.fetch = original;
  };
}

describe('fetchExternalIdentity', () => {
  it('returns null for providers without a registered fetcher', async () => {
    // Pick any string not in the OAuthProvider union and not registered.
    const id = await fetchExternalIdentity(
      'never_registered_provider' as never,
      'tok',
    );
    expect(id).toBeNull();
  });

  it('returns null when the fetcher throws (network failure)', async () => {
    const restore = mockFetchOnce(() => {
      throw new Error('network down');
    });
    try {
      const id = await fetchExternalIdentity('google', 'tok');
      expect(id).toBeNull();
    } finally {
      restore();
    }
  });

  describe('google', () => {
    it('maps userinfo to { externalAccountId: id, externalAccountLabel: email }', async () => {
      const restore = mockFetchOnce((url) => {
        expect(url).toContain('googleapis.com/oauth2/v2/userinfo');
        return new Response(
          JSON.stringify({ id: '108273...', email: 'person@example.com', name: 'H' }),
          { status: 200 },
        );
      });
      try {
        expect(await fetchExternalIdentity('google', 'tok')).toEqual({
          externalAccountId: '108273...',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });

    it('returns null on 401', async () => {
      const restore = mockFetchOnce(() => new Response('', { status: 401 }));
      try {
        expect(await fetchExternalIdentity('google', 'tok')).toBeNull();
      } finally {
        restore();
      }
    });
  });

  describe('slack', () => {
    it('keys on team_id (workspace identifier) and labels with team name', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({
              ok: true,
              team_id: 'T12345',
              team: 'Acme Workspace',
              user_id: 'U1',
              user: 'support-lead',
            }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('slack', 'tok')).toEqual({
          externalAccountId: 'T12345',
          externalAccountLabel: 'Acme Workspace',
        });
      } finally {
        restore();
      }
    });

    it('returns null when slack responds ok:false', async () => {
      const restore = mockFetchOnce(
        () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 }),
      );
      try {
        expect(await fetchExternalIdentity('slack', 'tok')).toBeNull();
      } finally {
        restore();
      }
    });
  });

  describe('github', () => {
    it('keys on numeric id, labels with login', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({ id: 12345, login: 'octocat', name: 'Alex' }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('github', 'tok')).toEqual({
          externalAccountId: '12345',
          externalAccountLabel: 'octocat',
        });
      } finally {
        restore();
      }
    });
  });

  describe('microsoft', () => {
    it('keys on id, prefers mail then userPrincipalName for label', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({
              id: 'aad-user-uuid',
              userPrincipalName: 'person@example.com',
              mail: 'person@example.com',
              displayName: 'Alex',
            }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('microsoft', 'tok')).toEqual({
          externalAccountId: 'aad-user-uuid',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('notion', () => {
    it('prefers workspace_name from a bot integration token', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({
              id: 'notion-bot-uuid',
              bot: { workspace_name: 'Acme' },
            }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('notion', 'tok')).toEqual({
          externalAccountId: 'notion-bot-uuid',
          externalAccountLabel: 'Acme',
        });
      } finally {
        restore();
      }
    });
  });

  describe('atlassian', () => {
    it('keys on account_id', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({
              account_id: '5b10ac8d82e05b22cc7d4ef5',
              email: 'person@example.com',
              name: 'Alex',
            }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('atlassian', 'tok')).toEqual({
          externalAccountId: '5b10ac8d82e05b22cc7d4ef5',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('zoom', () => {
    it('keys on id, labels with email', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({ id: 'zoom-user-uuid', email: 'person@example.com' }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('zoom', 'tok')).toEqual({
          externalAccountId: 'zoom-user-uuid',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('hubspot', () => {
    it('keys on hub_id, labels with hub_domain', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({ hub_id: 12345678, hub_domain: 'liftoff.hubspot.com', user: 'admin' }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('hubspot', 'tok')).toEqual({
          externalAccountId: '12345678',
          externalAccountLabel: 'liftoff.hubspot.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('salesforce', () => {
    it('uses instance_url from extras and the OIDC userinfo endpoint', async () => {
      const restore = mockFetchOnce((url) => {
        expect(url).toBe('https://liftoff.my.salesforce.com/services/oauth2/userinfo');
        return new Response(
          JSON.stringify({
            user_id: 'sf-user-id',
            email: 'person@example.com',
            preferred_username: 'person@example.com',
          }),
          { status: 200 },
        );
      });
      try {
        expect(
          await fetchExternalIdentity('salesforce', 'tok', {
            instanceUrl: 'https://liftoff.my.salesforce.com',
          }),
        ).toEqual({
          externalAccountId: 'sf-user-id',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });

    it('returns null when no instanceUrl is provided', async () => {
      expect(await fetchExternalIdentity('salesforce', 'tok')).toBeNull();
    });
  });

  describe('dropbox', () => {
    it('keys on account_id, labels with email', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({
              account_id: 'dbid:AAH4...',
              email: 'person@example.com',
              name: { display_name: 'Alex' },
            }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('dropbox', 'tok')).toEqual({
          externalAccountId: 'dbid:AAH4...',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('box', () => {
    it('keys on id, labels with login', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({ id: 'box-id', login: 'person@example.com', name: 'Alex' }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('box', 'tok')).toEqual({
          externalAccountId: 'box-id',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('asana', () => {
    it('reads { data: { gid, email, name } }', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({ data: { gid: '1200', email: 'person@example.com', name: 'Alex' } }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('asana', 'tok')).toEqual({
          externalAccountId: '1200',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('linear', () => {
    it('reads viewer.id + viewer.email from GraphQL', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({
              data: { viewer: { id: 'lin-uuid', email: 'person@example.com', name: 'Alex' } },
            }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('linear', 'tok')).toEqual({
          externalAccountId: 'lin-uuid',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('calendly', () => {
    it('reads resource.uri + email', async () => {
      const restore = mockFetchOnce(
        () =>
          new Response(
            JSON.stringify({
              resource: {
                uri: 'https://api.calendly.com/users/abc',
                email: 'person@example.com',
              },
            }),
            { status: 200 },
          ),
      );
      try {
        expect(await fetchExternalIdentity('calendly', 'tok')).toEqual({
          externalAccountId: 'https://api.calendly.com/users/abc',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });

  describe('zendesk', () => {
    it('requires subdomain in extras', async () => {
      expect(await fetchExternalIdentity('zendesk', 'tok')).toBeNull();
    });

    it('hits the subdomain-specific endpoint when subdomain is provided', async () => {
      const restore = mockFetchOnce((url) => {
        expect(url).toBe('https://acme.zendesk.com/api/v2/users/me.json');
        return new Response(
          JSON.stringify({
            user: { id: 42, email: 'person@example.com', name: 'Alex' },
          }),
          { status: 200 },
        );
      });
      try {
        expect(
          await fetchExternalIdentity('zendesk', 'tok', { subdomain: 'acme' }),
        ).toEqual({
          externalAccountId: 'acme:42',
          externalAccountLabel: 'person@example.com',
        });
      } finally {
        restore();
      }
    });
  });
});

describe('providerSupportsMultiInstance', () => {
  it('returns true for providers with a registered fetcher', () => {
    expect(providerSupportsMultiInstance('google')).toBe(true);
    expect(providerSupportsMultiInstance('slack')).toBe(true);
    expect(providerSupportsMultiInstance('github')).toBe(true);
    expect(providerSupportsMultiInstance('microsoft')).toBe(true);
    expect(providerSupportsMultiInstance('notion')).toBe(true);
    expect(providerSupportsMultiInstance('atlassian')).toBe(true);
    expect(providerSupportsMultiInstance('zoom')).toBe(true);
    expect(providerSupportsMultiInstance('hubspot')).toBe(true);
    expect(providerSupportsMultiInstance('salesforce')).toBe(true);
    expect(providerSupportsMultiInstance('dropbox')).toBe(true);
    expect(providerSupportsMultiInstance('box')).toBe(true);
    expect(providerSupportsMultiInstance('asana')).toBe(true);
    expect(providerSupportsMultiInstance('linear')).toBe(true);
    expect(providerSupportsMultiInstance('calendly')).toBe(true);
    expect(providerSupportsMultiInstance('docusign')).toBe(true);
    expect(providerSupportsMultiInstance('stripe')).toBe(true);
    expect(providerSupportsMultiInstance('zendesk')).toBe(true);
    expect(providerSupportsMultiInstance('intuit')).toBe(true);
    expect(providerSupportsMultiInstance('xero')).toBe(true);
    expect(providerSupportsMultiInstance('meta')).toBe(true);
  });

  it('also covers attio/outreach/gong/marketo/clay/granola/gusto/rippling/square/paypal', () => {
    expect(providerSupportsMultiInstance('attio')).toBe(true);
    expect(providerSupportsMultiInstance('outreach')).toBe(true);
    // salesloft is single-instance: its DCR token is MCP-audience and cannot
    // call api.salesloft.com/v2/me.json (the stripe pattern).
    expect(providerSupportsMultiInstance('salesloft')).toBe(false);
    expect(providerSupportsMultiInstance('gong')).toBe(true);
    expect(providerSupportsMultiInstance('marketo')).toBe(true);
    expect(providerSupportsMultiInstance('clay')).toBe(true);
    expect(providerSupportsMultiInstance('granola')).toBe(true);
    expect(providerSupportsMultiInstance('square')).toBe(true);
    expect(providerSupportsMultiInstance('paypal')).toBe(true);
  });
});

describe('extractComposioIdentity', () => {
  // Composio's SDK exposes the vendor account data under `state.val.<field>`
  // (canonical) AND, for legacy responses, under a top-level `params` map.
  // The extractor must read BOTH and prefer a STABLE vendor identifier
  // (workspace_id / account_id / etc.) over Composio's per-link id —
  // otherwise every reconnect creates a new Liftoff connector row.

  it('uses connectedAccount.id when no vendor identifier is exposed', async () => {
    const out = await extractComposioIdentity('gong', { id: 'ca_abc' });
    expect(out.externalAccountId).toBe('ca_abc');
    expect(out.externalAccountLabel).toBe('ca_abc');
  });

  it('prefers a stable workspace_id from state.val (modern Composio shape)', async () => {
    const out = await extractComposioIdentity('trello', {
      id: 'ca_xyz',
      state: {
        authScheme: 'OAUTH2',
        val: {
          access_token: 'trello-access-token',
          workspace_id: 'workspace_42',
          workspace_name: 'Acme Workspace',
        },
      },
    });
    expect(out.externalAccountId).toBe('workspace_42');
    expect(out.externalAccountLabel).toBe('Acme Workspace');
  });

  it('falls back to params.account_id when state.val is missing (legacy SDK shape)', async () => {
    const out = await extractComposioIdentity('mailchimp', {
      id: 'ca_xyz',
      params: { account_id: 'mc_5', account_email: 'user@example.com' },
    });
    expect(out.externalAccountId).toBe('mc_5');
    expect(out.externalAccountLabel).toBe('user@example.com');
  });

  it('state.val overrides params on conflict', async () => {
    const out = await extractComposioIdentity('gong', {
      id: 'ca_xyz',
      params: { account_id: 'OLD_LEGACY', account_email: 'old@example.com' },
      state: {
        authScheme: 'OAUTH2',
        val: { account_id: 'NEW_CANONICAL', account_email: 'new@example.com' },
      },
    });
    expect(out.externalAccountId).toBe('NEW_CANONICAL');
    expect(out.externalAccountLabel).toBe('new@example.com');
  });

  it('label falls back to externalAccountId when no labellable field is exposed', async () => {
    const out = await extractComposioIdentity('typeform', {
      id: 'ca_xyz',
      state: { authScheme: 'OAUTH2', val: { user_id: 'user_7' } },
    });
    expect(out.externalAccountId).toBe('user_7');
    expect(out.externalAccountLabel).toBe('user_7');
  });

  it('treats non-string id fields as absent (defensive)', async () => {
    const out = await extractComposioIdentity('discord', {
      id: 'ca_xyz',
      state: {
        authScheme: 'OAUTH2',
        val: {
          workspace_id: 12345 as unknown as string,
          team_id: 'team_real',
        },
      },
    });
    expect(out.externalAccountId).toBe('team_real');
  });

  it('handles a missing state object without throwing', async () => {
    const out = await extractComposioIdentity('airtable', { id: 'ca_xyz' });
    expect(out.externalAccountId).toBe('ca_xyz');
    expect(out.externalAccountLabel).toBe('ca_xyz');
  });

  it('handles a null state.val gracefully', async () => {
    const out = await extractComposioIdentity('freshbooks', {
      id: 'ca_xyz',
      state: { val: null as unknown as Record<string, unknown> },
    });
    expect(out.externalAccountId).toBe('ca_xyz');
  });

  // ── Layer 2: id_token JWT decode (OIDC providers) ────────────────────
  // Builds a minimal RFC-7519 JWT with the standard OIDC claims so the
  // extractor can pull the email out without us needing a live Composio
  // response.
  function makeJwt(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.signature-placeholder`;
  }

  it('decodes id_token JWT and uses email + sub when flat fields are absent (Google / OIDC providers)', async () => {
    const idToken = makeJwt({
      iss: 'https://accounts.google.com',
      sub: '110987654321098765432',
      email: 'person@example.com',
      email_verified: true,
      name: 'Alex',
    });
    const out = await extractComposioIdentity('google_mail', {
      id: 'ca_MTjQ55OS2di8',
      state: {
        authScheme: 'OAUTH2',
        val: {
          access_token: 'redacted',
          refresh_token: 'redacted',
          id_token: idToken,
        },
      },
    });
    expect(out.externalAccountId).toBe('110987654321098765432');
    expect(out.externalAccountLabel).toBe('person@example.com');
  });

  it('uses preferred_username when email claim is absent (Microsoft / Apple OIDC)', async () => {
    const idToken = makeJwt({
      sub: 'ms-user-uuid',
      preferred_username: 'person@example.com',
    });
    const out = await extractComposioIdentity('outlook', {
      id: 'ca_ms_abc',
      state: { val: { id_token: idToken } },
    });
    expect(out.externalAccountLabel).toBe('person@example.com');
    expect(out.externalAccountId).toBe('ms-user-uuid');
  });

  it('flat-field heuristic still wins over id_token when both are present', async () => {
    const idToken = makeJwt({ sub: 'jwt-sub', email: 'jwt@example.com' });
    const out = await extractComposioIdentity('atlassian', {
      id: 'ca_x',
      state: {
        val: {
          account_id: 'flat-account-id',
          account_email: 'flat@example.com',
          id_token: idToken,
        },
      },
    });
    expect(out.externalAccountId).toBe('flat-account-id');
    expect(out.externalAccountLabel).toBe('flat@example.com');
  });

  it('ignores an unparseable id_token without throwing', async () => {
    const out = await extractComposioIdentity('google_mail', {
      id: 'ca_x',
      state: { val: { id_token: 'not-a-jwt' } },
    });
    expect(out.externalAccountId).toBe('ca_x');
    expect(out.externalAccountLabel).toBe('ca_x');
  });

  // ── Layer 3: composio.tools.execute whoami fallback ──────────────────

  it('calls per-toolkit whoami via composio.tools.execute when both heuristic and id_token fail', async () => {
    const execute = jest.fn().mockResolvedValue({
      successful: true,
      data: { emailAddress: 'person@example.com', messagesTotal: 42 },
    });
    const out = await extractComposioIdentity(
      'google_mail',
      { id: 'ca_MTjQ55OS2di8', state: { val: { access_token: 'x', refresh_token: 'y' } } },
      { tools: { execute } } as unknown as Parameters<typeof extractComposioIdentity>[2],
      'tenant-1',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('GMAIL_GET_PROFILE', {
      userId: 'tenant-1',
      connectedAccountId: 'ca_MTjQ55OS2di8',
      arguments: {},
      dangerouslySkipVersionCheck: true,
    });
    expect(out.externalAccountLabel).toBe('person@example.com');
    expect(out.externalAccountId).toBe('person@example.com');
  });

  it('google_calendar whoami unwraps the calendar_data envelope (Composio nests Calendar payloads under data.calendar_data)', async () => {
    const execute = jest.fn().mockResolvedValue({
      successful: true,
      data: {
        calendar_data: {
          id: 'person@example.com',
          summary: 'person@example.com',
          timeZone: 'America/Los_Angeles',
          kind: 'calendar#calendar',
        },
        display_url: 'https://calendar.google.com/calendar/u/0/r/settings/calendar/primary',
      },
    });
    const out = await extractComposioIdentity(
      'google_calendar',
      { id: 'ca_nm3q69k4dJQZ', state: { val: { access_token: 'x', scope: 'calendar' } } },
      { tools: { execute } } as unknown as Parameters<typeof extractComposioIdentity>[2],
      'tenant-1',
    );
    expect(execute).toHaveBeenCalledWith('GOOGLECALENDAR_GET_CALENDAR', {
      userId: 'tenant-1',
      connectedAccountId: 'ca_nm3q69k4dJQZ',
      arguments: { calendarId: 'primary' },
      dangerouslySkipVersionCheck: true,
    });
    expect(out.externalAccountLabel).toBe('person@example.com');
    expect(out.externalAccountId).toBe('person@example.com');
  });

  it('Slack whoami pulls team_id + team name from SLACK_AUTH_TEST', async () => {
    const execute = jest.fn().mockResolvedValue({
      successful: true,
      data: { ok: true, team: 'Acme', team_id: 'T01ABCD2EFG', user: 'support-lead', user_id: 'U123' },
    });
    const out = await extractComposioIdentity(
      'slack',
      { id: 'ca_slack', state: { val: { access_token: 'x' } } },
      { tools: { execute } } as unknown as Parameters<typeof extractComposioIdentity>[2],
      'tenant-1',
    );
    expect(execute).toHaveBeenCalledWith('SLACK_AUTH_TEST', expect.any(Object));
    expect(out.externalAccountLabel).toBe('Acme');
    expect(out.externalAccountId).toBe('T01ABCD2EFG');
  });

  it('whoami failure falls through to account.id without throwing', async () => {
    const execute = jest.fn().mockRejectedValue(new Error('rate_limited'));
    const out = await extractComposioIdentity(
      'google_mail',
      { id: 'ca_xyz', state: { val: { access_token: 'x' } } },
      { tools: { execute } } as unknown as Parameters<typeof extractComposioIdentity>[2],
      'tenant-1',
    );
    expect(out.externalAccountId).toBe('ca_xyz');
    expect(out.externalAccountLabel).toBe('ca_xyz');
  });

  it('whoami unwraps Composio responses that nest the vendor payload under response_data', async () => {
    const execute = jest.fn().mockResolvedValue({
      successful: true,
      data: { response_data: { emailAddress: 'person@example.com' } },
    });
    const out = await extractComposioIdentity(
      'google_mail',
      { id: 'ca_x', state: { val: {} } },
      { tools: { execute } } as unknown as Parameters<typeof extractComposioIdentity>[2],
      'tenant-1',
    );
    expect(out.externalAccountLabel).toBe('person@example.com');
  });

  it('does NOT call whoami when layers 1 or 2 already resolved both fields', async () => {
    const execute = jest.fn();
    await extractComposioIdentity(
      'trello',
      {
        id: 'ca_xyz',
        state: { val: { workspace_id: 'w_42', workspace_name: 'Acme' } },
      },
      { tools: { execute } } as unknown as Parameters<typeof extractComposioIdentity>[2],
      'tenant-1',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

// Stripe identity comes from the MCP, not api.stripe.com. The connector holds a
// DCR token scoped `mcp`, which addresses the MCP server and nothing else — the
// first real connection stored a null externalAccountId and a blank label
// because the fetcher was calling /v1/account with it.
describe('fetchStripeIdentity', () => {
  const MCP_BODY = JSON.stringify({
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          accounts: [{ stripe_context: 'acct_1Nv0FGQ9RKHgCVdK', livemode: true, name: 'Acme, Inc.' }],
        }),
      }],
    },
  });

  it('reads the account id and name from list_available_accounts_or_orgs', async () => {
    let calledUrl = '';
    const restore = mockFetchOnce((url) => {
      calledUrl = url;
      return new Response(MCP_BODY, { status: 200 });
    });
    try {
      const id = await fetchExternalIdentity('stripe', 'oak_live_tok');
      expect(calledUrl).toBe('https://mcp.stripe.com/');
      expect(id).toEqual({
        externalAccountId: 'acct_1Nv0FGQ9RKHgCVdK',
        externalAccountLabel: 'Acme, Inc.',
      });
    } finally {
      restore();
    }
  });

  it('never calls api.stripe.com, which this token cannot authenticate', async () => {
    const seen: string[] = [];
    const restore = mockFetchOnce((url) => {
      seen.push(url);
      return new Response(MCP_BODY, { status: 200 });
    });
    try {
      await fetchExternalIdentity('stripe', 'oak_live_tok');
      expect(seen.some((u) => u.includes('api.stripe.com'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('returns null on an MCP tool error rather than inventing an identity', async () => {
    const restore = mockFetchOnce(() => new Response(
      JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] } }),
      { status: 200 },
    ));
    try {
      expect(await fetchExternalIdentity('stripe', 'tok')).toBeNull();
    } finally {
      restore();
    }
  });

  it('falls back to the account id when the account has no name', async () => {
    const restore = mockFetchOnce(() => new Response(
      JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify({ accounts: [{ stripe_context: 'acct_x' }] }) }] } }),
      { status: 200 },
    ));
    try {
      expect(await fetchExternalIdentity('stripe', 'tok')).toEqual({
        externalAccountId: 'acct_x',
        externalAccountLabel: 'acct_x',
      });
    } finally {
      restore();
    }
  });
});
