// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import { COMPOSIO_MANAGED_CONNECTOR_TYPES } from '../platform-tools-router';

describe('COMPOSIO_MANAGED_CONNECTOR_TYPES (platform-tools-router)', () => {
  it('pins the exact set of composio_managed catalog entries (drift gate)', () => {
    // Source of truth: `kind: 'composio_managed'` entries in
    // liftoff-connector-service src/catalog/connectors.ts. If the
    // catalog adds or removes a composio_managed connector, BOTH this
    // set AND the matching set in
    // liftoff-tenant-runtime src/billing/composio-call-reporter.ts
    // must be updated in the same change. A stale list silently drops
    // Composio tool calls from billing (no OU drain, no Stripe meter).
    const expected = [
      'activecampaign', 'airtable', 'apify', 'apollo', 'ashby', 'atlassian_confluence',
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
      'microsoft_onedrive', 'microsoft_outlook_mail', 'missive', 'mixpanel', 'monday', 'new_relic', 'northflank',
      'pagerduty', 'paperform', 'pdl', 'pipedrive', 'plausible', 'posthog', 'quickbooks', 'reddit',
      'reddit_ads',
      // 'slack' is absent — it uses native dispatch on our own Slack app
      // (see connector-service catalog entry).
      // 'salesforce' is composio_managed (Composio's managed OAuth app), not a
      // sidecar connector on its own Connected App.
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
    expect([...COMPOSIO_MANAGED_CONNECTOR_TYPES].sort()).toEqual(expected);
  });
});
