// CI check: every available MCP connector must have at least one tool
// classification seeded in a migration.
//
// How the gap-prevention loop works:
//   1. A new connector is added to liftoff-connector-service catalog.
//   2. `npm run sync:connectors` regenerates connector-service-cache.static.ts.
//   3. This test parses that file + all migration SQL, finds the new entry,
//      and fails CI until the developer either:
//        a) Runs `npm run classify:tools -- --connector <type> --token <token>`
//           in liftoff-connector-service and adds the resulting SQL as a migration
//           (preferred), OR
//        b) Adds the connector to COMING_SOON_OR_NOT_REQUIRED (if it's not yet
//           available or has only read-only tools and no state changes).
//
// No mocks needed — reads from disk only.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const STATIC_FALLBACK_PATH = join(ROOT, 'src/connectors/connector-service-cache.static.ts');

function parseSeededIntegrationTypes(): Set<string> {
  const seeded = new Set<string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    if (!content.includes('tool_classification_cache')) continue;
    if (!content.includes('INSERT INTO tool_classification_cache')) continue;

    // Extract (tool_name, integration_type, ...) tuples from VALUES rows.
    // The integration_type is always the second single-quoted token.
    const re = /\(\s*'[^']+',\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      seeded.add(m[1]);
    }
  }

  return seeded;
}

function parseConnectorTypesFromStaticFallback(): Set<string> {
  const content = readFileSync(STATIC_FALLBACK_PATH, 'utf-8');
  const types = new Set<string>();
  const re = /connectorType:\s*"([a-z_][a-z0-9_]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    types.add(m[1]);
  }
  return types;
}

// ── Exclusion sets ──────────────────────────────────────────────────────────

// Connectors that DON'T need classification seeds. Add to this set ONLY if:
//   - The connector is `status: 'coming_soon'` (no live MCP server yet), OR
//   - The connector is available but provably read-only (no write/destructive
//     tools at all — if unsure, do NOT add here; classify it instead), OR
//   - The connector is a BYOK web-tool vendor (category: 'web_tools') —
//     these are called via dedicated vendor clients in tenant-runtime, not
//     through MCP, so they have nothing to land in tool_classification_cache.
//
// Do NOT add connectors here just because they haven't been classified yet.
// That's what CLASSIFICATION_PENDING is for.
const COMING_SOON_OR_NOT_REQUIRED = new Set([
  // coming_soon — OAuth app or MCP server not yet in place
  'quickbooks',
  'xero',
  // gusto/rippling now seeded (in advance of the native cutover) in
  // migration 279_gusto_rippling_tool_classification.sql — full native tool set
  // (curated + generated), passthrough seeded always-HITL. So they're covered.
  'greenhouse',
  'pagerduty',
  'zendesk',         // seeded as 'zendesk' in migration 039 but now coming_soon; covered
  'demandbase',
  'gong',
  'marketo',
  // salesloft moved to its vendor-hosted MCP (available) and is seeded in
  // migration 461, so it no longer belongs here.
  'smartlead',
  'paypal',
  'plaid',
  'square',
  'google_ads',
  'microsoft_dynamics',
  'calendly',
  // BYOK web-tool vendors — auth.kind: 'api_key', category: 'web_tools'.
  // Not exposed via MCP; tool dispatch goes through tenant-runtime's
  // src/integrations/web-fetch/ vendor clients directly. tool_classification_cache
  // is for MCP-routed connectors only.
  'anchor_browser',
  'browserbase',
  'browser_use',
  'steel',
  'firecrawl',
  'tavily',
  'exa',
  'webclaw',
  // The 1Password service-account token the browsers' saved-login fill reads
  // the shared vault with (tenant-runtime src/integrations/onepassword/): an
  // api_key connector with no tools to classify.
  'onepassword',
]);

