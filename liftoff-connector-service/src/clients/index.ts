// Connector client registry — executes at import time.
//
// This module is the wiring that makes Execute / ExecuteBatch work end-to-end.
// Each registerConnectorExecutor call maps one `connectorType` to a
// ConnectorExecutor that can serve every functionName in that connector's
// registry. The execute-dispatcher looks up the right executor at call time
// and invokes it with a fully-populated ExecutorContext (tenant id, config,
// credentials, the vendor input payload, etc.).
//
// Two executor factories are used:
//   - makeClientExecutor       — REST clients that take a CredentialProvider
//   - makeMCPClientExecutor    — MCP clients that take {tenantId, credentialStore}
//
// Each factory handles CRUD routing uniformly: it looks up the function in
// connector-functions-registry, infers read/create/update/delete, and forwards
// the payload to the typed client method.
//
// Why this is a side-effectful module: there is no central registry object
// for connectors. Rather than maintain an N-entry switch in execute-dispatcher
// and drift every time a connector is added, each client self-registers
// here. `import './clients/index.js'` at startup is enough to light the
// whole execution surface up.

import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { makeClientExecutor, makeMCPClientExecutor } from './adapter.js';

// REST clients (take a CredentialProvider closure — see adapter.ts).
import { SlackClient } from './slack.js';
import { SalesforceClient } from './salesforce.js';
import { GoogleCalendarClient } from './google-calendar.js';
import { GoogleMailClient } from './google-mail.js';
import { GoogleYouTubeClient } from './google-youtube.js';
import { GoogleAdsClient } from './google-ads.js';
import { GoogleSheetsClient } from './google-sheets.js';
import { GoogleDocsClient } from './google-docs.js';
import { GoogleDriveClient } from './google-drive.js';
import { GoogleSlidesClient } from './google-slides.js';
import { MicrosoftOneDriveClient } from './microsoft-onedrive.js';
import { MicrosoftOutlookMailClient } from './microsoft-outlook-mail.js';
import { MicrosoftOutlookCalendarClient } from './microsoft-outlook-calendar.js';
import { MicrosoftTeamsClient } from './microsoft-teams.js';
import { MicrosoftToDoClient } from './microsoft-todo.js';
import { MicrosoftContactsClient } from './microsoft-contacts.js';
import { MicrosoftOneNoteClient } from './microsoft-onenote.js';
import { MicrosoftSharePointClient } from './microsoft-sharepoint.js';
import { MicrosoftPlannerClient } from './microsoft-planner.js';
import { DropboxClient } from './dropbox.js';
import { BoxClient } from './box.js';
import { JiraClient } from './jira.js';
import { ConfluenceClient } from './confluence.js';
import { ZendeskClient } from './zendesk.js';
import { LinearClient } from './linear.js';
import { GitLabClient } from './gitlab.js';
import { PlaidClient } from './plaid.js';
type PlaidEnv = 'sandbox' | 'production';
import { MailchimpClient } from './mailchimp.js';
import { TrelloClient } from './trello.js';
import { AsanaClient } from './asana.js';
import { PipedriveClient } from './pipedrive.js';
import { SendGridClient } from './sendgrid.js';
import { SquareClient } from './square.js';
import { PayPalClient } from './paypal.js';
import { CalendlyClient } from './calendly.js';
import { CalComClient } from './cal-com.js';
import { WooCommerceClient } from './woocommerce.js';
import { BambooHRClient } from './bamboohr.js';
import { ElicitClient } from './elicit.js';
import { DocuSignClient } from './docusign.js';
import { AttioMCPClient } from './attio-mcp.js';
import { WorkdayClient } from './workday.js';
import { OracleHcmClient } from './oracle-hcm.js';
import { NamelyClient } from './namely.js';
import { SapSuccessFactorsClient } from './sap-successfactors.js';
// Native HRIS batch 2.
import { DeelClient } from './deel.js';
import { FactorialClient } from './factorial.js';
import { HiBobClient } from './hibob.js';
import { PersonioClient } from './personio.js';
import { UkgProClient } from './ukg-pro.js';
import { UkgReadyClient } from './ukg-ready.js';
import { DayforceClient } from './dayforce.js';
import { AdpClient } from './adp.js';
import { GustoClient } from './gusto.js';
import { RipplingClient } from './rippling.js';
import { WarpClient } from './warp.js';

