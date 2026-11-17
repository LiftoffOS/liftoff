// Connector Types
// Per Section 11 & 12: Connector management types

export type ConnectorType =
  | 'google_drive'
  | 'google_docs'
  | 'google_sheets'
  | 'google_slides'
  | 'google_calendar'
  | 'google_mail'
  | 'google_ads'
  | 'google_contacts'
  | 'google_tasks'
  | 'salesforce'
  | 'hubspot'
  | 'slack'
  | 'atlassian_jira'
  | 'atlassian_confluence'
  | 'zendesk'
  | 'intercom'
  | 'github'
  | 'gitlab'
  | 'linear'
  | 'microsoft_onedrive'
  | 'microsoft_outlook_mail'
  | 'microsoft_outlook_calendar'
  | 'microsoft_teams'
  | 'microsoft_todo'
  | 'microsoft_contacts'
  | 'microsoft_onenote'
  | 'microsoft_sharepoint'
  | 'microsoft_planner'
  | 'microsoft_excel'
  | 'dropbox'
  | 'box'
  | 'stripe'
  | 'google_bigquery'
  | 'google_firestore'
  | 'snowflake'
  | 'databricks'
  | 'zoom'
  // Phase 2 — Planned connectors (all "Coming Soon" in UI)
  // Blocker: OAuth app registration on vendor portal
  | 'quickbooks'   // Register at developer.intuit.com
  | 'xero'         // Register at developer.xero.com
  | 'notion'       // Active — OAuth discovery + dynamic client registration (RFC 7591)
  | 'asana'        // Register at app.asana.com/0/developer-console
  | 'square'       // Register at developer.squareup.com
  | 'paypal'       // Register at developer.paypal.com
  | 'calendly'     // Register at developer.calendly.com
  | 'pandadoc'     // DCR — mcp.pandadoc.com/v1/mcp (e-signature + document automation)
  | 'pipedrive'    // Register at developers.pipedrive.com
  | 'docusign'     // Register at developers.docusign.com
  | 'outreach'     // Register at developers.outreach.io
  | 'salesloft'    // Register at developers.salesloft.com
  | 'gong'         // Register at app.gong.io/settings/api
  | 'marketo'      // Register at developers.marketo.com
  | 'meta_ads'      // Coming soon: Meta (Facebook) OAuth — developers.facebook.com
  // Blocker: OAuth app registration + partner program approval
  | 'gusto'        // Apply at gusto.com/embedded-payroll (partner approval required)
  | 'rippling'     // Apply at developer.rippling.com (partner approval required)
  | 'plaid'        // Apply at plaid.com/partners (partner approval required)
  // Active: DCR MCP connectors (OAuth discovery + dynamic client registration, no vendor registration)
  | 'datadog'      // DCR — mcp.datadoghq.com
  | 'granola'      // DCR — mcp.granola.ai
  // Active: API key connectors (no vendor registration — user provides their own key)
  | 'mailchimp'    // API key — user provides from mailchimp.com/account/api
  | 'sendgrid'     // API key — user provides from app.sendgrid.com/settings/api_keys
  | 'trello'       // API key + token — user provides from trello.com/power-ups/admin
  | 'bamboohr'     // API key — user provides from BambooHR account settings
  | 'cal_com'      // API key — user provides from cal.com/settings/developer/api-keys
  | 'woocommerce'  // Consumer key/secret — user generates from WooCommerce > Settings > REST API
  | 'sentry'       // API key — user provides from sentry.io/settings/account/api/auth-tokens/
  // Active: DCR MCP connectors (OAuth discovery + dynamic client registration, no vendor registration)
  | 'clay'         // DCR — api.clay.com/v3/mcp (Clay.com — GTM data enrichment / prospecting)
  | 'mesh'         // DCR — mcp.clay.earth (Mesh, formerly Clay.earth → me.sh — personal relationship CRM)
  | 'attio'        // DCR — mcp.attio.com (vendor-hosted MCP)
  | 'zoominfo'     // DCR — mcp.zoominfo.com (vendor-hosted MCP; B2B intelligence)
  | 'common_room'  // DCR — mcp.commonroom.io (vendor-hosted MCP; community-led GTM)
  | 'similarweb'   // DCR — mcp.similarweb.com (vendor-hosted MCP; web/competitive intel)
  | 'ahrefs'       // DCR — api.ahrefs.com/mcp (vendor-hosted MCP; SEO/backlinks)
  | 'supermetrics' // DCR — mcp.supermetrics.com (vendor-hosted MCP; marketing data)
  // Composio-managed (net-new) — no Liftoff sidecar; OAuth handled by Composio's app
  | 'freshbooks'   // Composio managed — Accounting
  | 'discord'      // Composio managed — Productivity / Communications
  | 'airtable'     // Composio managed — Data
  | 'typeform'     // Composio managed — Marketing / Forms
  | 'linkedin'     // Composio managed — Marketing / Social (org posting + ads metadata; NOT InMail/Sales Nav/Recruiter)
  // HR / ATS — Composio does NOT fit (composio_managed_auth_schemes: [] for all three).
  // Investigation: Composio has the toolkit pages but has not registered
  // OAuth client apps with these vendors, so 'custom auth' mode would still require
  // us to register the OAuth apps ourselves — at which point Composio adds nothing
  // over the existing sidecar pattern (bamboohr/rippling/gusto). Auth-provider
  // decision is open; ship as coming_soon until we pick a path.
  | 'workday'      // Coming soon — auth path TBD (Workday OAuth is per-customer-tenant)
  | 'lever'        // Coming soon — auth path TBD (Lever OAuth is self-serve at hire.lever.co/developer)
  | 'workable'     // Coming soon — auth path TBD (Workable OAuth is self-serve at workable.readme.io)
  // Composio-managed (coming_soon batch) — Composio HAS managed OAuth for all of
  // these (composio_managed_auth_schemes is non-empty). Selected specifically
  // because the vendor's OWN OAuth flow requires app review / marketplace listing
  // approval that takes weeks-to-months — Composio's managed app bypasses that
  // entirely. Pending bootstrap via `npm run composio:bootstrap-toolkit`.
  | 'facebook'     // Composio managed — Marketing / Social; bypasses Meta app review
  | 'instagram'    // Composio managed — Marketing / Social; bypasses Meta app review
  | 'whatsapp'     // Composio managed — Marketing / Messaging; bypasses Meta WABA Business verification
  | 'figma'        // Composio managed — Design; bypasses Figma Connect Apps approval
  | 'canva'        // Composio managed — Design; bypasses Canva Connect Apps program
  | 'bitbucket'    // Composio managed — Engineering; bypasses Atlassian developer console approval
  | 'pagerduty'    // Composio managed — Observability / Incident Response; bypasses partner program
  // Zoho suite — all Composio managed, all bypass Zoho Marketplace app review.
  // One toolkit per Zoho product; see the "Zoho suite" block in connectors.ts
  // for the shared region caveat and for how to count a toolkit's tools.
  | 'zoho'           // Composio managed — CRM (ZohoCRM.* scopes; Zoho CRM only)
  | 'zoho_bigin'     // Composio managed — CRM (Bigin, the small-business CRM; ZohoBigin.* scopes)
  | 'zoho_invoice'   // Composio managed — Accounting (invoices, estimates, payments, expenses)
  | 'zoho_books'     // Composio managed — Accounting (invoices, bills, estimates, expenses)
  | 'zoho_desk'      // Composio managed — Customer support (tickets + threads)
  | 'zoho_inventory' // Composio managed — E-commerce / inventory (items, sales + purchase orders)
  | 'zoho_mail'      // Composio managed — Email (messages, drafts; org-admin tools excluded)
  // Google scope extensions — ship via existing GOOGLE_CLIENT_ID app, NOT
  // via Composio. The 2-6 wk Google sensitive-scope review is the price we pay
  // for keeping the consent screen on "Liftoff" instead of "Composio.dev".
  // Same Google app, same OAuth flow, same sidecar pattern as google_mail /
  // google_calendar / google_drive. The "scope-extension" label is just a
  // bucket for ConnectorType comments — each one ships independently.
  | 'youtube'      // YouTube Data API v3 + Analytics v2 + Reporting v1; scopes youtube.readonly + youtube.force-ssl + yt-analytics.readonly (all sensitive)
  // google_analytics / google_search_console TBD — deferred
  | 'firecrawl'
  | 'anchor_browser'
  | 'browserbase'
  | 'tavily'
  | 'exa'
  | 'webclaw'
  | 'browser_use'  // API key — hosted browser sessions (CDP + live view). Key format bu_live_...
  | 'steel'        // API key — hosted browser sessions (CDP + live view + profiles). Key format ste-...
  | 'onepassword'  // API key: a 1Password service-account token (ops_…); the runtime reads the shared vault's logins and fills sign-in forms itself
  | 'elicit'       // API key — native sidecar; academic research (papers, reports, clinical trials, systematic reviews). User provides an elk_live_ key from elicit.com/settings
  // Net-new Composio-managed batch
  | 'activecampaign'
  | 'apify'
  // Capability-absorption data vendors
  | 'contactout'
  | 'crunchbase'
  | 'tikhub'
  | 'pdl'
  | 'hunterio'
  | 'saperly'
  | 'strale'
  | 'nasdaq'
  | 'ycombinator'
  | 'gloria'
  | 'minimax'
  | 'bytedance'
  | 'alibaba'
  | 'baserow'
  | 'brevo'
  | 'buildkite'
  | 'codacy'
  | 'dovetail'
  | 'elevenlabs'
  | 'fibery'
  | 'fillout'
  | 'folk'
  | 'follow_up_boss'
  | 'heygen'
  | 'imgbb'
  | 'incident_io'
  | 'jotform'
  | 'lemlist'
  | 'lemon_squeezy'
  | 'loops'
  | 'mailerlite'
  | 'mailersend'
  | 'mem'
  | 'new_relic'
  | 'northflank'
  | 'paperform'
  | 'scrapingbee'
  | 'supabase'
  | 'tally'
  | 'telegram'
  | 'toggl'
  | 'clicksend'
  | 'ticktick'
  | 'monday'
  | 'dialpad'
  | 'harvest'
  | 'google_meet'
  // Marketing connectors: vendor-hosted MCP + DCR, api_key, Composio-managed.
  | 'klaviyo' | 'kit' | 'omnisend' | 'amplitude' | 'pendo' | 'webflow' | 'typefully' | 'crustdata'
  | 'tapfiliate' | 'partnerstack' | 'crossbeam' | 'paddle' | 'snov' | 'sparktoro' | 'livestorm'
  | 'coupler' | 'keywords_everywhere' | 'tolt' | 'demandbase'
  | 'google_analytics' | 'google_search_console' | 'reddit_ads' | 'plausible' | 'dataforseo'
  // One generic type for every API a workspace connects from a conversation.
  // multiInstance: the provider, hosts, placement and operations are per
  // instance, on custom_api_connectors, and never on the shared catalog — a
  // workspace connecting something adds nothing anyone else can see.
  | 'custom_api_connector';

