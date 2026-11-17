// Pin test for COMPOSIO_TOOLKIT_SLUG_BY_TYPE.
//
// The map must stay in lockstep with:
//   - connector-service src/catalog/connectors.ts mcp.toolkitSlug values
//     for every composio_managed connector
//   - tenant-runtime src/billing/composio-call-reporter.ts COMPOSIO_MANAGED_TYPES set
//   - this package's scripts/sync-schemas.ts COMPOSIO_TOOLKIT_SLUGS list
//
// Drift in any of these breaks the dispatcher in subtle ways (wrong
// toolkit chosen, missing overlay, undefined route). This test pins the
// expected set so a single-side update can't ship silently.

import { COMPOSIO_TOOLKIT_SLUG_BY_TYPE, getToolkitSlugForConnectorType } from '../toolkit-slugs';

const EXPECTED_TYPES = [
  'activecampaign', 'airtable', 'apify', 'apollo', 'atlassian_confluence',
  'atlassian_jira', 'baserow', 'bitbucket', 'brevo', 'browseai', 'buildkite',
  'cal_com', 'canva', 'clicksend', 'clickup', 'close', 'coda', 'codacy',
  'datadog', 'dialpad', 'discord', 'documint', 'dovetail', 'dropbox',
  'elevenlabs', 'facebook', 'fibery', 'figma', 'fillout', 'fireflies', 'folk',
  'follow_up_boss', 'freshbooks', 'freshdesk', 'gong', 'google_ads',
  'google_calendar', 'google_docs', 'google_drive', 'google_mail',
  'google_meet', 'google_sheets', 'google_slides', 'greenhouse', 'gumroad',
  'harvest', 'heygen', 'imgbb', 'incident_io', 'instagram', 'instantly',
  'intercom', 'jotform', 'lemlist', 'lemon_squeezy', 'linkedin', 'loops',
  'mailchimp', 'mailerlite', 'mailersend', 'mem', 'microsoft_dynamics',
  'microsoft_excel', 'microsoft_outlook_mail', 'missive', 'mixpanel', 'monday',
  'new_relic', 'northflank', 'pagerduty', 'paperform', 'pipedrive', 'posthog',
  'quickbooks', 'reddit', 'salesforce', 'scrapingbee', 'shopify', 'slack', 'square',
  'supabase', 'tally', 'telegram', 'ticktick', 'todoist', 'toggl', 'trello',
  'typeform', 'whatsapp', 'workable', 'youtube',
  'zoho', 'zoho_bigin', 'zoho_books', 'zoho_desk', 'zoho_inventory',
  'zoho_invoice', 'zoho_mail',
  'google_analytics', 'google_search_console', 'reddit_ads', 'plausible', 'dataforseo',
];

describe('COMPOSIO_TOOLKIT_SLUG_BY_TYPE', () => {
  it('covers every expected composio_managed connector type', () => {
    const got = Object.keys(COMPOSIO_TOOLKIT_SLUG_BY_TYPE).sort();
    expect(got).toEqual([...EXPECTED_TYPES].sort());
  });

  it('every value is a non-empty string (toolkit slug)', () => {
    for (const [type, slug] of Object.entries(COMPOSIO_TOOLKIT_SLUG_BY_TYPE)) {
      expect(typeof slug).toBe('string');
      expect(slug.length).toBeGreaterThan(0);
      // Sanity: Composio slugs are lowercase alphanumeric + underscore.
      expect(slug).toMatch(/^[a-z0-9_]+$/);
      // Lookups round-trip.
      expect(getToolkitSlugForConnectorType(type)).toBe(slug);
    }
  });

  it('returns undefined for non-composio_managed connector types', () => {
    expect(getToolkitSlugForConnectorType('linear')).toBeUndefined();
    expect(getToolkitSlugForConnectorType('zendesk')).toBeUndefined();
    // 'salesforce' used to stand here as the non-Composio example. It is now on
    // Composio-managed auth: Composio's managed OAuth app removes the need for
    // us to hold our own Connected App consumer key at all.
    expect(getToolkitSlugForConnectorType('salesforce')).toBe('salesforce');
  });
});