// Known classification gaps that existed before this check was introduced.
// Remove an entry once you've added a classification migration for that
// connector. CI will then enforce the seed is present going forward.
//
// To generate SQL for a connector:
//   cd ../liftoff-connector-service
//   npm run classify:tools -- --connector <type> --token <oauth_access_token>
// Then paste the output into a new migration in migrations/.
// KNOWN BLIND SPOT: this file checks coverage per connector TYPE, not per tool
// NAME. A connector that flips native → composio_managed keeps its old seeds
// and so still counts as covered, while every tool it now exposes is renamed
// and therefore unclassified. microsoft_onedrive is in exactly that state:
// migration 082 seeded read_file / read_folder / create_folder / update_file /
// delete_file / delete_folder, and the Composio toolkit exposes get_item,
// list_items, download_file, upload_file and 31 others. The effect is
// fail-SECURE — an unclassified tool defaults to write+sensitive+destructive,
// so every call needs approval — but it is over-gating, not coverage. Fix by
// running classify:tools once a customer connection exists and seeding the new
// names; do NOT add such a type to CLASSIFICATION_PENDING, because the
// stale-entry guard below rejects anything already seeded.
const CLASSIFICATION_PENDING = new Set([
  // MCP-only connectors — need --connector <type> --token <oauth_token> once a customer connects
  'attio',
  // gitlab removed — seeded in migration 305_gitlab_tool_classification.sql (21 tools:
  // full gitlab.com/api/v4/mcp inventory, categories mirroring the GitHub seed in 084).
  // warp (tools-only) — surfaced by the static-cache resync; available in the live catalog but
  // not yet seeded. classify:tools once a connection exists, then seed + remove from here.
  'warp',
  // Change 6 GTM connectors (vendor_hosted + DCR) — classify:tools needs a live
  // authenticated connection; run once a test account is connected.
  // (outreach flipped coming_soon→available here, so it moves in from COMING_SOON.)
  'zoominfo',
  'common_room',
  'outreach',
  // 'clay' removed — seeded in migration 269_clay_tool_classification.sql (16 tools)
  // 'mesh' removed — seeded in migration 270_mesh_tool_classification.sql (20 tools)
  'datadog',
  'databricks',
  'google_bigquery',
  'google_contacts',
  'google_firestore',
  'google_tasks',
  'granola',
  'intercom',
  'notion',
  'pandadoc',
  'sentry',
  'zoom',
  // Composio-managed connectors — tools come from Composio's MCP server and
  // are classified by Composio, not Liftoff. The classify:tools script needs
  // a live OAuth token through Composio to enumerate. Operator-only setup.
  'airtable',
  'discord',
  'freshbooks',
  'linkedin',
  'typeform',
  // Composio-managed connectors added since the last classification sweep —
  // available in catalog, awaiting their first customer OAuth connection so
  // operator can run `npm run classify:tools --connector <type> --token <token>`
  // in liftoff-connector-service.
  'bitbucket',
  'canva',
  'figma',
  'facebook',
  'instagram',
  'reddit',
  'whatsapp',
  'youtube',
  // Capability-absorption batch — only the media-gen vendors remain. The six
  // composio-managed BYO vendors (pdl/hunterio/saperly/apify/contactout/
  // crunchbase) were seeded via classify:tools --from-registry in migration
  // 453_byo_vendor_tool_classification.sql and removed from here. minimax/
  // bytedance/alibaba have no executor yet (W8 media-gen), so they stay pending
  // — their tools fail-secure to HITL, over-gating not a leak.
  // (tikhub/strale/nasdaq seeded in 436; gloria in 438; the six above in 453.)
  'minimax',
  'bytedance',
  'alibaba',
  // Activated via Composio API_KEY — apollo/workable/pipedrive/instantly.
  // (lever is already seeded in migration 039_tool_classification_seed.sql.)
  'apollo',
  'workable',
  'pipedrive',
  'instantly',
  // Batch 3 — additional Composio-managed apps.
  'clickup',
  'todoist',
  'greenhouse',
  'ashby',
  'freshdesk',
  'coda',
  'missive',
  'fireflies',
  'fathom',
  'shopify',
  'gumroad',
  'close',
  'browseai',
  'documint',
  // Phase 3 — product_analytics capability via Composio.
  'posthog',
  'mixpanel',
  // data_table capability — Microsoft-Graph analog of google_sheets via Composio.
  'microsoft_excel',
  // Net-new Composio-managed batch — classified on first connection
  'activecampaign', 'baserow', 'brevo', 'buildkite', 'codacy',
  'dovetail', 'elevenlabs', 'fibery', 'fillout', 'folk', 'follow_up_boss',
  'heygen', 'imgbb', 'incident_io', 'jotform', 'lemlist', 'lemon_squeezy',
  'loops', 'mailerlite', 'mailersend', 'mem', 'new_relic', 'northflank',
  'paperform', 'scrapingbee', 'supabase', 'tally', 'telegram', 'toggl',
  'clicksend', 'ticktick', 'monday', 'dialpad', 'harvest', 'google_meet',
]);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Tool classification coverage', () => {
  let seeded: Set<string>;
  let allConnectors: Set<string>;

  beforeAll(() => {
    seeded = parseSeededIntegrationTypes();
    allConnectors = parseConnectorTypesFromStaticFallback();
  });

  it('every available MCP connector has at least one seeded classification', () => {
    const uncovered = [...allConnectors]
      .filter(t => !seeded.has(t))
      .filter(t => !COMING_SOON_OR_NOT_REQUIRED.has(t))
      .filter(t => !CLASSIFICATION_PENDING.has(t))
      .sort();

    if (uncovered.length > 0) {
      const msg = [
        '',
        'New connector(s) added to catalog without tool classification seeds:',
        ...uncovered.map(t => `  - ${t}`),
        '',
        'Generate seeds by running in liftoff-connector-service:',
        ...uncovered.map(t => `  npm run classify:tools -- --connector ${t} --token <oauth_token>`),
        '',
        'Then paste the SQL output into a new migration in migrations/.',
        '',
        'If this connector is coming_soon or truly read-only (no state-changing tools),',
        'add it to COMING_SOON_OR_NOT_REQUIRED in this file instead.',
      ].join('\n');
      throw new Error(msg);
    }

    // Sanity: seeded set should have at least 15 unique integration types
    expect(seeded.size).toBeGreaterThan(15);
  });

  it('CLASSIFICATION_PENDING has no stale entries — remove a connector once it is seeded', () => {
    const stale = [...CLASSIFICATION_PENDING].filter(t => seeded.has(t)).sort();

    if (stale.length > 0) {
      const msg = [
        '',
        'These connectors are in CLASSIFICATION_PENDING but already have seeds:',
        ...stale.map(t => `  - ${t}`),
        '',
        'Remove them from CLASSIFICATION_PENDING in this test file.',
      ].join('\n');
      throw new Error(msg);
    }
  });

  it('parses at least 15 seeded integration types from migrations', () => {
    // Sanity check: ensures the migration SQL parser is actually finding data.
    // seeded.size is the count of unique integration_type values across all
    // tool_classification_cache INSERT statements in migrations/.
    expect(seeded.size).toBeGreaterThan(15);
  });
});