export type ConnectorStatus = 'pending' | 'active' | 'error' | 'disabled' | 'disconnected';
export type CredentialStatus = 'active' | 'expired' | 'revoked' | 'refreshing';
export type CredentialType = 'oauth2' | 'api_key' | 'service_account';

export interface Connector {
  id: string;
  tenantId: string;
  type: ConnectorType;
  name: string;
  status: ConnectorStatus;
  config: Record<string, unknown>;
  apiKeyHint: string | null;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorCredential {
  id: string;
  connectorId: string;
  credentialType: CredentialType;
  secretName: string;
  scopes: string[] | null;
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
  status: CredentialStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorWithCredential extends Connector {
  credential?: ConnectorCredential;
}

export interface CreateConnectorInput {
  tenantId: string;
  type: ConnectorType;
  name: string;
  config?: Record<string, unknown>;
  // Defaults to 'pending'. OAuth connectors leave this default and flip to
  // 'active' after the callback. Non-OAuth flows (e.g. custom_mcp_server)
  // must pass 'active' explicitly, otherwise the row is hidden from the
  // Connections UI which only renders status === 'active' | 'error'.
  status?: ConnectorStatus;
}

export interface OAuthState {
  id: string;
  state: string;
  tenantId: string;
  accountId: string;
  connectorType: ConnectorType;
  scopes: string[] | null;
  redirectUri: string | null;
  codeVerifier: string | null; // PKCE code verifier for providers that require it
  expiresAt: Date;
  createdAt: Date;
}

// Google OAuth scopes per connector type
//
// ──────────────────────────────────────────────────────────────────────
// ⚠  WHERE TO MANAGE THESE SCOPES IN GOOGLE CLOUD CONSOLE
// ──────────────────────────────────────────────────────────────────────
//
// Liftoff Google connectors use two OAuth client apps — one per env:
//
//   Dev:  Project ID YOUR_CONTROL_PROJECT_STAGING  (project number YOUR_PROJECT_NUMBER_STAGING)
//         Console:   https://console.cloud.google.com/apis/credentials/consent?project=YOUR_CONTROL_PROJECT_STAGING
//   Prod: Project ID YOUR_CONTROL_PROJECT (project number YOUR_PROJECT_NUMBER)
//         Console:   https://console.cloud.google.com/apis/credentials/consent?project=YOUR_CONTROL_PROJECT
//
// Each env reads google-oauth-client-id / google-oauth-client-secret
// from its own Secret Manager. The two clients are independent —
// verification status is per-app, so adding a sensitive scope means
// submitting verification on BOTH consent screens (prod is the one
// users actually hit; dev is for in-house testing).
//
// (Keeping the two apps separate means a verification snag on one app
//  can't knock the other offline.)
//
// When adding a new scope below:
//   1. Append it to the relevant connector array.
//   2. Open EACH env's Console URL above → "Scopes" → "Add or remove scopes".
//      Both dev and prod consent screens need the scope.
//   3. If it's a SENSITIVE or RESTRICTED scope (per Google's tiering),
//      submit for verification on the prod app (the dev app stays in
//      test mode and never goes through review). Sensitive adds need
//      scope justification + a ≤2-min demo video, no CASA. Wall clock
//      is 2-6 weeks.
//   4. Until approval, OAuth flows for new scopes on prod show
//      "unverified app". Keep the connector status 'coming_soon' in
//      src/catalog/connectors.ts until approval.
//
// Same OAuth client is reused for any future Google service we add
// (google_analytics, google_search_console, etc. — see ConnectorType
// union for what's reserved).
// ──────────────────────────────────────────────────────────────────────
export const GOOGLE_CONNECTOR_SCOPES: Record<string, string[]> = {
  google_drive: [
    'https://www.googleapis.com/auth/drive',
  ],
  google_docs: [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive.file',
  ],
  google_sheets: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ],
  google_slides: [
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive',
  ],
  google_calendar: [
    'https://www.googleapis.com/auth/calendar',
  ],
  google_mail: [
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  google_contacts: [
    'https://www.googleapis.com/auth/contacts.readonly',
  ],
  google_tasks: [
    'https://www.googleapis.com/auth/tasks',
  ],
  google_bigquery: [
    'https://www.googleapis.com/auth/bigquery',
    'https://www.googleapis.com/auth/bigquery.readonly',
  ],
  google_firestore: [
    'https://www.googleapis.com/auth/datastore',
    'https://www.googleapis.com/auth/cloud-platform',
  ],
  google_ads: [
    'https://www.googleapis.com/auth/adwords',
  ],
  youtube: [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl',
    // YouTube Analytics v2 + Reporting v1 read access. Non-monetary only.
    // Add yt-analytics-monetary.readonly if/when revenue surfaces become a product.
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ],
};

// Slack OAuth USER scopes. The live authorize URL is minted from the catalog
// entry (src/catalog/connectors.ts slack.auth.scopes) — keep the two lists
// identical. app_mentions:read was removed: it is a BOT-only scope and is
// invalid in the user_scope parameter this connector requests.
// See: https://api.slack.com/scopes
export const SLACK_CONNECTOR_SCOPES: string[] = [
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'users:read',
  'users:read.email',
];

// Slack BOT scopes, granted in the SAME authorize as the user scopes above
// (scope= parameter alongside user_scope=). Connecting the Slack connector
// ALSO installs the Liftoff app's bot into the workspace: the callback hands
// the returned xoxb bot token to platform-backend (slack_workspace_installs),
// which drives agent chat, HITL cards, and slack_* bot tools (PB ADR-040).
// MUST stay in lockstep with the Slack app manifest's bot scopes.
export const SLACK_WORKSPACE_BOT_SCOPES: string[] = [
  'app_mentions:read',
  'channels:history',
  'channels:join',
  'channels:read',
  'chat:write',
  // NOT chat:write.customize: the bot never renames itself per message. An
  // agent-authored message opens with the agent's name in the TEXT instead —
  // one app reads as one app, and an agent carrying a human nickname must not
  // be able to look like a colleague.
  'chat:write.public',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'reactions:write',
  'users:read',
  'users:read.email',
];

// GitHub OAuth scopes
// See: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
export const GITHUB_CONNECTOR_SCOPES: string[] = [
  'repo',
  'read:user',
  'user:email',
  'read:org',
];

// Microsoft Graph OAuth scopes per connector type
// See: https://learn.microsoft.com/en-us/graph/permissions-reference
// Requesting full access to everything the user has permissions for
export const MICROSOFT_CONNECTOR_SCOPES: Record<string, string[]> = {
  microsoft_onedrive: [
    'Files.ReadWrite.All',
    'Sites.ReadWrite.All',
    'User.Read',
    'offline_access',
  ],
  microsoft_outlook_mail: [
    'Mail.ReadWrite',
    'Mail.ReadWrite.Shared',
    'Mail.Send',
    'Mail.Send.Shared',
    'MailboxSettings.ReadWrite',
    'User.Read',
    'offline_access',
  ],
  microsoft_outlook_calendar: [
    'Calendars.ReadWrite',
    'Calendars.ReadWrite.Shared',
    'MailboxSettings.ReadWrite',
    'User.Read',
    'offline_access',
  ],
  microsoft_teams: [
    'Team.ReadBasic.All',
    'TeamSettings.ReadWrite.All',
    'Channel.ReadBasic.All',
    'ChannelMessage.Read.All',
    'ChannelMessage.Send',
    'Chat.ReadWrite',
    'ChatMessage.Read',
    'ChatMessage.Send',
    'TeamsTab.ReadWrite.All',
    'TeamsAppInstallation.ReadForUser',
    'User.Read',
    'offline_access',
  ],
  microsoft_todo: [
    'Tasks.ReadWrite',
    'Tasks.ReadWrite.Shared',
    'User.Read',
    'offline_access',
  ],
  microsoft_contacts: [
    'Contacts.ReadWrite',
    'Contacts.ReadWrite.Shared',
    'People.Read',
    'People.Read.All',
    'User.Read',
    'offline_access',
  ],
  microsoft_onenote: [
    'Notes.ReadWrite.All',
    'User.Read',
    'offline_access',
  ],
  microsoft_sharepoint: [
    'Sites.ReadWrite.All',
    'Sites.Manage.All',
    'Files.ReadWrite.All',
    'User.Read',
    'offline_access',
  ],
  microsoft_planner: [
    'Tasks.ReadWrite',
    'Group.ReadWrite.All',
    'User.Read',
    'offline_access',
  ],
};

// Legacy alias for OneDrive scopes
export const MICROSOFT_ONEDRIVE_SCOPES: string[] = MICROSOFT_CONNECTOR_SCOPES.microsoft_onedrive;

// Dropbox OAuth scopes
// See: https://www.dropbox.com/developers/reference/oauth-guide
export const DROPBOX_CONNECTOR_SCOPES: string[] = [
  // Individual scopes
  'files.metadata.read',
  'files.metadata.write',
  'files.content.read',
  'files.content.write',
  'sharing.read',
  'sharing.write',
  'account_info.read',
  // Team scopes (Dropbox Business)
  'team_info.read',
  'team_data.member',
  'team_data.content.read',
  'team_data.content.write',
  'files.team_metadata.read',
  'files.team_metadata.write',
  'members.read',
  'groups.read',
];

// Box OAuth scopes
// See: https://developer.box.com/guides/api-calls/permissions-and-errors/scopes/
export const BOX_CONNECTOR_SCOPES: string[] = [
  'root_readwrite',
  'item_preview',
  'item_upload',
  'item_delete',
];

// Zendesk OAuth scopes
// See: https://developer.zendesk.com/api-reference/ticketing/oauth/oauth_authorizations/
export const ZENDESK_CONNECTOR_SCOPES: string[] = [
  'read',
  'write',
];

// Atlassian OAuth scopes (Jira)
// See: https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/
export const JIRA_CONNECTOR_SCOPES: string[] = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'read:servicedesk-request',
  'write:servicedesk-request',
  'offline_access',
];

// Atlassian OAuth scopes (Confluence)
// See: https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/
export const CONFLUENCE_CONNECTOR_SCOPES: string[] = [
  'read:confluence-content.all',
  'write:confluence-content',
  'read:confluence-space.summary',
  'read:confluence-user',
  'offline_access',
];

// Stripe MCP OAuth scope.
//
// `read_write` was the Stripe CONNECT scope and is wrong now: the connector
// authenticates by DCR against access.stripe.com/mcp, whose registration issues
// `scope: mcp`. Asking for read_write on the authorize request is asking for a
// scope that client was never granted.
export const STRIPE_CONNECTOR_SCOPES: string[] = [
  'mcp',
];

// Zoom OAuth scopes
// See: https://developers.zoom.us/docs/integrations/oauth/#scopes
export const ZOOM_CONNECTOR_SCOPES: string[] = [
  'meeting:read',
  'meeting:write',
  'user:read',
  'recording:read',
  'webinar:read',
  'webinar:write',
];

// Salesforce OAuth scopes
// See: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_tokens_scopes.htm
export const SALESFORCE_CONNECTOR_SCOPES: string[] = [
  'api',           // Access REST and SOAP APIs
  'refresh_token', // Allow refresh tokens (offline access)
  'full',          // Full access to all data accessible by the logged-in user
  'id',            // Access identity URL service
  'openid',        // OpenID Connect (access to user's identity)
];

// HubSpot OAuth scopes
// See: https://developers.hubspot.com/docs/api/working-with-oauth#scopes
export const HUBSPOT_CONNECTOR_SCOPES: string[] = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  'crm.schemas.deals.read',
  'forms',
  'content',
];