// MCP clients (take tenantId + credentialStore — see adapter.ts).
import { StripeMCPClient } from './stripe-mcp.js';
import { HubSpotMCPClient } from './hubspot-mcp.js';
import { NotionMCPClient } from './notion-mcp.js';
import { ClayMCPClient } from './clay-mcp.js';
import { MeshMCPClient } from './mesh-mcp.js';
import { QuickBooksMCPClient } from './quickbooks-mcp.js';
import { XeroMCPClient } from './xero-mcp.js';
import { IntercomMCPClient } from './intercom-mcp.js';
import { SnowflakeMCPClient } from './snowflake-mcp.js';
import { DatabricksMCPClient } from './databricks-mcp.js';
import './bigquery.js'; // native BigQuery executor self-registers on import (plan §3C)
// Internal-tier data vendors — native executors self-register on import, and
// each falls back to the platform key when the connector instance carries no
// tenant credential (platform-funded default; see clients/platform-vendor-keys.ts).
import './tikhub.js';
import './strale.js';
import './defillama.js';
import './nasdaq.js';
import './ycombinator.js';
import './apify.js';
import './gloria-mcp.js';
import './saperly.js';
import './hunter.js';
import './pdl.js';
// x402 pay-per-call vendors — no credential at all; each call's 402 is paid
// from the platform wallet (src/x402/). gloria's premium lane and strale's
// keyless fallback lane pay the same way from their executors above.
import './google-trends.js';
import './browserbase-x402.js';
import './kadec0.js';
// Aggregator rungs — the platform's own prepaid account at a reseller of
// key-based vendors, funded like a platform key, behind a workspace's own
// key for the same need.
import './locus.js';
import './vaaya.js';
// An API a workspace described and connected from a conversation. One executor
// for the whole family: the operations, the hosts and the placement are read
// per instance off `custom_api_connectors`, so nothing about a particular
// provider is compiled in here.
import '../custom-api/executor.js';
import { GenericMCPClient } from './generic-mcp.js';
import { OmnisendMCPClient } from './omnisend-mcp.js';
import { ZoomMCPClient } from './zoom-mcp.js';
import { getMCPServerConfig } from '../catalog/mcp-server-registry.js';

// ──────────────────────────────────────────────────────────────────────
// REST connector wiring
// ──────────────────────────────────────────────────────────────────────

registerConnectorExecutor(
  'slack',
  makeClientExecutor('slack', (_ctx, cp) => new SlackClient(cp)),
);
registerConnectorExecutor(
  'salesforce',
  makeClientExecutor('salesforce', (_ctx, cp) => new SalesforceClient(cp)),
);
registerConnectorExecutor(
  'google_calendar',
  makeClientExecutor('google_calendar', (_ctx, cp) => new GoogleCalendarClient(cp)),
);
registerConnectorExecutor(
  'google_mail',
  makeClientExecutor('google_mail', (_ctx, cp) => new GoogleMailClient(cp)),
);
registerConnectorExecutor(
  'google_ads',
  makeClientExecutor('google_ads', (_ctx, cp) => new GoogleAdsClient(cp)),
);
registerConnectorExecutor(
  'google_sheets',
  makeClientExecutor('google_sheets', (_ctx, cp) => new GoogleSheetsClient(cp)),
);
registerConnectorExecutor(
  'google_docs',
  makeClientExecutor('google_docs', (_ctx, cp) => new GoogleDocsClient(cp)),
);
registerConnectorExecutor(
  'google_drive',
  makeClientExecutor('google_drive', (_ctx, cp) => new GoogleDriveClient(cp)),
);
registerConnectorExecutor(
  'google_slides',
  makeClientExecutor('google_slides', (_ctx, cp) => new GoogleSlidesClient(cp)),
);
registerConnectorExecutor(
  'youtube',
  makeClientExecutor('youtube', (_ctx, cp) => new GoogleYouTubeClient(cp)),
);

