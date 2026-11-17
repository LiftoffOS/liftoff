// Canonical Liftoff response shape per stable tool name + canonical error
// mapping. Both native dispatch and Composio dispatch produce identical
// shapes per <toolkit>.<stableName> key, so agents see one shape regardless
// of source. The dispatcher validates every response post-translateOutput
// against the registered Zod schema and throws canonical_shape_violation
// on mismatch.

import { z } from 'zod';
import type { NormalizedToolError } from './types';

// ── Building blocks ──────────────────────────────────────────────────────

const paginatedList = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextPageToken: z.string().optional(),
  });

// Common item shapes reused across toolkits.
/**
 * A listed Gmail message, PROJECTED — not the raw MIME.
 *
 * This used to be `payload: z.unknown()`, which passed Gmail's entire message
 * structure through: base64 bodies, every part, and the full `Received:` header
 * chain, per message, for up to `max_results` messages. Listing 25 messages
 * could return hundreds of thousands of characters to carry one short
 * question.
 *
 * That is not free. The result becomes the step's output, blows the 8 KB
 * step-output budget, gets offloaded to a file in the run workspace, and the
 * next step then needs a tool call to read its own predecessor's value back —
 * which can lead an agent to ask a human for permission to run Python against
 * a file under `/workspace/run-values/`.
 *
 * Slack's shape next door was already projected (ts, user, text, channel).
 * Gmail was the outlier, and a listing is a listing: enough to decide which
 * message matters. The full body is what `get_thread` and `read_message` are
 * for.
 */
const gmailMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  date: z.string().optional(),
  /** Gmail's own short preview, or the first line of the decoded text body. */
  snippet: z.string().optional(),
});

/**
 * A message returned by a READ — get_message, get_thread, read_thread.
 *
 * Carries the decoded body, unlike `gmailMessage` (a listing, which carries a
 * snippet). What it does not carry is the transport: base64 encoding, the MIME
 * tree, the HTML duplicate of every text part, and the `Received:` chain.
 *
 * Without this projection each of the three typically returns tens of
 * thousands of characters, above the 8 KB step-output budget on a typical
 * call, so reading a thread pushes the step over the limit, offloads it to a
 * file, and forces the NEXT step to fetch its own predecessor's value back out
 * of the workspace with a tool call.
 */
const gmailFullMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  date: z.string().optional(),
  /** Decoded text body, bounded, with truncation stated inline when it applies. */
  body: z.string().optional(),
  /** Filenames only — never attachment content. */
  attachments: z.array(z.string()).optional(),
});

const slackMessage = z.object({
  ts: z.string(),
  user: z.string().optional(),
  text: z.string().optional(),
  channel: z.string(),
});

// ── Canonical response shapes ────────────────────────────────────────────

