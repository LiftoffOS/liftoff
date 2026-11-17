// Connector Normalizers Index
// Per Section 12: Normalized records are written into tenant Cloud SQL

import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { registerConnectorEntitySchemas } from '../catalog/connector-entity-schemas.js';
import { SalesforceNormalizer } from './salesforce.js';
import { HubSpotNormalizer } from './hubspot.js';
import { SlackNormalizer } from './slack.js';
import { JiraNormalizer } from './jira.js';
import { ZendeskNormalizer } from './zendesk.js';
import { IntercomNormalizer } from './intercom.js';
import { GitHubNormalizer } from './github.js';
import { GitLabNormalizer } from './gitlab.js';
import { LinearNormalizer } from './linear.js';
import { GoogleCalendarNormalizer } from './google-calendar.normalizer.js';
import { GoogleDriveNormalizer } from './google-drive.normalizer.js';
import { GoogleMailNormalizer } from './google-mail.normalizer.js';
import { GoogleContactsNormalizer } from './google-contacts.normalizer.js';
import { GoogleTasksNormalizer } from './google-tasks.normalizer.js';
import { MicrosoftOneDriveNormalizer } from './microsoft-onedrive.normalizer.js';
import { MicrosoftOutlookMailNormalizer } from './microsoft-outlook-mail.normalizer.js';
import { MicrosoftOutlookCalendarNormalizer } from './microsoft-outlook-calendar.normalizer.js';
import { MicrosoftTeamsNormalizer } from './microsoft-teams.normalizer.js';
import { MicrosoftToDoNormalizer } from './microsoft-todo.normalizer.js';
import { MicrosoftContactsNormalizer } from './microsoft-contacts.normalizer.js';
import { MicrosoftOneNoteNormalizer } from './microsoft-onenote.normalizer.js';
import { MicrosoftSharePointNormalizer } from './microsoft-sharepoint.normalizer.js';
import { MicrosoftPlannerNormalizer } from './microsoft-planner.normalizer.js';
import { DropboxNormalizer } from './dropbox.normalizer.js';
import { BoxNormalizer } from './box.normalizer.js';
import { GranolaNormalizer } from './granola.normalizer.js';
import { ZoomNormalizer } from './zoom.normalizer.js';
import { GongNormalizer } from './gong.normalizer.js';
import { WooCommerceNormalizer } from './woocommerce.normalizer.js';
import { BambooHRNormalizer } from './bamboohr.normalizer.js';
import { AsanaNormalizer } from './asana.normalizer.js';
import { CalendlyNormalizer } from './calendly.normalizer.js';
import { SendGridNormalizer } from './sendgrid.normalizer.js';
import { NotionNormalizer } from './notion.normalizer.js';
import { PayPalNormalizer } from './paypal.normalizer.js';
import { AttioNormalizer } from './attio.normalizer.js';
import { StripeNormalizer } from './stripe.normalizer.js';
import { SentryNormalizer } from './sentry.normalizer.js';
import { PipedriveNormalizer } from './pipedrive.normalizer.js';
import { CloseNormalizer } from './close.normalizer.js';
// datadog/apollo/folk normalizers migrated to the generic spec path below.
import { COMPOSIO_POLL_SPECS } from '../polling/composio-poll-spec.js';
import { ComposioGenericNormalizer } from './composio-generic.normalizer.js';

// Registry of all connector normalizers
const normalizers: Map<string, ConnectorNormalizer> = new Map();

// Register all normalizers
const allNormalizers: ConnectorNormalizer[] = [
  new SalesforceNormalizer(),
  new HubSpotNormalizer(),
  new SlackNormalizer(),
  new JiraNormalizer(),
  new ZendeskNormalizer(),
  new IntercomNormalizer(),
  new GitHubNormalizer(),
  new GitLabNormalizer(),
  new LinearNormalizer(),
  new GoogleCalendarNormalizer(),
  new GoogleDriveNormalizer(),
  new GoogleMailNormalizer(),
  new GoogleContactsNormalizer(),
  new GoogleTasksNormalizer(),
  new MicrosoftOneDriveNormalizer(),
  new MicrosoftOutlookMailNormalizer(),
  new MicrosoftOutlookCalendarNormalizer(),
  new MicrosoftTeamsNormalizer(),
  new MicrosoftToDoNormalizer(),
  new MicrosoftContactsNormalizer(),
  new MicrosoftOneNoteNormalizer(),
  new MicrosoftSharePointNormalizer(),
  new MicrosoftPlannerNormalizer(),
  new DropboxNormalizer(),
  new BoxNormalizer(),
  new GranolaNormalizer(),
  new ZoomNormalizer(),
  new GongNormalizer(),
  new WooCommerceNormalizer(),
  new BambooHRNormalizer(),
  new AsanaNormalizer(),
  new CalendlyNormalizer(),
  new SendGridNormalizer(),
  new NotionNormalizer(),
  new PayPalNormalizer(),
  new AttioNormalizer(),
  new StripeNormalizer(),
  new SentryNormalizer(),
  new PipedriveNormalizer(),
  new CloseNormalizer(),
];

