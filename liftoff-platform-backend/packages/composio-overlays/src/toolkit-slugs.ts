// Composio cutover-completion (C5): canonical Liftoff connector-type →
// Composio toolkit slug map. Single source of truth, consumed by:
//   - connector-service's boot merge (already uses CONNECTORS map via
//     mcp.toolkitSlug — kept in sync via the pin test below).
//   - tenant-runtime's mcp-server stable-name routing (reads from this
//     map to derive `route.toolkitSlug` for the dispatcher).
//   - tenant-runtime's composio-call-reporter (parseComposioToolName
//     guardrail; legacy code path retained for one release).
//
// Drift risk + mitigation: this map MUST stay in lockstep with
// `CONNECTORS[t].mcp.toolkitSlug` in connector-service's
// src/catalog/connectors.ts (and with COMPOSIO_TOOLKIT_SLUGS in
// scripts/sync-schemas.ts). The package's __tests__/toolkit-slugs.test.ts
// pins the set so a drift can't ship silently.

export const COMPOSIO_TOOLKIT_SLUG_BY_TYPE: Record<string, string> = {
  activecampaign: 'active_campaign',
  airtable: 'airtable',
  apify: 'apify',
  apollo: 'apollo',
  baserow: 'baserow',
  brevo: 'brevo',
  browseai: 'browseai',
  buildkite: 'buildkite',
  clicksend: 'clicksend',
  clickup: 'clickup',
  close: 'close',
  coda: 'coda',
  codacy: 'codacy',
  datadog: 'datadog',
  dialpad: 'dialpad',
  documint: 'documint',
  dovetail: 'dovetail',
  elevenlabs: 'elevenlabs',
  fibery: 'fibery',
  fillout: 'fillout_forms',
  fireflies: 'fireflies',
  folk: 'folk',
  follow_up_boss: 'follow_up_boss',
  freshdesk: 'freshdesk',
  atlassian_confluence: 'confluence',
  atlassian_jira: 'jira',
  bitbucket: 'bitbucket',
  cal_com: 'cal',
  canva: 'canva',
  discord: 'discord',
  dropbox: 'dropbox',
  facebook: 'facebook',
  figma: 'figma',
  freshbooks: 'freshbooks',
  gong: 'gong',
  google_ads: 'googleads',
  google_calendar: 'googlecalendar',
  google_docs: 'googledocs',
  google_drive: 'googledrive',
  google_meet: 'googlemeet',
  greenhouse: 'greenhouse',
  gumroad: 'gumroad',
  harvest: 'harvest',
  heygen: 'heygen',
  imgbb: 'imgbb',
  incident_io: 'incident_io',
  instantly: 'instantly',
  intercom: 'intercom',
  jotform: 'jotform',
  lemlist: 'lemlist',
  lemon_squeezy: 'lemon_squeezy',
  loops: 'loops_so',
  mailerlite: 'mailerlite',
  mailersend: 'mailersend',
  mem: 'mem',
  microsoft_excel: 'excel',
  missive: 'missive',
  mixpanel: 'mixpanel',
  monday: 'monday',
  new_relic: 'new_relic',
  northflank: 'northflank',
  paperform: 'paperform',
  pipedrive: 'pipedrive',
  posthog: 'posthog',
  reddit: 'reddit',
  salesforce: 'salesforce',
  scrapingbee: 'scrapingbee',
  shopify: 'shopify',
  supabase: 'supabase',
  tally: 'tally',
  telegram: 'telegram',
  ticktick: 'ticktick',
  todoist: 'todoist',
  toggl: 'toggl',
  workable: 'workable',
  google_mail: 'gmail',
  google_sheets: 'googlesheets',
  google_slides: 'googleslides',
  instagram: 'instagram',
  linkedin: 'linkedin',
  mailchimp: 'mailchimp',
  microsoft_dynamics: 'dynamics365',
  microsoft_outlook_mail: 'outlook',
  pagerduty: 'pagerduty',
  quickbooks: 'quickbooks',
  slack: 'slack',
  square: 'square',
  trello: 'trello',
  typeform: 'typeform',
  whatsapp: 'whatsapp',
  youtube: 'youtube',
  // Marketing: note plausible ≠ plausible_analytics.
  google_analytics: 'google_analytics',
  google_search_console: 'google_search_console',
  reddit_ads: 'reddit_ads',
  plausible: 'plausible_analytics',
  dataforseo: 'dataforseo',
  // Zoho suite — all seven toolkits, all routable.
  zoho: 'zoho',
  zoho_bigin: 'zoho_bigin',
  zoho_books: 'zoho_books',
  zoho_desk: 'zoho_desk',
  zoho_inventory: 'zoho_inventory',
  zoho_invoice: 'zoho_invoice',
  zoho_mail: 'zoho_mail',
};

/** Helper used by tenant-runtime's stable-name router; returns the
 *  toolkit slug for a given Liftoff connector type, or undefined if the
 *  type isn't composio_managed. */
export function getToolkitSlugForConnectorType(connectorType: string): string | undefined {
  return COMPOSIO_TOOLKIT_SLUG_BY_TYPE[connectorType];
}