/** Keyed `<toolkit>.<stableName>` (e.g. 'gmail.list_messages'). */
/** A projected calendar event: Google's two-shaped times flattened to strings. */
const calendarEvent = z.object({
  id: z.string(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  attendees: z.array(z.object({ email: z.string(), responseStatus: z.string() })),
});

/** A Drive file resource, id anchored and everything else preserved. */
const driveFile = z.object({ id: z.string() }).passthrough();
const driveFileList = z.object({
  // Composio declares `files` nullable, so an empty result is null rather than
  // an empty array. Both mean "no files", and neither is an error.
  files: z.array(driveFile).nullish(),
}).passthrough();

export const CANONICAL_RESPONSE_SHAPES = {
  // ── gmail ──
  'gmail.list_messages': paginatedList(gmailMessage),
  'gmail.send_email': z.object({ id: z.string(), threadId: z.string() }),
  'gmail.mark_as_read': z.object({ id: z.string(), labelIds: z.array(z.string()) }),
  'gmail.create_draft': z.object({ id: z.string(), message: z.unknown().optional() }),
  'gmail.reply_to_thread': z.object({ id: z.string(), threadId: z.string() }),
  'gmail.get_profile': z.object({ emailAddress: z.string() }).passthrough(),
  'gmail.list_labels': paginatedList(z.object({ id: z.string(), name: z.string() }).passthrough()),
  'gmail.list_threads': paginatedList(z.object({ id: z.string() }).passthrough()),
  'gmail.get_thread': z.object({ id: z.string(), messages: z.array(gmailFullMessage).optional() }),
  'gmail.get_message': gmailFullMessage,
  'gmail.search_contacts': paginatedList(z.object({ resourceName: z.string() }).passthrough()),
  'gmail.delete_message': z.object({ id: z.string() }).passthrough(),
  'gmail.trash_message': z.object({ id: z.string() }).passthrough(),
  'gmail.create_label': z.object({ id: z.string(), name: z.string() }).passthrough(),
  'gmail.delete_label': z.object({ id: z.string() }).passthrough(),
  'gmail.read_thread': z.object({ items: z.array(gmailFullMessage) }),

  // ── slack ──
  'slack.list_messages': paginatedList(slackMessage),
  'slack.send_message': z.object({ ts: z.string(), channel: z.string() }),
  'slack.add_reaction': z.object({ ok: z.boolean() }).passthrough(),
  'slack.list_channels': paginatedList(z.object({ id: z.string(), name: z.string() }).passthrough()),
  'slack.read_thread': paginatedList(z.object({ id: z.string(), user: z.string(), text: z.string() })),

  // ── jira ──
  'jira.list_issues': paginatedList(z.object({
    id: z.string(),
    key: z.string(),
    summary: z.string(),
    status: z.string(),
    assignee: z.string().optional(),
    priority: z.string().optional(),
  })),
  'jira.get_issue': z.object({ id: z.string(), key: z.string() }).passthrough(),
  'jira.create_issue': z.object({ id: z.string(), key: z.string() }),
  'jira.transition_issue': z.unknown(),
  'jira.update_issue': z.unknown(),
  'jira.add_comment': z.unknown(),
  'jira.list_transitions': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), toStatus: z.string() })) }),
  'jira.delete_issue': z.unknown(),
  'jira.list_projects': z.object({ items: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })) }),
  'jira.assign_issue': z.unknown(),
  'jira.read_comments': z.object({ items: z.array(z.object({ id: z.string(), body: z.string() }).passthrough()) }),

  // ── outlook ──
  'outlook.list_messages': paginatedList(z.object({
    id: z.string(),
    threadId: z.string(),
    payload: z.object({ subject: z.string(), bodyPreview: z.string(), from: z.string() }).passthrough(),
  })),
  'outlook.get_message': z.object({ id: z.string() }).passthrough(),
  'outlook.send_message': z.unknown(),
  'outlook.reply_to_message': z.unknown(),
  'outlook.create_draft': z.unknown(),
  'outlook.mark_as_read': z.unknown(),
  'outlook.delete_message': z.unknown(),
  'outlook.move_message': z.unknown(),
  'outlook.list_folders': z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }),
  'outlook.read_conversation': z.object({ items: z.array(z.object({ id: z.string(), subject: z.string(), bodyPreview: z.string() }).passthrough()) }),

  // ── pagerduty ──
  'pagerduty.list_incidents': paginatedList(z.object({
    id: z.string(),
    number: z.number(),
    title: z.string(),
    status: z.string(),
    urgency: z.string(),
    service: z.string(),
  })),
  'pagerduty.get_incident': z.object({ id: z.string() }).passthrough(),
  'pagerduty.acknowledge_incident': z.unknown(),
  'pagerduty.resolve_incident': z.unknown(),
  'pagerduty.create_incident': z.object({ id: z.string(), number: z.number() }),
  'pagerduty.add_note': z.unknown(),
  'pagerduty.list_services': z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }),
  'pagerduty.list_oncalls': z.object({ items: z.array(z.object({ userId: z.string(), userName: z.string(), scheduleName: z.string(), start: z.string(), end: z.string() })) }),

  // ── googlecalendar ──
  //
  // These shapes are reached through the overlay's translateOutput, which
  // flattens Google's resources out of Composio's wrappers. Composio returns
  // `calendars` where Google's reference says `items`, and nests a created
  // event under `response_data`; the projection is what makes one shape hold
  // for both dispatch sources, and the entries below are what it must produce.
  'googlecalendar.list_events': paginatedList(calendarEvent),
  'googlecalendar.find_event': paginatedList(calendarEvent),
  'googlecalendar.get_event': z.object({ id: z.string() }).passthrough(),
  'googlecalendar.get_calendar': z.object({
    id: z.string(),
    name: z.string(),
    timeZone: z.string().optional(),
  }),
  'googlecalendar.create_event': z.object({ id: z.string(), htmlLink: z.string() }),
  'googlecalendar.quick_add_event': z.object({ id: z.string(), htmlLink: z.string() }),
  'googlecalendar.update_event': z.object({ id: z.string(), htmlLink: z.string() }),
  'googlecalendar.delete_event': z.unknown(),
  'googlecalendar.list_calendars': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), primary: z.boolean() })) }),
  'googlecalendar.query_free_busy': z.object({ busyByCalendar: z.record(z.array(z.object({ start: z.string(), end: z.string() }))) }),
  'googlecalendar.respond_to_event': z.unknown(),

  // ── googledrive ──
  'googledrive.list_files': paginatedList(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), modifiedTime: z.string() })),
  'googledrive.get_file': z.object({ id: z.string() }).passthrough(),
  'googledrive.download_file': z.unknown(),
  'googledrive.upload_file': z.object({ id: z.string(), webViewLink: z.string() }),
  'googledrive.create_folder': z.object({ id: z.string(), name: z.string() }),
  'googledrive.delete_file': z.unknown(),
  'googledrive.copy_file': z.unknown(),
  'googledrive.share_file': z.unknown(),
  'googledrive.search_files': paginatedList(z.object({ id: z.string(), name: z.string(), mimeType: z.string() })),
  // Drive needs no projection: Composio already returns Google's own file
  // resources, id-bearing, under `files` or at the top level. So these entries
  // anchor the provenance path and pass everything else through — a narrow
  // shape here would STRIP the fields it does not name, since validation
  // returns the parsed value, and an agent would lose file names to a schema
  // that was only meant to check one of them.
  'googledrive.find_file': driveFileList,
  'googledrive.find_folder': driveFileList,
  'googledrive.get_file_metadata': driveFile,
  'googledrive.create_file': driveFile,
  'googledrive.create_file_from_text': driveFile,
  'googledrive.edit_file': driveFile,

  // googledocs / googlesheets: no projection, so these anchor the provenance
  // path and pass everything else through. A narrow shape here would STRIP the
  // fields it does not name, since validation returns the parsed value.
  'googledocs.search_documents': z.object({
    documents: z.array(z.object({ id: z.string() }).passthrough()).nullish(),
  }).passthrough(),
  // Both creates: the overlay's translateOutput reads the id from
  // `document_id`, from `documentId` or from `response_data.documentId`,
  // because the toolkit's versions put it in different places (the runtime
  // calls `latest`, which answers `documentId` alone). The shape then holds
  // the NORMALISED value to a string, so a create that returned none is still
  // a violation. `create_document` used to be registered as `{ id, title }`,
  // keys the vendor never declared, which passed only because that key was
  // never dispatched with a shape check.
  'googledocs.create_document': z.object({ document_id: z.string() }).passthrough(),
  'googledocs.create_document_markdown': z.object({ document_id: z.string() }).passthrough(),
  'googledocs.replace_all_text': z.object({ document_id: z.string() }).passthrough(),
  // copy and insert_table answer in camelCase where the rest of the toolkit
  // uses snake_case. Read from each tool's own schema, not from its neighbour.
  'googledocs.copy_document': z.object({ documentId: z.string() }).passthrough(),
  'googledocs.insert_table': z.object({ documentId: z.string() }).passthrough(),

  'googlesheets.search_spreadsheets': z.object({
    spreadsheets: z.array(z.object({ id: z.string() }).passthrough()).nullish(),
  }).passthrough(),
  'googlesheets.get_spreadsheet_info': z.object({
    response_data: z.object({ spreadsheetId: z.string() }).passthrough(),
  }).passthrough(),
  'googlesheets.create_row': z.object({
    spreadsheet: z.object({ spreadsheetId: z.string() }).passthrough(),
  }).passthrough(),
  'googlesheets.batch_update_values': z.object({ spreadsheetId: z.string() }).passthrough(),

  // ── googledocs ──
  'googledocs.get_document': z.unknown(),
  'googledocs.insert_text': z.unknown(),
  'googledocs.replace_text': z.unknown(),
  'googledocs.batch_update': z.unknown(),
  'googledocs.export_document': z.unknown(),

  // ── googlesheets ──
  'googlesheets.create_spreadsheet': z.object({ id: z.string(), url: z.string() }),
  'googlesheets.get_spreadsheet': z.unknown(),
  'googlesheets.read_values': z.object({ range: z.string(), values: z.array(z.array(z.unknown())) }),
  'googlesheets.write_values': z.unknown(),
  'googlesheets.append_values': z.unknown(),
  'googlesheets.clear_values': z.unknown(),
  'googlesheets.add_sheet': z.unknown(),
  'googlesheets.batch_update': z.unknown(),

  // ── googleslides ──
  'googleslides.create_presentation': z.object({ id: z.string(), title: z.string() }),
  'googleslides.get_presentation': z.unknown(),
  'googleslides.batch_update': z.unknown(),
  'googleslides.replace_all_text': z.unknown(),
  'googleslides.export_presentation': z.unknown(),

  // ── dropbox ──
  'dropbox.list_folder': paginatedList(z.object({ id: z.string(), name: z.string(), kind: z.string(), path: z.string() })),
  'dropbox.get_metadata': z.unknown(),
  'dropbox.download_file': z.unknown(),
  'dropbox.upload_file': z.object({ id: z.string(), path: z.string() }),
  'dropbox.create_folder': z.unknown(),
  'dropbox.delete': z.unknown(),
  'dropbox.move': z.unknown(),
  'dropbox.copy': z.unknown(),
  'dropbox.search': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })) }),
  'dropbox.create_shared_link': z.object({ url: z.string() }),

  // ── confluence ──
  'confluence.list_pages': paginatedList(z.object({ id: z.string(), title: z.string(), spaceKey: z.string() })),
  'confluence.get_page': z.unknown(),
  'confluence.create_page': z.object({ id: z.string(), title: z.string() }),
  'confluence.update_page': z.unknown(),
  'confluence.delete_page': z.unknown(),
  'confluence.add_comment': z.unknown(),
  'confluence.list_spaces': z.object({ items: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })) }),

  // ── trello ──
  'trello.list_cards': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), desc: z.string(), due: z.string(), listId: z.string(), closed: z.boolean() })) }),
  'trello.get_card': z.unknown(),
  'trello.create_card': z.object({ id: z.string(), shortUrl: z.string() }),
  'trello.update_card': z.unknown(),
  'trello.move_card': z.unknown(),
  'trello.delete_card': z.unknown(),
  'trello.add_comment': z.unknown(),
  'trello.list_boards': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), url: z.string() })) }),
  'trello.list_board_lists': z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }),

  // ── airtable ──
  'airtable.list_records': paginatedList(z.object({ id: z.string(), fields: z.record(z.unknown()), createdTime: z.string() })),
  'airtable.get_record': z.unknown(),
  'airtable.create_records': z.object({ items: z.array(z.object({ id: z.string(), fields: z.record(z.unknown()) })) }),
  'airtable.update_record': z.unknown(),
  'airtable.delete_record': z.unknown(),
  'airtable.list_bases': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), permissionLevel: z.string() })) }),
  'airtable.list_tables': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), primaryFieldId: z.string(), fieldCount: z.number() })) }),

  // ── bitbucket ──
  'bitbucket.list_repositories': paginatedList(z.object({ id: z.string(), name: z.string(), fullName: z.string(), slug: z.string() })),
  'bitbucket.get_repository': z.unknown(),
  'bitbucket.list_pull_requests': paginatedList(z.object({ id: z.number(), title: z.string(), state: z.string(), url: z.string() })),
  'bitbucket.get_pull_request': z.unknown(),
  'bitbucket.create_pull_request': z.unknown(),
  'bitbucket.merge_pull_request': z.unknown(),
  'bitbucket.comment_on_pull_request': z.unknown(),
  'bitbucket.list_issues': paginatedList(z.object({ id: z.number(), title: z.string(), state: z.string(), url: z.string() })),

  // ── cal_com ──
  'cal_com.list_bookings': paginatedList(z.object({ id: z.string(), uid: z.string(), title: z.string(), startTime: z.string(), endTime: z.string(), status: z.string() })),
  'cal_com.get_booking': z.unknown(),
  'cal_com.create_booking': z.object({ id: z.string(), uid: z.string() }),
  'cal_com.cancel_booking': z.unknown(),
  'cal_com.reschedule_booking': z.unknown(),
  'cal_com.list_event_types': z.object({ items: z.array(z.object({ id: z.number(), title: z.string(), slug: z.string(), durationMinutes: z.number() })) }),
  'cal_com.query_available_slots': z.object({ items: z.array(z.object({ time: z.string() })) }),

  // ── canva ──
  'canva.list_designs': paginatedList(z.object({ id: z.string(), title: z.string(), thumbnailUrl: z.string() })),
  'canva.get_design': z.unknown(),
  'canva.create_design': z.object({ id: z.string(), editUrl: z.string() }),
  'canva.export_design': z.object({ jobId: z.string(), status: z.string(), urls: z.array(z.string()) }),
  'canva.get_export_status': z.object({ jobId: z.string(), status: z.string(), urls: z.array(z.string()) }),
  'canva.list_folders': paginatedList(z.object({ id: z.string(), name: z.string() }).passthrough()),
  'canva.upload_asset': z.unknown(),

  // ── discord ──
  'discord.list_guilds': z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }),
  'discord.list_channels': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), type: z.number() })) }),
  'discord.list_messages': z.object({ items: z.array(slackMessage) }),
  'discord.send_message': z.object({ ts: z.string(), channel: z.string() }),
  'discord.add_reaction': z.unknown(),
  'discord.delete_message': z.unknown(),
  'discord.edit_message': z.unknown(),

  // ── facebook ──
  'facebook.list_pages': paginatedList(z.object({ id: z.string(), name: z.string(), category: z.string() })),
  'facebook.get_page': z.unknown(),
  'facebook.list_posts': paginatedList(z.object({ id: z.string(), message: z.string(), createdAt: z.string(), url: z.string() })),
  'facebook.create_post': z.object({ id: z.string() }),
  'facebook.delete_post': z.unknown(),
  'facebook.list_post_comments': paginatedList(z.object({ id: z.string(), message: z.string(), fromId: z.string(), fromName: z.string(), createdAt: z.string() })),
  'facebook.reply_to_comment': z.unknown(),

  // ── figma ──
  'figma.get_file': z.unknown(),
  'figma.get_nodes': z.unknown(),
  'figma.get_images': z.object({ imageUrlByNodeId: z.record(z.string()) }),
  'figma.list_comments': z.object({ items: z.array(z.object({ id: z.string(), message: z.string(), userId: z.string(), handle: z.string(), createdAt: z.string() })) }),
  'figma.post_comment': z.unknown(),
  'figma.delete_comment': z.unknown(),
  'figma.list_project_files': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), lastModified: z.string(), thumbnailUrl: z.string() })) }),

  // ── freshbooks ──
  'freshbooks.list_invoices': paginatedList(z.object({ id: z.string(), number: z.string(), status: z.string(), amount: z.string(), customerId: z.string() })),
  'freshbooks.get_invoice': z.unknown(),
  'freshbooks.create_invoice': z.unknown(),
  'freshbooks.send_invoice': z.unknown(),
  'freshbooks.list_clients': z.object({ items: z.array(z.object({ id: z.string(), organization: z.string(), email: z.string(), firstName: z.string(), lastName: z.string() })) }),
  'freshbooks.create_client': z.unknown(),
  'freshbooks.list_payments': z.object({ items: z.array(z.object({ id: z.string(), amount: z.string(), date: z.string(), type: z.string() })) }),

  // ── gong ──
  'gong.list_calls': paginatedList(z.object({ id: z.string(), title: z.string(), scheduled: z.string(), started: z.string(), durationSeconds: z.number(), primaryUserId: z.string() })),
  'gong.get_call': z.unknown(),
  'gong.get_call_transcript': z.object({ items: z.array(z.unknown()) }),
  'gong.list_users': paginatedList(z.object({ id: z.string(), email: z.string(), firstName: z.string(), lastName: z.string(), title: z.string() })),
  'gong.list_call_recordings': z.object({ items: z.array(z.object({ id: z.string(), url: z.string() })) }),
  'gong.list_deal_insights': paginatedList(z.object({ id: z.string(), name: z.string(), engagementScore: z.number(), sentiment: z.string() })),

  // ── google_ads ──
  'google_ads.list_campaigns': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), channelType: z.string() })) }),
  'google_ads.get_campaign': z.unknown(),
  'google_ads.create_campaign': z.unknown(),
  'google_ads.update_campaign_status': z.unknown(),
  'google_ads.run_report': z.object({ rows: z.array(z.unknown()) }),
  'google_ads.list_ad_groups': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })) }),
  'google_ads.list_customers': z.object({ items: z.array(z.object({ id: z.string(), resourceName: z.string() })) }),

  // ── instagram ──
  'instagram.get_user': z.unknown(),
  'instagram.list_media': paginatedList(z.object({ id: z.string(), caption: z.string(), mediaType: z.string(), mediaUrl: z.string(), permalink: z.string(), timestamp: z.string() })),
  'instagram.get_media': z.unknown(),
  'instagram.create_media': z.object({ creationId: z.string() }),
  'instagram.publish_media': z.object({ mediaId: z.string() }),
  'instagram.list_comments': paginatedList(z.object({ id: z.string(), text: z.string(), username: z.string(), timestamp: z.string() })),
  'instagram.reply_to_comment': z.unknown(),

  // ── linkedin ──
  'linkedin.get_profile': z.unknown(),
  'linkedin.list_organizations': z.object({ items: z.array(z.object({ organizationUrn: z.string(), role: z.string() })) }),
  'linkedin.create_post': z.object({ id: z.string() }),
  'linkedin.list_organization_posts': paginatedList(z.object({ id: z.string(), createdAt: z.string() })),
  'linkedin.get_post': z.unknown(),
  'linkedin.delete_post': z.unknown(),
  'linkedin.list_comments': z.object({ items: z.array(z.object({ id: z.string(), actor: z.string(), text: z.string(), createdAt: z.string() })) }),
  'linkedin.create_comment': z.unknown(),

  // ── mailchimp ──
  'mailchimp.list_audiences': paginatedList(z.object({ id: z.string(), name: z.string(), memberCount: z.number() })),
  'mailchimp.get_audience': z.unknown(),
  'mailchimp.list_members': paginatedList(z.object({ id: z.string(), email: z.string(), status: z.string(), mergeFields: z.record(z.unknown()) })),
  'mailchimp.add_member': z.unknown(),
  'mailchimp.remove_member': z.unknown(),
  'mailchimp.list_campaigns': paginatedList(z.object({ id: z.string(), title: z.string(), subject: z.string(), status: z.string(), sendTime: z.string() })),
  'mailchimp.create_campaign': z.unknown(),
  'mailchimp.send_campaign': z.unknown(),

  // ── dynamics365 ──
  'dynamics365.list_leads': paginatedList(z.object({ id: z.string(), subject: z.string(), firstName: z.string(), lastName: z.string(), email: z.string(), company: z.string(), statusCode: z.number() })),
  'dynamics365.get_lead': z.unknown(),
  'dynamics365.create_lead': z.unknown(),
  'dynamics365.update_lead': z.unknown(),
  'dynamics365.list_contacts': z.object({ items: z.array(z.object({ id: z.string(), firstName: z.string(), lastName: z.string(), email: z.string(), accountId: z.string() })) }),
  'dynamics365.create_contact': z.unknown(),
  'dynamics365.list_accounts': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), industryCode: z.number(), email: z.string() })) }),
  'dynamics365.list_opportunities': z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), estimatedValue: z.number(), stateCode: z.number(), statusCode: z.number() })) }),

  // ── square ──
  'square.list_payments': paginatedList(z.object({ id: z.string(), amount: z.number(), currency: z.string(), status: z.string(), createdAt: z.string(), receiptUrl: z.string() })),
  'square.get_payment': z.unknown(),
  'square.refund_payment': z.unknown(),
  'square.list_customers': paginatedList(z.object({ id: z.string(), givenName: z.string(), familyName: z.string(), email: z.string(), phone: z.string() })),
  'square.create_customer': z.unknown(),
  'square.list_orders': paginatedList(z.object({ id: z.string(), total: z.number(), currency: z.string(), state: z.string(), createdAt: z.string() })),
  'square.list_catalog_items': paginatedList(z.object({ id: z.string(), type: z.string(), name: z.string(), description: z.string() })),

  // ── typeform ──
  'typeform.list_forms': paginatedList(z.object({ id: z.string(), title: z.string(), url: z.string() })),
  'typeform.get_form': z.unknown(),
  'typeform.create_form': z.unknown(),
  'typeform.delete_form': z.unknown(),
  'typeform.list_responses': paginatedList(z.object({ id: z.string(), submittedAt: z.string(), answers: z.array(z.unknown()) })),
  'typeform.list_webhooks': z.object({ items: z.array(z.object({ id: z.string(), tag: z.string(), url: z.string(), enabled: z.boolean() })) }),
  'typeform.create_webhook': z.unknown(),

  // ── whatsapp ──
  'whatsapp.send_text_message': z.object({ id: z.string() }),
  'whatsapp.send_template_message': z.unknown(),
  'whatsapp.send_media_message': z.unknown(),
  'whatsapp.mark_message_read': z.unknown(),
  'whatsapp.list_phone_numbers': z.object({ items: z.array(z.object({ id: z.string(), displayPhoneNumber: z.string(), verifiedName: z.string() })) }),
  'whatsapp.list_templates': paginatedList(z.object({ id: z.string(), name: z.string(), status: z.string(), language: z.string(), category: z.string() })),

  // ── youtube ──
  'youtube.search_videos': paginatedList(z.object({ id: z.string(), title: z.string(), channel: z.string(), publishedAt: z.string(), description: z.string() })),
  'youtube.get_video': z.unknown(),
  'youtube.list_channel_videos': paginatedList(z.object({ id: z.string(), title: z.string(), publishedAt: z.string() })),
  'youtube.list_comment_threads': paginatedList(z.object({ id: z.string(), text: z.string(), author: z.string(), publishedAt: z.string() })),
  'youtube.reply_to_comment': z.unknown(),
  'youtube.get_channel': z.unknown(),
  'youtube.list_playlists': paginatedList(z.object({ id: z.string(), title: z.string(), description: z.string() })),

  // ── google_search_console ──
  // Passthrough overlay: the canonical shape is Composio's `data` object. Only
  // the fields provenance reads are named; everything else passes through, and
  // the named ones are optional so a response the vendor trims does not fail
  // the shape check and take the whole call with it.
  'google_search_console.list_sites': z.object({
    siteEntry: z.array(z.object({ siteUrl: z.string() }).passthrough()).optional(),
  }).passthrough(),
  'google_search_console.get_site': z.object({ siteUrl: z.string().optional() }).passthrough(),

  // ── reddit_ads ──
  // Passthrough overlay: the Reddit Ads API wraps every body in `data`.
  'reddit_ads.list_campaigns': z.object({
    data: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  }).passthrough(),
  'reddit_ads.get_campaign': z.object({ data: z.object({ id: z.string() }).passthrough().optional() }).passthrough(),
  'reddit_ads.create_campaign': z.object({ data: z.object({ id: z.string() }).passthrough().optional() }).passthrough(),
  'reddit_ads.list_saved_audiences': z.object({
    data: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  }).passthrough(),
  'reddit_ads.create_saved_audience': z.object({ data: z.object({ id: z.string() }).passthrough().optional() }).passthrough(),
} as const;