// Phase 2 Priority 1: New OAuth scopes for vendor MCP connectors
// SE-004: Minimum required scopes per provider (read-only default for financial)

export const QUICKBOOKS_CONNECTOR_SCOPES: string[] = [
  'com.intuit.quickbooks.accounting',
];

export const XERO_CONNECTOR_SCOPES: string[] = [
  'openid',
  'profile',
  'email',
  'accounting.transactions',
  'accounting.transactions.write',
  'accounting.contacts',
  'accounting.contacts.write',
  'accounting.settings.read',
  'offline_access',
];

export const NOTION_CONNECTOR_SCOPES: string[] = [
  // Notion OAuth does NOT use URL scope params — capabilities are configured in the
  // public integration settings at notion.so/my-integrations (read content, update content,
  // insert content, etc.). The empty array is intentional: passing scopes in the auth URL
  // is a no-op for Notion. This is NOT an internal integration token (API key) flow —
  // it requires NOTION_CLIENT_ID + NOTION_CLIENT_SECRET from a registered public OAuth app.
];

// Phase 2 Priority 2: New OAuth scopes
export const ASANA_CONNECTOR_SCOPES: string[] = ['default'];
export const MAILCHIMP_CONNECTOR_SCOPES: string[] = []; // API key based
export const SQUARE_CONNECTOR_SCOPES: string[] = [
  'ITEMS_READ', 'ITEMS_WRITE', 'ORDERS_READ', 'ORDERS_WRITE',
  'PAYMENTS_READ', 'CUSTOMERS_READ', 'CUSTOMERS_WRITE',
];
export const PAYPAL_CONNECTOR_SCOPES: string[] = [
  'openid', 'email',
  'https://uri.paypal.com/services/invoicing',
  'https://uri.paypal.com/services/payments/payment',
];
export const CALENDLY_CONNECTOR_SCOPES: string[] = []; // Default scopes
export const PIPEDRIVE_CONNECTOR_SCOPES: string[] = []; // Default scopes
export const DOCUSIGN_CONNECTOR_SCOPES: string[] = ['signature', 'impersonation'];
export const GUSTO_CONNECTOR_SCOPES: string[] = ['payrolls:read', 'employees:read', 'companies:read'];
export const RIPPLING_CONNECTOR_SCOPES: string[] = ['employee:read', 'company:read'];