registerConnectorExecutor(
  'microsoft_onedrive',
  makeClientExecutor('microsoft_onedrive', (_ctx, cp) => new MicrosoftOneDriveClient(cp)),
);
registerConnectorExecutor(
  'microsoft_outlook_mail',
  makeClientExecutor('microsoft_outlook_mail', (_ctx, cp) => new MicrosoftOutlookMailClient(cp)),
);
registerConnectorExecutor(
  'microsoft_outlook_calendar',
  makeClientExecutor(
    'microsoft_outlook_calendar',
    (_ctx, cp) => new MicrosoftOutlookCalendarClient(cp),
  ),
);
registerConnectorExecutor(
  'microsoft_teams',
  makeClientExecutor('microsoft_teams', (_ctx, cp) => new MicrosoftTeamsClient(cp)),
);
registerConnectorExecutor(
  'microsoft_todo',
  makeClientExecutor('microsoft_todo', (_ctx, cp) => new MicrosoftToDoClient(cp)),
);
registerConnectorExecutor(
  'microsoft_contacts',
  makeClientExecutor('microsoft_contacts', (_ctx, cp) => new MicrosoftContactsClient(cp)),
);
registerConnectorExecutor(
  'microsoft_onenote',
  makeClientExecutor('microsoft_onenote', (_ctx, cp) => new MicrosoftOneNoteClient(cp)),
);
registerConnectorExecutor(
  'microsoft_sharepoint',
  makeClientExecutor('microsoft_sharepoint', (_ctx, cp) => new MicrosoftSharePointClient(cp)),
);
registerConnectorExecutor(
  'microsoft_planner',
  makeClientExecutor('microsoft_planner', (_ctx, cp) => new MicrosoftPlannerClient(cp)),
);