for (const normalizer of allNormalizers) {
  normalizers.set(normalizer.connectorType, normalizer);
  // Boot-time registration of each normalizer's per-entity JSON Schemas.
  // CONNECTOR_ENTITY_SCHEMAS feeds /api/connectors/catalog (so platform-backend
  // can ship real field surfaces to the distill prompt) and the distill-time
  // structural analyzer in platform-backend (so predicates against undeclared
  // fields are rejected). The ConnectorNormalizer interface now requires
  // entitySchemas, so any new normalizer is registered automatically.
  registerConnectorEntitySchemas(normalizer.connectorType, normalizer.entitySchemas);
}

// Generic spec-driven normalizers: one ComposioGenericNormalizer per connector
// with a ComposioPollSpec (datadog/apollo/folk + all Phase-2 connectors). Its
// entity schemas are derived from the spec's `fields`, so distill predicates
// still see real field paths — no bespoke normalizer needed.
for (const spec of Object.values(COMPOSIO_POLL_SPECS)) {
  const gen = new ComposioGenericNormalizer(spec);
  normalizers.set(gen.connectorType, gen);
  registerConnectorEntitySchemas(gen.connectorType, gen.entitySchemas);
}

// The catalog connector type is `atlassian_jira`, but the Jira normalizer
// historically registered under `jira`. getNormalizer() and the entity-schema
// registry are keyed by connector type, so a reactive Jira subscription
// (connectorRef "atlassian_jira") resolved no normalizer and no entity schemas,
// silently breaking Jira polling and reactive-predicate validation. Alias both
// under the catalog key while keeping `jira` for back-compat.
const jiraNormalizer = normalizers.get('jira');
if (jiraNormalizer) {
  normalizers.set('atlassian_jira', jiraNormalizer);
  registerConnectorEntitySchemas('atlassian_jira', jiraNormalizer.entitySchemas);
}

// The Outlook normalizers emit entityType 'Message'/'Event' (their internal
// convention), but the catalog polls — and the clients key on — 'Email'/
// 'CalendarEvent'. publishPollingEvent stamps the loop entityType, so events are
// published as 'Email'/'CalendarEvent' with NO registered schema (it lived under
// 'Message'/'Event'), making distill reject predicates on the served entity.
// Alias the message/event schema under the polled entityType (merge, keeps the
// originals). The schema content is identical — a Message IS the Email payload.
const outlookMailNormalizer = normalizers.get('microsoft_outlook_mail');
if (outlookMailNormalizer?.entitySchemas['Message']) {
  registerConnectorEntitySchemas('microsoft_outlook_mail', { Email: outlookMailNormalizer.entitySchemas['Message'] });
}
const outlookCalNormalizer = normalizers.get('microsoft_outlook_calendar');
if (outlookCalNormalizer?.entitySchemas['Event']) {
  registerConnectorEntitySchemas('microsoft_outlook_calendar', { CalendarEvent: outlookCalNormalizer.entitySchemas['Event'] });
}

export function getNormalizer(connectorType: string): ConnectorNormalizer | undefined {
  return normalizers.get(connectorType.toLowerCase());
}

export function normalizePayload(connectorType: string, payload: unknown): NormalizedRecord[] {
  const normalizer = getNormalizer(connectorType);
  if (!normalizer) {
    throw new Error(`No normalizer found for connector type: ${connectorType}`);
  }
  return normalizer.normalize(payload);
}

export function getSupportedConnectorTypes(): string[] {
  return Array.from(normalizers.keys());
}

export * from './types.js';
export {
  SalesforceNormalizer,
  HubSpotNormalizer,
  SlackNormalizer,
  JiraNormalizer,
  ZendeskNormalizer,
  IntercomNormalizer,
  GitHubNormalizer,
  GitLabNormalizer,
  LinearNormalizer,
  GoogleCalendarNormalizer,
  GoogleDriveNormalizer,
  GoogleMailNormalizer,
  GoogleContactsNormalizer,
  GoogleTasksNormalizer,
  MicrosoftOneDriveNormalizer,
  MicrosoftOutlookMailNormalizer,
  MicrosoftOutlookCalendarNormalizer,
  MicrosoftTeamsNormalizer,
  MicrosoftToDoNormalizer,
  MicrosoftContactsNormalizer,
  MicrosoftOneNoteNormalizer,
  MicrosoftSharePointNormalizer,
  MicrosoftPlannerNormalizer,
  DropboxNormalizer,
  BoxNormalizer,
  GranolaNormalizer,
  ZoomNormalizer,
};