// Meta Ads (Facebook) OAuth scopes
// See: https://developers.facebook.com/docs/permissions
export const META_ADS_CONNECTOR_SCOPES: string[] = [
  'ads_read',
  'ads_management',
  'business_management',
  'leads_retrieval',
];

// OAuth provider configuration
export type OAuthProvider =
  | 'google' | 'slack' | 'github' | 'microsoft' | 'dropbox' | 'box'
  | 'zendesk' | 'atlassian' | 'stripe' | 'zoom' | 'salesforce' | 'hubspot'
  // Phase 2 new providers
  | 'intuit' | 'xero' | 'notion' | 'asana' | 'square' | 'paypal'
  | 'calendly' | 'docusign'
  // gusto + rippling — native HRIS via our own OAuth app (Gusto DevPortal / Rippling App-Shop).
  | 'gusto' | 'rippling'
  // bamboohr — native HRIS via our own BambooHR developer-portal OAuth app.
  // Per-company-subdomain authorize/token (SUBDOMAIN-templated, like zendesk).
  | 'bamboohr'
  | 'gitlab'
  | 'linear' | 'clay' | 'mesh' | 'attio' | 'granola'
  | 'outreach' | 'salesloft' | 'gong' | 'marketo'
  | 'zoominfo' | 'common_room' | 'similarweb' | 'ahrefs' | 'supermetrics'
  | 'pandadoc'
  | 'meta'
  // Marketing connectors (vendor-hosted MCP + DCR)
  | 'klaviyo' | 'kit' | 'omnisend' | 'amplitude' | 'pendo' | 'webflow' | 'typefully' | 'crustdata'
  | 'tapfiliate' | 'partnerstack' | 'crossbeam' | 'paddle' | 'snov' | 'sparktoro' | 'livestorm'
  | 'coupler' | 'keywords_everywhere' | 'demandbase';

// Static OAuth config — pre-registered client credentials from env vars (all existing connectors)
export interface StaticOAuthConfig {
  kind: 'static';
  authUrl: string;
  tokenUrl: string;
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
  scopes: string[];
  scopeDelimiter: string;
  requiresPkce?: boolean;
}

// Discovery-based OAuth config — endpoints and client_id obtained at runtime via
// .well-known discovery + RFC 7591 dynamic client registration (e.g., Notion MCP)
// PKCE is always required (public client, token_endpoint_auth_method: "none")
export interface DiscoveryOAuthConfig {
  kind: 'discovery';
  discoveryBaseUrl: string;        // e.g. 'https://mcp.notion.com'
  // Local-dev-only override. IGNORED in a deployed service (see
  // discoveryClientOverride in oauth/router.ts): pinning a hand-registered
  // client here turns DCR off for the provider, and the pinned client dies
  // silently the day the vendor expires it.
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
  scopes: string[];
  scopeDelimiter: string;
}

export type OAuthProviderConfig = StaticOAuthConfig | DiscoveryOAuthConfig;

export function isDiscoveryConfig(config: OAuthProviderConfig): config is DiscoveryOAuthConfig {
  return config.kind === 'discovery';
}

export function isStaticConfig(config: OAuthProviderConfig): config is StaticOAuthConfig {
  return config.kind === 'static';
}

// OAUTH_PROVIDER_CONFIGS — PROJECTION from CONNECTORS registry. See
// below (after the ConnectorType union + scope constants) for the
// builder + exported const. The declaration is delayed until after
// all its dependencies are in scope.

