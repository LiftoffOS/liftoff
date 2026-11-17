// Connector Normalizers Index
// Per Section 12: Normalized records are written into tenant Cloud SQL

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { SalesforceNormalizer } from './salesforce';
import { HubSpotNormalizer } from './hubspot';
import { SlackNormalizer } from './slack';
import { JiraNormalizer } from './jira';
import { ZendeskNormalizer } from './zendesk';
import { IntercomNormalizer } from './intercom';
import { GitHubNormalizer } from './github';
import { LinearNormalizer } from './linear';
import { GoogleCalendarNormalizer } from './google-calendar.normalizer';
import { GoogleDriveNormalizer } from './google-drive.normalizer';
import { GoogleMailNormalizer } from './google-mail.normalizer';
import { GoogleContactsNormalizer } from './google-contacts.normalizer';
import { GoogleTasksNormalizer } from './google-tasks.normalizer';
import { MicrosoftOneDriveNormalizer } from './microsoft-onedrive.normalizer';
import { MicrosoftOutlookMailNormalizer } from './microsoft-outlook-mail.normalizer';
import { MicrosoftOutlookCalendarNormalizer } from './microsoft-outlook-calendar.normalizer';
import { MicrosoftTeamsNormalizer } from './microsoft-teams.normalizer';
import { MicrosoftToDoNormalizer } from './microsoft-todo.normalizer';
import { MicrosoftContactsNormalizer } from './microsoft-contacts.normalizer';
import { MicrosoftOneNoteNormalizer } from './microsoft-onenote.normalizer';
import { MicrosoftSharePointNormalizer } from './microsoft-sharepoint.normalizer';
import { MicrosoftPlannerNormalizer } from './microsoft-planner.normalizer';
import { DropboxNormalizer } from './dropbox.normalizer';
import { BoxNormalizer } from './box.normalizer';

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
];

for (const normalizer of allNormalizers) {
  normalizers.set(normalizer.connectorType, normalizer);
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

export * from './types';
export {
  SalesforceNormalizer,
  HubSpotNormalizer,
  SlackNormalizer,
  JiraNormalizer,
  ZendeskNormalizer,
  IntercomNormalizer,
  GitHubNormalizer,
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
};
