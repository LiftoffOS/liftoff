import { COMPOSIO_MANAGED_TYPES, parseComposioToolName, reportComposioToolCall } from '../composio-call-reporter';

const mockFetch = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: jest.fn(() => ({
    fetch: (...args: unknown[]) => mockFetch(...args),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('parseComposioToolName', () => {
  it('extracts connectorType from mcp__<type>-<shortId>__<tool>', () => {
    expect(parseComposioToolName('mcp__cal_com-abcd1234__list_bookings')).toEqual({
      connectorType: 'cal_com',
      serverKey: 'cal_com-abcd1234',
    });
  });

  it('handles connector types with underscores (microsoft_dynamics, google_ads)', () => {
    expect(parseComposioToolName('mcp__microsoft_dynamics-12345678__get_account')?.connectorType).toBe('microsoft_dynamics');
    expect(parseComposioToolName('mcp__google_ads-87654321__list_campaigns')?.connectorType).toBe('google_ads');
  });

  it('returns null for connector types that are NOT composio_managed', () => {
    // The hardcoded allow-list refuses to attribute non-Composio calls
    // to the composio_mcp source — protects margin reports from cross-
    // attribution. hubspot/notion are direct-routed (or have their own
    // sidecars) and must not be billed as Composio.
    //
    // 'salesforce' is on Composio's managed OAuth app and a legitimate member
    // of the set, so zendesk is the native-sidecar example.
    // slack uses native dispatch on our own Slack app — its calls must not be
    // attributed to the composio_mcp cost source.
    expect(parseComposioToolName('mcp__slack-12345678__post_message')).toBeNull();
    expect(parseComposioToolName('mcp__hubspot-12345678__create_contact')).toBeNull();
    expect(parseComposioToolName('mcp__notion-abcdef12__create_page')).toBeNull();
    expect(parseComposioToolName('mcp__zendesk-abcd1234__create_ticket')).toBeNull();
  });

  it('parses tool calls for connectors flipped to composio_managed (gmail, drive, jira, datadog)', () => {
    // Regression: an allowlist that misses connectors flipped to
    // composio_managed (google_*, microsoft_outlook_mail, atlassian_*,
    // dropbox, youtube, datadog, …) silently drops every call to those
    // connectors from billing.
    expect(parseComposioToolName('mcp__google_mail-abcd1234__send_email')?.connectorType).toBe('google_mail');
    expect(parseComposioToolName('mcp__google_drive-abcd1234__list_files')?.connectorType).toBe('google_drive');
    expect(parseComposioToolName('mcp__atlassian_jira-abcd1234__create_issue')?.connectorType).toBe('atlassian_jira');
    expect(parseComposioToolName('mcp__microsoft_outlook_mail-abcd1234__send')?.connectorType).toBe('microsoft_outlook_mail');
    expect(parseComposioToolName('mcp__datadog-87654321__list_monitors')?.connectorType).toBe('datadog');
    expect(parseComposioToolName('mcp__reddit-abcd1234__search_posts')?.connectorType).toBe('reddit');
    expect(parseComposioToolName('mcp__apollo-abcd1234__search_people')?.connectorType).toBe('apollo');
    expect(parseComposioToolName('mcp__lever-abcd1234__list_candidates')?.connectorType).toBe('lever');
    expect(parseComposioToolName('mcp__pipedrive-abcd1234__list_deals')?.connectorType).toBe('pipedrive');
    expect(parseComposioToolName('mcp__clickup-abcd1234__list_tasks')?.connectorType).toBe('clickup');
    expect(parseComposioToolName('mcp__greenhouse-abcd1234__list_jobs')?.connectorType).toBe('greenhouse');
    expect(parseComposioToolName('mcp__shopify-abcd1234__list_orders')?.connectorType).toBe('shopify');
    expect(parseComposioToolName('mcp__posthog-abcd1234__query_insight')?.connectorType).toBe('posthog');
    expect(parseComposioToolName('mcp__mixpanel-abcd1234__query_funnel')?.connectorType).toBe('mixpanel');
  });

  it('COMPOSIO_MANAGED_TYPES pins the exact catalog set (drift gate)', () => {
    // Source of truth: `kind: 'composio_managed'` entries in
    // liftoff-connector-service src/catalog/connectors.ts. If the
    // catalog adds or removes a composio_managed connector, BOTH this
    // set AND the matching set in
    // liftoff-platform-backend src/internal-api/platform-tools-router.ts
    // must be updated in the same change.
    const expected = [
      'activecampaign', 'airtable', 'apollo', 'ashby', 'atlassian_confluence',
      'atlassian_jira', 'baserow', 'bitbucket', 'brevo', 'browseai', 'buildkite',
      'cal_com', 'canva', 'clicksend', 'clickup', 'close', 'coda',
      'codacy', 'datadog', 'dataforseo', 'dialpad', 'discord', 'documint', 'dovetail',
      'dropbox', 'elevenlabs', 'facebook', 'fathom', 'fibery', 'figma',
      'fillout', 'fireflies', 'folk', 'follow_up_boss', 'freshbooks', 'freshdesk',
      'gong', 'google_ads', 'google_analytics', 'google_calendar', 'google_docs', 'google_drive', 'google_mail',
      'google_meet', 'google_search_console', 'google_sheets', 'google_slides', 'greenhouse', 'gumroad', 'harvest',
      'heygen', 'hunterio', 'imgbb', 'incident_io', 'instagram', 'instantly', 'intercom',
      'jotform', 'lemlist', 'lemon_squeezy', 'lever', 'linkedin', 'loops',
      'mailchimp', 'mailerlite', 'mailersend', 'mem', 'microsoft_dynamics', 'microsoft_excel',
      'microsoft_onedrive',
      'microsoft_outlook_mail', 'missive', 'mixpanel', 'monday', 'new_relic', 'northflank',
      'pagerduty', 'paperform', 'pdl', 'pipedrive', 'plausible', 'posthog', 'quickbooks', 'reddit',
      'reddit_ads',
      // 'slack' is absent — native dispatch on our own Slack app.
      // 'salesforce' is composio_managed.
      'salesforce',
      'saperly', 'scrapingbee', 'shopify', 'square', 'supabase', 'tally',
      'telegram', 'ticktick', 'todoist', 'toggl', 'trello', 'typeform',
      'whatsapp', 'workable', 'youtube',
      // Zoho suite — zoho_books / zoho_desk / zoho_inventory / zoho_mail are
      // coming_soon (Composio serves them 0 tools) but are still
      // composio_managed, so they belong in the set.
      'zoho', 'zoho_bigin', 'zoho_books', 'zoho_desk', 'zoho_inventory',
      'zoho_invoice', 'zoho_mail',
    ];
    expect([...COMPOSIO_MANAGED_TYPES].sort()).toEqual(expected);
  });

  it('returns null for non-MCP tool calls', () => {
    expect(parseComposioToolName('liftoff_send_message')).toBeNull();
    expect(parseComposioToolName('Read')).toBeNull();
    expect(parseComposioToolName('Bash')).toBeNull();
  });

  it('returns null for malformed mcp__ tool names', () => {
    expect(parseComposioToolName('mcp__')).toBeNull();
    expect(parseComposioToolName('mcp__no_server_separator')).toBeNull();
    expect(parseComposioToolName('mcp__nodash__tool')).toBeNull();
  });
});

describe('reportComposioToolCall', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POSTs one call entry to /api/internal/platform-tools/composio-tool-calls', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await reportComposioToolCall({
      tenantId: 'tenant_xyz',
      agentId: 'agent_abc',
      invocationId: 'inv_123',
      callId: 'tool_use_456',
      connectorType: 'cal_com',
      toolName: 'mcp__cal_com-abcd1234__list_bookings',
      occurredAt: new Date('2026-05-22T19:00:00Z'),
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [service, path, init] = mockFetch.mock.calls[0];
    expect(service).toBe('platform');
    expect(path).toBe('/api/internal/platform-tools/composio-tool-calls');
    expect(init.method).toBe('POST');
    // WS-C regression: an explicit 'Content-Type' here duplicates
    // ServiceClient.buildHeaders' default; the case-differing pair gets
    // comma-joined by fetch and express.json refuses to parse the body —
    // every report then 400s with `calls[] required`. The header must NOT
    // be passed; buildHeaders supplies it.
    expect(init.headers).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toEqual({
      tenantId: 'tenant_xyz',
      agentId: 'agent_abc',
      invocationId: 'inv_123',
      callId: 'tool_use_456',
      connectorType: 'cal_com',
      toolName: 'mcp__cal_com-abcd1234__list_bookings',
      occurredAt: '2026-05-22T19:00:00.000Z',
    });
  });

  it('includes the response body in the failure log (a bare status was undiagnosable)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"calls[] required"}',
    });
    const { logger } = require('../../infrastructure/logging');

    await reportComposioToolCall({
      tenantId: 'tenant_xyz',
      agentId: 'agent_abc',
      callId: 'tool_use_456',
      connectorType: 'gong',
      toolName: 'mcp__gong-12345678__list_calls',
      occurredAt: new Date(),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('calls[] required') }),
      'composio_call_reporter_failed',
    );
  });

  it('swallows HTTP errors (fire-and-forget — must not throw)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      reportComposioToolCall({
        tenantId: 'tenant_xyz',
        agentId: 'agent_abc',
        callId: 'tool_use_456',
        connectorType: 'cal_com',
        toolName: 'mcp__cal_com-abcd1234__list_bookings',
        occurredAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows network errors (must not throw)', async () => {
    mockFetch.mockRejectedValue(new Error('ENETUNREACH'));

    await expect(
      reportComposioToolCall({
        tenantId: 'tenant_xyz',
        agentId: null,
        callId: 'tool_use_456',
        connectorType: 'gong',
        toolName: 'mcp__gong-12345678__list_calls',
        occurredAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});