// Map connector types to OAuth providers
export function getOAuthProvider(connectorType: ConnectorType): OAuthProvider | null {
  if (connectorType.startsWith('google_')) {
    return 'google';
  }
  if (connectorType.startsWith('microsoft_')) {
    return 'microsoft';
  }
  if (connectorType === 'slack') {
    return 'slack';
  }
  if (connectorType === 'github') {
    return 'github';
  }
  if (connectorType === 'dropbox') {
    return 'dropbox';
  }
  if (connectorType === 'box') {
    return 'box';
  }
  if (connectorType === 'zendesk') {
    return 'zendesk';
  }
  if (connectorType === 'atlassian_jira' || connectorType === 'atlassian_confluence') {
    return 'atlassian';
  }
  if (connectorType === 'stripe') {
    return 'stripe';
  }
  if (connectorType === 'zoom') {
    return 'zoom';
  }
  if (connectorType === 'google_bigquery' || connectorType === 'google_firestore') {
    return 'google';
  }
  if (connectorType === 'salesforce') {
    return 'salesforce';
  }
  if (connectorType === 'hubspot') {
    return 'hubspot';
  }
  // Phase 2 new providers
  if (connectorType === 'quickbooks') return 'intuit';
  if (connectorType === 'xero') return 'xero';
  if (connectorType === 'notion') return 'notion';
  if (connectorType === 'asana') return 'asana';
  if (connectorType === 'square') return 'square';
  if (connectorType === 'paypal') return 'paypal';
  if (connectorType === 'calendly') return 'calendly';
  if (connectorType === 'docusign') return 'docusign';
  if (connectorType === 'gitlab') return 'gitlab';
  if (connectorType === 'linear') return 'linear';
  if (connectorType === 'clay') return 'clay';
  if (connectorType === 'mesh') return 'mesh';
  if (connectorType === 'attio') return 'attio';
  if (connectorType === 'granola') return 'granola';
  if (connectorType === 'pandadoc') return 'pandadoc';
  if (connectorType === 'outreach') return 'outreach';
  if (connectorType === 'salesloft') return 'salesloft';
  if (connectorType === 'zoominfo') return 'zoominfo';
  if (connectorType === 'common_room') return 'common_room';
  if (connectorType === 'similarweb') return 'similarweb';
  if (connectorType === 'ahrefs') return 'ahrefs';
  if (connectorType === 'supermetrics') return 'supermetrics';
  if (connectorType === 'gong') return 'gong';
  if (connectorType === 'marketo') return 'marketo';
  if (connectorType === 'meta_ads') return 'meta';
  // Marketing connectors (vendor-hosted MCP + DCR). tolt / plausible / dataforseo are
  // api_key and fall through to null; google_analytics / google_search_console resolve
  // to 'google' through the startsWith('google_') branch above exactly as google_ads
  // does, and the /start router branches on mcp.kind === 'composio_managed' first.
  if (connectorType === 'klaviyo') return 'klaviyo';
  if (connectorType === 'kit') return 'kit';
  if (connectorType === 'omnisend') return 'omnisend';
  if (connectorType === 'amplitude') return 'amplitude';
  if (connectorType === 'pendo') return 'pendo';
  if (connectorType === 'webflow') return 'webflow';
  if (connectorType === 'typefully') return 'typefully';
  if (connectorType === 'crustdata') return 'crustdata';
  if (connectorType === 'tapfiliate') return 'tapfiliate';
  if (connectorType === 'partnerstack') return 'partnerstack';
  if (connectorType === 'crossbeam') return 'crossbeam';
  if (connectorType === 'paddle') return 'paddle';
  if (connectorType === 'snov') return 'snov';
  if (connectorType === 'sparktoro') return 'sparktoro';
  if (connectorType === 'livestorm') return 'livestorm';
  if (connectorType === 'coupler') return 'coupler';
  if (connectorType === 'keywords_everywhere') return 'keywords_everywhere';
  if (connectorType === 'demandbase') return 'demandbase';
  // Native HRIS connectors with their own OAuth app.
  if (connectorType === 'gusto') return 'gusto';
  if (connectorType === 'rippling') return 'rippling';
  if (connectorType === 'bamboohr') return 'bamboohr';
  // API-key connectors: no OAuth provider. Returns null for:
  //   - Vendor API keys: plaid, cal_com, trello, woocommerce, sendgrid,
  //     mailchimp, sentry, databricks (and bamboohr while dormant/api_key)
  //   - BYOK web-tool vendors: firecrawl, anchor_browser, browserbase,
  //     tavily, exa, webclaw, browser_use, steel, onepassword
  //   - Custom MCP servers (per-instance credentials): custom_mcp_server
  return null;
}

// Get scopes for a connector type
export function getConnectorScopes(connectorType: ConnectorType): string[] {
  const provider = getOAuthProvider(connectorType);
  if (!provider) {
    return [];
  }
  if (provider === 'google') {
    return GOOGLE_CONNECTOR_SCOPES[connectorType] || [];
  }
  if (provider === 'microsoft') {
    return MICROSOFT_CONNECTOR_SCOPES[connectorType] || [];
  }
  if (provider === 'dropbox') {
    return DROPBOX_CONNECTOR_SCOPES;
  }
  if (provider === 'box') {
    return BOX_CONNECTOR_SCOPES;
  }
  if (provider === 'zendesk') {
    return ZENDESK_CONNECTOR_SCOPES;
  }
  if (provider === 'atlassian') {
    if (connectorType === 'atlassian_jira') return JIRA_CONNECTOR_SCOPES;
    if (connectorType === 'atlassian_confluence') return CONFLUENCE_CONNECTOR_SCOPES;
    return [];
  }
  if (provider === 'stripe') {
    return STRIPE_CONNECTOR_SCOPES;
  }
  if (provider === 'zoom') {
    return ZOOM_CONNECTOR_SCOPES;
  }
  if (provider === 'salesforce') {
    return SALESFORCE_CONNECTOR_SCOPES;
  }
  if (provider === 'hubspot') {
    return HUBSPOT_CONNECTOR_SCOPES;
  }
  return OAUTH_PROVIDER_CONFIGS[provider].scopes;
}

// Connector display names
/**
 * Display names keyed by connector type.
 *
 * As of the unified-catalog refactor, this is a PROJECTION over the
 * CONNECTORS registry in src/catalog/connectors.ts. The literal object
 * below is kept as a typed compatibility layer so existing consumers
 * (and the ConnectorType union) still type-check — but values match the
 * registry 1:1 and drift is prevented by a test in
 * src/catalog/__tests__/connectors.test.ts.
 *
 * To rename a connector, edit its `displayName` in connectors.ts.
 */

// ──────────────────────────────────────────────────────────────────────
// Function / tool schema types (ported from tenant-runtime types.ts).
// Used by connector-functions-registry + capability dispatch.
// ──────────────────────────────────────────────────────────────────────

