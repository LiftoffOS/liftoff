import type { HarvestEvent } from './types';

const ENTITY_TYPE_BLOCKLIST = new Set([
  'Contact', 'ContactGroup', 'ContactFolder',
  'CalendarEvent', 'Calendar', 'CalendarNotification',
  'Task', 'TaskList', 'Plan', 'Bucket',
  'Folder', 'DeletedItem', 'SharedDrive', 'DriveNotification',
  'Label', 'User', 'Membership', 'Team', 'Channel',
  'MailFolder', 'EmailLabel', 'EmailRef', 'EmailThreadRef',
  'EmailHistory', 'EmailNotification', 'Reaction', 'Event',
]);

const TEXT_FIELDS = ['text', 'body', 'content', 'description', 'summary',
                     'notes', 'title', 'subject', 'message', 'transcript'];

const TEXT_MIME_PREFIXES = [
  'text/', 'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation', 'application/vnd.openxmlformats',
  'application/msword', 'application/vnd.ms-',
];

const MIN_HARVEST_LENGTH = parseInt(process.env.MIN_HARVEST_LENGTH ?? '150', 10);

/**
 * Pull text fields out of the event payload in a stable order, joining
 * non-empty string values. Returns null when the concatenated text is
 * shorter than MIN_HARVEST_LENGTH (not enough signal for the LLM).
 */
export function extractText(event: HarvestEvent): string | null {
  const parts: string[] = [];
  for (const field of TEXT_FIELDS) {
    const value = event.data[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      parts.push(value.trim());
    }
  }
  if (parts.length === 0) return null;
  const combined = parts.join('\n\n');
  if (combined.length < MIN_HARVEST_LENGTH) return null;
  return combined;
}

/**
 * Three-stage pre-filter:
 *   1. entity-type blocklist (calendar, contacts, etc — never harvest-worthy)
 *   2. text-extraction floor (skip records below MIN_HARVEST_LENGTH)
 *   3. mime-type allowlist when the payload declares one (skip binaries)
 */
export function shouldAttemptClassification(event: HarvestEvent): boolean {
  if (ENTITY_TYPE_BLOCKLIST.has(event.entityType)) return false;

  if (extractText(event) === null) return false;

  const mimeType = event.data.mimeType;
  if (typeof mimeType === 'string') {
    const ok = TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
    if (!ok) return false;
  }

  return true;
}