registerConnectorExecutor(
  'dropbox',
  makeClientExecutor('dropbox', (_ctx, cp) => new DropboxClient(cp)),
);
registerConnectorExecutor(
  'box',
  makeClientExecutor('box', (_ctx, cp) => new BoxClient(cp)),
);
registerConnectorExecutor(
  'atlassian_jira',
  makeClientExecutor('atlassian_jira', (_ctx, cp) => new JiraClient(cp)),
);
registerConnectorExecutor(
  'atlassian_confluence',
  makeClientExecutor('atlassian_confluence', (_ctx, cp) => new ConfluenceClient(cp)),
);
registerConnectorExecutor(
  'zendesk',
  makeClientExecutor('zendesk', (_ctx, cp) => new ZendeskClient(cp)),
);
registerConnectorExecutor(
  'linear',
  makeClientExecutor('linear', (_ctx, cp) => new LinearClient(cp)),
);
registerConnectorExecutor(
  'plaid',
  makeClientExecutor('plaid', (_ctx, cp) => {
    const env = (process.env.PLAID_ENV as PlaidEnv | undefined) ?? 'sandbox';
    return new PlaidClient(cp, env);
  }),
);
registerConnectorExecutor(
  'mailchimp',
  makeClientExecutor('mailchimp', (_ctx, cp) => new MailchimpClient(cp)),
);
registerConnectorExecutor(
  'trello',
  makeClientExecutor('trello', (_ctx, cp) => new TrelloClient(cp)),
);
registerConnectorExecutor(
  'asana',
  makeClientExecutor('asana', (_ctx, cp) => new AsanaClient(cp)),
);
registerConnectorExecutor(
  'pipedrive',
  makeClientExecutor('pipedrive', (_ctx, cp) => new PipedriveClient(cp)),
);
registerConnectorExecutor(
  'sendgrid',
  makeClientExecutor('sendgrid', (_ctx, cp) => new SendGridClient(cp)),
);
registerConnectorExecutor(
  'square',
  makeClientExecutor('square', (_ctx, cp) => new SquareClient(cp)),
);
registerConnectorExecutor(
  'paypal',
  makeClientExecutor('paypal', (_ctx, cp) => new PayPalClient(cp)),
);
registerConnectorExecutor(
  'calendly',
  makeClientExecutor('calendly', (_ctx, cp) => new CalendlyClient(cp)),
);
registerConnectorExecutor(
  'cal_com',
  makeClientExecutor('cal_com', (_ctx, cp) => new CalComClient(cp)),
);
registerConnectorExecutor(
  'woocommerce',
  makeClientExecutor('woocommerce', (_ctx, cp) => new WooCommerceClient(cp)),
);
registerConnectorExecutor(
  'bamboohr',
  makeClientExecutor('bamboohr', (_ctx, cp) => new BambooHRClient(cp)),
);
registerConnectorExecutor(
  'elicit',
  makeClientExecutor('elicit', (_ctx, cp) => new ElicitClient(cp)),
);
registerConnectorExecutor(
  'docusign',
  makeClientExecutor('docusign', (_ctx, cp) => new DocuSignClient(cp)),
);
// First-party native HRIS executors. Every HRIS connector is served by its own client.
// The credentialProvider closure yields the vaulted credential — an api_key for the
// direct-vault connectors, or the OAuth accessToken for the static_oauth ones
// (gusto/rippling/bamboohr).
registerConnectorExecutor('workday', makeClientExecutor('workday', (_ctx, cp) => new WorkdayClient(cp)));
registerConnectorExecutor('oracle_hcm', makeClientExecutor('oracle_hcm', (_ctx, cp) => new OracleHcmClient(cp)));
registerConnectorExecutor('namely', makeClientExecutor('namely', (_ctx, cp) => new NamelyClient(cp)));
registerConnectorExecutor('sap_successfactors', makeClientExecutor('sap_successfactors', (_ctx, cp) => new SapSuccessFactorsClient(cp)));
// adp_run + adp_workforce_now share one AdpClient (product identified by the type).
registerConnectorExecutor('deel', makeClientExecutor('deel', (_ctx, cp) => new DeelClient(cp)));
registerConnectorExecutor('factorial', makeClientExecutor('factorial', (_ctx, cp) => new FactorialClient(cp)));
registerConnectorExecutor('hibob', makeClientExecutor('hibob', (_ctx, cp) => new HiBobClient(cp)));
registerConnectorExecutor('personio', makeClientExecutor('personio', (_ctx, cp) => new PersonioClient(cp)));
registerConnectorExecutor('ukg_pro', makeClientExecutor('ukg_pro', (_ctx, cp) => new UkgProClient(cp)));
registerConnectorExecutor('ukg_ready', makeClientExecutor('ukg_ready', (_ctx, cp) => new UkgReadyClient(cp)));
registerConnectorExecutor('dayforce', makeClientExecutor('dayforce', (_ctx, cp) => new DayforceClient(cp)));
registerConnectorExecutor('adp_run', makeClientExecutor('adp_run', (_ctx, cp) => new AdpClient(cp, 'adp_run')));
registerConnectorExecutor('adp_workforce_now', makeClientExecutor('adp_workforce_now', (_ctx, cp) => new AdpClient(cp, 'adp_workforce_now')));
registerConnectorExecutor('gusto', makeClientExecutor('gusto', (_ctx, cp) => new GustoClient(cp)));
registerConnectorExecutor('rippling', makeClientExecutor('rippling', (_ctx, cp) => new RipplingClient(cp)));
registerConnectorExecutor('warp', makeClientExecutor('warp', (_ctx, cp) => new WarpClient(cp)));

// ──────────────────────────────────────────────────────────────────────
// MCP connector wiring
// ──────────────────────────────────────────────────────────────────────