export interface JsonSchemaProperty {
  type: string | string[];
  description?: string;
  required?: boolean;
  /** REQUIRED when type === 'array'. Empty object `{}` means "any". */
  items?: JsonSchemaProperty | Record<string, never>;
  /** Optional nested properties when type === 'object'. */
  properties?: Record<string, JsonSchemaProperty>;
  /** Optional enum constraint. */
  enum?: (string | number | boolean | null)[];
  /** Values a caller may copy, which constrain nothing. Where a source
   *  published TEST INPUTS as if they were the field's domain, the listed
   *  values land here and the field keeps its type — see
   *  catalog/locus-parse-schemas.ts. */
  examples?: (string | number | boolean | null)[];
  /** Optional sub-required list when type === 'object'. */
  requiredFields?: string[];
}

export interface ConnectorFunction {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  /**
   * The schema the SOURCE will actually accept, when it is narrower than the
   * one the model is offered. Never shown to a model and never used to shape
   * a tool definition: it exists so a caller can tell, before spending a
   * call, that this source would refuse these arguments.
   *
   * One source can have both because one schema cannot be both: Parse
   * publishes its scraper's TEST INPUTS in the same place as the field's
   * domain, and Locus turns that list into an enum it enforces, while Parse
   * itself takes free text. `inputSchema` says what may be asked for;
   * this says what this reseller will pass on. See
   * catalog/locus-parse-schemas.ts.
   */
  routingSchema?: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  /** What the function does to the world. `internalCollaboration` marks a
   *  message into the workspace's OWN collaboration surface — how a team talks
   *  to its people — and is never held for approval by any gate; it sits
   *  beside `write` and is read as the more specific of the two. Mirrors
   *  `ToolCategory` in @liftoffos/connector-types. */
  categories: ('read' | 'write' | 'destructive' | 'outbound' | 'sensitive' | 'internalCollaboration')[];
  draftVariant?: string;
  entityType?: string;
  /**
   * Set on warehouse query functions that take a raw SQL string in `sqlParam`.
   * The execution path (native client or the Composio dispatcher) MUST run the
   * read-only statement gate (fail-closed) + row cap from
   * src/clients/warehouse/query-guardrails.ts on that arg before dispatch.
   * See implementation plan §2.
   */
  sqlGuard?: { sqlParam: string; dialect: 'postgresql' | 'snowflake' | 'bigquery' | 'hive' };
  /**
   * Success (2xx) response body schema, emitted by the spec codegen for OpenAPI-sourced
   * native HRIS tools. Read at runtime by the drift checker
   * (src/observability/response-conformance.ts) to flag spec-vs-reality divergence.
   */
  responseSchema?: JsonSchemaProperty;
  /**
   * When true, this numeric-returning function is eligible to back
   * a `source.kind: 'computed_metric'` reactive subscription. Generic flag;
   * any connector author may set it on functions in their own code. The
   * platform validates that subscriptions referencing a fn have
   * metricReadable=true at distill/validate time. No vendor-specific code on
   * the platform side.
   */
  metricReadable?: boolean;
  /**
   * Dispatch override. When true, the executor adapter routes this function
   * to the client's `list(entityType, filters)` method instead of the
   * default `read(entityType, entityId, payload)` path. Use for read-only
   * functions whose payload semantics match the polling-style `ListFilters`
   * shape (limit / pageToken / since / q). Gmail's `list_messages` is the
   * canonical example — the agent passes `query` and we honour it as Gmail's
   * `q` parameter via the `ListFilters.q` field.
   */
  useListMethod?: boolean;
  /**
   * Work-queue role for at-least-once-with-idempotent-ack discipline (W1
   * of the work_inbox/ack plan).
   *
   *   'inbox' — surfaces a queue of pending work items; the membership of
   *             the returned list is filtered by external-system state
   *             (e.g. is:unread, status:open, assignee:me).
   *   'ack'   — flips the external-system state so the same item no longer
   *             appears in the paired inbox tool's next list.
   *
   * MUST be set in lockstep with `paired_ack` / `acknowledges` and
   * `workItemKind`. Boot-time validator refuses to start otherwise.
   *
   * Convention is connector-agnostic: distill auto-injects an
   * acknowledgement contract whenever the agent's resolved tool catalog
   * contains an `inbox` tool whose paired `ack` is also bound.
   */
  workRole?: 'inbox' | 'ack';
  /**
   * On a `workRole='inbox'` tool: the registry name of the paired ack
   * tool — e.g. `'mark_as_read'`, NOT the per-account aliased form
   * `'google-mail-14a82d9e__mark_as_read'`. The runtime composes the
   * caller's alias at dispatch time so multi-account agents bind to the
   * right account's ack.
   */
  paired_ack?: string;
  /**
   * On a `workRole='ack'` tool: the registry name of the inbox tool this
   * ack closes the loop on (mirror of `paired_ack`).
   */
  acknowledges?: string;
  /**
   * Stable cross-connector identifier for the kind of work item. Both
   * sides of a pair MUST agree. Examples (open set — connectors author
   * their own values):
   *   'email_message' | 'support_ticket' | 'issue' | 'pull_request' |
   *   'lead' | 'task' | 'incident' | 'chat_message' | 'signature_request' |
   *   'invoice' | 'order' | 'campaign' | 'booking' | 'time_off_request' |
   *   'card' | 'deal' | 'page'
   */
  workItemKind?: string;
  /**
   * Composio cutover-completion (C2/C3): origin of this function
   * definition.
   *   'native'   — hand-authored in CONNECTOR_FUNCTIONS, dispatched via
   *                the connector's native REST executor.
   *   'composio' — sourced from @liftoffos/composio-overlays (merged into
   *                CONNECTOR_FUNCTIONS at boot for composio_managed types),
   *                dispatched via composio.tools.execute() in
   *                tenant-runtime.
   * Read by tenant-runtime's stable-name router to pick a dispatch path.
   * Absent for legacy / pre-cutover entries; the router treats absent as
   * 'native' for backward compatibility.
   */
  definitionSource?: 'native' | 'composio';
  /**
   * The underlying vendor's tool name. For `definitionSource='composio'`,
   * this is the Composio vendor name (e.g. 'GMAIL_FETCH_EMAILS') that the
   * dispatcher will pass as the slug to composio.tools.execute(). The
   * `name` field above is the stable Liftoff name (e.g. 'list_messages')
   * that the agent calls. For native tools, MUST be either omitted or
   * equal to `name`.
   */
  vendorToolName?: string;

  // ── Record provenance / host-only fields / staged writes ──────────────
  //
  // Mirrors @liftoffos/connector-types. This interface is a hand-maintained
  // duplicate of the published one, so a field added there and not here is a
  // field this service cannot populate — and one added here and not there is a
  // field that does not survive the RPC. Both directions are silent.

  /** Payload arguments that identify the record this call acts on. Name the
   *  arguments that pick out WHICH record, never the ones carrying WHAT to do
   *  to it: `body` and `text` are content. */
  idArgs?: string[];

  /** Where this tool's RESULT carries record identities. `path` is a dot path
   *  with `[]` meaning "every element": `messages[].ts`, `data.spreadsheetId`.
   *  `entityType` is matched against the entity a later write names, so a
   *  message id cannot vouch for a pull request. */
  returnsIds?: Array<{ entityType: string; path: string }>;

