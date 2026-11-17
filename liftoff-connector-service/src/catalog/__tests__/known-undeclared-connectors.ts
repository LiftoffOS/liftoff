// Connectors with writes that nobody has declared provenance for yet.
//
// Frozen debt, in the shape of the other ratchets here: the entries are the
// state on the day the ratchet landed, and anything NEW fails. It only
// tightens — a connector that gains declarations must come off, and the test
// fails if it does not.
//
// This is NOT a statement that these connectors are unprotected. The runtime's
// heuristic identifier floor covers every connector at the gateway door,
// declared or not. This list is about the PRECISION layer, which is the one
// that can say "this write names a pull request the run never read" rather than
// "this write names something id-shaped the run never read".

export const KNOWN_UNDECLARED_CONNECTORS: readonly string[] = [
  'adp_run',
  'adp_workforce_now',
  'apify',
  'atlassian_jira',
  'browseai',
  'canva',
  'clay',
  'close',
  'coda',
  'databricks',
  // dataforseo's five writes (start_serp_task, start_keyword_task,
  // start_trends_task, start_site_audit, start_lighthouse_audit) each start a
  // paid job on the customer's account and take no record id, so there is no
  // argument an idArgs declaration could name.
  'dataforseo',
  'dayforce',
  'dialpad',
  'discord',
  'dovetail',
  'dropbox',
  'elevenlabs',
  'elicit',
  'fibery',
  'fireflies',
  'google_ads',
  'google_bigquery',
  'google_meet',
  'gumroad',
  'harvest',
  'heygen',
  'hunterio',
  'imgbb',
  'incident_io',
  'instagram',
  'lemon_squeezy',
  'linkedin',
  'loops',
  'mailerlite',
  'mem',
  'missive',
  'new_relic',
  'pipedrive',
  'posthog',
  'quickbooks',
  'reddit',
  'sendgrid',
  'shopify',
  'snowflake',
  'supabase',
  'toggl',
  'trello',
  'typeform',
  'ukg_pro',
  'zoho_mail',
];