export type CanonicalKey = keyof typeof CANONICAL_RESPONSE_SHAPES;

// ── Canonical errors ─────────────────────────────────────────────────────

export function normalizedError(
  code: NormalizedToolError['code'],
  message: string,
  retryable: boolean,
  vendorPayload?: unknown,
  retryAfterMs?: number,
): NormalizedToolError {
  const err = new Error(message) as NormalizedToolError;
  err.code = code;
  err.retryable = retryable;
  if (vendorPayload !== undefined) err.vendorPayload = vendorPayload;
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

/** Best-effort extraction of a vendor Retry-After hint from a Composio error
 *  payload. Returns milliseconds. Retry-After headers are seconds by
 *  convention, so *_after (without the _ms suffix) fields are scaled ×1000.
 *  Returns undefined when the vendor gave no hint (the safe default). */
function extractRetryAfterMs(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.retryAfterMs === 'number') return d.retryAfterMs;
  if (typeof d.retry_after_ms === 'number') return d.retry_after_ms;
  if (typeof d.retryAfter === 'number') return d.retryAfter * 1000;
  if (typeof d.retry_after === 'number') return d.retry_after * 1000;
  return undefined;
}

export function defaultComposioErrorMap(
  err: { code: number; message: string; data?: unknown },
): NormalizedToolError {
  if (err.code === -32401 || /auth|unauthor|401|invalid.token/i.test(err.message)) {
    return normalizedError('auth_expired', err.message, false, err);
  }
  if (err.code === -32429 || /rate.?limit|429|too.many/i.test(err.message)) {
    return normalizedError('rate_limited', err.message, true, err, extractRetryAfterMs(err.data));
  }
  if (err.code === -32404 || /not.found|404/i.test(err.message)) {
    return normalizedError('not_found', err.message, false, err);
  }
  if (err.code === -32403 || /forbidden|permission.denied|403/i.test(err.message)) {
    return normalizedError('permission_denied', err.message, false, err);
  }
  if ((err.code >= -32099 && err.code <= -32000) || /invalid.argument|bad.request|400/i.test(err.message)) {
    return normalizedError('invalid_arguments', err.message, false, err);
  }
  if (err.code === -32503 || /unavailable|503|temporarily/i.test(err.message)) {
    return normalizedError('vendor_unavailable', err.message, true, err);
  }
  return normalizedError('internal_error', err.message, false, err);
}