  /** Result paths that reach the surface but never the model — signed URLs,
   *  payment links, one-time tokens. Distinct from secret-scrubbing, which
   *  removes a value from everywhere; here the person still needs it. */
  egressOnly?: string[];

  /** 'stage' prepares a change a paired apply commits; 'apply' commits one;
   *  'direct' (the default, and everything that does not opt in) takes effect
   *  by itself. Validated in lockstep with `paired_apply` at boot. */
  writeRole?: 'stage' | 'apply' | 'direct';

  /** On writeRole='stage': registry name of the apply tool that commits it. */
  paired_apply?: string;
}

export interface NormalizedRecord {
  connectorId: string;
  entityType: string;
  externalId: string;
  data: Record<string, unknown>;
  syncedAt: Date;
}

export interface ConnectorManifest {
  id: string;
  tenantId: string;
  connectorType: ConnectorType;
  alias: string;
  displayName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorManifestCreate {
  tenantId: string;
  connectorType: ConnectorType;
  alias: string;
  displayName: string;
  enabled?: boolean;
}

// CONNECTOR_TYPES_LIST is declared below, after the CONNECTORS import and
// CONNECTOR_DISPLAY_NAMES projection, because it derives from them.

// ── Catalog projections ──────────────────────────────────────────────
//
// The two exports below are PROJECTIONS over the CONNECTORS registry in
// src/catalog/connectors.ts. They must stay defined at the bottom of this
// file because (a) they depend on the scope constants above, and (b) the
// CONNECTORS import is evaluated at module-load time.
//
// Drift prevention: src/catalog/__tests__/connectors.test.ts asserts that
// every field in these projections matches the registry for every entry.

import { CONNECTORS } from './catalog/connectors.js';

/**
 * Display names keyed by connector type.
 *
 * DERIVED from the CONNECTORS registry. To rename a connector, edit its
 * `displayName` in catalog/connectors.ts.
 */
export const CONNECTOR_DISPLAY_NAMES: Record<ConnectorType, string> = Object.fromEntries(
  Object.values(CONNECTORS).map((c) => [c.type, c.displayName]),
) as Record<ConnectorType, string>;

/**
 * Provider-level OAuth configuration keyed by OAuthProvider.
 *
 * DERIVED from the CONNECTORS registry. For each provider, the first
 * connector that maps to it via `getOAuthProvider()` supplies the
 * authUrl / tokenUrl / clientIdEnvVar / clientSecretEnvVar. The `scopes`
 * field matches the original behaviour: multi-connector providers
 * (google, microsoft, atlassian) report [] here — per-connector scopes
 * are looked up via `getConnectorScopes()` — while single-connector
 * providers return the connector's own scopes.
 */
function buildOAuthProviderConfigsFromRegistry(): Record<OAuthProvider, OAuthProviderConfig> {
  const providerScopesForMultiConnectorProviders: Partial<Record<OAuthProvider, readonly string[]>> = {
    google:    [],
    microsoft: MICROSOFT_ONEDRIVE_SCOPES,
    atlassian: [],
  };

  const byProvider = new Map<OAuthProvider, ConnectorType>();
  for (const connector of Object.values(CONNECTORS)) {
    const provider = getOAuthProvider(connector.type as ConnectorType);
    if (!provider) continue;
    // Prefer direct-routed connectors as the prototype. composio_managed
    // entries carry the COMPOSIO_MANAGED + composio.dev sentinel auth that
    // isn't useful for buildAuthUrl / exchangeCodeForTokens. Only fall back
    // to composio_managed if no direct connector exists for the provider
    // (the case for providers that are 100% on Composio, e.g. gong).
    const existing = byProvider.get(provider);
    const existingIsComposio =
      existing && CONNECTORS[existing]?.mcp?.kind === 'composio_managed';
    const currentIsComposio = connector.mcp?.kind === 'composio_managed';
    if (!existing || (existingIsComposio && !currentIsComposio)) {
      byProvider.set(provider, connector.type as ConnectorType);
    }
  }

  const result = {} as Record<OAuthProvider, OAuthProviderConfig>;
  for (const [provider, connectorType] of byProvider) {
    const connector = CONNECTORS[connectorType]!;
    const auth = connector.auth;
    const overrideScopes = providerScopesForMultiConnectorProviders[provider];

    if (auth.kind === 'static_oauth') {
      result[provider] = {
        kind: 'static',
        authUrl: auth.authUrl,
        tokenUrl: auth.tokenUrl,
        clientIdEnvVar: auth.clientIdEnvVar,
        clientSecretEnvVar: auth.clientSecretEnvVar,
        scopes: overrideScopes ? [...overrideScopes] : [...auth.scopes],
        scopeDelimiter: auth.scopeDelimiter,
        requiresPkce: auth.requiresPkce,
      };
    } else if (auth.kind === 'dcr_oauth') {
      result[provider] = {
        kind: 'discovery',
        discoveryBaseUrl: auth.discoveryBaseUrl,
        clientIdEnvVar: auth.clientIdEnvVar,
        clientSecretEnvVar: auth.clientSecretEnvVar,
        scopes: overrideScopes ? [...overrideScopes] : [...auth.scopes],
        scopeDelimiter: auth.scopeDelimiter,
      };
    } else {
      throw new Error(
        `Provider ${provider} (prototype connector ${connectorType}) has non-OAuth auth.kind=${auth.kind}`,
      );
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// ⚠  OAUTH APP REGISTRY — WHERE EACH VENDOR'S APP LIVES
// ──────────────────────────────────────────────────────────────────────
//
// For every static_oauth connector, the OAuth client_id/secret pair we
// store in Secret Manager corresponds to an actual app registered in
// the vendor's developer dashboard. When you need to add a scope,
// rotate the secret, fix a redirect URI, or update a privacy policy
// link — go here. Keep this table updated when adding new connectors.
//
// Secret Manager naming convention (in YOUR_GCP_PROJECT{dev,prod}):
//   <vendor>-oauth-client-id-{dev,prod}
//   <vendor>-oauth-client-secret-{dev,prod}
//
// ENV VAR                        DASHBOARD URL                                                                         NOTES
// ─────────────────────────────  ────────────────────────────────────────────────────────────────────────────────────  ─────────────────────────────────────────
// GOOGLE_CLIENT_ID               https://console.cloud.google.com/apis/credentials/consent?project=YOUR_GCP_PROJECT{dev,prod}   ⚠ Dev/prod have SEPARATE clients. See block above GOOGLE_CONNECTOR_SCOPES for the full procedure.
// MICROSOFT_CLIENT_ID            https://entra.microsoft.com → Identity → Applications → App registrations            Azure AD tenant: <add tenant ID when known>. Multi-tenant app.
// SLACK_CLIENT_ID                https://api.slack.com/apps                                                            One Slack app per environment OK; redirect URIs differ dev vs prod.
// ATLASSIAN_CLIENT_ID            https://developer.atlassian.com/console/myapps                                        Same app covers Jira + Confluence (scopes differ).
// SALESFORCE_CLIENT_ID           https://login.salesforce.com → Setup → App Manager → External Client Apps             "Connected App" in Salesforce parlance.
// HUBSPOT_CLIENT_ID              https://developers.hubspot.com → "Apps"                                               One app per developer account.
// GITHUB_CLIENT_ID               https://github.com/settings/apps  (NOT /settings/developers/oauth-apps)               GitHub App, not OAuth App — different scopes, per-install permissions.
// ZENDESK_CLIENT_ID              https://<subdomain>.zendesk.com → Admin Center → Apps and integrations → Zendesk API  Per-customer-subdomain; OAuth app registered per partner workspace.
// INTERCOM_CLIENT_ID             https://app.intercom.com → Settings → Developers → "Your apps"                        (No env var — Intercom uses static OAuth via INTERCOM_* env vars if added.)
// LINEAR_CLIENT_ID               https://linear.app → Settings → API → OAuth applications                              Workspace-level dev settings.
// ASANA_CLIENT_ID                https://app.asana.com/0/my-apps                                                        Per-account dev console.
// NOTION_CLIENT_ID               https://www.notion.so/profile/integrations  AND  https://developers.notion.com         Notion currently used via DCR — env vars exist for the static fallback only.
// DROPBOX_CLIENT_ID              https://www.dropbox.com/developers/apps                                                Per-account dev console.
// BOX_CLIENT_ID                  https://app.box.com/developers/console                                                 Per-account dev console.
// ZOOM_CLIENT_ID                 https://marketplace.zoom.us → Develop → Build App                                     OAuth-type app.
// META_CLIENT_ID                 https://developers.facebook.com/apps                                                  ONE app covers Facebook, Instagram, WhatsApp, Threads.
// CALENDLY_CLIENT_ID             https://calendly.com/integrations/api_webhooks → OAuth apps                            Per-account.
// DATADOG_CLIENT_ID              https://app.datadoghq.com/personal-settings/oauth-apps                                 Datadog currently used via DCR — env vars are fallback.
// CLAY_CLIENT_ID                 (Clay uses DCR — no static app registration)                                          —
// GRANOLA_CLIENT_ID              (Granola uses DCR — no static app registration)                                       —
// DOCUSIGN_CLIENT_ID             https://admin.docusign.com → Apps and Keys  (sandbox: https://admindemo.docusign.com)  Promote-to-prod is explicit; sandbox + prod are separate apps.
// STRIPE_CONNECT_CLIENT_ID       https://dashboard.stripe.com/settings/connect/onboarding-options                       Stripe Connect app (read-only OAuth, not the regular API key).
// INTUIT_CLIENT_ID               https://developer.intuit.com → My Apps                                                 QuickBooks Online — same app handles sandbox + prod via separate keys.
// XERO_CLIENT_ID                 https://developer.xero.com/myapps                                                      Per-account dev console.
// GUSTO_CLIENT_ID                https://gusto.com/embedded-payroll  (partner program approval required)                Apply for partner status before app is provisioned.
// RIPPLING_CLIENT_ID             https://developer.rippling.com  (partner program approval required)                    Apply for partner status before app is provisioned.
// PAYPAL_CLIENT_ID               https://developer.paypal.com/dashboard                                                 Sandbox + Live apps are separate; both managed here.
// PIPEDRIVE_CLIENT_ID            https://developers.pipedrive.com  (OAuth app registration)                             Per-account, in beta.
// MARKETO_CLIENT_ID              https://developers.marketo.com                                                         Per-instance custom service in Marketo admin.
// OUTREACH_CLIENT_ID             https://developers.outreach.io                                                         Per-account dev console.
// SALESLOFT_CLIENT_ID            (salesloft uses DCR — no static app registration)                                    DCR: local-dev override only.
// LEVER_CLIENT_ID                https://hire.lever.co/developer/documentation  (self-serve OAuth app registration)     Coming_soon — no app registered yet.
// WORKABLE_CLIENT_ID             https://workable.readme.io/reference/oauth-flow  (self-serve OAuth app registration)   Coming_soon — no app registered yet.
// WORKDAY_CLIENT_ID              (per-customer-tenant — no shared OAuth app possible by Workday architecture)           Coming_soon — would require per-tenant onboarding flow.
// KLAVIYO_CLIENT_ID             (klaviyo uses DCR — no static app registration)                                           DCR: local-dev override only.
// KIT_CLIENT_ID                 (kit uses DCR — no static app registration)                                               DCR: local-dev override only.
// OMNISEND_CLIENT_ID            (omnisend uses DCR — no static app registration)                                          DCR: local-dev override only.
// AMPLITUDE_CLIENT_ID           (amplitude uses DCR — no static app registration)                                         DCR: local-dev override only.
// PENDO_CLIENT_ID               (pendo uses DCR — no static app registration)                                             DCR: local-dev override only.
// WEBFLOW_CLIENT_ID             (webflow uses DCR — no static app registration)                                           DCR: local-dev override only.
// TYPEFULLY_CLIENT_ID           (typefully uses DCR — no static app registration)                                         DCR: local-dev override only.
// CRUSTDATA_CLIENT_ID           (crustdata uses DCR — no static app registration)                                         DCR: local-dev override only.
// TAPFILIATE_CLIENT_ID          (tapfiliate uses DCR — no static app registration)                                        DCR: local-dev override only.
// PARTNERSTACK_CLIENT_ID        (partnerstack uses DCR — no static app registration)                                      DCR: local-dev override only.
// CROSSBEAM_CLIENT_ID           (crossbeam uses DCR — no static app registration)                                         DCR: local-dev override only.
// PADDLE_CLIENT_ID              (paddle uses DCR — no static app registration)                                            DCR: local-dev override only.
// SNOV_CLIENT_ID                (snov uses DCR — no static app registration)                                              DCR: local-dev override only.
// SPARKTORO_CLIENT_ID           (sparktoro uses DCR — no static app registration)                                         DCR: local-dev override only.
// LIVESTORM_CLIENT_ID           (livestorm uses DCR — no static app registration)                                         DCR: local-dev override only.
// COUPLER_CLIENT_ID             (coupler uses DCR — no static app registration)                                           DCR: local-dev override only.
// KEYWORDS_EVERYWHERE_CLIENT_ID (keywords_everywhere uses DCR — no static app registration)                               DCR: local-dev override only.
// DEMANDBASE_CLIENT_ID          (demandbase uses DCR — no static app registration)                                        DCR: local-dev override only.
//
// COMPOSIO_MANAGED is a sentinel value for Composio-managed connectors:
// no Liftoff-registered OAuth app — Composio handles OAuth on their end
// using their own client_id. See config/composio-resources.json for the
// per-toolkit auth_config and mcp_server IDs.
// ──────────────────────────────────────────────────────────────────────
export const OAUTH_PROVIDER_CONFIGS: Record<OAuthProvider, OAuthProviderConfig> =
  buildOAuthProviderConfigsFromRegistry();

// Canonical list of all known connector types — keys of CONNECTORS.
// Derived to keep ConnectorType union + registry in lockstep (enforced by
// the reverse-completeness test in catalog/__tests__/connectors.test.ts).
export const CONNECTOR_TYPES_LIST: ConnectorType[] = Object.keys(CONNECTORS) as ConnectorType[];