registerConnectorExecutor(
  'stripe',
  makeMCPClientExecutor(
    'stripe',
    (args) =>
      new StripeMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'hubspot',
  makeMCPClientExecutor(
    'hubspot',
    (args) =>
      new HubSpotMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'gitlab',
  makeMCPClientExecutor(
    'gitlab',
    (args) =>
      new GitLabClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
      }),
  ),
);
registerConnectorExecutor(
  'attio',
  makeMCPClientExecutor(
    'attio',
    (args) =>
      new AttioMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'notion',
  makeMCPClientExecutor(
    'notion',
    (args) =>
      new NotionMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'clay',
  makeMCPClientExecutor(
    'clay',
    (args) =>
      new ClayMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);

registerConnectorExecutor(
  'mesh',
  makeMCPClientExecutor(
    'mesh',
    (args) =>
      new MeshMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'quickbooks',
  makeMCPClientExecutor(
    'quickbooks',
    (args) =>
      new QuickBooksMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'xero',
  makeMCPClientExecutor(
    'xero',
    (args) =>
      new XeroMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'intercom',
  makeMCPClientExecutor(
    'intercom',
    (args) =>
      new IntercomMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);
registerConnectorExecutor(
  'snowflake',
  makeMCPClientExecutor(
    'snowflake',
    (args) => {
      if (!args.connectorConfig) {
        throw new Error(
          'Snowflake MCP requires connectorConfig (accountIdentifier, username)',
        );
      }
      return new SnowflakeMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        connectorConfig: args.connectorConfig,
        correlationId: args.correlationId,
      });
    },
  ),
);
registerConnectorExecutor(
  'databricks',
  makeMCPClientExecutor(
    'databricks',
    (args) => {
      if (!args.connectorConfig) {
        throw new Error('Databricks MCP requires connectorConfig (workspaceUrl)');
      }
      return new DatabricksMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        connectorConfig: args.connectorConfig,
        correlationId: args.correlationId,
      });
    },
  ),
);

// ──────────────────────────────────────────────────────────────────────
// Generic MCP connector wiring — for MCP-only connector types that do not
// have a dedicated client class (github, datadog, sentry, etc).
// ──────────────────────────────────────────────────────────────────────

function genericMCPExecutor(connectorType: string) {
  return makeMCPClientExecutor(connectorType, (args) => {
    const cfg = getMCPServerConfig(connectorType, args.connectorConfig);
    if (!cfg) {
      throw new Error(`No MCP server configuration for connector type "${connectorType}"`);
    }
    return new GenericMCPClient({
      tenantId: args.tenantId,
      connectorType,
      mcpUrl: cfg.mcpUrl,
      credentialStore: args.credentialStore,
      correlationId: args.correlationId,
    });
  });
}

registerConnectorExecutor('github', genericMCPExecutor('github'));
registerConnectorExecutor('datadog', genericMCPExecutor('datadog'));
registerConnectorExecutor('sentry', genericMCPExecutor('sentry'));
registerConnectorExecutor('granola', genericMCPExecutor('granola'));

// Marketing connectors on vendor-hosted MCP. The generic client
// is the browse tier for a vendor-hosted server without a bespoke client: a
// picker asking for a Klaviyo list or a Salesloft cadence is answered by the
// server's own enumerating tool (mcp-entity-list.ts), which is what
// browse-coverage.test.ts demands of every connectable destination.
for (const type of [
  'klaviyo', 'kit', 'amplitude', 'pendo', 'webflow', 'typefully', 'crustdata',
  'tapfiliate', 'partnerstack', 'crossbeam', 'paddle', 'salesloft', 'snov', 'sparktoro',
  'livestorm', 'coupler', 'keywords_everywhere', 'tolt', 'demandbase',
]) {
  registerConnectorExecutor(type, genericMCPExecutor(type));
}
// omnisend is a meta-tool server (search / tool_schema / tool_documentation /
// execute); its operations are discovered one level down. See omnisend-mcp.ts.
registerConnectorExecutor(
  'omnisend',
  makeMCPClientExecutor('omnisend', (args) => {
    const cfg = getMCPServerConfig('omnisend', args.connectorConfig);
    if (!cfg) throw new Error('No MCP server configuration for connector type "omnisend"');
    return new OmnisendMCPClient({
      tenantId: args.tenantId,
      mcpUrl: cfg.mcpUrl,
      credentialStore: args.credentialStore,
      correlationId: args.correlationId,
    });
  }),
);
registerConnectorExecutor(
  'zoom',
  makeMCPClientExecutor(
    'zoom',
    (args) =>
      new ZoomMCPClient({
        tenantId: args.tenantId,
        credentialStore: args.credentialStore,
        correlationId: args.correlationId,
      }),
  ),
);

// Re-export the client types for callers that want to construct clients
// manually (e.g. tests).
export * from './types.js';
export { SlackClient } from './slack.js';
export { SalesforceClient } from './salesforce.js';
export { GoogleCalendarClient } from './google-calendar.js';
export { GoogleMailClient } from './google-mail.js';
export { GoogleYouTubeClient } from './google-youtube.js';
export { GoogleAdsClient } from './google-ads.js';
export { GoogleSheetsClient } from './google-sheets.js';
export { GoogleDocsClient } from './google-docs.js';
export { GoogleDriveClient } from './google-drive.js';
export { GoogleSlidesClient } from './google-slides.js';
export { MicrosoftOneDriveClient } from './microsoft-onedrive.js';
export { MicrosoftOutlookMailClient } from './microsoft-outlook-mail.js';
export { MicrosoftOutlookCalendarClient } from './microsoft-outlook-calendar.js';
export { MicrosoftTeamsClient } from './microsoft-teams.js';
export { MicrosoftToDoClient } from './microsoft-todo.js';
export { MicrosoftContactsClient } from './microsoft-contacts.js';
export { MicrosoftOneNoteClient } from './microsoft-onenote.js';
export { MicrosoftSharePointClient } from './microsoft-sharepoint.js';
export { MicrosoftPlannerClient } from './microsoft-planner.js';
export { DropboxClient } from './dropbox.js';
export { BoxClient } from './box.js';
export { StripeMCPClient } from './stripe-mcp.js';
export { HubSpotMCPClient } from './hubspot-mcp.js';
export { NotionMCPClient } from './notion-mcp.js';
export { ClayMCPClient } from './clay-mcp.js';
export { MeshMCPClient } from './mesh-mcp.js';
export { QuickBooksMCPClient } from './quickbooks-mcp.js';
export { XeroMCPClient } from './xero-mcp.js';
export { SnowflakeMCPClient } from './snowflake-mcp.js';
export { DatabricksMCPClient } from './databricks-mcp.js';
export { IntercomMCPClient } from './intercom-mcp.js';
export { PlaidClient } from './plaid.js';
export { MailchimpClient } from './mailchimp.js';
export { TrelloClient } from './trello.js';
export { AsanaClient } from './asana.js';
export { PipedriveClient } from './pipedrive.js';
export { SendGridClient } from './sendgrid.js';
export { SquareClient } from './square.js';
export { PayPalClient } from './paypal.js';
export { CalendlyClient } from './calendly.js';
export { CalComClient } from './cal-com.js';
export { WooCommerceClient } from './woocommerce.js';
export { BambooHRClient } from './bamboohr.js';
export { ElicitClient } from './elicit.js';
export { DocuSignClient } from './docusign.js';
export { GustoClient, RipplingClient };
export { AttioClient } from './attio.js';
export { AttioMCPClient } from './attio-mcp.js';
export { GenericMCPClient } from './generic-mcp.js';
export { OmnisendMCPClient } from './omnisend-mcp.js';
export { ZoomMCPClient } from './zoom-mcp.js';
export { ZoomClient } from './zoom.js';
