// Liftoff Switch — source integration name to Liftoff catalog connector type.
//
// Used to classify a source integration into destination A (a Liftoff catalog
// connector to reconnect) rather than B (a customer-owned remote MCP server) or
// C (requires hosting). When the same capability exists both as a source MCP
// definition and as a catalog connector, the catalog connector wins: a
// reconnected Liftoff connection is governed and metered, a raw MCP endpoint is
// neither.
//
// This map is intentionally conservative. An unmapped name is reported as
// needing attention rather than guessed into a connector type: binding an agent
// to the wrong integration is worse than telling the user we did not recognise
// something. The server re-validates every type against the live catalog, so a
// name that maps here but is not currently connectable is reported as
// unsupported rather than becoming a Needs Reconnect card whose reconnect
// action cannot work.

export interface CatalogMapping {
  connectorType: string;
  /** Authorization method from Liftoff's catalog, when known locally. The
   *  server is authoritative and may correct this. */
  authMethod?: 'oauth' | 'api_key' | 'keypair' | 'iam_grant';
}

const MAP: Record<string, CatalogMapping> = {
  slack: { connectorType: 'slack', authMethod: 'oauth' },
  github: { connectorType: 'github', authMethod: 'oauth' },
  gitlab: { connectorType: 'gitlab', authMethod: 'oauth' },
  gmail: { connectorType: 'google_mail', authMethod: 'oauth' },
  'google-mail': { connectorType: 'google_mail', authMethod: 'oauth' },
  googlemail: { connectorType: 'google_mail', authMethod: 'oauth' },
  'google-drive': { connectorType: 'google_drive', authMethod: 'oauth' },
  googledrive: { connectorType: 'google_drive', authMethod: 'oauth' },
  gdrive: { connectorType: 'google_drive', authMethod: 'oauth' },
  'google-sheets': { connectorType: 'google_sheets', authMethod: 'oauth' },
  googlesheets: { connectorType: 'google_sheets', authMethod: 'oauth' },
  'google-calendar': { connectorType: 'google_calendar', authMethod: 'oauth' },
  googlecalendar: { connectorType: 'google_calendar', authMethod: 'oauth' },
  notion: { connectorType: 'notion', authMethod: 'oauth' },
  hubspot: { connectorType: 'hubspot', authMethod: 'oauth' },
  salesforce: { connectorType: 'salesforce', authMethod: 'oauth' },
  linear: { connectorType: 'linear', authMethod: 'oauth' },
  jira: { connectorType: 'jira', authMethod: 'oauth' },
  confluence: { connectorType: 'confluence', authMethod: 'oauth' },
  asana: { connectorType: 'asana', authMethod: 'oauth' },
  trello: { connectorType: 'trello', authMethod: 'oauth' },
  zendesk: { connectorType: 'zendesk', authMethod: 'oauth' },
  intercom: { connectorType: 'intercom', authMethod: 'oauth' },
  stripe: { connectorType: 'stripe', authMethod: 'api_key' },
  discord: { connectorType: 'discord', authMethod: 'oauth' },
  telegram: { connectorType: 'telegram', authMethod: 'api_key' },
  teams: { connectorType: 'microsoft_teams', authMethod: 'oauth' },
  'microsoft-teams': { connectorType: 'microsoft_teams', authMethod: 'oauth' },
  outlook: { connectorType: 'microsoft_outlook_mail', authMethod: 'oauth' },
  'outlook-mail': { connectorType: 'microsoft_outlook_mail', authMethod: 'oauth' },
  dropbox: { connectorType: 'dropbox', authMethod: 'oauth' },
  box: { connectorType: 'box', authMethod: 'oauth' },
  airtable: { connectorType: 'airtable', authMethod: 'oauth' },
  shopify: { connectorType: 'shopify', authMethod: 'oauth' },
};

/** Map a source integration or MCP server name to a Liftoff catalog connector.
 *  Returns null when there is no confident match. */
export function mapToCatalogConnector(sourceName: string): CatalogMapping | null {
  const key = sourceName.trim().toLowerCase().replace(/^mcp[:_-]/, '').replace(/[\s_]+/g, '-');
  if (MAP[key]) return MAP[key];

  // A bare suffix match handles names like "slack-bot" or "github-issues"
  // without guessing at arbitrary substrings.
  for (const [name, mapping] of Object.entries(MAP)) {
    if (key === `${name}-mcp` || key === `${name}-bot` || key.startsWith(`${name}-`)) {
      return mapping;
    }
  }

  return null;
}

/** Exposed for tests and for the review surface, which lists what the importer
 *  is able to recognise. */
export function knownConnectorTypes(): string[] {
  return [...new Set(Object.values(MAP).map((m) => m.connectorType))].sort();
}
