// Connector Functions Registry
// Central source of truth for all connector function definitions.
// Used by the subscriber (runtime provisioning) and seed migrations.
//
// To add history-reading to a connector (existing or new):
//   1. Add historyReads to its definition in catalog/connectors.ts
//   2. Implement case '<entityType>' in the client's read() method
//   Done — the tool appears in getConnectorFunctions() automatically.
//
// Do NOT add read_<history> entries manually to the FUNCTIONS arrays below.

import type { ConnectorFunction } from '../types.js';
import { CONNECTORS } from './connectors.js';
import type { ConnectorHistoryConfig } from './connectors.js';
// Composio cutover-completion (C3): boot-time merge of @liftoffos/composio-overlays
// into CONNECTOR_FUNCTIONS. See the merge block at the bottom of this file
// for the actual mutation; imports stay top-of-file.
import {
  COMPOSIO_TOOL_SCHEMAS,
  COMPOSIO_TOOL_OVERLAYS,
  COMPOSIO_HISTORY_MAPPINGS,
  agentFacingInputSchema,
} from '@liftoffos/composio-overlays';
import {
  shouldSwitchoverComposioToNative,
  shouldForceComposio,
  isNativeHrisConnector,
} from './source-overrides.js';
import { TIKHUB_FUNCTIONS } from './generated/tikhub.js';
import { STRALE_FUNCTIONS } from './generated/strale.js';
import { CRUNCHBASE_FUNCTIONS } from './generated/crunchbase.js';
import { CONTACTOUT_FUNCTIONS } from './generated/contactout.js';
import { GLORIA_FUNCTIONS } from './generated/gloria.js';
import { SAPERLY_FUNCTIONS } from './generated/saperly.js';
import { HUNTER_FUNCTIONS } from './generated/hunter.js';
import { PDL_FUNCTIONS } from './generated/pdl.js';
import { DEFILLAMA_FUNCTIONS } from './generated/defillama.js';
import { NASDAQ_FUNCTIONS } from './generated/nasdaq.js';
import { YCOMBINATOR_FUNCTIONS } from './generated/ycombinator.js';
import { APIFY_FUNCTIONS } from './generated/apify.js';
import { GOOGLE_TRENDS_FUNCTIONS } from './generated/google-trends.js';
import { BROWSERBASE_X402_FUNCTIONS } from './generated/browserbase-x402.js';
import { KADEC0_FUNCTIONS } from './generated/kadec0.js';
import { LOCUS_FUNCTIONS } from './generated/locus.js';
import { LOCUS_PARSE_FUNCTIONS } from './generated/locus-parse.js';
import { VAAYA_FUNCTIONS } from './generated/vaaya.js';
import { ALIBABA_FUNCTIONS, BYTEDANCE_FUNCTIONS, MINIMAX_FUNCTIONS } from './generated/media-gen.js';
import { applyReviewedIdArgs } from './reviewed-id-args.js';

// ─── Google Ads ──────────────────────────────────────────────────────────────

const GOOGLE_ADS_FUNCTIONS: ConnectorFunction[] = [
  // ── Campaigns ──────────────────────────────────────────────────────────────
  {
    name: 'read_campaign',
    description: 'Read a Google Ads campaign by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign ID in format "{customerId}/{campaignId}"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'campaign',
  },
  {
    name: 'list_campaigns',
    description: 'List campaigns for a Google Ads customer account',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Google Ads customer ID' },
        status: { type: 'string', description: 'Filter by status: ENABLED, PAUSED, or REMOVED' },
      },
      required: ['customerId'],
    },
    categories: ['read'],
    entityType: 'campaign',
  },
  {
    name: 'create_campaign',
    description: 'Create a new Google Ads campaign',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Google Ads customer ID' },
        name: { type: 'string', description: 'Campaign name' },
        status: { type: 'string', description: 'Campaign status: ENABLED or PAUSED' },
        advertisingChannelType: { type: 'string', description: 'Channel type: SEARCH, DISPLAY, SHOPPING, VIDEO, etc.' },
        startDate: { type: 'string', description: 'Start date in YYYYMMDD format' },
        endDate: { type: 'string', description: 'End date in YYYYMMDD format (optional)' },
        campaignBudget: { type: 'string', description: 'Resource name of the campaign budget' },
      },
      required: ['customerId', 'name', 'advertisingChannelType', 'campaignBudget'],
    },
    // 'outbound' so the tenant-runtime catalog filter gates this under
    // communication='draft'. A Google Ads campaign publishes ads to the
    // public — under draft policy, agents must HITL-approve before
    // creating one. Google Ads has no draft endpoint, so the HITL
    // approval (via HitlGateError) is the correct fallback.
    categories: ['write', 'outbound'],
    entityType: 'campaign',
  },
  {
    name: 'update_campaign',
    description: 'Update settings for an existing Google Ads campaign',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign ID in format "{customerId}/{campaignId}"' },
        name: { type: 'string', description: 'New campaign name' },
        status: { type: 'string', description: 'New status: ENABLED or PAUSED' },
        endDate: { type: 'string', description: 'New end date in YYYYMMDD format' },
      },
      required: ['id'],
    },
    // 'outbound' so the tenant-runtime catalog filter gates this under
    // communication='draft' — same rationale as create_campaign.
    // Modifying a live campaign changes what the public sees.
    categories: ['write', 'outbound'],
    entityType: 'campaign',
  },
  {
    name: 'pause_campaign',
    description: 'Pause a Google Ads campaign',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign ID in format "{customerId}/{campaignId}"' },
      },
      required: ['id'],
    },
    // 'outbound' — pausing a live campaign stops public ads. Under
    // draft policy this should require human approval like enable.
    categories: ['write', 'outbound'],
    entityType: 'campaign',
  },
  {
    name: 'enable_campaign',
    description: 'Enable a paused Google Ads campaign',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign ID in format "{customerId}/{campaignId}"' },
      },
      required: ['id'],
    },
    // 'outbound' — enabling a campaign starts public ads running.
    // Same rationale as create_campaign.
    categories: ['write', 'outbound'],
    entityType: 'campaign',
  },
  {
    name: 'remove_campaign',
    description: 'Remove (delete) a Google Ads campaign',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign ID in format "{customerId}/{campaignId}"' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'campaign',
  },
  // ── Ad Groups ──────────────────────────────────────────────────────────────
  {
    name: 'read_ad_group',
    description: 'Read a Google Ads ad group by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ad group ID in format "{customerId}/{adGroupId}"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'ad_group',
  },
  {
    name: 'list_ad_groups',
    description: 'List ad groups for a Google Ads campaign',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Google Ads customer ID' },
        campaignId: { type: 'string', description: 'Filter by campaign ID' },
        status: { type: 'string', description: 'Filter by status: ENABLED, PAUSED, or REMOVED' },
      },
      required: ['customerId'],
    },
    categories: ['read'],
    entityType: 'ad_group',
  },
  {
    name: 'create_ad_group',
    description: 'Create a new ad group within a Google Ads campaign',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Google Ads customer ID' },
        campaignId: { type: 'string', description: 'Parent campaign ID' },
        name: { type: 'string', description: 'Ad group name' },
        status: { type: 'string', description: 'Ad group status: ENABLED or PAUSED' },
        type: { type: 'string', description: 'Ad group type: SEARCH_STANDARD, DISPLAY_STANDARD, etc.' },
        cpcBidMicros: { type: 'string', description: 'Default CPC bid in micros (1 USD = 1,000,000 micros)' },
      },
      required: ['customerId', 'campaignId', 'name'],
    },
    categories: ['write'],
    entityType: 'ad_group',
  },
  {
    name: 'update_ad_group',
    description: 'Update settings for an existing Google Ads ad group',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ad group ID in format "{customerId}/{adGroupId}"' },
        name: { type: 'string', description: 'New ad group name' },
        status: { type: 'string', description: 'New status: ENABLED or PAUSED' },
        cpcBidMicros: { type: 'string', description: 'New default CPC bid in micros' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'ad_group',
  },
  // ── Keywords ──────────────────────────────────────────────────────────────
  {
    name: 'read_keyword',
    description: 'Read a Google Ads keyword by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Keyword ID in format "{customerId}/{adGroupId}~{criterionId}"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'keyword',
  },
  {
    name: 'list_keywords',
    description: 'List keywords for a Google Ads ad group',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Google Ads customer ID' },
        adGroupId: { type: 'string', description: 'Filter by ad group ID' },
        status: { type: 'string', description: 'Filter by status: ENABLED, PAUSED, or REMOVED' },
      },
      required: ['customerId'],
    },
    categories: ['read'],
    entityType: 'keyword',
  },
  {
    name: 'create_keyword',
    description: 'Add a keyword to a Google Ads ad group',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Google Ads customer ID' },
        adGroupId: { type: 'string', description: 'Ad group ID to add the keyword to' },
        text: { type: 'string', description: 'Keyword text' },
        matchType: { type: 'string', description: 'Match type: BROAD, PHRASE, or EXACT' },
        status: { type: 'string', description: 'Keyword status: ENABLED or PAUSED' },
      },
      required: ['customerId', 'adGroupId', 'text', 'matchType'],
    },
    categories: ['write'],
    entityType: 'keyword',
  },
  {
    name: 'update_keyword',
    description: 'Update status or bid for a Google Ads keyword',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Keyword ID in format "{customerId}/{adGroupId}~{criterionId}"' },
        status: { type: 'string', description: 'New status: ENABLED or PAUSED' },
        cpcBidMicros: { type: 'string', description: 'New CPC bid override in micros' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'keyword',
  },
  {
    name: 'remove_keyword',
    description: 'Remove a keyword from a Google Ads ad group',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Keyword ID in format "{customerId}/{adGroupId}~{criterionId}"' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'keyword',
  },
  // ── Reporting ─────────────────────────────────────────────────────────────
  {
    name: 'get_performance_report',
    description: 'Get campaign performance metrics (impressions, clicks, cost, conversions) for the last 30 days',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Customer ID to report on (can equal customerId)' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'performance_report',
  },
  {
    name: 'list_budgets',
    description: 'List all campaign budgets for a Google Ads customer account',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Customer ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'campaign_budgets',
  },
  {
    name: 'create_budget',
    description: 'Create a new campaign budget in Google Ads',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Google Ads customer ID' },
        name: { type: 'string', description: 'Budget name' },
        amount_usd: { type: 'number', description: 'Daily budget amount in USD' },
        delivery_method: { type: 'string', description: '"STANDARD" (default) or "ACCELERATED"' },
      },
      required: ['customer_id', 'name', 'amount_usd'],
    },
    categories: ['write'],
    entityType: 'campaign_budget',
  },
  {
    name: 'update_budget',
    description: 'Update an existing Google Ads campaign budget',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Budget resource ID as "customerId/budgetId"' },
        name: { type: 'string', description: 'New budget name' },
        amount_usd: { type: 'number', description: 'New daily budget amount in USD' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'campaign_budget',
  },
];

// ─── Google Mail ─────────────────────────────────────────────────────────────

const GOOGLE_MAIL_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'send_email',
    description: 'Send a new email via Gmail',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Optional. Send From this verified Send-as alias on the connected Gmail account. Omit to send as the account\'s primary address.' },
        to: { type: 'string', description: 'Recipient email address (or comma-separated addresses)' },
        cc: { type: 'string', description: 'CC recipient(s)' },
        bcc: { type: 'string', description: 'BCC recipient(s)' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body content' },
        contentType: { type: 'string', description: '"text" (default) or "html"' },
        threadId: { type: 'string', description: 'Gmail thread ID to group with an existing conversation' },
      },
      required: ['to', 'subject', 'body'],
    },
    categories: ['write', 'outbound'],
    draftVariant: 'google-mail__create_draft',
    entityType: 'message',
  },
  {
    name: 'reply_email',
    description: 'Reply to an existing email thread in Gmail',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Optional. Send From this verified Send-as alias on the connected Gmail account. Omit to send as the account\'s primary address.' },
        to: { type: 'string', description: 'Recipient email address(es)' },
        cc: { type: 'string', description: 'CC recipient(s)' },
        bcc: { type: 'string', description: 'BCC recipient(s)' },
        subject: { type: 'string', description: 'Email subject (typically "Re: ...")' },
        body: { type: 'string', description: 'Reply body content' },
        contentType: { type: 'string', description: '"text" (default) or "html"' },
        messageId: { type: 'string', description: 'Message-ID of the email being replied to' },
        threadId: { type: 'string', description: 'Gmail thread ID' },
      },
      required: ['to', 'subject', 'body', 'messageId', 'threadId'],
    },
    categories: ['write', 'outbound'],
    draftVariant: 'google-mail__create_draft',
    entityType: 'reply',
  },
  {
    name: 'forward_email',
    description: 'Forward an email to another recipient via Gmail',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Optional. Send From this verified Send-as alias on the connected Gmail account. Omit to send as the account\'s primary address.' },
        to: { type: 'string', description: 'Recipient to forward the email to' },
        cc: { type: 'string', description: 'CC recipient(s)' },
        bcc: { type: 'string', description: 'BCC recipient(s)' },
        subject: { type: 'string', description: 'Email subject (typically "Fwd: ...")' },
        body: { type: 'string', description: 'Body content including the forwarded message' },
        contentType: { type: 'string', description: '"text" (default) or "html"' },
        threadId: { type: 'string', description: 'Original thread ID' },
      },
      required: ['to', 'subject', 'body'],
    },
    categories: ['write', 'outbound'],
    draftVariant: 'google-mail__create_draft',
    entityType: 'forward',
  },
  {
    name: 'create_draft',
    description: 'Create a draft email in Gmail without sending it',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address(es)' },
        cc: { type: 'string', description: 'CC recipient(s)' },
        bcc: { type: 'string', description: 'BCC recipient(s)' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body content' },
        contentType: { type: 'string', description: '"text" (default) or "html"' },
        threadId: { type: 'string', description: 'Thread ID if this draft is a reply' },
      },
      required: ['subject', 'body'],
    },
    categories: ['write'],
    entityType: 'draft',
  },
  {
    name: 'read_email',
    description: 'Read a specific Gmail message by ID, returning decoded subject, body, sender, recipients, and metadata',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message ID to read' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'message',
  },
  {
    name: 'search',
    description: 'Search for emails in Gmail using Gmail search syntax',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail search query (e.g., "from:alice@co.com subject:invoice is:unread")' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'search',
  },
  {
    name: 'delete_email',
    description: 'Delete an email from Gmail (moves to trash, recoverable for 30 days)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message ID to delete' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'message',
  },
  {
    name: 'list_labels',
    description: 'List all Gmail labels (inbox, sent, custom labels, etc.)',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'labels',
  },
  {
    name: 'read_label',
    description: 'Read a single Gmail label by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Label ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'label',
  },
  {
    name: 'list_messages',
    description: 'List Gmail messages with optional filtering',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g. "from:user@example.com")' },
        maxResults: { type: 'number', description: 'Max results (default 50)' },
        pageToken: { type: 'string', description: 'Page token from previous response' },
      },
    },
    categories: ['read'],
    // entityType 'Email' aligns with GoogleMailClient.list()'s gate. When
    // useListMethod is set, the adapter routes through client.list(), which
    // honors filters.q (Gmail's `q` parameter), filters.limit, filters.pageToken.
    entityType: 'Email',
    useListMethod: true,
    // W1 inbox: list_messages is poll-shaped (agents use it with q='is:unread'
    // to get the queue of pending messages). update_message is the ack —
    // calling it with removeLabelIds: ['UNREAD'] flips the message out of the
    // q='is:unread' result set on the next poll.
    workRole: 'inbox',
    paired_ack: 'update_message',
    workItemKind: 'email_message',
  },
  {
    name: 'list_drafts',
    description: 'List Gmail drafts',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Max results (default 50)' },
        pageToken: { type: 'string', description: 'Page token from previous response' },
      },
    },
    categories: ['read'],
    entityType: 'drafts',
  },
  {
    name: 'read_draft',
    description: 'Read a specific Gmail draft by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Gmail draft ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'draft',
  },
  {
    name: 'update_message',
    description: 'Update a Gmail message (e.g. add/remove labels, mark as read/unread). To acknowledge an inbox item, call with removeLabelIds: ["UNREAD"] so the next q="is:unread" poll does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message ID' },
        addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to add' },
        removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to remove' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'message',
    // W1 ack: acknowledges list_messages by removing UNREAD label.
    workRole: 'ack',
    acknowledges: 'list_messages',
    workItemKind: 'email_message',
  },
  {
    name: 'update_draft',
    description: 'Update an existing Gmail draft',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail draft ID' },
        to: { type: 'string', description: 'Recipient email address(es)' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body content' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'draft',
  },
  {
    name: 'update_label',
    description: 'Update a Gmail label name or visibility',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Label ID' },
        name: { type: 'string', description: 'New label name' },
        labelListVisibility: { type: 'string', description: 'labelShow, labelShowIfUnread, or labelHide' },
        messageListVisibility: { type: 'string', description: 'show or hide' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'label',
  },
  {
    name: 'delete_draft',
    description: 'Delete a Gmail draft',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Gmail draft ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'draft',
  },
  {
    name: 'delete_label',
    description: 'Delete a Gmail label',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Label ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'label',
  },
];

// ─── Google Calendar ─────────────────────────────────────────────────────────

const GOOGLE_CALENDAR_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_event',
    description: 'Read a Google Calendar event by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID (format: "calendarId/eventId")' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'event',
  },
  {
    name: 'read_calendar',
    description: 'Read Google Calendar metadata by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Calendar ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'calendar',
  },
  {
    name: 'create_event',
    description: 'Create a new event on a Google Calendar',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (defaults to "primary")' },
        summary: { type: 'string', description: 'Event title' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        start: { type: 'object', description: 'Start time with dateTime and timeZone' },
        end: { type: 'object', description: 'End time with dateTime and timeZone' },
        attendees: { type: 'array', items: { type: 'object' }, description: 'List of attendee objects with email' },
      },
      required: ['summary', 'start', 'end'],
    },
    categories: ['write', 'outbound'],
    entityType: 'event',
  },
  {
    name: 'create_calendar',
    description: 'Create a new Google Calendar',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Calendar name' },
        description: { type: 'string', description: 'Calendar description' },
        timeZone: { type: 'string', description: 'Time zone (e.g. "America/Los_Angeles")' },
      },
      required: ['summary'],
    },
    categories: ['write'],
    entityType: 'calendar',
  },
  {
    name: 'update_event',
    description: 'Update an existing Google Calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID (format: "calendarId/eventId")' },
        summary: { type: 'string', description: 'Updated title' },
        description: { type: 'string', description: 'Updated description' },
        location: { type: 'string', description: 'Updated location' },
        start: { type: 'object', description: 'Updated start time' },
        end: { type: 'object', description: 'Updated end time' },
        attendees: { type: 'array', items: { type: 'object' }, description: 'Updated attendees' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'event',
  },
  {
    name: 'update_calendar',
    description: 'Update Google Calendar metadata',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Calendar ID' },
        summary: { type: 'string', description: 'Updated name' },
        description: { type: 'string', description: 'Updated description' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'calendar',
  },
  {
    name: 'delete_event',
    description: 'Delete a Google Calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID (format: "calendarId/eventId")' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'event',
  },
  {
    name: 'delete_calendar',
    description: 'Delete a Google Calendar',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Calendar ID' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'calendar',
  },
  {
    name: 'list_events',
    description: 'List events from a Google Calendar',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
        timeMin: { type: 'string', description: 'Start of time range (ISO 8601)' },
        timeMax: { type: 'string', description: 'End of time range (ISO 8601)' },
        maxResults: { type: 'number', description: 'Max results (default 50)' },
        pageToken: { type: 'string', description: 'Page token from previous response' },
      },
    },
    categories: ['read'],
    entityType: 'events',
  },
  {
    name: 'list_calendars',
    description: 'List all Google Calendars the user has access to',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'calendars',
  },
];

// ─── Google YouTube ──────────────────────────────────────────────────────────
// Maps to GoogleYouTubeClient methods (read/create/update/delete) on entityType.
// Scopes covered: youtube.readonly, youtube.force-ssl, yt-analytics.readonly.
// Three APIs behind one client: Data API v3, Analytics API v2, Reporting API v1.
// Video upload (resumable multipart) is intentionally NOT exposed — defer until
// real demand surfaces.

const GOOGLE_YOUTUBE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_channel',
    description: 'Read a YouTube channel by ID, including snippet, statistics, branding, and content details. Omit id to read the authenticated user\'s own channel.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Channel ID. If omitted, reads the authenticated user\'s channel.' },
      },
    },
    categories: ['read'],
    entityType: 'channel',
  },
  {
    name: 'read_video',
    description: 'Read a YouTube video by ID, including snippet, statistics, content details, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Video ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'video',
  },
  {
    name: 'read_playlist',
    description: 'Read a YouTube playlist by ID, including snippet, content details, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Playlist ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'playlist',
  },
  {
    name: 'list_videos',
    description: 'List videos. Defaults to the authenticated user\'s own uploads; pass channelId to list another channel\'s public uploads.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID to list videos for. If omitted, lists the authenticated user\'s own uploads.' },
        q: { type: 'string', description: 'Optional search filter' },
        order: { type: 'string', description: 'Sort order: date, rating, relevance, title, viewCount. Defaults to date.' },
        maxResults: { type: 'number', description: 'Max results per page (default 50)' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'videos',
  },
  {
    name: 'list_playlists',
    description: 'List playlists. Defaults to the authenticated user\'s own playlists; pass channelId to list another channel\'s public playlists.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel ID. If omitted, lists the authenticated user\'s playlists.' },
        maxResults: { type: 'number', description: 'Max results per page (default 50)' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'playlists',
  },
  {
    name: 'list_playlist_items',
    description: 'List the items (videos) in a YouTube playlist.',
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'Playlist ID' },
        maxResults: { type: 'number', description: 'Max results per page (default 50)' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
      required: ['playlistId'],
    },
    categories: ['read'],
    entityType: 'playlist_items',
  },
  {
    name: 'list_comments',
    description: 'List top-level comment threads on a YouTube video, including replies.',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: 'Video ID' },
        order: { type: 'string', description: 'Sort order: time or relevance. Defaults to time.' },
        maxResults: { type: 'number', description: 'Max results per page (default 50)' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
      required: ['videoId'],
    },
    categories: ['read'],
    entityType: 'comments',
  },
  {
    name: 'search',
    description: 'Search across the public YouTube catalog. Returns videos, channels, or playlists depending on `type`.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query' },
        type: { type: 'string', description: 'video | channel | playlist (default video)' },
        order: { type: 'string', description: 'Sort order: date, rating, relevance, title, viewCount (default relevance)' },
        maxResults: { type: 'number', description: 'Max results per page (default 25)' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
      required: ['q'],
    },
    categories: ['read'],
    entityType: 'search',
  },
  {
    name: 'create_playlist',
    description: 'Create a new YouTube playlist on the authenticated user\'s channel.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Playlist title' },
        description: { type: 'string', description: 'Playlist description' },
        privacyStatus: { type: 'string', description: 'public | unlisted | private (default private)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      },
      required: ['title'],
    },
    categories: ['write'],
    entityType: 'playlist',
  },
  {
    name: 'create_playlist_item',
    description: 'Add a video to a YouTube playlist.',
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'Playlist ID' },
        videoId: { type: 'string', description: 'Video ID to add' },
        position: { type: 'number', description: 'Zero-based insertion index' },
      },
      required: ['playlistId', 'videoId'],
    },
    categories: ['write'],
    entityType: 'playlist_item',
  },
  {
    name: 'create_comment',
    description: 'Post a top-level comment on a YouTube video.',
    inputSchema: {
      type: 'object',
      properties: {
        videoId: { type: 'string', description: 'Video ID' },
        text: { type: 'string', description: 'Comment text' },
      },
      required: ['videoId', 'text'],
    },
    categories: ['write', 'outbound'],
    entityType: 'comment',
  },
  {
    name: 'update_video',
    description: 'Update metadata on one of the authenticated user\'s YouTube videos. Cannot change the uploaded media; only snippet + status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Video ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
        categoryId: { type: 'string', description: 'YouTube category ID (required by API on every update)' },
        privacyStatus: { type: 'string', description: 'public | unlisted | private' },
      },
      required: ['id', 'categoryId'],
    },
    categories: ['write'],
    entityType: 'video',
  },
  {
    name: 'update_playlist',
    description: 'Update metadata on one of the authenticated user\'s YouTube playlists.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Playlist ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        privacyStatus: { type: 'string', description: 'public | unlisted | private' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'playlist',
  },
  {
    name: 'delete_video',
    description: 'Delete one of the authenticated user\'s YouTube videos.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Video ID' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'video',
  },
  {
    name: 'delete_playlist',
    description: 'Delete one of the authenticated user\'s YouTube playlists.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Playlist ID' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'playlist',
  },
  {
    name: 'delete_playlist_item',
    description: 'Remove a video from a YouTube playlist.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Playlist item ID' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'playlist_item',
  },
  {
    name: 'delete_comment',
    description: 'Delete a YouTube comment.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Comment ID' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'comment',
  },
  // ── Analytics API v2 ────────────────────────────────────────────────────
  {
    name: 'query_analytics',
    description: 'Query YouTube Analytics metrics (views, likes, watch time, traffic sources, audience demographics, etc.) for the authenticated channel over a date range. Caller picks the metrics + optional dimensions. Non-monetary only.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date, inclusive, YYYY-MM-DD' },
        endDate: { type: 'string', description: 'End date, inclusive, YYYY-MM-DD' },
        metrics: { type: 'string', description: 'Comma-separated YouTube Analytics metrics (e.g. "views,likes,estimatedMinutesWatched")' },
        dimensions: { type: 'string', description: 'Optional comma-separated dimensions (e.g. "day", "country", "video"). Omit for a single aggregate row.' },
        filters: { type: 'string', description: 'Optional filter expression (e.g. "country==US;video==abc123")' },
        sort: { type: 'string', description: 'Optional sort expression (e.g. "-views" for descending views)' },
        ids: { type: 'string', description: 'Channel/owner selector (default "channel==MINE")' },
        maxResults: { type: 'number', description: 'Max rows in response' },
        currency: { type: 'string', description: 'ISO-4217 currency for monetary metrics (only meaningful with the monetary scope; ignored otherwise)' },
      },
      required: ['startDate', 'endDate', 'metrics'],
    },
    categories: ['read'],
    entityType: 'analytics_report',
  },
  // ── Reporting API v1 ────────────────────────────────────────────────────
  {
    name: 'list_report_types',
    description: 'List the YouTube Reporting API bulk report types available to the authenticated channel.',
    inputSchema: {
      type: 'object',
      properties: {
        includeSystemManaged: { type: 'boolean', description: 'Include system-managed report types (CMS/content-owner only).' },
        pageSize: { type: 'number', description: 'Max report types per page' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'report_types',
  },
  {
    name: 'create_reporting_job',
    description: 'Subscribe to a YouTube Reporting API report type. Once created, YouTube generates a daily report file the agent can fetch via list_reports.',
    inputSchema: {
      type: 'object',
      properties: {
        reportTypeId: { type: 'string', description: 'Report type ID (from list_report_types)' },
        name: { type: 'string', description: 'Human-readable job name' },
      },
      required: ['reportTypeId'],
    },
    categories: ['write'],
    entityType: 'reporting_job',
  },
  {
    name: 'list_reporting_jobs',
    description: 'List the YouTube Reporting API jobs the authenticated channel is currently subscribed to.',
    inputSchema: {
      type: 'object',
      properties: {
        includeSystemManaged: { type: 'boolean', description: 'Include system-managed jobs (CMS/content-owner only).' },
        pageSize: { type: 'number', description: 'Max jobs per page' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'reporting_jobs',
  },
  {
    name: 'delete_reporting_job',
    description: 'Unsubscribe from a YouTube Reporting API job. New reports stop being generated; already-generated reports remain available for 60 days.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Reporting job ID' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'reporting_job',
  },
  {
    name: 'list_reports',
    description: 'List generated reports for a YouTube Reporting API job. Each report includes a downloadUrl the agent can fetch (auth required).',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Reporting job ID' },
        createdAfter: { type: 'string', description: 'Only reports created after this timestamp (RFC 3339)' },
        startTimeAtOrAfter: { type: 'string', description: 'Only reports whose data window starts at or after this timestamp (RFC 3339)' },
        startTimeBefore: { type: 'string', description: 'Only reports whose data window starts before this timestamp (RFC 3339)' },
        pageSize: { type: 'number', description: 'Max reports per page' },
        pageToken: { type: 'string', description: 'Page token from a previous response' },
      },
      required: ['jobId'],
    },
    categories: ['read'],
    entityType: 'reports',
  },
];

// ─── Google Docs ─────────────────────────────────────────────────────────────

const GOOGLE_DOCS_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_document',
    description: 'Read a Google Docs document metadata and structure',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'document',
  },
  {
    name: 'read_content',
    description: 'Read a Google Docs document content as plain text',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'content',
  },
  {
    name: 'create_document',
    description: 'Create a new Google Docs document',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Initial text content' },
      },
    },
    categories: ['write'],
    entityType: 'document',
  },
  {
    name: 'create_content',
    description: 'Insert text content into an existing Google Docs document',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Document ID' },
        content: { type: 'string', description: 'Text content to insert' },
        index: { type: 'number', description: 'Character index to insert at (defaults to 1)' },
      },
      required: ['documentId', 'content'],
    },
    categories: ['write'],
    entityType: 'content',
  },
  {
    name: 'update_document',
    description: 'Execute batch update requests on a Google Docs document',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Document ID' },
        requests: { type: 'array', items: { type: 'object' }, description: 'Array of Google Docs batch update request objects' },
      },
      required: ['documentId', 'requests'],
    },
    categories: ['write'],
    entityType: 'document',
  },
  {
    name: 'delete_content',
    description: 'Delete a range of content from a Google Docs document',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'Document ID' },
        startIndex: { type: 'number', description: 'Start index of range to delete' },
        endIndex: { type: 'number', description: 'End index of range to delete' },
      },
      required: ['documentId', 'startIndex', 'endIndex'],
    },
    categories: ['destructive'],
    entityType: 'content',
  },
  {
    name: 'list_documents',
    description: 'List Google Docs documents in Drive',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Max results (default 100)' },
        pageToken: { type: 'string', description: 'Page token from previous response' },
      },
    },
    categories: ['read'],
    entityType: 'documents',
  },
  {
    name: 'search_documents',
    description: 'Search Google Docs documents by name or content query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Drive query string (e.g. \"name contains 'report'\")" },
        pageSize: { type: 'number', description: 'Max results (default 100)' },
        pageToken: { type: 'string', description: 'Page token from previous response' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'documents',
  },
  {
    name: 'update_content',
    description: 'Replace or insert content in a Google Docs document',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID' },
        deleteRange: { type: 'object', description: 'Range to delete: { startIndex, endIndex }' },
        insertText: { type: 'string', description: 'Text to insert after the deletion' },
        insertIndex: { type: 'number', description: 'Character index to insert at (default 1)' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'content',
  },
  {
    name: 'update_formatting',
    description: 'Apply text style formatting to a range in a Google Docs document',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID' },
        range: { type: 'object', description: 'Range to format: { startIndex, endIndex }' },
        textStyle: { type: 'object', description: 'Text style properties (bold, italic, fontSize, etc.)' },
        fields: { type: 'string', description: 'Comma-separated style fields to update (default: *)' },
      },
      required: ['id', 'range', 'textStyle'],
    },
    categories: ['write'],
    entityType: 'formatting',
  },
];

// ─── Google Drive ────────────────────────────────────────────────────────────

const GOOGLE_DRIVE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_file',
    description: 'Read Google Drive file metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'file',
  },
  {
    name: 'read_folder',
    description: 'Read Google Drive folder metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'folder',
  },
  {
    name: 'create_folder',
    description: 'Create a new folder in Google Drive',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name' },
        parents: { type: 'array', items: { type: 'string' }, description: 'Parent folder IDs' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'folder',
  },
  {
    name: 'create_file',
    description: 'Create a new file (metadata only) in Google Drive',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name' },
        mimeType: { type: 'string', description: 'MIME type' },
        parents: { type: 'array', items: { type: 'string' }, description: 'Parent folder IDs' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'file',
  },
  {
    name: 'create_permission',
    description: 'Share a Google Drive file or folder by adding a permission',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File or folder ID to share' },
        type: { type: 'string', description: 'Permission type: user, group, domain, or anyone' },
        role: { type: 'string', description: 'Role: owner, writer, commenter, or reader' },
        emailAddress: { type: 'string', description: 'Email address of user or group' },
      },
      required: ['fileId', 'type', 'role'],
    },
    categories: ['write', 'outbound'],
    entityType: 'permission',
  },
  {
    name: 'update_file',
    description: 'Update Google Drive file metadata',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File ID' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        starred: { type: 'boolean', description: 'Whether starred' },
        trashed: { type: 'boolean', description: 'Whether trashed' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'file',
  },
  {
    name: 'delete_file',
    description: 'Permanently delete a file from Google Drive',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'file',
  },
  {
    name: 'delete_folder',
    description: 'Permanently delete a folder from Google Drive',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'folder',
  },
  {
    name: 'list_files',
    description: 'List files in Google Drive, optionally filtered by folder and MIME type',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder ID to list (default: all files)' },
        mimeTypes: { type: 'array', items: { type: 'string' }, description: 'Filter to these MIME types' },
        pageSize: { type: 'number', description: 'Results per page (max 100)' },
        pageToken: { type: 'string', description: 'Pagination token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'search_files',
    description: 'Search for files in Google Drive by name or content query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Google Drive query string (e.g. \"name contains 'report'\")" },
        mimeTypes: { type: 'array', items: { type: 'string' }, description: 'Filter to these MIME types' },
        pageSize: { type: 'number', description: 'Results per page (max 100)' },
        pageToken: { type: 'string', description: 'Pagination token from a previous response' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'list_folders',
    description: 'List folders in Google Drive, optionally filtered by parent folder',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Parent folder ID (default: all folders)' },
        pageSize: { type: 'number', description: 'Results per page (max 100)' },
        pageToken: { type: 'string', description: 'Pagination token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'folders',
  },
  {
    name: 'read_permissions',
    description: 'Read the sharing permissions for a Google Drive file or folder',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File or folder ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'permissions',
  },
  {
    name: 'create_shortcut',
    description: 'Create a shortcut to a Google Drive file or folder',
    inputSchema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'ID of the file or folder to link to' },
        name: { type: 'string', description: 'Shortcut name' },
        parents: { type: 'array', items: { type: 'string' }, description: 'Parent folder IDs' },
      },
      required: ['targetId'],
    },
    categories: ['write'],
    entityType: 'shortcut',
  },
  {
    name: 'update_permission',
    description: 'Update the role of an existing Google Drive permission',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "fileId/permissionId"' },
        role: { type: 'string', description: 'New role: owner, writer, commenter, or reader' },
      },
      required: ['id', 'role'],
    },
    categories: ['write'],
    entityType: 'permission',
  },
  {
    name: 'delete_permission',
    description: 'Remove a sharing permission from a Google Drive file or folder',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "fileId/permissionId"' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'permission',
  },
  {
    name: 'delete_shortcut',
    description: 'Delete a Google Drive shortcut',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Shortcut file ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'shortcut',
  },
];

// ─── Google Sheets ───────────────────────────────────────────────────────────

const GOOGLE_SHEETS_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_spreadsheet',
    description: 'Read Google Sheets spreadsheet metadata and sheet list',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Spreadsheet ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'spreadsheet',
  },
  {
    name: 'read_values',
    description: 'Read cell values from a range in a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range (e.g. "Sheet1!A1:D10")' },
      },
      required: ['spreadsheetId', 'range'],
    },
    categories: ['read'],
    entityType: 'values',
  },
  {
    name: 'create_spreadsheet',
    description: 'Create a new Google Sheets spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        properties: { type: 'object', description: 'Spreadsheet properties (title, locale)' },
        sheets: { type: 'array', items: { type: 'object' }, description: 'Initial sheet definitions' },
      },
    },
    categories: ['write'],
    entityType: 'spreadsheet',
  },
  {
    name: 'create_sheet',
    description: 'Add a new sheet (tab) to an existing spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
        title: { type: 'string', description: 'Sheet title' },
      },
      required: ['spreadsheetId'],
    },
    categories: ['write'],
    entityType: 'sheet',
  },
  {
    name: 'create_values',
    description: 'Append rows of values to a range in Google Sheets. Each cell must be a plain string or number — NOT an object.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range to append to (e.g. "Sheet1!A:B")' },
        values: {
          type: 'array',
          description: '2D array of rows. Each row is an array of plain string or number values. Example: [["2026-04-11", 72734], ["2026-04-12", 73000]]',
          items: {
            type: 'array',
            items: { type: ['string', 'number'], description: 'Cell value — must be a plain string or number, NOT an object' },
          },
        },
      },
      required: ['spreadsheetId', 'range', 'values'],
    },
    categories: ['write'],
    entityType: 'values',
  },
  {
    name: 'update_values',
    description: 'Write/overwrite cell values in a range in Google Sheets. Each cell must be a plain string or number — NOT an object.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range to write to (e.g. "Sheet1!A1:B2")' },
        values: {
          type: 'array',
          description: '2D array of rows. Each row is an array of plain string or number values. Example: [["2026-04-11", 72734]]',
          items: {
            type: 'array',
            items: { type: ['string', 'number'], description: 'Cell value — must be a plain string or number, NOT an object' },
          },
        },
      },
      required: ['spreadsheetId', 'range', 'values'],
    },
    categories: ['write'],
    entityType: 'values',
  },
  {
    name: 'delete_sheet',
    description: 'Delete a sheet (tab) from a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
        sheetId: { type: 'number', description: 'Numeric sheet ID to delete' },
      },
      required: ['spreadsheetId', 'sheetId'],
    },
    categories: ['destructive'],
    entityType: 'sheet',
  },
  {
    name: 'list_spreadsheets',
    description: 'List Google Sheets spreadsheets in Drive',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Max results (default 100)' },
        pageToken: { type: 'string', description: 'Page token from previous response' },
      },
    },
    categories: ['read'],
    entityType: 'spreadsheets',
  },
  {
    name: 'read_sheet',
    description: 'Read metadata for a specific sheet (tab) within a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "spreadsheetId/sheetId"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'sheet',
  },
  {
    name: 'list_sheets',
    description: 'List all sheets (tabs) in a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
      },
      required: ['spreadsheetId'],
    },
    categories: ['read'],
    entityType: 'sheets',
  },
  {
    name: 'update_spreadsheet',
    description: 'Execute batch update requests on a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Spreadsheet ID' },
        requests: { type: 'array', items: { type: 'object' }, description: 'Array of Sheets batchUpdate request objects' },
      },
      required: ['id', 'requests'],
    },
    categories: ['write'],
    entityType: 'spreadsheet',
  },
  {
    name: 'delete_values',
    description: 'Clear all values in a range of a Google Sheets spreadsheet',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "spreadsheetId/range" (e.g. "abc123/Sheet1!A1:D10")' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'values',
  },
  {
    name: 'delete_spreadsheet',
    description: 'Delete a Google Sheets spreadsheet via Google Drive',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Spreadsheet ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'spreadsheet',
  },
];

// ─── Google Slides ───────────────────────────────────────────────────────────

const GOOGLE_SLIDES_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_presentation',
    description: 'Read a Google Slides presentation metadata and slide list',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Presentation ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'presentation',
  },
  {
    name: 'create_presentation',
    description: 'Create a new Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Presentation title' } },
    },
    categories: ['write'],
    entityType: 'presentation',
  },
  {
    name: 'create_slide',
    description: 'Add a new slide to a Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        insertionIndex: { type: 'number', description: 'Position to insert at' },
      },
      required: ['presentationId'],
    },
    categories: ['write'],
    entityType: 'slide',
  },
  {
    name: 'create_textbox',
    description: 'Add a textbox element to a slide',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        slideId: { type: 'string', description: 'Slide object ID' },
        text: { type: 'string', description: 'Text content' },
      },
      required: ['presentationId', 'slideId'],
    },
    categories: ['write'],
    entityType: 'textbox',
  },
  {
    name: 'update_presentation',
    description: 'Execute batch update requests on a Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        requests: { type: 'array', items: { type: 'object' }, description: 'Array of Slides batch update request objects' },
      },
      required: ['presentationId', 'requests'],
    },
    categories: ['write'],
    entityType: 'presentation',
  },
  {
    name: 'delete_slide',
    description: 'Delete a slide from a Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        slideId: { type: 'string', description: 'Slide object ID to delete' },
      },
      required: ['presentationId', 'slideId'],
    },
    categories: ['destructive'],
    entityType: 'slide',
  },
  {
    name: 'list_presentations',
    description: 'List Google Slides presentations',
    inputSchema: {
      type: 'object',
      properties: {
        pageToken: { type: 'string', description: 'Page token from previous response' },
        pageSize: { type: 'number', description: 'Max results (default 100)' },
      },
    },
    categories: ['read'],
    entityType: 'presentations',
  },
  {
    name: 'read_slide',
    description: 'Read the properties and elements of a specific slide in a Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "presentationId/slideId"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'slide',
  },
  {
    name: 'read_element',
    description: 'Read a specific page element (text box, image, shape) in a Google Slides presentation',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "presentationId/slideId/elementId"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'element',
  },
  {
    name: 'create_image',
    description: 'Insert an image into a Google Slides presentation slide',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        slideId: { type: 'string', description: 'Slide object ID to insert into' },
        url: { type: 'string', description: 'Publicly accessible image URL' },
        translateX: { type: 'number', description: 'Horizontal position in EMUs' },
        translateY: { type: 'number', description: 'Vertical position in EMUs' },
        width: { type: 'number', description: 'Image width in EMUs' },
        height: { type: 'number', description: 'Image height in EMUs' },
      },
      required: ['presentationId', 'slideId', 'url'],
    },
    categories: ['write'],
    entityType: 'image',
  },
  {
    name: 'create_shape',
    description: 'Insert a shape into a Google Slides presentation slide',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Presentation ID' },
        slideId: { type: 'string', description: 'Slide object ID to insert into' },
        shapeType: { type: 'string', description: 'Shape type (e.g. RECTANGLE, ELLIPSE, ARROW)' },
        translateX: { type: 'number', description: 'Horizontal position in EMUs' },
        translateY: { type: 'number', description: 'Vertical position in EMUs' },
        width: { type: 'number', description: 'Shape width in EMUs' },
        height: { type: 'number', description: 'Shape height in EMUs' },
      },
      required: ['presentationId', 'slideId', 'shapeType'],
    },
    categories: ['write'],
    entityType: 'shape',
  },
  {
    name: 'update_slide',
    description: 'Update slide properties (background, layout) via a batch update request',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "presentationId/slideId"' },
        requests: { type: 'array', items: { type: 'object' }, description: 'Array of Slides batch update request objects' },
      },
      required: ['id', 'requests'],
    },
    categories: ['write'],
    entityType: 'slide',
  },
  {
    name: 'update_element',
    description: 'Update a page element (text, style, transform) via a batch update request',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "presentationId/slideId/elementId"' },
        requests: { type: 'array', items: { type: 'object' }, description: 'Array of Slides batch update request objects' },
      },
      required: ['id', 'requests'],
    },
    categories: ['write'],
    entityType: 'element',
  },
  {
    name: 'delete_element',
    description: 'Delete a page element from a Google Slides presentation slide',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "presentationId/slideId/elementId"' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'element',
  },
];

// ─── Slack ───────────────────────────────────────────────────────────────────

const SLACK_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_message',
    description: 'Read a Slack message by channel and timestamp',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel ID' },
        ts: { type: 'string', description: 'Message timestamp' },
      },
      required: ['channel', 'ts'],
    },
    categories: ['read'],
    idArgs: ['channel', 'ts'],
    returnsIds: [{ entityType: 'message', path: 'ts' }],
    entityType: 'message',
  },
  {
    name: 'read_channel',
    description: 'Read Slack channel information',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Channel ID' } },
      required: ['id'],
    },
    categories: ['read'],
    idArgs: ['id'],
    returnsIds: [{ entityType: 'channel', path: 'id' }],
    entityType: 'channel',
  },
  {
    name: 'send_message',
    description: 'Send a message to a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID to post to' },
        text: { type: 'string', description: 'Message text' },
        thread_ts: { type: 'string', description: 'Parent message timestamp for threading' },
      },
      required: ['channel', 'text'],
    },
    // Slack is an internal collaboration surface, not an outbound channel. The
    // 'outbound' tag put it under the workspace Communication policy ("How teams
    // should handle outbound messages"), so with communication='draft' this tool was
    // deregistered in favour of schedule_message and a post to an internal channel
    // like #ci-alerts was denied at canUseTool with nothing to approve.
    //
    // schedule_message is also NOT a draft: it is a delayed send that fires on a
    // timer, so treating it as the reviewable alternative was wrong on its own terms.
    //
    // `internalCollaboration` states it as a category rather than a remark, so
    // every gate — the runtime's and the control plane's — reads a message into
    // the workspace's own Slack as never held.
    categories: ['write', 'internalCollaboration'],
    idArgs: ['channel', 'thread_ts'],
    draftVariant: 'slack__schedule_message',
    entityType: 'message',
  },
  {
    name: 'schedule_message',
    description: 'Schedule a message for later delivery in Slack',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        text: { type: 'string', description: 'Message text' },
        post_at: { type: 'string', description: 'Unix timestamp for delivery' },
      },
      required: ['channel', 'text', 'post_at'],
    },
    categories: ['write', 'internalCollaboration'],
    idArgs: ['channel'],
    entityType: 'message',
  },
  {
    name: 'create_channel',
    description: 'Create a new Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name (lowercase, no spaces)' },
        is_private: { type: 'string', description: 'Whether private' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'channel',
  },
  {
    name: 'update_message',
    description: 'Update an existing Slack message',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        ts: { type: 'string', description: 'Message timestamp' },
        text: { type: 'string', description: 'New message text' },
      },
      required: ['channel', 'ts', 'text'],
    },
    categories: ['write', 'internalCollaboration'],
    idArgs: ['channel', 'ts'],
    entityType: 'message',
  },
  {
    name: 'update_channel',
    description: 'Update a Slack channel (rename, topic, or purpose)',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        name: { type: 'string', description: 'New name' },
        topic: { type: 'string', description: 'New topic' },
        purpose: { type: 'string', description: 'New purpose' },
      },
      required: ['channel'],
    },
    categories: ['write'],
    idArgs: ['channel'],
    entityType: 'channel',
  },
  {
    name: 'delete_message',
    description: 'Delete a Slack message',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        ts: { type: 'string', description: 'Message timestamp' },
      },
      required: ['channel', 'ts'],
    },
    categories: ['destructive'],
    idArgs: ['channel', 'ts'],
    entityType: 'message',
  },
  {
    name: 'delete_channel',
    description: 'Archive a Slack channel',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Channel ID to archive' } },
      required: ['id'],
    },
    categories: ['destructive'],
    idArgs: ['id'],
    entityType: 'channel',
  },
  {
    name: 'list_channels',
    description: 'List Slack channels the bot has access to',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
        types: { type: 'string', description: 'Channel types: public_channel, private_channel, im, mpim (comma-separated)' },
      },
    },
    categories: ['read'],
    returnsIds: [{ entityType: 'channel', path: 'channels[].id' }],
    entityType: 'channels',
  },
  {
    name: 'list_messages',
    description: 'List recent messages in a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        limit: { type: 'number', description: 'Max messages to return (default 50)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
        oldest: { type: 'string', description: 'Start of time range (Unix timestamp)' },
        latest: { type: 'string', description: 'End of time range (Unix timestamp)' },
      },
      required: ['channel'],
    },
    categories: ['read'],
    returnsIds: [{ entityType: 'message', path: 'messages[].ts' }],
    entityType: 'messages',
  },
];

// ─── GitHub ──────────────────────────────────────────────────────────────────
// Phase 3.1: GitHub migrated to official MCP server — REST functions removed.
// Tools are now dynamically discovered via getMCPServerConfig('github').

// ─── Salesforce ──────────────────────────────────────────────────────────────

const SALESFORCE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_record',
    description: 'Read a Salesforce record by SObject type and ID',
    inputSchema: {
      type: 'object',
      properties: {
        sobject_type: { type: 'string', description: 'SObject type (Account, Contact, Lead, Opportunity, Case, Task)' },
        id: { type: 'string', description: 'Record ID' },
      },
      required: ['sobject_type', 'id'],
    },
    categories: ['read'],
  },
  {
    name: 'search_records',
    description: 'Search Salesforce records using SOQL',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'SOQL query (e.g. "SELECT Id, Name FROM Account WHERE Name LIKE \'Acme%\'")' },
      },
      required: ['id'],
    },
    categories: ['read'],
  },
  {
    name: 'create_account',
    description: 'Create a new Salesforce Account',
    inputSchema: {
      type: 'object',
      properties: {
        Name: { type: 'string', description: 'Account name' },
        Industry: { type: 'string', description: 'Industry' },
        Phone: { type: 'string', description: 'Phone number' },
        Website: { type: 'string', description: 'Website URL' },
      },
      required: ['Name'],
    },
    categories: ['write'],
    entityType: 'Account',
  },
  {
    name: 'create_contact',
    description: 'Create a new Salesforce Contact',
    inputSchema: {
      type: 'object',
      properties: {
        FirstName: { type: 'string', description: 'First name' },
        LastName: { type: 'string', description: 'Last name' },
        Email: { type: 'string', description: 'Email' },
        Phone: { type: 'string', description: 'Phone' },
        AccountId: { type: 'string', description: 'Parent Account ID' },
      },
      required: ['LastName'],
    },
    categories: ['write'],
    entityType: 'Contact',
  },
  {
    name: 'create_lead',
    description: 'Create a new Salesforce Lead',
    inputSchema: {
      type: 'object',
      properties: {
        FirstName: { type: 'string', description: 'First name' },
        LastName: { type: 'string', description: 'Last name' },
        Company: { type: 'string', description: 'Company name' },
        Email: { type: 'string', description: 'Email' },
        Status: { type: 'string', description: 'Lead status' },
      },
      required: ['LastName', 'Company'],
    },
    categories: ['write'],
    entityType: 'Lead',
  },
  {
    name: 'create_opportunity',
    description: 'Create a new Salesforce Opportunity',
    inputSchema: {
      type: 'object',
      properties: {
        Name: { type: 'string', description: 'Opportunity name' },
        StageName: { type: 'string', description: 'Sales stage' },
        CloseDate: { type: 'string', description: 'Expected close date (YYYY-MM-DD)' },
        Amount: { type: 'string', description: 'Deal amount' },
        AccountId: { type: 'string', description: 'Account ID' },
      },
      required: ['Name', 'StageName', 'CloseDate'],
    },
    categories: ['write'],
    entityType: 'Opportunity',
  },
  {
    name: 'list_contacts',
    description: 'List Salesforce Contacts with SOQL',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        where: { type: 'string', description: 'Optional SOQL WHERE clause (without the WHERE keyword)' },
      },
    },
    categories: ['read'],
    entityType: 'contacts',
  },
  {
    name: 'list_leads',
    description: 'List Salesforce Leads with SOQL. The inbox queue is leads with Status that has not yet been worked (e.g. where="Status = \'Open - Not Contacted\'" or where="Status = \'Working - Contacted\'").',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        where: { type: 'string', description: 'Optional SOQL WHERE clause (without the WHERE keyword)' },
      },
    },
    categories: ['read'],
    entityType: 'leads',
    // W1 inbox: list_leads with SOQL Status filter is poll-shaped;
    // update_lead transitioning Status closes the loop.
    workRole: 'inbox',
    paired_ack: 'update_lead',
    workItemKind: 'lead',
  },
  {
    name: 'list_accounts',
    description: 'List Salesforce Accounts with SOQL',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        where: { type: 'string', description: 'Optional SOQL WHERE clause (without the WHERE keyword)' },
      },
    },
    categories: ['read'],
    entityType: 'accounts',
  },
  {
    name: 'update_account',
    description: 'Update a Salesforce Account',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Account ID' },
        Name: { type: 'string' },
        Industry: { type: 'string' },
        Phone: { type: 'string' },
        Website: { type: 'string' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'Account',
  },
  {
    name: 'update_contact',
    description: 'Update a Salesforce Contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact ID' },
        FirstName: { type: 'string' },
        LastName: { type: 'string' },
        Email: { type: 'string' },
        Phone: { type: 'string' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'Contact',
  },
  {
    name: 'update_lead',
    description: 'Update a Salesforce Lead. To acknowledge an inbox item, change Status out of the unhandled-queue values the inbox SOQL filter scopes to.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Lead ID' },
        FirstName: { type: 'string' },
        LastName: { type: 'string' },
        Email: { type: 'string' },
        Status: { type: 'string' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'Lead',
    // W1 ack: acknowledges list_leads by transitioning Status.
    workRole: 'ack',
    acknowledges: 'list_leads',
    workItemKind: 'lead',
  },
  {
    name: 'update_opportunity',
    description: 'Update a Salesforce Opportunity',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Opportunity ID' },
        Name: { type: 'string' },
        StageName: { type: 'string' },
        CloseDate: { type: 'string' },
        Amount: { type: 'string' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'Opportunity',
  },
  {
    name: 'delete_record',
    description: 'Delete a Salesforce record by SObject type and ID',
    inputSchema: {
      type: 'object',
      properties: {
        sobject_type: { type: 'string', description: 'SObject type' },
        id: { type: 'string', description: 'Record ID to delete' },
      },
      required: ['sobject_type', 'id'],
    },
    categories: ['destructive'],
  },
];

// ─── Microsoft Outlook Mail ──────────────────────────────────────────────────

const MICROSOFT_OUTLOOK_MAIL_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_message',
    description: 'Read an Outlook email message by ID, returning decoded subject, body, sender, recipients, and metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Message ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'message',
  },
  {
    name: 'search',
    description: 'Search for emails in Outlook using a text query',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Search query text (e.g. "from:alice@company.com subject:invoice")' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'search',
  },
  {
    name: 'send_email',
    description: 'Send a new email via Outlook immediately',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body content' },
        contentType: { type: 'string', description: '"Text" (default) or "HTML"' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients' },
        from: {
          type: 'string',
          description:
            'Optional shared mailbox to send from (e.g. "support@tenant.onmicrosoft.com"). ' +
            'The connected user must have Send-As permission on this mailbox and the connector ' +
            'must have Mail.Send.Shared scope. Omit to send as the connected user.',
        },
      },
      required: ['subject', 'body', 'to'],
    },
    categories: ['write', 'outbound'],
    draftVariant: 'microsoft-outlook-mail__create_draft',
    entityType: 'message',
  },
  {
    name: 'reply_email',
    description: 'Reply to an existing Outlook email thread, sending immediately',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'ID of the message being replied to' },
        body: { type: 'string', description: 'Reply body content' },
        contentType: { type: 'string', description: '"Text" (default) or "HTML"' },
        to: { type: 'array', items: { type: 'string' }, description: 'Override To recipients (defaults to original sender)' },
        from: {
          type: 'string',
          description:
            'Optional shared mailbox to send from (e.g. "support@tenant.onmicrosoft.com"). ' +
            'The connected user must have Send-As permission on this mailbox and the connector ' +
            'must have Mail.Send.Shared scope. Omit to send as the connected user.',
        },
      },
      required: ['messageId', 'body'],
    },
    categories: ['write', 'outbound'],
    draftVariant: 'microsoft-outlook-mail__create_reply_draft',
    entityType: 'reply',
  },
  {
    name: 'forward_email',
    description: 'Forward an existing Outlook email to new recipients, sending immediately',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'ID of the message being forwarded' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        body: { type: 'string', description: 'Optional comment to prepend above the forwarded content' },
        from: {
          type: 'string',
          description: 'Optional shared mailbox to forward from (see send_email).',
        },
      },
      required: ['messageId', 'to'],
    },
    categories: ['write', 'outbound'],
    entityType: 'forward',
  },
  {
    name: 'create_draft',
    description: 'Create a new draft email in Outlook without sending',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body content' },
        contentType: { type: 'string', description: '"Text" (default) or "HTML"' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients' },
        from: {
          type: 'string',
          description:
            'Optional shared mailbox to send from (e.g. "support@tenant.onmicrosoft.com"). ' +
            'The connected user must have Send-As permission on this mailbox and the connector ' +
            'must have Mail.Send.Shared scope. Omit to send as the connected user.',
        },
      },
      required: ['subject', 'body', 'to'],
    },
    categories: ['write'],
    entityType: 'draft',
  },
  {
    name: 'create_reply_draft',
    description: 'Create a draft reply to an Outlook email without sending it — the draft appears in Drafts for review',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'ID of the message being replied to' },
        body: { type: 'string', description: 'Reply body content' },
        contentType: { type: 'string', description: '"Text" (default) or "HTML"' },
        from: {
          type: 'string',
          description:
            'Optional shared mailbox to send from (e.g. "support@tenant.onmicrosoft.com"). ' +
            'The connected user must have Send-As permission on this mailbox and the connector ' +
            'must have Mail.Send.Shared scope. Omit to send as the connected user.',
        },
      },
      required: ['messageId', 'body'],
    },
    categories: ['write'],
    entityType: 'reply_draft',
  },
  {
    name: 'read_mail_folder',
    description: 'Read an Outlook mail folder by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'mailFolder',
  },
  {
    name: 'create_mail_folder',
    description: 'Create a new Outlook mail folder',
    inputSchema: {
      type: 'object',
      properties: { displayName: { type: 'string', description: 'Folder display name' } },
      required: ['displayName'],
    },
    categories: ['write'],
    entityType: 'mailFolder',
  },
  {
    name: 'update_message',
    description: 'Update an existing Outlook email message (e.g. mark as read). To acknowledge an inbox item, call with isRead: true so the next unread-filtered list does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message ID' },
        isRead: { type: 'boolean', description: 'Mark as read/unread' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'message',
    // W1 ack: acknowledges list_messages by setting isRead=true.
    workRole: 'ack',
    acknowledges: 'list_messages',
    workItemKind: 'email_message',
  },
  {
    name: 'delete_message',
    description: 'Delete an Outlook email message',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Message ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'message',
  },
  {
    name: 'delete_mail_folder',
    description: 'Delete an Outlook mail folder',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'mailFolder',
  },
  {
    name: 'list_messages',
    description: 'List Outlook mail messages. Use filter: "isRead eq false" to scope to the unread inbox queue.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder ID (default: inbox)' },
        top: { type: 'number', description: 'Max results (default 50)' },
        skip: { type: 'number', description: 'Number of items to skip for pagination' },
        filter: { type: 'string', description: 'OData filter expression' },
      },
    },
    categories: ['read'],
    entityType: 'Email',
    useListMethod: true,
    // W1 inbox: list_messages is poll-shaped (agents scope via filter="isRead eq false");
    // update_message with isRead=true is the ack that flips it out of the next list.
    workRole: 'inbox',
    paired_ack: 'update_message',
    workItemKind: 'email_message',
  },
  {
    name: 'list_mail_folders',
    description: 'List Outlook mail folders',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'mail_folders',
  },
  {
    name: 'list_drafts',
    description: 'List Outlook draft emails',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'Max results (default 50)' },
        skip: { type: 'number', description: 'Number of items to skip for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'mail_drafts',
  },
  {
    name: 'read_draft',
    description: 'Read an Outlook draft email by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Draft message ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'draft',
  },
  {
    name: 'update_draft',
    description: 'Update an existing Outlook draft email',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Draft message ID' },
        subject: { type: 'string', description: 'Updated subject' },
        body: { type: 'string', description: 'Updated body content' },
        contentType: { type: 'string', description: '"Text" (default) or "HTML"' },
        to: { type: 'array', items: { type: 'string' }, description: 'Updated To recipients' },
        cc: { type: 'array', items: { type: 'string' }, description: 'Updated CC recipients' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'draft',
  },
  {
    name: 'delete_draft',
    description: 'Delete an Outlook draft email',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Draft message ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'draft',
  },
  {
    name: 'delete_reply_draft',
    description: 'Delete an Outlook reply draft (unsent reply to a message thread)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Reply draft message ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'reply_draft',
  },
];

// ─── Microsoft Outlook Calendar ──────────────────────────────────────────────

const MICROSOFT_OUTLOOK_CALENDAR_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_event',
    description: 'Read an Outlook calendar event by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Event ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'event',
  },
  {
    name: 'create_event',
    description: 'Create a new Outlook calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Event subject' },
        start: { type: 'string', description: 'Start datetime (ISO 8601)' },
        end: { type: 'string', description: 'End datetime (ISO 8601)' },
        timeZone: { type: 'string', description: 'Time zone (default "UTC")' },
        location: { type: 'string', description: 'Event location' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
      },
      required: ['subject', 'start', 'end'],
    },
    categories: ['write'],
    entityType: 'event',
  },
  {
    name: 'update_event',
    description: 'Update an existing Outlook calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID' },
        subject: { type: 'string', description: 'Updated subject' },
        start: { type: 'string', description: 'Updated start' },
        end: { type: 'string', description: 'Updated end' },
        location: { type: 'string', description: 'Updated location' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'event',
  },
  {
    name: 'delete_event',
    description: 'Delete an Outlook calendar event',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Event ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'event',
  },
  {
    name: 'list_events',
    description: 'List Outlook calendar events',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
        startDateTime: { type: 'string', description: 'Start of time range (ISO 8601)' },
        endDateTime: { type: 'string', description: 'End of time range (ISO 8601)' },
        top: { type: 'number', description: 'Max results (default 50)' },
        skip: { type: 'number', description: 'Items to skip for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'events',
  },
  {
    name: 'list_calendars',
    description: 'List all Outlook calendars',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'calendars',
  },
  {
    name: 'read_calendar',
    description: 'Read an Outlook calendar by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Calendar ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'calendar',
  },
  {
    name: 'create_calendar',
    description: 'Create a new Outlook calendar',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Calendar name' },
        color: { type: 'string', description: 'Calendar color (e.g. lightBlue, lightGreen)' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'calendar',
  },
  {
    name: 'update_calendar',
    description: 'Update an existing Outlook calendar name or color',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Calendar ID' },
        name: { type: 'string', description: 'New calendar name' },
        color: { type: 'string', description: 'New calendar color' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'calendar',
  },
];

// ─── Microsoft Teams ─────────────────────────────────────────────────────────

const MICROSOFT_TEAMS_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_channel',
    description: 'Read a Teams channel by team and channel ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "teamId:channelId"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'channel',
  },
  {
    name: 'send_message',
    description: 'Send a message to a Teams channel',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team ID' },
        channelId: { type: 'string', description: 'Channel ID' },
        content: { type: 'string', description: 'Message content' },
        contentType: { type: 'string', description: '"text" (default) or "html"' },
      },
      required: ['teamId', 'channelId', 'content'],
    },
    // Microsoft Teams is an internal collaboration surface, not an outbound
    // channel — same correction as Slack send_message above. 'outbound' put it
    // under the workspace Communication policy ("How teams should handle outbound
    // messages"), which is about reaching people outside the workspace. Worse than
    // Slack's case: Teams publishes no draftVariant, so under communication='draft'
    // the only available decision was an approval demand it could never satisfy.
    categories: ['write', 'internalCollaboration'],
    entityType: 'message',
  },
  {
    name: 'create_channel',
    description: 'Create a new channel in a Teams team',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team ID' },
        displayName: { type: 'string', description: 'Channel display name' },
        description: { type: 'string', description: 'Channel description' },
      },
      required: ['teamId', 'displayName'],
    },
    categories: ['write'],
    entityType: 'channel',
  },
  {
    name: 'update_message',
    description: 'Update an existing Teams channel message',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team ID' },
        channelId: { type: 'string', description: 'Channel ID' },
        messageId: { type: 'string', description: 'Message ID' },
        content: { type: 'string', description: 'Updated content' },
      },
      required: ['teamId', 'channelId', 'messageId', 'content'],
    },
    categories: ['write', 'internalCollaboration'],
    entityType: 'message',
  },
  {
    name: 'delete_channel',
    description: 'Delete a Teams channel',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team ID' },
        channelId: { type: 'string', description: 'Channel ID to delete' },
      },
      required: ['teamId', 'channelId'],
    },
    categories: ['destructive'],
    entityType: 'channel',
  },
  {
    name: 'list_teams',
    description: 'List Microsoft Teams the user belongs to',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'teams',
  },
  {
    name: 'list_channels',
    description: 'List channels in a Microsoft Team',
    inputSchema: {
      type: 'object',
      properties: { teamId: { type: 'string', description: 'Team ID' } },
      required: ['teamId'],
    },
    categories: ['read'],
    entityType: 'team_channels',
  },
  {
    name: 'list_messages',
    description: 'List messages in a Microsoft Teams channel',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team ID' },
        channelId: { type: 'string', description: 'Channel ID' },
        top: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['teamId', 'channelId'],
    },
    categories: ['read'],
    entityType: 'team_messages',
  },
  {
    name: 'read_team',
    description: 'Read Microsoft Teams team details by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Team ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'team',
  },
];

// ─── Microsoft ToDo ──────────────────────────────────────────────────────────

const MICROSOFT_TODO_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_task',
    description: 'Read a Microsoft To Do task',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "listId:taskId"' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'task',
  },
  {
    name: 'list_task_lists',
    description: 'List all To Do task lists',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'task_lists',
  },
  {
    name: 'create_task',
    description: 'Create a new task in Microsoft To Do',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'Task list ID' },
        title: { type: 'string', description: 'Task title' },
        body: { type: 'string', description: 'Task notes' },
        importance: { type: 'string', description: '"low", "normal", or "high"' },
        dueDate: { type: 'string', description: 'Due date (ISO 8601)' },
      },
      required: ['listId', 'title'],
    },
    categories: ['write'],
    entityType: 'task',
  },
  {
    name: 'create_task_list',
    description: 'Create a new To Do task list',
    inputSchema: {
      type: 'object',
      properties: { displayName: { type: 'string', description: 'List display name' } },
      required: ['displayName'],
    },
    categories: ['write'],
    entityType: 'taskList',
  },
  {
    name: 'update_task',
    description: 'Update a Microsoft To Do task. To acknowledge an inbox item, set status to "completed" so the next non-completed-filtered list does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "listId:taskId"' },
        title: { type: 'string', description: 'Updated title' },
        status: { type: 'string', description: 'Status: notStarted, inProgress, completed' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'task',
    workRole: 'ack',
    acknowledges: 'list_tasks',
    workItemKind: 'task',
  },
  {
    name: 'delete_task',
    description: 'Delete a Microsoft To Do task',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "listId:taskId"' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'task',
  },
  {
    name: 'list_tasks',
    description: 'List tasks in a Microsoft To Do task list. Filter the result client-side to exclude status=completed to scope to the unhandled queue.',
    inputSchema: {
      type: 'object',
      properties: { listId: { type: 'string', description: 'Task list ID' } },
      required: ['listId'],
    },
    categories: ['read'],
    entityType: 'tasks',
    workRole: 'inbox',
    paired_ack: 'update_task',
    workItemKind: 'task',
  },
  {
    name: 'read_task_list',
    description: 'Read a Microsoft To Do task list by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task list ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'taskList',
  },
  {
    name: 'update_task_list',
    description: 'Update the display name of a Microsoft To Do task list',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task list ID' },
        displayName: { type: 'string', description: 'New display name' },
      },
      required: ['id', 'displayName'],
    },
    categories: ['write'],
    entityType: 'taskList',
  },
  {
    name: 'delete_task_list',
    description: 'Delete a Microsoft To Do task list',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task list ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'taskList',
  },
];

// ─── Microsoft Contacts ──────────────────────────────────────────────────────

const MICROSOFT_CONTACTS_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_contact',
    description: 'Read a Microsoft contact by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'contact',
  },
  {
    name: 'create_contact',
    description: 'Create a new Microsoft contact',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses' },
        company: { type: 'string', description: 'Company name' },
        jobTitle: { type: 'string', description: 'Job title' },
      },
      required: ['firstName'],
    },
    categories: ['write'],
    entityType: 'contact',
  },
  {
    name: 'update_contact',
    description: 'Update an existing Microsoft contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact ID' },
        firstName: { type: 'string', description: 'Updated first name' },
        lastName: { type: 'string', description: 'Updated last name' },
        company: { type: 'string', description: 'Updated company' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'contact',
  },
  {
    name: 'delete_contact',
    description: 'Delete a Microsoft contact',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'contact',
  },
  {
    name: 'list_contacts',
    description: 'List Microsoft contacts',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'Max results (default 100)' },
        skip: { type: 'number', description: 'Items to skip for pagination' },
        folderId: { type: 'string', description: 'Contact folder ID (default: root)' },
      },
    },
    categories: ['read'],
    entityType: 'contact_list',
  },
  {
    name: 'list_contact_folders',
    description: 'List Microsoft contact folders',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'contact_folders',
  },
  {
    name: 'read_contact_folder',
    description: 'Read a Microsoft contact folder by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact folder ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'contactFolder',
  },
  {
    name: 'create_contact_folder',
    description: 'Create a new Microsoft contact folder',
    inputSchema: {
      type: 'object',
      properties: { displayName: { type: 'string', description: 'Folder display name' } },
      required: ['displayName'],
    },
    categories: ['write'],
    entityType: 'contactFolder',
  },
  {
    name: 'delete_contact_folder',
    description: 'Delete a Microsoft contact folder',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact folder ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'contactFolder',
  },
];

// ─── Microsoft OneNote ───────────────────────────────────────────────────────

const MICROSOFT_ONENOTE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_notebook',
    description: 'Read a OneNote notebook by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Notebook ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'notebook',
  },
  {
    name: 'read_page',
    description: 'Read a OneNote page by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Page ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'page',
  },
  {
    name: 'create_notebook',
    description: 'Create a new OneNote notebook',
    inputSchema: {
      type: 'object',
      properties: { displayName: { type: 'string', description: 'Notebook name' } },
      required: ['displayName'],
    },
    categories: ['write'],
    entityType: 'notebook',
  },
  {
    name: 'create_section',
    description: 'Create a new section in a OneNote notebook',
    inputSchema: {
      type: 'object',
      properties: {
        notebookId: { type: 'string', description: 'Notebook ID' },
        displayName: { type: 'string', description: 'Section name' },
      },
      required: ['notebookId', 'displayName'],
    },
    categories: ['write'],
    entityType: 'section',
  },
  {
    name: 'create_page',
    description: 'Create a new page in a OneNote section',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: { type: 'string', description: 'Section ID' },
        title: { type: 'string', description: 'Page title' },
        content: { type: 'string', description: 'HTML content' },
      },
      required: ['sectionId'],
    },
    categories: ['write'],
    entityType: 'page',
  },
  {
    name: 'update_page',
    description: 'Update a OneNote page content',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page ID' },
        content: { type: 'string', description: 'HTML content to append' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'page',
  },
  {
    name: 'delete_page',
    description: 'Delete a OneNote page',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Page ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'page',
  },
  {
    name: 'list_notebooks',
    description: 'List all OneNote notebooks',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'notebooks',
  },
  {
    name: 'list_sections',
    description: 'List sections in a OneNote notebook',
    inputSchema: {
      type: 'object',
      properties: { notebookId: { type: 'string', description: 'Notebook ID' } },
      required: ['notebookId'],
    },
    categories: ['read'],
    entityType: 'sections',
  },
  {
    name: 'list_pages',
    description: 'List pages in a OneNote section',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: { type: 'string', description: 'Section ID' },
        pageSize: { type: 'number', description: 'Results per page' },
      },
      required: ['sectionId'],
    },
    categories: ['read'],
    entityType: 'pages',
  },
  {
    name: 'read_section',
    description: 'Read a OneNote section by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Section ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'section',
  },
];

// ─── Microsoft SharePoint ────────────────────────────────────────────────────

const MICROSOFT_SHAREPOINT_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_site',
    description: 'Read a SharePoint site by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Site ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'site',
  },
  {
    name: 'read_list_item',
    description: 'Read an item from a SharePoint list',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Compound ID "siteId:listId:itemId"' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'listItem',
  },
  {
    name: 'read_list',
    description: 'Read a SharePoint list by site and list ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Compound ID "siteId:listId"' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'list',
  },
  {
    name: 'create_list',
    description: 'Create a new SharePoint list',
    inputSchema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', description: 'Site ID' },
        displayName: { type: 'string', description: 'List display name' },
      },
      required: ['siteId', 'displayName'],
    },
    categories: ['write'],
    entityType: 'list',
  },
  {
    name: 'create_list_item',
    description: 'Create a new item in a SharePoint list',
    inputSchema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', description: 'Site ID' },
        listId: { type: 'string', description: 'List ID' },
        fields: { type: 'object', description: 'Field values for the list item' },
      },
      required: ['siteId', 'listId', 'fields'],
    },
    categories: ['write'],
    entityType: 'listItem',
  },
  {
    name: 'update_list_item',
    description: 'Update field values on a SharePoint list item',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "siteId:listId:itemId"' },
        fields: { type: 'object', description: 'Field values to update' },
      },
      required: ['id', 'fields'],
    },
    categories: ['write'],
    entityType: 'listItem',
  },
  {
    name: 'delete_list_item',
    description: 'Delete an item from a SharePoint list',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Compound ID "siteId:listId:itemId"' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'listItem',
  },
  {
    name: 'list_sites',
    description: 'List SharePoint sites',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filter sites by name keyword' },
        pageSize: { type: 'number', description: 'Results per page' },
      },
    },
    categories: ['read'],
    entityType: 'sites',
  },
  {
    name: 'list_lists',
    description: 'List all lists in a SharePoint site',
    inputSchema: {
      type: 'object',
      properties: { siteId: { type: 'string', description: 'Site ID' } },
      required: ['siteId'],
    },
    categories: ['read'],
    entityType: 'lists',
  },
  {
    name: 'list_drive_items',
    description: 'List files and folders in a SharePoint document library',
    inputSchema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', description: 'Site ID' },
        folderId: { type: 'string', description: 'Folder ID (default: root)' },
        pageSize: { type: 'number', description: 'Results per page' },
      },
      required: ['siteId'],
    },
    categories: ['read'],
    entityType: 'drive_items',
  },
  {
    name: 'read_drive_item',
    description: 'Read a SharePoint document library item by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Compound ID "siteId:itemId"' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'driveItem',
  },
  {
    name: 'update_drive_item',
    description: 'Update the name or other metadata of a SharePoint document library item',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "siteId:itemId"' },
        name: { type: 'string', description: 'New item name' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'driveItem',
  },
  {
    name: 'create_folder',
    description: 'Create a new folder in a SharePoint document library',
    inputSchema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', description: 'Site ID' },
        parentId: { type: 'string', description: 'Parent folder item ID (default: root)' },
        name: { type: 'string', description: 'Folder name' },
      },
      required: ['siteId', 'name'],
    },
    categories: ['write'],
    entityType: 'folder',
  },
  {
    name: 'delete_list',
    description: 'Delete a SharePoint list',
    inputSchema: {
      type: 'object',
      properties: {
        siteId: { type: 'string', description: 'Site ID' },
        listId: { type: 'string', description: 'List ID to delete' },
      },
      required: ['siteId', 'listId'],
    },
    categories: ['destructive'],
    entityType: 'list',
  },
  {
    name: 'delete_drive_item',
    description: 'Delete a file or folder from a SharePoint document library',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Compound ID "siteId:itemId"' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'driveItem',
  },
];

// ─── Microsoft Planner ───────────────────────────────────────────────────────

const MICROSOFT_PLANNER_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_task',
    description: 'Read a Planner task by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'task',
  },
  {
    name: 'list_tasks',
    description: 'List all tasks in a Planner plan. Filter the result client-side to exclude percentComplete=100 to scope to the unhandled queue.',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string', description: 'Plan ID' } },
      required: ['planId'],
    },
    categories: ['read'],
    entityType: 'tasks',
    workRole: 'inbox',
    paired_ack: 'update_task',
    workItemKind: 'task',
  },
  {
    name: 'create_task',
    description: 'Create a new Planner task',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan ID' },
        bucketId: { type: 'string', description: 'Bucket ID' },
        title: { type: 'string', description: 'Task title' },
        dueDate: { type: 'string', description: 'Due date (ISO 8601)' },
        priority: { type: 'number', description: 'Priority (1=urgent, 5=medium, 9=low)' },
      },
      required: ['planId', 'title'],
    },
    categories: ['write'],
    entityType: 'task',
  },
  {
    name: 'create_bucket',
    description: 'Create a new bucket in a Planner plan',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan ID' },
        name: { type: 'string', description: 'Bucket name' },
      },
      required: ['planId', 'name'],
    },
    categories: ['write'],
    entityType: 'bucket',
  },
  {
    name: 'update_task',
    description: 'Update an existing Planner task. To acknowledge an inbox item, set percentComplete=100 so the next non-complete-filtered list does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        title: { type: 'string', description: 'New title' },
        percentComplete: { type: 'number', description: 'Completion % (0, 50, or 100)' },
        dueDate: { type: 'string', description: 'New due date' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'task',
    workRole: 'ack',
    acknowledges: 'list_tasks',
    workItemKind: 'task',
  },
  {
    name: 'delete_task',
    description: 'Delete a Planner task',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'task',
  },
  {
    name: 'read_bucket',
    description: 'Read a Microsoft Planner bucket by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Bucket ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'bucket',
  },
  {
    name: 'list_buckets',
    description: 'List all buckets in a Microsoft Planner plan',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string', description: 'Plan ID' } },
      required: ['planId'],
    },
    categories: ['read'],
    entityType: 'buckets',
  },
  {
    name: 'update_bucket',
    description: 'Update a Microsoft Planner bucket (rename)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Bucket ID' },
        name: { type: 'string', description: 'New bucket name' },
      },
      required: ['id', 'name'],
    },
    categories: ['write'],
    entityType: 'bucket',
  },
  {
    name: 'delete_bucket',
    description: 'Delete a Microsoft Planner bucket',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Bucket ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'bucket',
  },
];

// ─── Microsoft OneDrive ──────────────────────────────────────────────────────

const MICROSOFT_ONEDRIVE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_file',
    description: 'Read OneDrive file metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File item ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'file',
  },
  {
    name: 'read_folder',
    description: 'Read OneDrive folder metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder item ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'folder',
  },
  {
    name: 'create_folder',
    description: 'Create a new folder in OneDrive',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name' },
        parentId: { type: 'string', description: 'Parent folder ID (default "root")' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'folder',
  },
  {
    name: 'update_file',
    description: 'Update OneDrive file metadata (name, description)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File item ID' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'file',
  },
  {
    name: 'delete_file',
    description: 'Delete a file from OneDrive',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File item ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'file',
  },
  {
    name: 'delete_folder',
    description: 'Delete a folder from OneDrive',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder item ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'folder',
  },
  {
    name: 'list_files',
    description: 'List files and folders inside a OneDrive folder',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder item ID (default: root)' },
        pageSize: { type: 'number', description: 'Results per page (max 100)' },
        skipToken: { type: 'string', description: 'OData skip token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'search_files',
    description: 'Search for files in OneDrive by name',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        pageSize: { type: 'number', description: 'Results per page (max 100)' },
        skipToken: { type: 'string', description: 'OData skip token from a previous response' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'list_folders',
    description: 'List folders inside a OneDrive folder',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Parent folder item ID (default: root)' },
        pageSize: { type: 'number', description: 'Results per page (max 100)' },
        skipToken: { type: 'string', description: 'OData skip token from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'folders',
  },
];

// ─── Dropbox ─────────────────────────────────────────────────────────────────

const DROPBOX_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_file',
    description: 'Read Dropbox file metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File path or ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'file',
  },
  {
    name: 'read_folder',
    description: 'Read Dropbox folder metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder path or ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'folder',
  },
  {
    name: 'create_folder',
    description: 'Create a new folder in Dropbox',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path (e.g. "/Documents/New Folder")' },
      },
      required: ['path'],
    },
    categories: ['write'],
    entityType: 'folder',
  },
  {
    name: 'update_file',
    description: 'Move or rename a file in Dropbox',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Current file path or ID' },
        newPath: { type: 'string', description: 'New path' },
      },
      required: ['id', 'newPath'],
    },
    categories: ['write'],
    entityType: 'file',
  },
  {
    name: 'delete_file',
    description: 'Delete a file from Dropbox',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File path or ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'file',
  },
  {
    name: 'delete_folder',
    description: 'Delete a folder from Dropbox',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder path or ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'folder',
  },
  {
    name: 'list_files',
    description: 'List files and folders inside a Dropbox folder',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder path (e.g. "/Documents"). Default: root' },
        pageSize: { type: 'number', description: 'Results per page (max 2000)' },
        cursor: { type: 'string', description: 'Cursor from a previous response for continuation' },
      },
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'search_files',
    description: 'Search for files in Dropbox by name',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        path: { type: 'string', description: 'Limit search to this folder path' },
        pageSize: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'list_folders',
    description: 'List folders inside a Dropbox folder',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder path (e.g. "/Documents"). Default: root' },
        pageSize: { type: 'number', description: 'Results per page (max 2000)' },
        cursor: { type: 'string', description: 'Cursor from a previous response for continuation' },
      },
    },
    categories: ['read'],
    entityType: 'folders',
  },
  {
    name: 'update_folder',
    description: 'Move or rename a Dropbox folder',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Folder path or ID to move/rename' },
        toPath: { type: 'string', description: 'New path including the new name (e.g. "/New/Path/FolderName")' },
        autoRename: { type: 'boolean', description: 'Auto-rename if destination conflicts (default false)' },
      },
      required: ['id', 'toPath'],
    },
    categories: ['write'],
    entityType: 'folder',
  },
];

// ─── BambooHR ────────────────────────────────────────────────────────────────

const BAMBOOHR_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_employee',
    description: 'Get employee details by ID from BambooHR. Use id=0 to get the API key owner.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Employee ID (use "0" for the API key owner)' },
        fields: {
          type: 'string',
          description: 'Comma-separated list of fields to return (e.g. "firstName,lastName,workEmail,jobTitle"). Max 400 fields.',
        },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'GET /api/v1/employees/{id}',
  },
  {
    name: 'list_employees',
    description: 'List all active employees in the BambooHR company directory',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'GET /api/v1/employees/directory',
  },
  {
    name: 'get_employee_directory',
    description: 'Get the full company employee directory from BambooHR including field definitions',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'GET /api/v1/employees/directory',
  },
  {
    name: 'get_time_off_requests',
    description: 'List time-off requests from BambooHR with optional date range and status filters',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Start date filter (YYYY-MM-DD)' },
        end: { type: 'string', description: 'End date filter (YYYY-MM-DD)' },
        status: {
          type: 'string',
          description: 'Filter by status: approved, denied, superceded, requested, canceled',
        },
        employeeId: { type: 'string', description: 'Filter by employee ID' },
        type: { type: 'string', description: 'Filter by time-off type ID' },
      },
    },
    categories: ['read'],
    entityType: 'GET /api/v1/time_off/requests',
  },
  {
    name: 'approve_time_off',
    description: 'Approve a pending time-off request in BambooHR',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Time-off request ID to approve' },
        status: { type: 'string', enum: ['approved'], description: 'Always "approved" for this tool (sent in the request body).' },
        note: { type: 'string', description: 'Optional note to include with the approval' },
      },
      required: ['id', 'status'],
    },
    categories: ['write'],
    entityType: 'PUT /api/v1/time_off/requests/{id}/status',
  },
  {
    name: 'deny_time_off',
    description: 'Deny a pending time-off request in BambooHR',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Time-off request ID to deny' },
        status: { type: 'string', enum: ['denied'], description: 'Always "denied" for this tool (sent in the request body).' },
        note: { type: 'string', description: 'Optional reason for the denial' },
      },
      required: ['id', 'status'],
    },
    categories: ['write'],
    entityType: 'PUT /api/v1/time_off/requests/{id}/status',
  },
  {
    name: 'update_employee_field',
    description: 'Update one or more fields on a BambooHR employee record',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Employee ID' },
        body: {
          type: 'object',
          description: 'Object of field name → value pairs to update (e.g. { "department": "Engineering" }). Sent as the request body.',
        },
      },
      required: ['id', 'body'],
    },
    categories: ['write'],
    entityType: 'POST /api/v1/employees/{id}',
  },
  {
    name: 'get_job_info',
    description: "Get an employee's job title, department, division, location, and supervisor from BambooHR",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Employee ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'GET /api/v1/employees/{id}/tables/jobInfo',
  },
  {
    name: 'create_employee',
    description: 'Create a new employee record in BambooHR',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string', description: 'Employee first name' },
        lastName: { type: 'string', description: 'Employee last name' },
        workEmail: { type: 'string', description: 'Work email address' },
        department: { type: 'string', description: 'Department name' },
        jobTitle: { type: 'string', description: 'Job title' },
        hireDate: { type: 'string', description: 'Hire date (YYYY-MM-DD)' },
      },
      required: ['firstName', 'lastName'],
    },
    categories: ['write'],
    entityType: 'POST /api/v1/employees/',
  },
  {
    name: 'create_time_off',
    description: 'Submit a time-off request in BambooHR',
    inputSchema: {
      type: 'object',
      properties: {
        employeeId: { type: 'string', description: 'Employee ID' },
        timeOffTypeId: { type: 'number', description: 'Time-off type ID' },
        start: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        end: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        note: { type: 'string', description: 'Optional note' },
      },
      required: ['employeeId', 'timeOffTypeId', 'start', 'end'],
    },
    categories: ['write'],
    entityType: 'PUT /api/v1/employees/{employeeId}/time_off/request',
  },
];

// ─── Jira ─────────────────────────────────────────────────────────────────────

const JIRA_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'search_issues',
    description: 'Search Jira issues using JQL (Jira Query Language). Use jql="status != Done AND assignee = currentUser()" (or similar) to scope to the open inbox queue.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'JQL query string, e.g. "project = PROJ AND status = In Progress"' },
        maxResults: { type: 'string', description: 'Maximum number of results to return (default 50)' },
        startAt: { type: 'string', description: 'Starting index for pagination (default 0)' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Fields to include in the response (e.g. ["summary","status","assignee"])',
        },
      },
      required: ['jql'],
    },
    categories: ['read'],
    entityType: 'issues',
    // W1 inbox: search_issues is poll-shaped via JQL status filter;
    // transition_issue is the ack (move to Done/Closed).
    workRole: 'inbox',
    paired_ack: 'transition_issue',
    workItemKind: 'issue',
  },
  {
    name: 'get_issue',
    description: 'Get a Jira issue by its ID or key (e.g. PROJ-123)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue ID or key (e.g. PROJ-123)' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'issue',
  },
  {
    name: 'create_issue',
    description: 'Create a new Jira issue in a project',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key (e.g. PROJ)' },
        summary: { type: 'string', description: 'Issue summary / title' },
        issuetype: { type: 'string', description: 'Issue type name (e.g. Bug, Task, Story)' },
        description: { type: 'string', description: 'Plain text description of the issue' },
        priority: { type: 'string', description: 'Priority name (e.g. High, Medium, Low)' },
        assignee: { type: 'string', description: 'Assignee accountId' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels to apply to the issue',
        },
      },
      required: ['project', 'summary', 'issuetype'],
    },
    categories: ['write'],
    entityType: 'issue',
  },
  {
    name: 'update_issue',
    description: 'Update fields on an existing Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue ID or key (e.g. PROJ-123)' },
        summary: { type: 'string', description: 'New summary / title' },
        description: { type: 'string', description: 'New plain text description' },
        priority: { type: 'string', description: 'New priority name' },
        assignee: { type: 'string', description: 'New assignee accountId' },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'New labels (replaces existing labels)',
        },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'issue',
  },
  {
    name: 'transition_issue',
    description: 'Transition a Jira issue to a new status (e.g. move from "To Do" to "In Progress"). To acknowledge an inbox item, transition out of the status the inbox JQL filters on.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue ID or key (e.g. PROJ-123)' },
        transitionId: { type: 'string', description: 'Transition ID. Use get_issue first to find available transitions.' },
        transitionName: { type: 'string', description: 'Transition name as a hint (e.g. "In Progress"). transitionId takes precedence.' },
      },
      required: ['id', 'transitionId'],
    },
    categories: ['write'],
    entityType: 'transition',
    // W1 ack: acknowledges search_issues by changing workflow status.
    workRole: 'ack',
    acknowledges: 'search_issues',
    workItemKind: 'issue',
  },
  {
    name: 'add_comment',
    description: 'Add a comment to a Jira issue',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue ID or key (e.g. PROJ-123)' },
        text: { type: 'string', description: 'Comment text (plain text)' },
      },
      required: ['issueId', 'text'],
    },
    // 'outbound' — Jira comments are visible to every project member
    // and external watchers in customer-portal mode. Under
    // communication='draft' the tenant-runtime catalog filter wraps
    // this with HitlGateError (Jira has no draft-comment endpoint in
    // its REST API). Matches the Composio overlay tag for the same
    // tool (packages/composio-overlays/src/overlays/atlassian_jira.ts).
    categories: ['write', 'outbound'],
    entityType: 'comment',
  },
  {
    name: 'list_projects',
    description: 'List all Jira projects accessible to the current user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'projects',
  },
  {
    name: 'get_project',
    description: 'Get details for a specific Jira project by ID or key',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project ID or key (e.g. PROJ)' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'project',
  },
];

// ─── Confluence ───────────────────────────────────────────────────────────────

const CONFLUENCE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'search_pages',
    description: 'Search Confluence content using CQL (Confluence Query Language)',
    inputSchema: {
      type: 'object',
      properties: {
        cql: { type: 'string', description: 'CQL query string, e.g. "space.key = TEAM AND title ~ sprint"' },
        limit: { type: 'string', description: 'Maximum number of results (default 25)' },
      },
      required: ['cql'],
    },
    categories: ['read'],
    entityType: 'search',
  },
  {
    name: 'get_page',
    description: 'Get a Confluence page by its ID, including the page body content',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Confluence page ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'page',
  },
  {
    name: 'create_page',
    description: 'Create a new Confluence page in a space',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: { type: 'string', description: 'Space ID where the page will be created' },
        title: { type: 'string', description: 'Page title' },
        content: { type: 'string', description: 'Page body content in Confluence Storage Format (HTML-like XML)' },
        parentId: { type: 'string', description: 'Parent page ID (optional — creates at space root if omitted)' },
      },
      required: ['spaceId', 'title', 'content'],
    },
    categories: ['write'],
    entityType: 'page',
  },
  {
    name: 'update_page',
    description: 'Update an existing Confluence page. Requires the current version number.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Confluence page ID' },
        title: { type: 'string', description: 'New page title' },
        content: { type: 'string', description: 'New page body in Confluence Storage Format' },
        versionNumber: { type: 'string', description: 'Current version number + 1 (required by Confluence API)' },
        versionMessage: { type: 'string', description: 'Optional message describing this version' },
      },
      required: ['id', 'title', 'content', 'versionNumber'],
    },
    categories: ['write'],
    entityType: 'page',
  },
  {
    name: 'list_spaces',
    description: 'List all Confluence spaces accessible to the current user',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Space type filter: "global" or "personal"' },
        limit: { type: 'string', description: 'Maximum number of results (default 25)' },
      },
    },
    categories: ['read'],
    entityType: 'spaces',
  },
  {
    name: 'get_space',
    description: 'Get details for a specific Confluence space by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Confluence space ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'space',
  },
];

// ─── Linear ──────────────────────────────────────────────────────────────────

const LINEAR_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'create_issue',
    description: 'Create a new issue in a Linear team',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'The ID of the team to create the issue in' },
        title: { type: 'string', description: 'Issue title' },
        description: { type: 'string', description: 'Issue description (markdown)' },
        assigneeId: { type: 'string', description: 'User ID to assign the issue to' },
        priority: { type: 'string', description: 'Priority: 0=none, 1=urgent, 2=high, 3=normal, 4=low' },
        stateId: { type: 'string', description: 'Workflow state ID' },
        labelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to apply' },
        projectId: { type: 'string', description: 'Project ID to associate the issue with' },
      },
      required: ['teamId', 'title'],
    },
    categories: ['write'],
    entityType: 'issue',
  },
  {
    name: 'update_issue',
    description: 'Update an existing Linear issue — change state, assignee, priority, or labels. To acknowledge an inbox item, set stateId to a non-open workflow state (Done/Cancelled) so the next open-state-filtered list does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue ID (UUID) or identifier (e.g. ENG-123)' },
        title: { type: 'string', description: 'Updated title' },
        description: { type: 'string', description: 'Updated description (markdown)' },
        stateId: { type: 'string', description: 'New workflow state ID' },
        assigneeId: { type: 'string', description: 'New assignee user ID' },
        priority: { type: 'string', description: 'New priority: 0=none, 1=urgent, 2=high, 3=normal, 4=low' },
        labelIds: { type: 'array', items: { type: 'string' }, description: 'Replacement label IDs (replaces all existing labels)' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'issue',
    // W1 ack: acknowledges list_issues by transitioning out of an open workflow state.
    workRole: 'ack',
    acknowledges: 'list_issues',
    workItemKind: 'issue',
  },
  {
    name: 'list_issues',
    description: 'List Linear issues with optional filters by team, state, assignee, or priority. Filter by stateId to scope to the open (unhandled) queue.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Filter by team ID' },
        stateId: { type: 'string', description: 'Filter by workflow state ID' },
        assigneeId: { type: 'string', description: 'Filter by assignee user ID' },
        priority: { type: 'string', description: 'Filter by priority: 0=none, 1=urgent, 2=high, 3=normal, 4=low' },
      },
    },
    categories: ['read'],
    entityType: 'issues',
    // W1 inbox: list_issues with stateId filter is poll-shaped; update_issue
    // moves an item out of the open queue.
    workRole: 'inbox',
    paired_ack: 'update_issue',
    workItemKind: 'issue',
  },
  {
    name: 'get_issue',
    description: 'Get a specific Linear issue by ID or identifier (e.g. ENG-123)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue ID (UUID) or identifier (e.g. ENG-123)' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'issue',
  },
  {
    name: 'assign_issue',
    description: 'Assign a Linear issue to a team member',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue ID (UUID) or identifier (e.g. ENG-123)' },
        assigneeId: { type: 'string', description: 'User ID of the team member to assign' },
      },
      required: ['id', 'assigneeId'],
    },
    categories: ['write'],
    entityType: 'issue',
  },
  {
    name: 'list_teams',
    description: 'List all teams in the Linear workspace',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'teams',
  },
  {
    name: 'list_projects',
    description: 'List all projects in the Linear workspace with their status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'projects',
  },
  {
    name: 'archive_issue',
    description: 'Archive a Linear issue (Linear does not permanently delete issues)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue ID (UUID) or identifier (e.g. ENG-123)' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'issue',
  },
];

// ─── GitLab ──────────────────────────────────────────────────────────────────
// Native-REST merge-request tools (the review roles' surface). GitLab's vendor
// MCP needs an `mcp`-scope token our static OAuth app can't hold, so these run
// over the documented REST API with the connector's `api` token instead (see
// src/clients/gitlab.ts). `project` accepts a numeric id OR a "group/path"; both
// `project` and `merge_request_iid` come from the triggering connector-event.
const GITLAB_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'create_merge_request',
    description: 'Open a GitLab merge request from a pushed source branch into a target branch (e.g. main). Use after code has been committed and pushed.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or URL path, e.g. "group/repo"' },
        source_branch: { type: 'string', description: 'The branch containing the changes' },
        target_branch: { type: 'string', description: 'The branch to merge into, e.g. "main"' },
        title: { type: 'string', description: 'Merge request title' },
        description: { type: 'string', description: 'Merge request description (markdown)' },
      },
      required: ['project', 'source_branch', 'target_branch', 'title'],
    },
    categories: ['write'],
    entityType: 'merge_request',
  },
  {
    name: 'get_merge_request',
    description: 'Get a GitLab merge request (title, state, author, source/target branch) by its project and iid.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or URL path, e.g. "group/repo"' },
        merge_request_iid: { type: 'string', description: 'The merge request iid (per-project number)' },
      },
      required: ['project', 'merge_request_iid'],
    },
    categories: ['read'],
    idArgs: ['project', 'merge_request_iid'],
    returnsIds: [{ entityType: 'merge_request', path: 'iid' }],
    entityType: 'merge_request',
  },
  {
    name: 'get_merge_request_diffs',
    description: 'Read the file-by-file diff of a GitLab merge request — the changed code to review.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or URL path, e.g. "group/repo"' },
        merge_request_iid: { type: 'string', description: 'The merge request iid (per-project number)' },
      },
      required: ['project', 'merge_request_iid'],
    },
    categories: ['read'],
    idArgs: ['project', 'merge_request_iid'],
    entityType: 'merge_request_diffs',
  },
  {
    name: 'get_merge_request_notes',
    description: 'Read the existing comments (notes) on a GitLab merge request, oldest first — use to see what other reviewers have already raised before commenting.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or URL path, e.g. "group/repo"' },
        merge_request_iid: { type: 'string', description: 'The merge request iid (per-project number)' },
      },
      required: ['project', 'merge_request_iid'],
    },
    categories: ['read'],
    idArgs: ['project', 'merge_request_iid'],
    entityType: 'merge_request_notes',
  },
  {
    name: 'create_merge_request_note',
    description: 'Post a review comment (note) on a GitLab merge request.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project id or URL path, e.g. "group/repo"' },
        merge_request_iid: { type: 'string', description: 'The merge request iid (per-project number)' },
        body: { type: 'string', description: 'The comment body (markdown)' },
      },
      required: ['project', 'merge_request_iid', 'body'],
    },
    categories: ['write'],
    idArgs: ['project', 'merge_request_iid'],
    entityType: 'merge_request_note',
  },
];

// ─── Box ─────────────────────────────────────────────────────────────────────

const BOX_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_file',
    description: 'Read Box file metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'file',
  },
  {
    name: 'read_folder',
    description: 'Read Box folder metadata',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'folder',
  },
  {
    name: 'create_folder',
    description: 'Create a new folder in Box',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name' },
        parentId: { type: 'string', description: 'Parent folder ID (default "0" for root)' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'folder',
  },
  {
    name: 'update_file',
    description: 'Update Box file metadata or move it',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File ID' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        parentId: { type: 'string', description: 'Move to this folder' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'file',
  },
  {
    name: 'delete_file',
    description: 'Delete a file from Box (moves to trash)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'File ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'file',
  },
  {
    name: 'delete_folder',
    description: 'Delete a folder from Box (moves to trash)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Folder ID' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'folder',
  },
  {
    name: 'list_files',
    description: 'List items inside a Box folder',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder ID (default: "0" for root)' },
        pageSize: { type: 'number', description: 'Results per page (max 1000)' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'search_files',
    description: 'Search for files in Box by name or content',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        folderId: { type: 'string', description: 'Limit search to this folder' },
        pageSize: { type: 'number', description: 'Max results' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'files',
  },
  {
    name: 'list_folders',
    description: 'List folders inside a Box folder',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Parent folder ID (default: "0" for root)' },
        pageSize: { type: 'number', description: 'Max results per page (max 1000)' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'folders',
  },
];

// ─── DocuSign ─────────────────────────────────────────────────────────────────

const DOCUSIGN_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'send_envelope',
    description: 'Send a document for e-signature by creating a DocuSign envelope',
    inputSchema: {
      type: 'object',
      properties: {
        emailSubject: { type: 'string', description: 'Subject of the email sent to signers' },
        emailBlurb: { type: 'string', description: 'Optional message body to include in the email' },
        signerEmail: { type: 'string', description: 'Email address of the signer (single signer shortcut)' },
        signerName: { type: 'string', description: 'Display name of the signer' },
        documentBase64: { type: 'string', description: 'Base64-encoded document content' },
        documentName: { type: 'string', description: 'Name of the document (e.g. "Contract.pdf")' },
        fileExtension: { type: 'string', description: 'File extension of the document (e.g. "pdf")' },
        documents: { type: 'array', description: 'Array of document objects (advanced multi-document use)', items: { type: 'object' } },
        recipients: { type: 'object', description: 'Full DocuSign recipients object (advanced use; overrides signerEmail/signerName)' },
        templateId: { type: 'string', description: 'DocuSign template ID to use instead of uploading documents' },
        templateRoles: { type: 'array', description: 'Role assignments for the template', items: { type: 'object' } },
        status: { type: 'string', description: '"sent" to send immediately (default), "created" to save as draft' },
      },
      required: ['emailSubject'],
    },
    categories: ['write', 'outbound'],
    entityType: 'envelope',
  },
  {
    name: 'get_envelope_status',
    description: 'Get the current status and details of a DocuSign envelope',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'DocuSign envelope ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'envelope',
  },
  {
    name: 'list_envelopes',
    description: 'List DocuSign envelopes with optional status and date filters',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: sent, delivered, signed, completed, declined, voided' },
        from_date: { type: 'string', description: 'ISO 8601 date — return envelopes changed after this date (defaults to 30 days ago)' },
        count: { type: 'string', description: 'Maximum number of envelopes to return (default 20, max 100)' },
        start_position: { type: 'string', description: 'Starting position for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'envelopes',
  },
  {
    name: 'void_envelope',
    description: 'Void (cancel) a DocuSign envelope that is in sent or delivered status',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'DocuSign envelope ID to void' },
        voidedReason: { type: 'string', description: 'Reason for voiding the envelope (shown to recipients)' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'envelope_void',
  },
  {
    name: 'get_document',
    description: 'Download a signed document from a DocuSign envelope as base64-encoded content',
    inputSchema: {
      type: 'object',
      properties: {
        envelopeId: { type: 'string', description: 'DocuSign envelope ID' },
        documentId: { type: 'string', description: 'Document ID within the envelope, or "combined" for all documents merged into one PDF (default)' },
      },
      required: ['envelopeId'],
    },
    categories: ['read'],
    entityType: 'document',
  },
  {
    name: 'list_recipients',
    description: 'List all recipients for a DocuSign envelope and their signing status',
    inputSchema: {
      type: 'object',
      properties: {
        envelopeId: { type: 'string', description: 'DocuSign envelope ID' },
      },
      required: ['envelopeId'],
    },
    categories: ['read'],
    entityType: 'recipients',
  },
  {
    name: 'create_envelope',
    description: 'Create a DocuSign envelope as a draft (status="created") without sending it immediately',
    inputSchema: {
      type: 'object',
      properties: {
        emailSubject: { type: 'string', description: 'Subject of the email sent to signers' },
        emailBlurb: { type: 'string', description: 'Optional message body' },
        signerEmail: { type: 'string', description: 'Email address of the signer' },
        signerName: { type: 'string', description: 'Display name of the signer' },
        documentBase64: { type: 'string', description: 'Base64-encoded document content' },
        documentName: { type: 'string', description: 'Document name (e.g. "Contract.pdf")' },
        fileExtension: { type: 'string', description: 'File extension (e.g. "pdf")' },
        documents: { type: 'array', items: { type: 'object' }, description: 'Array of document objects (multi-document)' },
        recipients: { type: 'object', description: 'Full DocuSign recipients object' },
        templateId: { type: 'string', description: 'DocuSign template ID' },
        templateRoles: { type: 'array', items: { type: 'object' }, description: 'Role assignments for the template' },
      },
      required: ['emailSubject'],
    },
    categories: ['write'],
    entityType: 'envelope',
  },
  {
    name: 'update_envelope',
    description: 'Update a DocuSign envelope (e.g. change status from "created" to "sent", or update recipients)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'DocuSign envelope ID' },
        status: { type: 'string', description: 'New status: sent, voided, created' },
        emailSubject: { type: 'string', description: 'Updated email subject' },
        voidedReason: { type: 'string', description: 'Reason for voiding (when status=voided)' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'envelope',
  },
  {
    name: 'manage_recipients',
    description: 'Add, update, or delete recipients on a DocuSign envelope',
    inputSchema: {
      type: 'object',
      properties: {
        envelopeId: { type: 'string', description: 'DocuSign envelope ID' },
        recipients: { type: 'object', description: 'DocuSign recipients object with signers, cc, etc.' },
        operation: { type: 'string', description: '"add", "update", or "delete" (default: add)' },
      },
      required: ['envelopeId', 'recipients'],
    },
    categories: ['write'],
    entityType: 'recipients',
  },
];

// ─── Plaid ────────────────────────────────────────────────────────────────────
// Read-only banking connector. All functions are in the 'read' or 'sensitive'
// category — Plaid surfaces financial data but initiates no mutations.

const PLAID_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_accounts',
    description: 'List all connected bank accounts with cached balance information. For real-time balances use get_balance.',
    inputSchema: {
      type: 'object',
      properties: {
        account_ids: {
          type: 'array',
          description: 'Optional list of account IDs to filter results. Omit to return all accounts.',
          items: { type: 'string' },
        },
      },
    },
    categories: ['read', 'sensitive'],
    entityType: 'accounts',
  },
  {
    name: 'get_transactions',
    description: 'Get transaction history for a date range across connected bank accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format (inclusive)',
        },
        end_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format (inclusive)',
        },
        account_ids: {
          type: 'array',
          description: 'Optional list of account IDs to filter. Omit to return transactions for all accounts.',
          items: { type: 'string' },
        },
        count: {
          type: 'number',
          description: 'Number of transactions to return (default 100, max 500)',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default 0)',
        },
      },
      required: ['start_date', 'end_date'],
    },
    categories: ['read', 'sensitive'],
    entityType: 'transactions',
  },
  {
    name: 'get_balance',
    description: 'Get current real-time balance for connected bank accounts. Forces a live refresh — more accurate but slower than get_accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        account_ids: {
          type: 'array',
          description: 'Optional list of account IDs to retrieve balances for. Omit to return balances for all accounts.',
          items: { type: 'string' },
        },
      },
    },
    categories: ['read', 'sensitive'],
    entityType: 'balance',
  },
  {
    name: 'get_identity',
    description: 'Get account holder identity information including names, addresses, emails, and phone numbers on file at the bank.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read', 'sensitive'],
    entityType: 'identity',
  },
  {
    name: 'get_liabilities',
    description: 'Get loan and credit card liability data (student loans, mortgages, credit cards). Requires the Liabilities product to have been enabled during bank connection.',
    inputSchema: {
      type: 'object',
      properties: {
        account_ids: {
          type: 'array',
          description: 'Optional list of account IDs to filter liability data.',
          items: { type: 'string' },
        },
      },
    },
    categories: ['read', 'sensitive'],
    entityType: 'liabilities',
  },
];


// ─── Mailchimp ───────────────────────────────────────────────────────────────

const MAILCHIMP_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_campaigns',
    description: 'List Mailchimp campaigns, optionally filtered by status',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by campaign status: save, paused, schedule, sending, sent',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default 10, max 1000)',
        },
        offset: {
          type: 'number',
          description: 'Starting position in results for pagination',
        },
      },
    },
    categories: ['read'],
    entityType: 'list_campaigns',
  },
  {
    name: 'get_campaign',
    description: 'Get details and settings for a specific Mailchimp campaign',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'campaign',
  },
  {
    name: 'create_campaign',
    description: 'Create a new Mailchimp email campaign. The campaign will be in "save" status and must be sent or scheduled separately.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Campaign type: regular, plaintext, absplit, rss, or variate',
        },
        recipients: {
          type: 'object',
          description: 'Audience to send to. Must include list_id (the audience ID).',
          properties: {
            list_id: { type: 'string', description: 'Mailchimp audience (list) ID' },
          },
        },
        settings: {
          type: 'object',
          description: 'Campaign settings',
          properties: {
            subject_line: { type: 'string', description: 'Email subject line' },
            preview_text: { type: 'string', description: 'Preview text that appears in inbox' },
            title: { type: 'string', description: 'Internal campaign title (not shown to recipients)' },
            from_name: { type: 'string', description: 'Sender display name' },
            reply_to: { type: 'string', description: 'Reply-to email address' },
          },
        },
      },
      required: ['type', 'recipients', 'settings'],
    },
    categories: ['write'],
    entityType: 'campaign',
  },
  {
    name: 'send_campaign',
    description: 'Send a Mailchimp campaign immediately. The campaign must have content set and be in a sendable state. This action is irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'ID of the campaign to send' },
      },
      required: ['campaign_id'],
    },
    categories: ['write', 'outbound', 'destructive'],
    entityType: 'send_campaign',
  },
  {
    name: 'schedule_campaign',
    description: 'Schedule a Mailchimp campaign for future delivery at a specified time.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'ID of the campaign to schedule' },
        schedule_time: {
          type: 'string',
          description: 'ISO 8601 datetime for scheduled delivery (e.g. "2024-12-25T10:00:00+00:00")',
        },
        timewarp: {
          type: 'boolean',
          description: "If true, schedule based on each subscriber's local time zone (requires Mailchimp Pro)",
        },
      },
      required: ['campaign_id', 'schedule_time'],
    },
    categories: ['write', 'outbound'],
    entityType: 'schedule_campaign',
  },
  {
    name: 'get_campaign_report',
    description: 'Get performance metrics for a sent Mailchimp campaign, including opens, clicks, bounces, and unsubscribes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign ID to retrieve the report for' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'report',
  },
  {
    name: 'list_audience_members',
    description: 'List members of a Mailchimp audience (list)',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Mailchimp audience (list) ID' },
        status: {
          type: 'string',
          description: 'Filter by subscription status: subscribed, unsubscribed, cleaned, pending',
        },
        count: { type: 'number', description: 'Number of results to return (default 10, max 1000)' },
        offset: { type: 'number', description: 'Starting position in results for pagination' },
      },
      required: ['list_id'],
    },
    categories: ['read'],
    entityType: 'list_members',
  },
  {
    name: 'add_audience_member',
    description: 'Add a new contact to a Mailchimp audience (list)',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Mailchimp audience (list) ID' },
        email_address: { type: 'string', description: 'Contact email address' },
        status: {
          type: 'string',
          description: 'Subscription status: subscribed, unsubscribed, cleaned, or pending',
        },
        merge_fields: {
          type: 'object',
          description: 'Merge tag values (e.g. FNAME, LNAME). Keys are the merge tag names.',
          properties: {},
        },
        tags: {
          type: 'array',
          description: 'Tags to apply to the contact',
          items: { type: 'string' },
        },
      },
      required: ['list_id', 'email_address', 'status'],
    },
    categories: ['write'],
    entityType: 'list_member',
  },
  {
    name: 'update_audience_member',
    description: 'Update contact data or subscription status for a Mailchimp audience member',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Mailchimp audience (list) ID' },
        email_address: {
          type: 'string',
          description: 'Contact email address (used to identify the member)',
        },
        status: {
          type: 'string',
          description: 'Updated subscription status: subscribed, unsubscribed, cleaned, or pending',
        },
        merge_fields: {
          type: 'object',
          description: 'Updated merge tag values (e.g. FNAME, LNAME)',
          properties: {},
        },
      },
      required: ['list_id', 'email_address'],
    },
    categories: ['write'],
    entityType: 'list_member',
  },
];

// ─── Rippling HRIS ───────────────────────────────────────────────────────────
// Wave 1, Tier 3. API: https://api.rippling.com
// Confirmed endpoints (2026-04-15): /platform/api/{employees,departments,custom_fields}
//   /payroll/api/{time_off_requests,timecards}
// Payroll run summary endpoint not publicly available — omitted per API_REFERENCE.md


// ─── Gusto ───────────────────────────────────────────────────────────────────
// Wave 2, Tier 4. API: https://api.gusto.com/v1
// Confirmed endpoints (2026-04-15): /companies/{id}/employees, /employees/{id},
//   /companies/{id}/payrolls, /companies/{id}/time_off_requests,
//   /companies/{id}/company_benefits


// ─── HubSpot ─────────────────────────────────────────────────────────────────
// Tier 3. API: https://api.hubapi.com/crm/v3
// Reads route through HubSpotMCPClient (vendor MCP at mcp.hubspot.com);
// writes route through HubSpotWriteClient (direct REST). Both share the same
// OAuth app credentials and are registered together under the 'hubspot' key.

const HUBSPOT_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_contact',
    description: 'Get a HubSpot contact by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'HubSpot contact ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'contact',
  },
  {
    name: 'read_company',
    description: 'Get a HubSpot company by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'HubSpot company ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'company',
  },
  {
    name: 'read_deal',
    description: 'Get a HubSpot deal by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'HubSpot deal ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'deal',
  },
  {
    name: 'read_ticket',
    description: 'Get a HubSpot ticket by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'HubSpot ticket ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'ticket',
  },
  {
    name: 'read_invoice',
    description: 'Get a HubSpot invoice by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'HubSpot invoice ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'invoice',
  },
  {
    name: 'list_contacts',
    description: 'List HubSpot contacts with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'contacts',
  },
  {
    name: 'list_deals',
    description: 'List HubSpot deals',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'deals',
  },
  {
    name: 'list_companies',
    description: 'List HubSpot companies',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'companies',
  },
  {
    name: 'list_tickets',
    description: 'List HubSpot support tickets',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'tickets',
  },
  {
    name: 'create_contact',
    description: 'Create a new contact in HubSpot CRM',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email address' },
        firstname: { type: 'string', description: 'First name' },
        lastname: { type: 'string', description: 'Last name' },
        phone: { type: 'string', description: 'Phone number' },
        company: { type: 'string', description: 'Company name' },
        jobtitle: { type: 'string', description: 'Job title' },
      },
    },
    categories: ['write'],
    entityType: 'contact',
  },
  {
    name: 'update_contact',
    description: 'Update an existing HubSpot contact by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'HubSpot contact ID' },
        email: { type: 'string', description: 'Updated email address' },
        firstname: { type: 'string', description: 'Updated first name' },
        lastname: { type: 'string', description: 'Updated last name' },
        phone: { type: 'string', description: 'Updated phone number' },
        company: { type: 'string', description: 'Updated company name' },
        jobtitle: { type: 'string', description: 'Updated job title' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'contact',
  },
  {
    name: 'delete_contact',
    description: 'Delete a HubSpot contact (moves to recycling bin, recoverable for 90 days)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'HubSpot contact ID to delete' },
      },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'contact',
  },
  {
    name: 'create_deal',
    description: 'Create a new deal in HubSpot CRM',
    inputSchema: {
      type: 'object',
      properties: {
        dealname: { type: 'string', description: 'Deal name (required)' },
        dealstage: { type: 'string', description: 'Deal stage internal ID (get from HubSpot pipeline settings)' },
        pipeline: { type: 'string', description: 'Pipeline internal ID (defaults to "default")' },
        amount: { type: 'string', description: 'Deal amount as a string' },
        closedate: { type: 'string', description: 'Expected close date (ISO 8601, e.g. 2026-12-31T00:00:00Z)' },
      },
      required: ['dealname'],
    },
    categories: ['write'],
    entityType: 'deal',
  },
  {
    name: 'update_deal',
    description: 'Update an existing HubSpot deal by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'HubSpot deal ID' },
        dealname: { type: 'string', description: 'Updated deal name' },
        dealstage: { type: 'string', description: 'Updated deal stage internal ID' },
        amount: { type: 'string', description: 'Updated deal amount' },
        closedate: { type: 'string', description: 'Updated close date (ISO 8601)' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'deal',
  },
  {
    name: 'create_company',
    description: 'Create a new company record in HubSpot CRM',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company name (required)' },
        domain: { type: 'string', description: 'Company website domain (e.g. acme.com)' },
        industry: { type: 'string', description: 'Industry identifier (e.g. TECHNOLOGY)' },
        phone: { type: 'string', description: 'Company phone number' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'company',
  },
  {
    name: 'log_activity',
    description: 'Log an activity (note, email, or call) in HubSpot CRM and optionally associate it with a contact, company, or deal',
    inputSchema: {
      type: 'object',
      properties: {
        activity_type: {
          type: 'string',
          description: 'Type of activity: "note" (default), "email", or "call"',
          enum: ['note', 'email', 'call'],
        },
        hs_note_body: { type: 'string', description: 'Note body text (for activity_type: note)' },
        hs_timestamp: { type: 'string', description: 'Activity timestamp (ISO 8601, defaults to now)' },
        associations: {
          type: 'array',
          description: 'CRM objects to associate this activity with',
          items: {
            type: 'object',
            properties: {
              objectType: { type: 'string', description: 'CRM object type: contact, company, deal' },
              objectId: { type: 'string', description: 'CRM object ID' },
            },
          },
        },
      },
    },
    categories: ['write'],
    entityType: 'engagement',
  },
];

// ─── Zendesk ─────────────────────────────────────────────────────────────────

const ZENDESK_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_tickets',
    description: 'List Zendesk support tickets with optional sorting and pagination. The inbox queue is tickets with status in (open, pending, hold) — filter client-side.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'string', description: 'Number of results per page (max 100)' },
        pageAfter: { type: 'string', description: 'Cursor for next page (from meta.after_cursor)' },
        sortBy: { type: 'string', description: 'Field to sort by: created_at, updated_at, status' },
        sortOrder: { type: 'string', description: 'Sort direction: asc or desc' },
      },
    },
    categories: ['read'],
    entityType: 'tickets',
    // W1 inbox: open/pending/hold tickets are the unhandled queue;
    // update_ticket with status=solved or closed is the ack.
    workRole: 'inbox',
    paired_ack: 'update_ticket',
    workItemKind: 'support_ticket',
  },
  {
    name: 'get_ticket',
    description: 'Get a Zendesk support ticket by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'ticket',
  },
  {
    name: 'create_ticket',
    description: 'Create a new Zendesk support ticket',
    inputSchema: {
      type: 'object',
      properties: {
        comment: { type: 'string', description: 'Initial ticket comment / description (required)' },
        subject: { type: 'string', description: 'Ticket subject / title' },
        priority: { type: 'string', description: 'Priority: low | normal | high | urgent' },
        requester_id: { type: 'string', description: 'User ID of the requester' },
        assignee_id: { type: 'string', description: 'User ID of the assignee' },
        group_id: { type: 'string', description: 'Group ID to assign the ticket to' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply to the ticket',
        },
      },
      required: ['comment'],
    },
    categories: ['write'],
    entityType: 'ticket',
  },
  {
    name: 'update_ticket',
    description: 'Update an existing Zendesk ticket — change status, priority, assignee, or add a comment. To acknowledge an inbox item, set status to solved or closed so the next inbox-filtered list does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket ID' },
        subject: { type: 'string', description: 'New ticket subject' },
        status: { type: 'string', description: 'New status: open | pending | hold | solved | closed' },
        priority: { type: 'string', description: 'New priority: low | normal | high | urgent' },
        assignee_id: { type: 'string', description: 'New assignee user ID' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement tags (replaces all existing tags)',
        },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'ticket',
    // W1 ack: acknowledges list_tickets by transitioning out of the open queue.
    workRole: 'ack',
    acknowledges: 'list_tickets',
    workItemKind: 'support_ticket',
  },
  {
    name: 'add_comment',
    description: 'Add a comment or internal note to a Zendesk ticket',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket ID to comment on' },
        body: { type: 'string', description: 'Comment text' },
        public: { type: 'string', description: 'true = public reply, false = internal note (default true)' },
        author_id: { type: 'string', description: 'Author user ID (defaults to authenticated user)' },
      },
      required: ['ticketId', 'body'],
    },
    // 'outbound' — Zendesk add_comment defaults to public=true (visible
    // to the requester / customer). The agent picks the `public` flag,
    // so we can't safely classify the tool based on intent. Tag as
    // outbound and let the tenant-runtime catalog filter wrap with
    // HitlGateError under communication='draft'. A future
    // `add_internal_note` tool (public=false hard-coded) would be the
    // natural draftVariant if/when added.
    categories: ['write', 'outbound'],
    entityType: 'comment',
  },
  {
    name: 'search_tickets',
    description: 'Search Zendesk tickets using Zendesk search syntax',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Zendesk search query (e.g. "status:open priority:high")' },
        pageSize: { type: 'string', description: 'Number of results per page (max 100)' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'search',
  },
  {
    name: 'list_users',
    description: 'List Zendesk users with optional role filter and pagination',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Filter by role: end-user | agent | admin' },
        pageSize: { type: 'string', description: 'Number of results per page (max 100)' },
        pageAfter: { type: 'string', description: 'Cursor for next page' },
      },
    },
    categories: ['read'],
    entityType: 'users',
  },
  {
    name: 'get_user',
    description: 'Get a Zendesk user by their ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'user',
  },
  {
    name: 'create_user',
    description: 'Create a new Zendesk user (end-user, agent, or admin)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name of the user' },
        email: { type: 'string', description: 'Email address' },
        role: { type: 'string', description: 'Role: end-user | agent | admin (default end-user)' },
        organization_id: { type: 'string', description: 'Organization ID to associate the user with' },
        phone: { type: 'string', description: 'Phone number' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'user',
  },
  {
    name: 'update_user',
    description: 'Update an existing Zendesk user',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'User ID' },
        name: { type: 'string', description: 'New full name' },
        email: { type: 'string', description: 'New email address' },
        role: { type: 'string', description: 'New role: end-user | agent | admin' },
        organization_id: { type: 'string', description: 'New organization ID' },
        phone: { type: 'string', description: 'New phone number' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'user',
  },
  {
    name: 'list_organizations',
    description: 'List all Zendesk organizations with optional pagination',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'string', description: 'Number of results per page (max 100)' },
        pageAfter: { type: 'string', description: 'Cursor for next page' },
      },
    },
    categories: ['read'],
    entityType: 'organizations',
  },
  {
    name: 'get_organization',
    description: 'Get a Zendesk organization by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Organization ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'organization',
  },
  {
    name: 'list_articles',
    description: 'List Help Center articles in the Zendesk knowledge base',
    inputSchema: {
      type: 'object',
      properties: {
        locale: { type: 'string', description: 'Locale filter (e.g. en-us)' },
        sortBy: { type: 'string', description: 'Sort field: position | title | created_at | updated_at' },
        sortOrder: { type: 'string', description: 'Sort direction: asc or desc' },
        pageSize: { type: 'string', description: 'Number of results per page (max 100)' },
        pageAfter: { type: 'string', description: 'Cursor for next page' },
      },
    },
    categories: ['read'],
    entityType: 'articles',
  },
  {
    name: 'get_article',
    description: 'Get a Zendesk Help Center article by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Article ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'article',
  },
  {
    name: 'search_articles',
    description: 'Search Zendesk Help Center articles by keyword',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        locale: { type: 'string', description: 'Filter by locale (e.g. en-us)' },
        sectionId: { type: 'string', description: 'Filter by section ID' },
        perPage: { type: 'string', description: 'Results per page (max 25)' },
        page: { type: 'string', description: 'Page number (offset pagination)' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'articles_search',
  },
];

// ─── Trello ───────────────────────────────────────────────────────────────────

const TRELLO_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_boards',
    description: 'List all Trello boards accessible to the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'boards',
  },
  {
    name: 'get_board',
    description: 'Get details of a specific Trello board by ID',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', description: 'Trello board ID' },
      },
      required: ['board_id'],
    },
    categories: ['read'],
    entityType: 'board',
  },
  {
    name: 'list_lists',
    description: 'List all open lists on a Trello board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', description: 'Trello board ID' },
      },
      required: ['board_id'],
    },
    categories: ['read'],
    entityType: 'lists',
  },
  {
    name: 'list_cards',
    description: 'List cards on a Trello board or within a specific list. Provide board_id to get all board cards, or list_id to get cards in a specific list. One of the two is required. For inbox-style workflows, scope by list_id="<incoming list ID>" so only the cards in your incoming list are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', description: 'Trello board ID — returns all open cards on the board' },
        list_id: { type: 'string', description: 'Trello list ID — returns cards in this specific list' },
      },
    },
    categories: ['read'],
    entityType: 'cards',
    workRole: 'inbox',
    paired_ack: 'update_card',
    workItemKind: 'card',
  },
  {
    name: 'get_card',
    description: 'Get full details of a specific Trello card by ID',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'Trello card ID' },
      },
      required: ['card_id'],
    },
    categories: ['read'],
    entityType: 'card',
  },
  {
    name: 'create_card',
    description: 'Create a new card in a Trello list',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'ID of the list to create the card in' },
        name: { type: 'string', description: 'Card title/name' },
        desc: { type: 'string', description: 'Card description (supports markdown)' },
        due: { type: 'string', description: 'Due date in ISO 8601 format (e.g. 2026-05-01T09:00:00Z)' },
        member_ids: {
          type: 'array',
          description: 'Array of Trello member IDs to assign to the card',
          items: { type: 'string' },
        },
      },
      required: ['list_id', 'name'],
    },
    categories: ['write'],
    entityType: 'card',
  },
  {
    name: 'update_card',
    description: 'Update an existing Trello card — rename, change description, set due date, move to another list, or unarchive. To acknowledge an inbox item, move it out of the inbox list (set list_id to a "done" or "in progress" list) so the next inbox-list-filtered fetch does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'ID of the card to update' },
        name: { type: 'string', description: 'New card title' },
        desc: { type: 'string', description: 'New card description' },
        due: { type: 'string', description: 'New due date in ISO 8601 format, or null to clear' },
        list_id: { type: 'string', description: 'Move card to this list ID' },
        closed: { type: 'boolean', description: 'Set to true to archive, false to unarchive' },
      },
      required: ['card_id'],
    },
    categories: ['write'],
    entityType: 'card',
    workRole: 'ack',
    acknowledges: 'list_cards',
    workItemKind: 'card',
  },
  {
    name: 'delete_card',
    description: 'Permanently delete a Trello card. This cannot be undone — prefer archive_card if you want to recover the card later.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'ID of the card to delete' },
      },
      required: ['card_id'],
    },
    categories: ['destructive'],
    entityType: 'card',
  },
  {
    name: 'add_card_comment',
    description: 'Add a comment to a Trello card',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'ID of the card to comment on' },
        text: { type: 'string', description: 'Comment text' },
      },
      required: ['card_id', 'text'],
    },
    categories: ['write', 'outbound'],
    entityType: 'comment',
  },
  {
    name: 'list_board_members',
    description: 'List all members of a Trello board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', description: 'Trello board ID' },
      },
      required: ['board_id'],
    },
    categories: ['read'],
    entityType: 'board_members',
  },
  {
    name: 'archive_card',
    description: 'Archive a Trello card (sets closed=true). The card is hidden from the board but can be recovered. Use delete_card for permanent removal.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'ID of the card to archive' },
      },
      required: ['card_id'],
    },
    categories: ['write'],
    entityType: 'card',
  },
  {
    name: 'create_list',
    description: 'Create a new list on a Trello board',
    inputSchema: {
      type: 'object',
      properties: {
        idBoard: { type: 'string', description: 'Board ID to add the list to' },
        name: { type: 'string', description: 'List name' },
        pos: { type: 'string', description: 'Position: "top", "bottom", or a positive number' },
      },
      required: ['idBoard', 'name'],
    },
    categories: ['write'],
    entityType: 'list',
  },
  {
    name: 'update_list',
    description: 'Update a Trello list (rename, reposition, or close)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'List ID' },
        name: { type: 'string', description: 'New list name' },
        pos: { type: 'string', description: 'New position' },
        closed: { type: 'boolean', description: 'Archive the list' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'list',
  },
  {
    name: 'delete_list',
    description: 'Archive a Trello list (Trello does not support permanent list deletion via API)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'List ID to archive' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'list',
  },
  {
    name: 'create_board',
    description: 'Create a new Trello board',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Board name' },
        desc: { type: 'string', description: 'Board description' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'board',
  },
  {
    name: 'update_board',
    description: 'Update a Trello board (rename, description, or close)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Board ID' },
        name: { type: 'string', description: 'New board name' },
        desc: { type: 'string', description: 'New description' },
        closed: { type: 'boolean', description: 'Archive the board' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'board',
  },
];

// ─── Asana ───────────────────────────────────────────────────────────────────

const ASANA_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_projects',
    description: 'List all projects in an Asana workspace',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_gid: { type: 'string', description: 'Workspace GID to list projects from' },
        archived: { type: 'boolean', description: 'If true, return only archived projects; if false (default), return active projects' },
      },
      required: ['workspace_gid'],
    },
    categories: ['read'],
    entityType: 'projects',
  },
  {
    name: 'get_project',
    description: 'Get details for a specific Asana project by its GID',
    inputSchema: {
      type: 'object',
      properties: {
        project_gid: { type: 'string', description: 'Project GID' },
      },
      required: ['project_gid'],
    },
    categories: ['read'],
    entityType: 'project',
  },
  {
    name: 'list_tasks',
    description: 'List tasks for an Asana project with optional filters. The default completed=false scopes to the inbox queue of incomplete tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        project_gid: { type: 'string', description: 'Project GID to list tasks from' },
        completed: { type: 'boolean', description: 'Filter by completion status. Defaults to false (incomplete tasks only).' },
        assignee: { type: 'string', description: 'Filter by assignee GID or email' },
        limit: { type: 'number', description: 'Maximum number of tasks to return (max 100)' },
      },
      required: ['project_gid'],
    },
    categories: ['read'],
    entityType: 'tasks',
    workRole: 'inbox',
    paired_ack: 'update_task',
    workItemKind: 'task',
  },
  {
    name: 'get_task',
    description: 'Get details for a specific Asana task by its GID',
    inputSchema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'Task GID' },
      },
      required: ['task_gid'],
    },
    categories: ['read'],
    entityType: 'task',
  },
  {
    name: 'create_task',
    description: 'Create a new task in an Asana project',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_gid: { type: 'string', description: 'Workspace GID' },
        project_gid: { type: 'string', description: 'Project GID to add the task to' },
        name: { type: 'string', description: 'Task name' },
        notes: { type: 'string', description: 'Task description / notes' },
        assignee: { type: 'string', description: 'Assignee user GID or email address' },
        due_on: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
      },
      required: ['workspace_gid', 'project_gid', 'name'],
    },
    categories: ['write'],
    entityType: 'task',
  },
  {
    name: 'update_task',
    description: 'Update an existing Asana task. To acknowledge an inbox item, set completed=true so the next default list_tasks (completed=false) does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'Task GID to update' },
        name: { type: 'string', description: 'New task name' },
        notes: { type: 'string', description: 'New task notes / description' },
        completed: { type: 'boolean', description: 'Mark the task as completed or incomplete' },
        assignee: { type: 'string', description: 'New assignee user GID or email address' },
        due_on: { type: 'string', description: 'New due date in YYYY-MM-DD format' },
      },
      required: ['task_gid'],
    },
    categories: ['write'],
    entityType: 'task',
    workRole: 'ack',
    acknowledges: 'list_tasks',
    workItemKind: 'task',
  },
  {
    name: 'delete_task',
    description: 'Permanently delete an Asana task',
    inputSchema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'Task GID to delete' },
      },
      required: ['task_gid'],
    },
    categories: ['destructive'],
    entityType: 'task',
  },
  {
    name: 'list_task_comments',
    description: 'List stories (comments and activity) on an Asana task',
    inputSchema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'Task GID to list stories for' },
      },
      required: ['task_gid'],
    },
    categories: ['read'],
    entityType: 'task_comments',
  },
  {
    name: 'add_task_comment',
    description: 'Add a comment to an Asana task',
    inputSchema: {
      type: 'object',
      properties: {
        task_gid: { type: 'string', description: 'Task GID to comment on' },
        text: { type: 'string', description: 'Comment text' },
      },
      required: ['task_gid', 'text'],
    },
    categories: ['write', 'outbound'],
    entityType: 'task_comment',
  },
  {
    name: 'list_users',
    description: 'List users in an Asana workspace',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_gid: { type: 'string', description: 'Workspace GID to list users from' },
      },
      required: ['workspace_gid'],
    },
    categories: ['read'],
    entityType: 'users',
  },
  {
    name: 'list_sections',
    description: 'List sections in an Asana project',
    inputSchema: {
      type: 'object',
      properties: {
        project_gid: { type: 'string', description: 'Project GID to list sections from' },
      },
      required: ['project_gid'],
    },
    categories: ['read'],
    entityType: 'sections',
  },
  {
    name: 'create_section',
    description: 'Create a new section in an Asana project',
    inputSchema: {
      type: 'object',
      properties: {
        project_gid: { type: 'string', description: 'Project GID to add the section to' },
        name: { type: 'string', description: 'Section name' },
      },
      required: ['project_gid', 'name'],
    },
    categories: ['write'],
    entityType: 'section',
  },
  {
    name: 'update_section',
    description: 'Update an Asana section (rename)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Section GID to update' },
        name: { type: 'string', description: 'New section name' },
      },
      required: ['id', 'name'],
    },
    categories: ['write'],
    entityType: 'section',
  },
  {
    name: 'delete_section',
    description: 'Delete an Asana section',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Section GID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'section',
  },
  {
    name: 'create_project',
    description: 'Create a new Asana project',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_gid: { type: 'string', description: 'Workspace GID' },
        name: { type: 'string', description: 'Project name' },
        notes: { type: 'string', description: 'Project description' },
        team_gid: { type: 'string', description: 'Team GID to assign the project to' },
      },
      required: ['workspace_gid', 'name'],
    },
    categories: ['write'],
    entityType: 'project',
  },
  {
    name: 'update_project',
    description: 'Update an Asana project (rename, notes)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project GID to update' },
        name: { type: 'string', description: 'New project name' },
        notes: { type: 'string', description: 'New project notes' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'project',
  },
];

// ─── Pipedrive ────────────────────────────────────────────────────────────────

const PIPEDRIVE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_deals',
    description: 'List deals in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by deal status: open (default), won, lost',
          enum: ['open', 'won', 'lost'],
        },
        limit: { type: 'number', description: 'Max number of deals to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'deals',
  },
  {
    name: 'get_deal',
    description: 'Get full details of a specific Pipedrive deal',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Pipedrive deal ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'deal',
  },
  {
    name: 'create_deal',
    description: 'Create a new deal in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Deal title' },
        value: { type: 'number', description: 'Deal value amount' },
        currency: { type: 'string', description: 'Currency code (e.g. USD, EUR)' },
        person_id: { type: 'number', description: 'ID of the associated person/contact' },
        org_id: { type: 'number', description: 'ID of the associated organization' },
        pipeline_id: { type: 'number', description: 'Pipeline ID to place the deal in' },
        stage_id: { type: 'number', description: 'Stage ID within the pipeline' },
        expected_close_date: { type: 'string', description: 'Expected close date (YYYY-MM-DD)' },
      },
      required: ['title'],
    },
    categories: ['write'],
    entityType: 'deal',
  },
  {
    name: 'update_deal',
    description: 'Update an existing Pipedrive deal',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Pipedrive deal ID to update' },
        title: { type: 'string', description: 'New deal title' },
        value: { type: 'number', description: 'New deal value' },
        status: { type: 'string', description: 'Deal status: open, won, or lost', enum: ['open', 'won', 'lost'] },
        stage_id: { type: 'number', description: 'Move deal to this stage ID' },
        lost_reason: { type: 'string', description: 'Reason the deal was lost (when status=lost)' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'deal',
  },
  {
    name: 'list_persons',
    description: 'List persons (contacts) in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of persons to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'persons',
  },
  {
    name: 'get_person',
    description: 'Get full details of a specific Pipedrive person/contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Pipedrive person ID' },
      },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'person',
  },
  {
    name: 'create_person',
    description: 'Create a new person (contact) in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name of the person' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        org_id: { type: 'number', description: 'ID of the organization this person belongs to' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'person',
  },
  {
    name: 'update_person',
    description: 'Update an existing Pipedrive person/contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Pipedrive person ID to update' },
        name: { type: 'string', description: 'New full name' },
        email: { type: 'string', description: 'New email address' },
        phone: { type: 'string', description: 'New phone number' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'person',
  },
  {
    name: 'list_organizations',
    description: 'List organizations in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of organizations to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'organizations',
  },
  {
    name: 'create_organization',
    description: 'Create a new organization in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Organization name' },
        address: { type: 'string', description: 'Organization address' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'organization',
  },
  {
    name: 'list_activities',
    description: 'List activities (calls, meetings, tasks) in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        done: { type: 'boolean', description: 'Filter by completion status (default false = incomplete)' },
        deal_id: { type: 'number', description: 'Filter to activities for a specific deal' },
        person_id: { type: 'number', description: 'Filter to activities for a specific person' },
      },
    },
    categories: ['read'],
    entityType: 'activities',
  },
  {
    name: 'create_activity',
    description: 'Create a new activity (call, meeting, task, etc.) in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Activity subject/title' },
        type: {
          type: 'string',
          description: 'Activity type',
          enum: ['call', 'meeting', 'task', 'deadline', 'email', 'lunch'],
        },
        due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        deal_id: { type: 'number', description: 'Associate with a deal ID' },
        person_id: { type: 'number', description: 'Associate with a person ID' },
        note: { type: 'string', description: 'Activity note or description' },
      },
      required: ['subject', 'type', 'due_date'],
    },
    categories: ['write'],
    entityType: 'activity',
  },
  {
    name: 'create_note',
    description: 'Create a note in Pipedrive CRM, optionally linked to a deal or person',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note content' },
        deal_id: { type: 'number', description: 'Link note to this deal ID' },
        person_id: { type: 'number', description: 'Link note to this person ID' },
      },
      required: ['content'],
    },
    categories: ['write', 'outbound'],
    entityType: 'note',
  },
  {
    name: 'list_pipelines',
    description: 'List all pipelines in Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'pipelines',
  },
  {
    name: 'delete_deal',
    description: 'Delete a deal from Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Pipedrive deal ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'deal',
  },
  {
    name: 'delete_person',
    description: 'Delete a person (contact) from Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Pipedrive person ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'person',
  },
  {
    name: 'delete_activity',
    description: 'Delete an activity from Pipedrive CRM',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Pipedrive activity ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'activity',
  },
  {
    name: 'read_deal_activities',
    description: 'Read all activities (calls, meetings, tasks) associated with a Pipedrive deal',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Pipedrive deal ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'deal_activities',
  },
];

// ─── SendGrid ──────────────────────────────────────────────────────────────────

const SENDGRID_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'send_email',
    description: 'Send a transactional email via SendGrid',
    inputSchema: {
      type: 'object',
      properties: {
        to_email: { type: 'string', description: 'Recipient email address' },
        to_name: { type: 'string', description: 'Recipient display name' },
        from_email: { type: 'string', description: 'Sender email address (must be verified in SendGrid)' },
        from_name: { type: 'string', description: 'Sender display name' },
        subject: { type: 'string', description: 'Email subject line' },
        text_content: { type: 'string', description: 'Plain text email body (at least one of text_content or html_content is required)' },
        html_content: { type: 'string', description: 'HTML email body (at least one of text_content or html_content is required)' },
      },
      required: ['to_email', 'from_email', 'subject'],
    },
    categories: ['write', 'outbound'],
    entityType: 'email',
  },
  {
    name: 'send_email_from_template',
    description: 'Send a transactional email using a SendGrid dynamic template',
    inputSchema: {
      type: 'object',
      properties: {
        to_email: { type: 'string', description: 'Recipient email address' },
        from_email: { type: 'string', description: 'Sender email address (must be verified in SendGrid)' },
        template_id: { type: 'string', description: 'SendGrid dynamic template ID (starts with d-)' },
        template_data: {
          type: 'object',
          description: 'Key-value pairs for dynamic template substitutions (e.g. { "name": "John", "order_id": "12345" })',
        },
      },
      required: ['to_email', 'from_email', 'template_id'],
    },
    categories: ['write', 'outbound'],
    entityType: 'email_template',
  },
  {
    name: 'list_contacts',
    description: 'List marketing contacts in SendGrid',
    inputSchema: {
      type: 'object',
      properties: {
        page_size: { type: 'number', description: 'Number of contacts per page (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'contacts',
  },
  {
    name: 'search_contacts',
    description: 'Search SendGrid marketing contacts using SGQL query syntax',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'SGQL query string (e.g. "email LIKE \'%@example.com\'" or "first_name = \'Jane\'")',
        },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'contacts_search',
  },
  {
    name: 'upsert_contacts',
    description: 'Add or update marketing contacts in SendGrid. Returns a job_id (async operation)',
    inputSchema: {
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          description: 'Array of contact objects. Each must have an email field.',
          items: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'Contact email address' },
              first_name: { type: 'string', description: 'First name' },
              last_name: { type: 'string', description: 'Last name' },
            },
            requiredFields: ['email'],
          },
        },
        list_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list UUIDs to add contacts to',
        },
      },
      required: ['contacts'],
    },
    categories: ['write'],
    entityType: 'contacts_upsert',
  },
  {
    name: 'list_contact_lists',
    description: 'List all marketing contact lists in SendGrid',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'lists',
  },
  {
    name: 'create_contact_list',
    description: 'Create a new marketing contact list in SendGrid',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the contact list' },
      },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'list',
  },
  {
    name: 'list_templates',
    description: 'List dynamic transactional email templates in SendGrid',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'templates',
  },
  {
    name: 'get_email_stats',
    description: 'Get email send statistics from SendGrid for a date range',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date for stats (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'End date for stats (YYYY-MM-DD)' },
        aggregated_by: {
          type: 'string',
          description: 'Aggregation period: day, week, or month',
          enum: ['day', 'week', 'month'],
        },
      },
      required: ['start_date'],
    },
    categories: ['read'],
    entityType: 'stats',
  },
  {
    name: 'unsubscribe_email',
    description: 'Add an email address to the SendGrid global unsubscribe list',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to add to the global unsubscribe list' },
      },
      required: ['email'],
    },
    categories: ['write', 'destructive'],
    entityType: 'unsubscribe',
  },
];

// ─── Square ──────────────────────────────────────────────────────────────────

const SQUARE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_locations',
    description: 'List all business locations for the Square merchant account',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'locations',
  },
  {
    name: 'search_orders',
    description: 'Search Square orders by location with optional state and date range filters',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Square location ID to search orders for' },
        state: { type: 'string', description: 'Order state filter: OPEN, COMPLETED, or CANCELED' },
        created_after: { type: 'string', description: 'ISO 8601 datetime — return orders created after this time' },
        created_before: { type: 'string', description: 'ISO 8601 datetime — return orders created before this time' },
        limit: { type: 'number', description: 'Maximum number of orders to return (max 100)' },
      },
      required: ['location_id'],
    },
    categories: ['read'],
    entityType: 'orders',
  },
  {
    name: 'get_order',
    description: 'Get details of a specific Square order by ID',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Square order ID' },
      },
      required: ['order_id'],
    },
    categories: ['read'],
    entityType: 'order',
  },
  {
    name: 'list_payments',
    description: 'List Square payments for a location with optional time range filters',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Square location ID' },
        begin_time: { type: 'string', description: 'ISO 8601 datetime — return payments on or after this time' },
        end_time: { type: 'string', description: 'ISO 8601 datetime — return payments on or before this time' },
        limit: { type: 'number', description: 'Maximum number of payments to return' },
      },
      required: ['location_id'],
    },
    categories: ['read'],
    entityType: 'payments',
  },
  {
    name: 'get_payment',
    description: 'Get details of a specific Square payment by ID',
    inputSchema: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'Square payment ID' },
      },
      required: ['payment_id'],
    },
    categories: ['read'],
    entityType: 'payment',
  },
  {
    name: 'create_refund',
    description: 'Create a refund for a Square payment',
    inputSchema: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'Square payment ID to refund' },
        amount_cents: { type: 'number', description: 'Amount to refund in cents (e.g. 1000 = $10.00)' },
        currency: { type: 'string', description: 'ISO 4217 currency code (default: USD)' },
        reason: { type: 'string', description: 'Optional reason for the refund' },
      },
      required: ['payment_id', 'amount_cents'],
    },
    categories: ['destructive'],
    entityType: 'refund',
  },
  {
    name: 'list_customers',
    description: 'List customers in the Square customer directory',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of customers to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'customers',
  },
  {
    name: 'get_customer',
    description: 'Get details of a specific Square customer by ID',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Square customer ID' },
      },
      required: ['customer_id'],
    },
    categories: ['read'],
    entityType: 'customer',
  },
  {
    name: 'create_customer',
    description: 'Create a new customer in the Square customer directory',
    inputSchema: {
      type: 'object',
      properties: {
        given_name: { type: 'string', description: 'Customer first name' },
        family_name: { type: 'string', description: 'Customer last name' },
        email_address: { type: 'string', description: 'Customer email address' },
        phone_number: { type: 'string', description: 'Customer phone number' },
        note: { type: 'string', description: 'Internal note about the customer' },
      },
    },
    categories: ['write'],
    entityType: 'customer',
  },
  {
    name: 'update_customer',
    description: 'Update an existing Square customer record',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Square customer ID to update' },
        given_name: { type: 'string', description: 'Updated first name' },
        family_name: { type: 'string', description: 'Updated last name' },
        email_address: { type: 'string', description: 'Updated email address' },
        phone_number: { type: 'string', description: 'Updated phone number' },
      },
      required: ['customer_id'],
    },
    categories: ['write'],
    entityType: 'customer',
  },
  {
    name: 'list_catalog_items',
    description: 'List catalog items, variations, and categories from the Square catalog',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'catalog_items',
  },
];

// ─── PayPal ───────────────────────────────────────────────────────────────────

const PAYPAL_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_transactions',
    description: 'List PayPal payment transactions within a date range',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'ISO 8601 datetime with timezone offset, e.g. 2024-01-01T00:00:00-0700' },
        end_date: { type: 'string', description: 'ISO 8601 datetime with timezone offset, e.g. 2024-01-31T23:59:59-0700' },
        page_size: { type: 'number', description: 'Number of transactions per page (max 500)' },
      },
      required: ['start_date', 'end_date'],
    },
    categories: ['read'],
    entityType: 'transactions',
  },
  {
    name: 'get_order',
    description: 'Get details of a specific PayPal order by ID',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'PayPal order ID' },
      },
      required: ['order_id'],
    },
    categories: ['read'],
    entityType: 'order',
  },
  {
    name: 'refund_payment',
    description: 'Refund a captured PayPal payment',
    inputSchema: {
      type: 'object',
      properties: {
        capture_id: { type: 'string', description: 'PayPal capture ID to refund' },
        amount: { type: 'string', description: 'Amount to refund as a decimal string, e.g. "10.00" (omit for full refund)' },
        currency_code: { type: 'string', description: 'ISO 4217 currency code (default: USD)' },
        note_to_payer: { type: 'string', description: 'Optional note to include in the refund notification to payer' },
      },
      required: ['capture_id'],
    },
    categories: ['destructive'],
    entityType: 'refund',
  },
  {
    name: 'list_invoices',
    description: 'List PayPal invoices with pagination',
    inputSchema: {
      type: 'object',
      properties: {
        page_size: { type: 'number', description: 'Number of invoices per page (max 100)' },
        page: { type: 'number', description: 'Page number (1-based)' },
      },
    },
    categories: ['read'],
    entityType: 'invoices',
  },
  {
    name: 'get_invoice',
    description: 'Get details of a specific PayPal invoice by ID',
    inputSchema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'PayPal invoice ID' },
      },
      required: ['invoice_id'],
    },
    categories: ['read'],
    entityType: 'invoice',
  },
  {
    name: 'create_invoice',
    description: 'Create a new PayPal invoice draft',
    inputSchema: {
      type: 'object',
      properties: {
        merchant_email: { type: 'string', description: 'Merchant (sender) email address' },
        billing_email: { type: 'string', description: 'Customer (recipient) email address' },
        items: {
          type: 'array',
          description: 'Line items on the invoice — each with name, quantity, and unit_price_value (e.g. "50.00")',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Item name' },
              quantity: { type: 'number', description: 'Item quantity' },
              unit_price_value: { type: 'string', description: 'Unit price as a decimal string, e.g. "50.00"' },
            },
          },
        },
        currency_code: { type: 'string', description: 'ISO 4217 currency code (default: USD)' },
        note: { type: 'string', description: 'Optional note to include on the invoice' },
      },
      required: ['merchant_email', 'billing_email', 'items'],
    },
    categories: ['write'],
    entityType: 'invoice',
  },
  {
    name: 'send_invoice',
    description: 'Send a PayPal invoice draft to the customer',
    inputSchema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'PayPal invoice ID to send' },
      },
      required: ['invoice_id'],
    },
    categories: ['write', 'outbound'],
    entityType: 'invoice_send',
  },
  {
    name: 'list_disputes',
    description: 'List PayPal payment disputes',
    inputSchema: {
      type: 'object',
      properties: {
        page_size: { type: 'number', description: 'Number of disputes to return per page' },
      },
    },
    categories: ['read'],
    entityType: 'disputes',
  },
  {
    name: 'get_dispute',
    description: 'Get details of a specific PayPal dispute by ID',
    inputSchema: {
      type: 'object',
      properties: {
        dispute_id: { type: 'string', description: 'PayPal dispute ID' },
      },
      required: ['dispute_id'],
    },
    categories: ['read'],
    entityType: 'dispute',
  },
];

// ─── Calendly ────────────────────────────────────────────────────────────────

const CALENDLY_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_current_user',
    description: 'Get the current authenticated Calendly user info including scheduling URL and organization',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'current_user',
  },
  {
    name: 'list_event_types',
    description: 'List all event types (meeting templates) for the authenticated Calendly user',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Filter to active event types only (default: true)',
        },
      },
    },
    categories: ['read'],
    entityType: 'event_types',
  },
  {
    name: 'get_event_type',
    description: 'Get details for a specific Calendly event type by UUID',
    inputSchema: {
      type: 'object',
      properties: {
        event_type_uuid: { type: 'string', description: 'Event type UUID' },
      },
      required: ['event_type_uuid'],
    },
    categories: ['read'],
    entityType: 'event_type',
  },
  {
    name: 'list_scheduled_events',
    description: 'List scheduled Calendly meetings for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: active or canceled (default: active)',
        },
        min_start_time: { type: 'string', description: 'Earliest start time (ISO 8601)' },
        max_start_time: { type: 'string', description: 'Latest start time (ISO 8601)' },
        count: { type: 'number', description: 'Number of events to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'scheduled_events',
  },
  {
    name: 'get_scheduled_event',
    description: 'Get details for a specific scheduled Calendly event by UUID',
    inputSchema: {
      type: 'object',
      properties: {
        event_uuid: { type: 'string', description: 'Scheduled event UUID' },
      },
      required: ['event_uuid'],
    },
    categories: ['read'],
    entityType: 'scheduled_event',
  },
  {
    name: 'list_event_invitees',
    description: 'List all invitees for a specific scheduled Calendly event',
    inputSchema: {
      type: 'object',
      properties: {
        event_uuid: { type: 'string', description: 'Scheduled event UUID' },
      },
      required: ['event_uuid'],
    },
    categories: ['read'],
    entityType: 'event_invitees',
  },
  {
    name: 'cancel_event',
    description: 'Cancel a scheduled Calendly event. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        event_uuid: { type: 'string', description: 'Scheduled event UUID to cancel' },
        reason: { type: 'string', description: 'Optional reason for cancellation' },
      },
      required: ['event_uuid'],
    },
    categories: ['destructive'],
    entityType: 'scheduled_event',
  },
  {
    name: 'find_events_by_invitee',
    description: 'Find all scheduled Calendly events where a specific person was invited',
    inputSchema: {
      type: 'object',
      properties: {
        invitee_email: { type: 'string', description: 'Email address of the invitee to search for' },
        count: { type: 'number', description: 'Maximum number of results to return (max 100)' },
      },
      required: ['invitee_email'],
    },
    categories: ['read'],
    entityType: 'events_by_invitee',
  },
  {
    name: 'list_organization_members',
    description: 'List all members of the Calendly organization',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Maximum number of members to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'organization_members',
  },
];

// ─── Cal.com ──────────────────────────────────────────────────────────────────

const CAL_COM_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_profile',
    description: 'Get the current Cal.com user profile including id, username, and email',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'profile',
  },
  {
    name: 'list_event_types',
    description: 'List all Cal.com event types for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'event_types',
  },
  {
    name: 'get_event_type',
    description: 'Get details for a specific Cal.com event type by ID',
    inputSchema: {
      type: 'object',
      properties: {
        event_type_id: { type: 'number', description: 'Event type ID' },
      },
      required: ['event_type_id'],
    },
    categories: ['read'],
    entityType: 'event_type',
  },
  {
    name: 'update_event_type',
    description: 'Update settings for a Cal.com event type (title, description, duration, visibility)',
    inputSchema: {
      type: 'object',
      properties: {
        event_type_id: { type: 'number', description: 'Event type ID to update' },
        title: { type: 'string', description: 'New title for the event type' },
        description: { type: 'string', description: 'New description' },
        length: { type: 'number', description: 'Duration in minutes' },
        hidden: { type: 'boolean', description: 'Whether to hide the event type from the public booking page' },
      },
      required: ['event_type_id'],
    },
    categories: ['write'],
    entityType: 'event_type',
  },
  {
    name: 'list_bookings',
    description: 'List Cal.com bookings with optional status filter',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: upcoming, past, cancelled (default: upcoming)',
        },
        take: { type: 'number', description: 'Number of bookings to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'bookings',
  },
  {
    name: 'get_booking',
    description: 'Get details for a specific Cal.com booking by ID',
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'number', description: 'Booking ID' },
      },
      required: ['booking_id'],
    },
    categories: ['read'],
    entityType: 'booking',
  },
  {
    name: 'cancel_booking',
    description: 'Cancel a Cal.com booking. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'number', description: 'Booking ID to cancel' },
      },
      required: ['booking_id'],
    },
    categories: ['destructive'],
    entityType: 'booking',
  },
  {
    name: 'list_schedules',
    description: 'List all Cal.com availability schedules',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'schedules',
  },
  {
    name: 'list_team_members',
    description: 'List Cal.com team members',
    inputSchema: {
      type: 'object',
      properties: {
        take: { type: 'number', description: 'Number of members to return (max 100)' },
      },
    },
    categories: ['read'],
    entityType: 'team_members',
  },
];

// ─── WooCommerce ──────────────────────────────────────────────────────────────

const WOOCOMMERCE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_orders',
    description: 'List WooCommerce orders with optional status filter',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Order status filter: pending, processing, on-hold, completed, cancelled, refunded, failed, or any (default: any)',
        },
        per_page: { type: 'number', description: 'Orders per page (max 100)' },
        page: { type: 'number', description: 'Page number (1-indexed)' },
      },
    },
    categories: ['read'],
    entityType: 'orders',
  },
  {
    name: 'get_order',
    description: 'Get details for a specific WooCommerce order by ID',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'number', description: 'Order ID' },
      },
      required: ['order_id'],
    },
    categories: ['read'],
    entityType: 'order',
  },
  {
    name: 'update_order_status',
    description: 'Update the status of a WooCommerce order',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'number', description: 'Order ID to update' },
        status: {
          type: 'string',
          description: 'New order status: processing, completed, cancelled, or refunded',
        },
        customer_note: { type: 'string', description: 'Optional note to add to the order' },
      },
      required: ['order_id', 'status'],
    },
    categories: ['write'],
    entityType: 'order',
  },
  {
    name: 'list_products',
    description: 'List WooCommerce products with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', description: 'Products per page (max 100)' },
        page: { type: 'number', description: 'Page number (1-indexed)' },
        status: { type: 'string', description: 'Product status: publish or draft (default: publish)' },
      },
    },
    categories: ['read'],
    entityType: 'products',
  },
  {
    name: 'get_product',
    description: 'Get details for a specific WooCommerce product by ID',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'number', description: 'Product ID' },
      },
      required: ['product_id'],
    },
    categories: ['read'],
    entityType: 'product',
  },
  {
    name: 'create_product',
    description: 'Create a new WooCommerce product listing',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Product name' },
        regular_price: { type: 'string', description: 'Product price as a string (e.g. "29.99")' },
        description: { type: 'string', description: 'Full product description' },
        short_description: { type: 'string', description: 'Short product description for listing pages' },
        stock_quantity: { type: 'number', description: 'Initial stock quantity' },
        manage_stock: { type: 'boolean', description: 'Whether to enable stock management' },
      },
      required: ['name', 'regular_price'],
    },
    categories: ['write'],
    entityType: 'product',
  },
  {
    name: 'update_product',
    description: 'Update an existing WooCommerce product',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'number', description: 'Product ID to update' },
        name: { type: 'string', description: 'New product name' },
        regular_price: { type: 'string', description: 'New price (e.g. "29.99")' },
        stock_quantity: { type: 'number', description: 'Updated stock quantity' },
        status: { type: 'string', description: 'New status: publish or draft' },
      },
      required: ['product_id'],
    },
    categories: ['write'],
    entityType: 'product',
  },
  {
    name: 'delete_product',
    description: 'Permanently delete a WooCommerce product. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'number', description: 'Product ID to permanently delete' },
      },
      required: ['product_id'],
    },
    categories: ['destructive'],
    entityType: 'product',
  },
  {
    name: 'list_customers',
    description: 'List WooCommerce customers',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'number', description: 'Customers per page (max 100)' },
        page: { type: 'number', description: 'Page number (1-indexed)' },
      },
    },
    categories: ['read'],
    entityType: 'customers',
  },
  {
    name: 'get_customer',
    description: 'Get details for a specific WooCommerce customer by ID',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'number', description: 'Customer ID' },
      },
      required: ['customer_id'],
    },
    categories: ['read'],
    entityType: 'customer',
  },
  {
    name: 'list_categories',
    description: 'List all WooCommerce product categories',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    categories: ['read'],
    entityType: 'categories',
  },
  {
    name: 'get_sales_report',
    description: 'Get a WooCommerce sales summary report for a time period',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Reporting period: week, month, or year (default: week)',
        },
        date_min: { type: 'string', description: 'Start date filter (YYYY-MM-DD)' },
        date_max: { type: 'string', description: 'End date filter (YYYY-MM-DD)' },
      },
    },
    categories: ['read'],
    entityType: 'sales_report',
  },
  {
    name: 'create_order',
    description: 'Create a new WooCommerce order',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Order status (e.g. pending, processing, completed)' },
        customer_id: { type: 'number', description: 'Customer ID (0 for guest)' },
        line_items: {
          type: 'array',
          description: 'Array of line items with product_id and quantity',
          items: { type: 'object' },
        },
        billing: { type: 'object', description: 'Billing address fields' },
        shipping: { type: 'object', description: 'Shipping address fields' },
      },
      required: ['line_items'],
    },
    categories: ['write'],
    entityType: 'order',
  },
  {
    name: 'create_customer',
    description: 'Create a new WooCommerce customer',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Customer email address' },
        first_name: { type: 'string', description: 'First name' },
        last_name: { type: 'string', description: 'Last name' },
        username: { type: 'string', description: 'Username' },
        password: { type: 'string', description: 'Password' },
        billing: { type: 'object', description: 'Billing address fields' },
        shipping: { type: 'object', description: 'Shipping address fields' },
      },
      required: ['email'],
    },
    categories: ['write'],
    entityType: 'customer',
  },
  {
    name: 'update_customer',
    description: 'Update a WooCommerce customer',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Customer ID' },
        email: { type: 'string', description: 'New email address' },
        first_name: { type: 'string', description: 'First name' },
        last_name: { type: 'string', description: 'Last name' },
        billing: { type: 'object', description: 'Billing address fields' },
        shipping: { type: 'object', description: 'Shipping address fields' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'customer',
  },
];

// ─── QuickBooks ───────────────────────────────────────────────────────────────

const QUICKBOOKS_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_customer',
    description: 'Get a QuickBooks customer by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Customer ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'customer',
  },
  {
    name: 'read_invoice',
    description: 'Get a QuickBooks invoice by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Invoice ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'invoice',
  },
  {
    name: 'read_payment',
    description: 'Get a QuickBooks payment by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Payment ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'payment',
  },
  {
    name: 'read_account',
    description: 'Get a QuickBooks account by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Account ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'account',
  },
  {
    name: 'read_vendor',
    description: 'Get a QuickBooks vendor by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Vendor ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'vendor',
  },
  {
    name: 'read_estimate',
    description: 'Get a QuickBooks estimate by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Estimate ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'estimate',
  },
  {
    name: 'read_bill',
    description: 'Get a QuickBooks bill by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Bill ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'bill',
  },
  {
    name: 'read_item',
    description: 'Get a QuickBooks item (product/service) by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Item ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'item',
  },
  {
    name: 'read_employee',
    description: 'Get a QuickBooks employee by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Employee ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'employee',
  },
  {
    name: 'create_invoice',
    description: 'Create a new invoice in QuickBooks',
    inputSchema: {
      type: 'object',
      properties: {
        CustomerRef: { type: 'object', description: 'Customer reference with Id and name' },
        Line: { type: 'array', items: {}, description: 'Line items for the invoice' },
        DueDate: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        DocNumber: { type: 'string', description: 'Invoice document number' },
      },
      required: ['CustomerRef', 'Line'],
    },
    categories: ['write'],
    entityType: 'invoice',
  },
  {
    name: 'update_invoice',
    description: 'Update an existing invoice in QuickBooks',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Invoice ID' },
        SyncToken: { type: 'string', description: 'Optimistic concurrency token' },
        Line: { type: 'array', items: {}, description: 'Updated line items' },
        DueDate: { type: 'string', description: 'Updated due date' },
      },
      required: ['id', 'SyncToken'],
    },
    categories: ['write'],
    entityType: 'invoice',
  },
  {
    name: 'create_customer',
    description: 'Create a new customer in QuickBooks',
    inputSchema: {
      type: 'object',
      properties: {
        DisplayName: { type: 'string', description: 'Customer display name' },
        GivenName: { type: 'string', description: 'First name' },
        FamilyName: { type: 'string', description: 'Last name' },
        PrimaryEmailAddr: { type: 'object', description: 'Email address object' },
        PrimaryPhone: { type: 'object', description: 'Phone number object' },
      },
      required: ['DisplayName'],
    },
    categories: ['write'],
    entityType: 'customer',
  },
  {
    name: 'create_payment',
    description: 'Record a payment received from a customer in QuickBooks',
    inputSchema: {
      type: 'object',
      properties: {
        CustomerRef: { type: 'object', description: 'Customer reference' },
        TotalAmt: { type: 'number', description: 'Total payment amount' },
        Line: { type: 'array', items: {}, description: 'Payment lines linked to invoices' },
        TxnDate: { type: 'string', description: 'Payment date (YYYY-MM-DD)' },
      },
      required: ['CustomerRef', 'TotalAmt'],
    },
    categories: ['write'],
    entityType: 'payment',
  },
];

// ─── Xero ─────────────────────────────────────────────────────────────────────

const XERO_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'read_contact',
    description: 'Get a Xero contact by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Contact ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'contact',
  },
  {
    name: 'read_invoice',
    description: 'Get a Xero invoice by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Invoice ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'invoice',
  },
  {
    name: 'read_payment',
    description: 'Get a Xero payment by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Payment ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'payment',
  },
  {
    name: 'read_account',
    description: 'Get a Xero account by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Account ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'account',
  },
  {
    name: 'read_credit_note',
    description: 'Get a Xero credit note by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Credit note ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'credit_note',
  },
  {
    name: 'read_item',
    description: 'Get a Xero inventory item by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Item ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'item',
  },
  {
    name: 'read_employee',
    description: 'Get a Xero employee by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Employee ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'employee',
  },
  {
    name: 'read_organisation',
    description: 'Get Xero organisation details',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'organisation',
  },
  {
    name: 'create_invoice',
    description: 'Create a new invoice (ACCREC or ACCPAY) in Xero',
    inputSchema: {
      type: 'object',
      properties: {
        Type: { type: 'string', description: 'ACCREC (accounts receivable) or ACCPAY (accounts payable)' },
        Contact: { type: 'object', description: 'Contact reference with ContactID' },
        LineItems: { type: 'array', items: {}, description: 'Invoice line items' },
        Date: { type: 'string', description: 'Invoice date (YYYY-MM-DD)' },
        DueDate: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        InvoiceNumber: { type: 'string', description: 'Invoice number' },
      },
      required: ['Type', 'Contact', 'LineItems'],
    },
    categories: ['write'],
    entityType: 'invoice',
  },
  {
    name: 'update_invoice',
    description: 'Update an existing invoice in Xero',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Invoice ID (InvoiceID)' },
        Status: { type: 'string', description: 'Invoice status (e.g. SUBMITTED, AUTHORISED)' },
        LineItems: { type: 'array', items: {}, description: 'Updated line items' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'invoice',
  },
  {
    name: 'create_contact',
    description: 'Create a new contact in Xero',
    inputSchema: {
      type: 'object',
      properties: {
        Name: { type: 'string', description: 'Contact name' },
        EmailAddress: { type: 'string', description: 'Contact email address' },
        Phones: { type: 'array', items: {}, description: 'Phone numbers' },
        Addresses: { type: 'array', items: {}, description: 'Physical addresses' },
        IsCustomer: { type: 'boolean', description: 'Whether this contact is a customer' },
        IsSupplier: { type: 'boolean', description: 'Whether this contact is a supplier' },
      },
      required: ['Name'],
    },
    categories: ['write'],
    entityType: 'contact',
  },
  {
    name: 'create_payment',
    description: 'Record a payment against an invoice in Xero',
    inputSchema: {
      type: 'object',
      properties: {
        Invoice: { type: 'object', description: 'Invoice reference with InvoiceID' },
        Account: { type: 'object', description: 'Account reference with Code' },
        Date: { type: 'string', description: 'Payment date (YYYY-MM-DD)' },
        Amount: { type: 'number', description: 'Payment amount' },
      },
      required: ['Invoice', 'Account', 'Date', 'Amount'],
    },
    categories: ['write'],
    entityType: 'payment',
  },
];

// ─── Snowflake ────────────────────────────────────────────────────────────────

const SNOWFLAKE_FUNCTIONS: ConnectorFunction[] = [
  {
    // Read-only query surface. Decomposed from the old catch-all execute_sql so
    // the risk classifier can see this is a READ (plan §1.3): the statement is
    // validated read-only + row-capped centrally via sqlGuard (plan §2) before
    // it reaches the Snowflake MCP execute_sql tool.
    name: 'run_query',
    description:
      'Run a read-only SQL SELECT query against the Snowflake warehouse and return rows. Only SELECT is permitted; the statement is validated read-only and row-capped before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'A single read-only SQL SELECT statement' },
      },
      required: ['statement'],
    },
    categories: ['read'],
    entityType: 'sql_result',
    sqlGuard: { sqlParam: 'statement', dialect: 'snowflake' },
  },
  {
    // Write surface. NO sqlGuard — data-modifying SQL is intentional here and is
    // gated by the risk/authorize path (categories:['write']), not the
    // read-only gate (plan §1.3/§14).
    name: 'run_write_sql',
    description:
      'Execute a data-modifying SQL statement (INSERT/UPDATE/DELETE/MERGE) against the Snowflake warehouse. Requires write authorization; use run_query for reads.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'SQL DML statement to execute' },
      },
      required: ['statement'],
    },
    categories: ['write'],
    entityType: 'sql_result',
  },
  {
    // Graceful semantic surface (plan §3A/§6): answered by Cortex Analyst when a
    // semantic model is configured for the account, otherwise returns a
    // not-configured notice and steers the agent back to run_query.
    name: 'semantic_query',
    description:
      'Ask a natural-language question answered by the Snowflake Cortex Analyst semantic model, if one is configured for the account. Returns the generated answer, or a not-configured notice.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language business question' },
      },
      required: ['question'],
    },
    categories: ['read'],
    entityType: 'semantic',
  },
  {
    name: 'list_databases',
    description: 'List all accessible databases in the Snowflake account',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'databases',
  },
  {
    name: 'list_tables',
    description: 'List tables in a Snowflake schema',
    inputSchema: {
      type: 'object',
      properties: {
        schema_name: { type: 'string', description: 'Schema name (DATABASE.SCHEMA format)' },
      },
      required: ['schema_name'],
    },
    categories: ['read'],
    entityType: 'tables',
  },
  {
    name: 'get_table_schema',
    description: 'Get column definitions for a Snowflake table',
    inputSchema: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Fully-qualified table name' },
      },
      required: ['table_name'],
    },
    categories: ['read'],
    entityType: 'table_schema',
  },
];

// ─── Intercom ────────────────────────────────────────────────────────────────

const INTERCOM_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_articles',
    description: 'List Help Center articles in Intercom',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number (1-indexed, default 1)' },
        perPage: { type: 'number', description: 'Articles per page (max 50, default 50)' },
      },
    },
    categories: ['read'],
    entityType: 'articles',
  },
  {
    name: 'get_article',
    description: 'Read a Help Center article by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Article ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'article',
  },
  {
    name: 'get_contact',
    description: 'Read an Intercom contact by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'contact',
  },
  {
    name: 'get_conversation',
    description: 'Read an Intercom conversation by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Conversation ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'conversation',
  },
  {
    name: 'get_company',
    description: 'Read an Intercom company by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Company ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'company',
  },
  {
    name: 'list_conversations',
    description: 'List Intercom conversations',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Filter by state: open, closed, or snoozed' },
      },
    },
    categories: ['read'],
    entityType: 'conversations',
  },
  {
    name: 'list_contacts',
    description: 'List Intercom contacts',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Filter by email address' },
      },
    },
    categories: ['read'],
    entityType: 'contacts',
  },
  {
    name: 'create_contact',
    description: 'Create a new Intercom contact',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email' },
        name: { type: 'string', description: 'Contact name' },
        phone: { type: 'string', description: 'Contact phone' },
        role: { type: 'string', description: 'Role: user or lead' },
      },
      required: ['email'],
    },
    categories: ['write'],
    entityType: 'contact',
  },
  {
    name: 'update_contact',
    description: 'Update an existing Intercom contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Contact ID' },
        email: { type: 'string', description: 'New email' },
        name: { type: 'string', description: 'New name' },
        phone: { type: 'string', description: 'New phone' },
        custom_attributes: { type: 'object', description: 'Custom attribute updates' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'contact',
  },
  {
    name: 'create_conversation',
    description: 'Create a new Intercom conversation',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'object', description: 'Contact reference: { type, id }' },
        body: { type: 'string', description: 'Message body' },
      },
      required: ['from', 'body'],
    },
    categories: ['write', 'outbound'],
    entityType: 'conversation',
  },
  {
    name: 'update_conversation',
    description: 'Update an Intercom conversation — change status (close/open/snooze), assign to admin/team, or update attributes',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
        action: { type: 'string', description: 'Action: close, open, snooze, assign, or omit for attribute update' },
        admin_id: { type: 'string', description: 'Admin ID performing the action' },
        assignee_id: { type: 'string', description: 'Assignee admin or team ID (required for assign action)' },
        assignee_type: { type: 'string', description: '"admin" or "team" (default: admin, used with assign action)' },
        snoozed_until: { type: 'number', description: 'Unix timestamp to snooze until (required for snooze action)' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'conversation',
  },
  {
    name: 'create_note',
    description: 'Add an internal note to an Intercom contact',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'Contact ID' },
        admin_id: { type: 'string', description: 'Admin ID creating the note' },
        body: { type: 'string', description: 'Note content (HTML supported)' },
      },
      required: ['contact_id', 'admin_id', 'body'],
    },
    categories: ['write'],
    entityType: 'note',
  },
  {
    name: 'send_message',
    description: 'Send an outbound message to a contact via Intercom',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'object', description: 'Recipient reference: { type, id }' },
        from: { type: 'object', description: 'Sender admin reference: { type, id }' },
        subject: { type: 'string', description: 'Message subject (email only)' },
        body: { type: 'string', description: 'Message body' },
        messageType: { type: 'string', description: 'inapp or email' },
      },
      required: ['to', 'from', 'body', 'messageType'],
    },
    categories: ['write', 'outbound'],
    entityType: 'message',
  },
  {
    name: 'close_conversation',
    description: 'Close an Intercom conversation',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Conversation ID' },
        admin_id: { type: 'string', description: 'Admin ID performing the close' },
      },
      required: ['id', 'admin_id'],
    },
    categories: ['write'],
    entityType: 'conversation',
  },
  {
    name: 'delete_contact',
    description: 'Delete an Intercom contact by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Contact ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'contact',
  },
  {
    name: 'create_tag',
    description: 'Create a new tag in Intercom',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Tag name' } },
      required: ['name'],
    },
    categories: ['write'],
    entityType: 'tag',
  },
  {
    name: 'delete_tag',
    description: 'Delete an Intercom tag by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Tag ID to delete' } },
      required: ['id'],
    },
    categories: ['destructive'],
    entityType: 'tag',
  },
];

// ─── Notion ──────────────────────────────────────────────────────────────────

const NOTION_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'search_pages',
    description: 'Search Notion pages by title',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
    },
    categories: ['read'],
    entityType: 'page_search',
  },
  {
    name: 'list_pages',
    description: 'List all Notion pages accessible to the integration',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'pages',
  },
  {
    name: 'list_databases',
    description: 'List all Notion databases accessible to the integration',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
    categories: ['read'],
    entityType: 'databases',
  },
  {
    name: 'read_page',
    description: 'Read a Notion page by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Page ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'page',
  },
  {
    name: 'read_database',
    description: 'Read a Notion database by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Database ID' } },
      required: ['id'],
    },
    categories: ['read'],
    entityType: 'database',
  },
  {
    name: 'create_page',
    description: 'Create a new Notion page',
    inputSchema: {
      type: 'object',
      properties: {
        parent: { type: 'object', description: 'Parent reference: { type: "database_id" | "page_id", id }' },
        properties: { type: 'object', description: 'Page properties (required for database parents)' },
        children: { type: 'array', description: 'Block children content', items: { type: 'object', description: 'Block object' } },
      },
      required: ['parent'],
    },
    categories: ['write'],
    entityType: 'page',
  },
  {
    name: 'update_page',
    description: 'Update a Notion page properties or archive it',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page ID' },
        properties: { type: 'object', description: 'Property values to update' },
        archived: { type: 'boolean', description: 'Set true to archive the page' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'page',
  },
  {
    name: 'create_database',
    description: 'Create a new Notion database',
    inputSchema: {
      type: 'object',
      properties: {
        parent: { type: 'object', description: 'Parent page reference: { type: "page_id", id }' },
        title: { type: 'array', description: 'Rich-text title blocks', items: { type: 'object', description: 'Rich text object' } },
        properties: { type: 'object', description: 'Schema property definitions' },
      },
      required: ['parent', 'properties'],
    },
    categories: ['write'],
    entityType: 'database',
  },
  {
    name: 'update_database',
    description: 'Update a Notion database title or properties schema',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Database ID' },
        title: { type: 'array', description: 'New rich-text title', items: { type: 'object', description: 'Rich text object' } },
        properties: { type: 'object', description: 'Property schema updates' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'database',
  },
  {
    name: 'move_page',
    description: 'Move a Notion page to a different parent',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Page ID to move' },
        parent: { type: 'object', description: 'New parent reference: { type: "page_id" | "database_id", id }' },
      },
      required: ['id', 'parent'],
    },
    categories: ['write'],
    entityType: 'page_move',
  },
];

// ─── Attio ───────────────────────────────────────────────────────────────────

const ATTIO_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_person',
    description: 'Get an Attio person record by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Record ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'person',
  },
  {
    name: 'get_company',
    description: 'Get an Attio company record by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Record ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'company',
  },
  {
    name: 'get_deal',
    description: 'Get an Attio deal record by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Record ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'deal',
  },
  {
    name: 'get_note',
    description: 'Get an Attio note by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Note ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'note',
  },
  {
    name: 'get_task',
    description: 'Get an Attio task by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Task ID' } }, required: ['id'] },
    categories: ['read'],
    entityType: 'task',
  },
  {
    name: 'list_people',
    description: 'List Attio people records with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object', description: 'Attio filter conditions' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'people',
  },
  {
    name: 'list_companies',
    description: 'List Attio company records with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object', description: 'Attio filter conditions' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'companies',
  },
  {
    name: 'list_deals',
    description: 'List Attio deal records with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object', description: 'Attio filter conditions' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Offset for pagination' },
      },
    },
    categories: ['read'],
    entityType: 'deals',
  },
  {
    name: 'list_notes',
    description: 'List Attio notes',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'notes',
  },
  {
    name: 'list_tasks',
    description: 'List Attio tasks. Filter the result client-side to exclude is_completed=true to scope to the unhandled queue.',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'tasks',
    workRole: 'inbox',
    paired_ack: 'update_task',
    workItemKind: 'task',
  },
  {
    name: 'create_person',
    description: 'Create a new person record in Attio',
    inputSchema: {
      type: 'object',
      properties: { data: { type: 'object', description: 'Attio attribute values map' } },
      required: ['data'],
    },
    categories: ['write'],
    entityType: 'person',
  },
  {
    name: 'update_person',
    description: 'Update an Attio person record',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record ID' },
        data: { type: 'object', description: 'Attribute values to update' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'person',
  },
  {
    name: 'delete_person',
    description: 'Delete an Attio person record',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Record ID' } }, required: ['id'] },
    categories: ['destructive'],
    entityType: 'person',
  },
  {
    name: 'create_company',
    description: 'Create a new company record in Attio',
    inputSchema: {
      type: 'object',
      properties: { data: { type: 'object', description: 'Attio attribute values map' } },
      required: ['data'],
    },
    categories: ['write'],
    entityType: 'company',
  },
  {
    name: 'update_company',
    description: 'Update an Attio company record',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record ID' },
        data: { type: 'object', description: 'Attribute values to update' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'company',
  },
  {
    name: 'delete_company',
    description: 'Delete an Attio company record',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Record ID' } }, required: ['id'] },
    categories: ['destructive'],
    entityType: 'company',
  },
  {
    name: 'create_deal',
    description: 'Create a new deal record in Attio',
    inputSchema: {
      type: 'object',
      properties: { data: { type: 'object', description: 'Attio attribute values map' } },
      required: ['data'],
    },
    categories: ['write'],
    entityType: 'deal',
  },
  {
    name: 'update_deal',
    description: 'Update an Attio deal record',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record ID' },
        data: { type: 'object', description: 'Attribute values to update' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'deal',
  },
  {
    name: 'create_note',
    description: 'Create a note in Attio',
    inputSchema: {
      type: 'object',
      properties: {
        parent_object: { type: 'string', description: 'Object type: people, companies, or deals' },
        parent_record_id: { type: 'string', description: 'ID of the parent record' },
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Note content (markdown)' },
      },
      required: ['parent_object', 'parent_record_id'],
    },
    categories: ['write'],
    entityType: 'note',
  },
  {
    name: 'create_task',
    description: 'Create a task in Attio',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Task description' },
        deadline_at: { type: 'string', description: 'Due date (ISO 8601)' },
        is_completed: { type: 'boolean', description: 'Initial completion state' },
        linked_records: { type: 'array', description: 'Records to link this task to', items: { type: 'object' } },
      },
      required: ['content'],
    },
    categories: ['write'],
    entityType: 'task',
  },
  {
    name: 'update_task',
    description: 'Update an Attio task. To acknowledge an inbox item, set is_completed=true so the next list filtered on incomplete does not re-surface it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        content: { type: 'string', description: 'New content' },
        is_completed: { type: 'boolean', description: 'Completion state' },
        deadline_at: { type: 'string', description: 'New due date (ISO 8601)' },
      },
      required: ['id'],
    },
    categories: ['write'],
    entityType: 'task',
    workRole: 'ack',
    acknowledges: 'list_tasks',
    workItemKind: 'task',
  },
];

// ── Clay.com (api.clay.com/v3/mcp) — enumerated live via tools/list (16 tools) ──
const CLAY_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'find-and-enrich-contacts-at-company',
    description: 'Search for contacts at a company by role, title, name, or department.',
    inputSchema: {
        type: 'object',
        properties: {
          companyIdentifier: {
            type: 'string',
            description: 'The company identifier to search for company and contacts. Either a domain (e.g. "clay.com") or a LinkedIn URL (e.g. "https://www.linkedin.com/company/grow-with-clay").'
          },
          contactFilters: {
            type: 'object',
            properties: {
              names: {
                type: 'array',
                description: 'Search for one or more comma-separated names. Can be first name, last name, or both',
                items: {
                  type: 'string'
                }
              },
              job_title_keywords: {
                type: 'array',
                description: 'Search for one or more comma-separated keywords in the person\'s job title. E.g \'Founder, Vice President\'',
                items: {
                  type: 'string'
                }
              },
              job_title_exclude_keywords: {
                type: 'array',
                description: 'Search for one or more comma-separated keywords that shouldn\'t be in the person\'s job title. E.g \'Vice, Junior\'',
                items: {
                  type: 'string'
                }
              },
              profile_keywords: {
                type: 'array',
                description: 'Search for one or more keywords anywhere in bio (experience descriptions, etc.)',
                items: {
                  type: 'string'
                }
              },
              certification_keywords: {
                type: 'array',
                description: 'Search for one or more comma-separated keywords in the profile\'s certifications',
                items: {
                  type: 'string'
                }
              },
              languages: {
                type: 'array',
                description: 'Search for one or more comma-separated languages spoken by the person',
                items: {
                  type: 'string'
                }
              },
              school_names: {
                type: 'array',
                description: 'Search for one or more comma-separated schools that were attended by the person',
                items: {
                  type: 'string'
                }
              },
              current_role_min_months_since_start_date: {
                type: 'number'
              },
              current_role_max_months_since_start_date: {
                type: 'number'
              },
              locations: {
                type: 'array',
                description: 'Search for one or more comma-separated locations. A location can be a city or a country. E.g. \'Berlin\', \'United States\'',
                items: {
                  type: 'string'
                }
              },
              locations_exclude: {
                type: 'array',
                description: 'Exclude one or more comma-separated locations. A location can be a city or a country. E.g. \'Berlin\', \'United States\'',
                items: {
                  type: 'string'
                }
              }
            }
          },
          dataPoints: {
            type: 'object',
            description: 'Optional data points to enrich during search creation',
            properties: {
              contactDataPoints: {
                type: 'array',
                description: 'Contact data points to enrich',
                items: {}
              },
              companyDataPoints: {
                type: 'array',
                description: 'Company data points to enrich',
                items: {}
              }
            }
          }
        },
        required: ['companyIdentifier']
      },
    categories: ['write', 'sensitive'],
  },
  {
    name: 'find-and-enrich-list-of-contacts',
    description: 'Find and enrich specific named contacts at their companies.',
    inputSchema: {
        type: 'object',
        properties: {
          contactIdentifiers: {
            type: 'array',
            description: 'Array of contact identifiers to find and enrich, with their company identifiers',
            items: {}
          },
          dataPoints: {
            type: 'object',
            description: 'Optional data points to enrich during search creation',
            properties: {
              contactDataPoints: {
                type: 'array',
                description: 'Contact data points to enrich',
                items: {}
              },
              companyDataPoints: {
                type: 'array',
                description: 'Company data points to enrich',
                items: {}
              }
            }
          }
        },
        required: ['contactIdentifiers']
      },
    categories: ['write', 'sensitive'],
  },
  {
    name: 'find-and-enrich-company',
    description: 'Find and enrich a single company by domain or LinkedIn URL.',
    inputSchema: {
        type: 'object',
        properties: {
          companyIdentifier: {
            type: 'string',
            description: 'Company identifier (domain like "clay.com" or LinkedIn URL like "https://www.linkedin.com/company/grow-with-clay")'
          },
          companyDataPoints: {
            type: 'array',
            description: 'Optional data points to enrich during search creation',
            items: {}
          }
        },
        required: ['companyIdentifier']
      },
    categories: ['write'],
  },
  {
    name: 'add-contact-data-points',
    description: 'Add data points to contacts in an existing search. Supports enriching ALL contacts or specific contacts via entityIds.',
    inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID identifying the search to add contact data points to'
          },
          dataPoints: {
            type: 'array',
            description: 'The data points to apply to the contacts',
            items: {}
          },
          entityIds: {
            type: 'array',
            description: 'Optional. Array of entityIds to enrich. When omitted, enriches all contacts.',
            items: {
              type: 'string'
            }
          }
        },
        required: ['taskId', 'dataPoints']
      },
    categories: ['write', 'sensitive'],
  },
  {
    name: 'add-company-data-points',
    description: 'Add data points to companies in an existing search. Supports enriching ALL companies or specific companies via entityIds.',
    inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID identifying the search to add company data points to'
          },
          dataPoints: {
            type: 'array',
            description: 'The data points to apply to the company',
            items: {}
          },
          entityIds: {
            type: 'array',
            description: 'Optional. Array of entityIds to enrich. When omitted, enriches all companies.',
            items: {
              type: 'string'
            }
          }
        },
        required: ['taskId', 'dataPoints']
      },
    categories: ['write'],
  },
  {
    name: 'get-credits-available',
    description: 'Check if credits are available for the workspace. Returns hasWorkspaceCredits, hasSalesRepCredits, and (when credit budgets are enabled) hasBudgetCredits.',
    inputSchema: {
        type: 'object',
        properties: {}
      },
    categories: ['read'],
  },
  {
    name: 'get-task',
    description: 'Get task status and results by task ID. This tool handles all task types (search, direct) and returns the current state.',
    inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID to retrieve (mcp-task-* or legacy cgas-search-id-*)'
          }
        },
        required: ['taskId']
      },
    categories: ['read'],
  },
  {
    name: 'get-task-context',
    description: 'Retrieve the current state of a task — all entities, enrichment values, and statuses.',
    inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID to retrieve (mcp-task-* or legacy cgas-search-id-*)'
          },
          entityIds: {
            type: 'array',
            description: 'Optional. Pass specific entity IDs to retrieve only those entities. Leave empty or omit to retrieve all entities for the task.',
            items: {
              type: 'string'
            }
          }
        },
        required: ['taskId']
      },
    categories: ['read'],
  },
  {
    name: 'track-event',
    description: 'Track an analytics event with optional properties.',
    inputSchema: {
        type: 'object',
        properties: {
          eventName: {
            type: 'string',
            description: 'The name of the event to track'
          },
          properties: {
            type: 'object',
            description: 'Additional properties to include with the event'
          }
        },
        required: ['eventName']
      },
    categories: ['write'],
  },
  {
    name: 'run_subroutine_no_mapping',
    description: 'Run a custom subroutine on search entities. The backend automatically generates the field mapping.',
    inputSchema: {
        type: 'object',
        properties: {
          subroutine_id: {
            type: 'string',
            description: 'The ID of the subroutine to execute.'
          },
          taskId: {
            type: 'string',
            description: 'The taskId from the existing search.'
          },
          entityIds: {
            type: 'array',
            description: 'Optional. Array of entityIds to run on. When omitted, runs on all entities.',
            items: {
              type: 'string'
            }
          },
          inputs: {
            type: 'object',
            description: 'Optional. Explicit values for inputs the user selected (e.g. dropdown pickers), keyed by input name. Applied as-is; these override field mapping.'
          }
        },
        required: ['subroutine_id', 'taskId']
      },
    categories: ['write'],
  },
  {
    name: 'get_subroutine_input_options',
    description: 'Fetch the available dropdown options for a subroutine input that has a configured options source.',
    inputSchema: {
        type: 'object',
        properties: {
          subroutine_id: {
            type: 'string',
            description: 'The ID of the subroutine.'
          },
          inputName: {
            type: 'string',
            description: 'The name of the input whose options to fetch.'
          }
        },
        required: ['subroutine_id', 'inputName']
      },
    categories: ['read'],
  },
  {
    name: 'list_subroutines',
    description: 'List available custom functions. Available functions: . Call this to see their required inputs before using run_subroutine.',
    inputSchema: {
        type: 'object',
        properties: {}
      },
    categories: ['read'],
  },
  {
    name: 'run_subroutine',
    description: 'Execute a function on contacts/companies FROM AN EXISTING SEARCH ().',
    inputSchema: {
        type: 'object',
        properties: {
          subroutine_id: {
            type: 'string',
            description: 'The ID of the subroutine to execute. Get this from list_subroutines.'
          },
          taskId: {
            type: 'string',
            description: 'Required. The taskId from the existing search task to add results to.'
          },
          entityIds: {
            type: 'array',
            description: 'Optional. Array of entityIds to run on. When omitted with fieldMapping, runs on all contacts.',
            items: {
              type: 'string'
            }
          },
          fieldMapping: {
            type: 'object',
            description: 'Required for batch mode (running on ALL contacts). Format: { "entityField": "subroutineInput" } — the KEY is the entity field name (from contact data), the VALUE is the subroutine input name. Examp...'
          }
        },
        required: ['subroutine_id', 'taskId']
      },
    categories: ['write'],
  },
  {
    name: 'run_subroutine_direct',
    description: 'Execute a custom function directly with provided inputs. NO existing task or entityIds needed.',
    inputSchema: {
        type: 'object',
        properties: {
          subroutine_id: {
            type: 'string',
            description: 'The ID of the subroutine to execute. Get this from list_subroutines.'
          },
          inputs: {
            type: 'object',
            description: 'The actual input values for the subroutine. Keys must match the input names from list_subroutines. Example: {"Linkedin URL": "https://linkedin.com/in/john", "Full name": "John Doe"}'
          }
        },
        required: ['subroutine_id', 'inputs']
      },
    categories: ['write'],
  },
  {
    name: 'ask-question-about-accounts',
    description: 'Ask a natural language question about one or more accounts available in Clay Audiences. Depending on your workspace settings and whether Salesforce owner data is available, this may be limited to a...',
    inputSchema: {
        type: 'object',
        properties: {
          accountIds: {
            type: 'array',
            items: {
              type: 'integer'
            }
          },
          question: {
            type: 'string'
          }
        },
        required: ['accountIds', 'question']
      },
    categories: ['read'],
  },
  {
    name: 'query-objects',
    description: 'Query audience accounts, contacts, or deals using natural language. This tool translates your description into a structured filter, validates it against the database, and returns matching entities...',
    inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language description of what to filter, e.g. "tech companies with 500+ employees"'
          },
          audienceName: {
            type: 'string',
            description: 'Name of a saved audience segment to scope results to'
          },
          onlyMine: {
            type: 'boolean',
            description: 'When true, restrict account results to the caller\'s Salesforce-owned accounts'
          },
          limit: {
            type: 'integer',
            description: 'Max rows to return'
          },
          offset: {
            type: 'integer',
            description: 'Pagination offset'
          }
        },
        required: ['query']
      },
    categories: ['read'],
  },
];

// ── Mesh (mcp.clay.earth, formerly Clay.earth) — enumerated live via tools/list (20 tools) ──
const MESH_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_user_information',
    description: 'Get information about the current user',
    inputSchema: {
        type: 'object',
        properties: {}
      },
    categories: ['read'],
  },
  {
    name: 'searchContacts',
    description: 'Search for contacts and return matching people. Use for questions about specific contacts or "who" questions (e.g. "Who did I meet most?" or "who works as an engineer?"). Returns actual contact rec...',
    inputSchema: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          name: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          work_history: {
            type: 'object',
            properties: {
              company: {
                type: 'array',
                items: {
                  type: 'string'
                }
              },
              position: {
                type: 'array',
                items: {
                  type: 'string'
                }
              },
              active: {
                type: 'boolean'
              }
            }
          },
          education_history: {
            type: 'object',
            properties: {
              school: {
                type: 'array',
                items: {
                  type: 'string'
                }
              },
              degree: {
                type: 'array',
                items: {
                  type: 'string'
                }
              },
              active: {
                type: 'boolean'
              }
            }
          },
          location: {
            type: 'object',
            description: 'Filter by location if the user is asking about a location.',
            properties: {
              longitude: {
                type: 'number',
                description: 'The longitude of the location the user is asking about.'
              },
              latitude: {
                type: 'number',
                description: 'The latitude of the location the user is asking about.'
              },
              distance: {
                type: 'number',
                description: 'The distance radius to filter for in kilometers.'
              }
            }
          },
          age: {
            type: 'object',
            properties: {
              gte: {
                type: 'number',
                description: 'The minimum age to filter for.'
              },
              lte: {
                type: 'number',
                description: 'The maximum age to filter for.'
              }
            }
          },
          previous_birthday: {
            type: 'object',
            properties: {
              gte: {
                type: 'string',
                description: 'The earliest date to filter for previous birthdays.'
              },
              lte: {
                type: 'string',
                description: 'The latest date to filter for previous birthdays.'
              }
            }
          },
          information_type: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          upcoming_birthday: {
            type: 'object',
            properties: {
              gte: {
                type: 'string',
                description: 'The earliest date to filter for upcoming birthdays.'
              },
              lte: {
                type: 'string',
                description: 'The latest date to filter for upcoming birthdays.'
              }
            }
          },
          first_email_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          last_email_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          first_interaction_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          last_interaction_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          first_event_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          last_event_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          first_text_message_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          last_text_message_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          note_content: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          note_date: {
            type: 'object',
            properties: {
              gte: {
                type: 'string'
              },
              lte: {
                type: 'string'
              }
            }
          },
          email_count: {
            type: 'object',
            properties: {
              gte: {
                type: 'number'
              },
              lte: {
                type: 'number'
              }
            }
          },
          event_count: {
            type: 'object',
            properties: {
              gte: {
                type: 'number'
              },
              lte: {
                type: 'number'
              }
            }
          },
          text_message_count: {
            type: 'object',
            properties: {
              gte: {
                type: 'number'
              },
              lte: {
                type: 'number'
              }
            }
          },
          group_ids: {
            type: 'array',
            items: {}
          },
          integration: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          limit: {
            type: 'number',
            description: 'The maximum number of results to return. If the user is only asking about a count, you should request 0.'
          },
          sort: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                enum: ['relevance', 'last_texted', 'last_interacted', 'created']
              },
              direction: {
                type: 'string',
                enum: ['asc', 'desc']
              }
            }
          },
          exclude_contact_ids: {
            type: 'array',
            items: {
              type: 'number'
            }
          },
          include_fields: {
            type: 'array',
            items: {
              type: 'string'
            }
          }
        }
      },
    categories: ['read'],
  },
  {
    name: 'getContact',
    description: 'Get full details for a contact by id, including emails, social links, phone numbers, and notes.',
    inputSchema: {
        type: 'object',
        properties: {
          contact_id: {
            type: 'number',
            description: 'The ID of the contact to get details for.'
          }
        },
        required: ['contact_id']
      },
    categories: ['read'],
  },
  {
    name: 'createContact',
    description: 'Create a new contact record in Mesh. This endpoint should only be used when you need to create a completely new contact, not for adding contacts to groups.',
    inputSchema: {
        type: 'object',
        properties: {
          first_name: {
            type: 'string',
            description: 'The first name of the contact.'
          },
          last_name: {
            type: 'string',
            description: 'The last name of the contact.'
          },
          phone: {
            type: 'array',
            description: 'The phone number of the contact.',
            items: {
              type: 'string'
            }
          },
          email: {
            type: 'array',
            description: 'The email of the contact.',
            items: {
              type: 'string'
            }
          },
          linkedin: {
            type: 'string'
          },
          locations: {
            type: 'array',
            description: 'The locations associated with the contact.',
            items: {}
          },
          bio: {
            type: 'string',
            description: 'The biography of the contact.'
          },
          website: {
            type: 'array',
            description: 'The website addresses of the contact. These can be any valid web address. They must not be locations.',
            items: {
              type: 'string'
            }
          },
          title: {
            type: 'string',
            description: 'The job title of the contact.'
          },
          organization: {
            type: 'string',
            description: 'The organization of the contact.'
          },
          birthday: {
            type: 'string',
            description: 'The birthday of the contact. Use the format YYYY-MM-DD, if no year is specified use 0, if no month or day is specified do not include.'
          }
        }
      },
    categories: ['write'],
  },
  {
    name: 'updateContact',
    description: 'Update a contact record in Mesh. This endpoint should only be used when you need to update a contact, not for adding contacts to groups.',
    inputSchema: {
        type: 'object',
        properties: {
          first_name: {
            type: 'string',
            description: 'The first name of the contact.'
          },
          last_name: {
            type: 'string',
            description: 'The last name of the contact.'
          },
          phone: {
            type: 'array',
            description: 'The phone number of the contact.',
            items: {
              type: 'string'
            }
          },
          email: {
            type: 'array',
            description: 'The email of the contact.',
            items: {
              type: 'string'
            }
          },
          linkedin: {
            type: 'string'
          },
          locations: {
            type: 'array',
            description: 'The locations associated with the contact.',
            items: {}
          },
          bio: {
            type: 'string',
            description: 'The biography of the contact.'
          },
          website: {
            type: 'array',
            description: 'The website addresses of the contact. These can be any valid web address. They must not be locations.',
            items: {
              type: 'string'
            }
          },
          title: {
            type: 'string',
            description: 'The job title of the contact.'
          },
          organization: {
            type: 'string',
            description: 'The organization of the contact.'
          },
          birthday: {
            type: 'string',
            description: 'The birthday of the contact. Use the format YYYY-MM-DD, if no year is specified use 0, if no month or day is specified do not include.'
          },
          contact_id: {
            type: 'number',
            description: 'The ID of the contact to update.'
          }
        },
        required: ['contact_id']
      },
    categories: ['write'],
  },
  {
    name: 'archive_contact',
    description: 'Archive a contact record in Mesh. This endpoint should only be used when you need to archive a contact.',
    inputSchema: {
        type: 'object',
        properties: {
          contact_ids: {
            type: 'array',
            description: 'The IDs of the contacts to perform the action on.',
            items: {
              type: 'number'
            }
          }
        },
        required: ['contact_ids']
      },
    categories: ['write'],
  },
  {
    name: 'restore_contact',
    description: 'Restore a archived contact record in Mesh. This endpoint should only be used when you need to restore a contact.',
    inputSchema: {
        type: 'object',
        properties: {
          contact_ids: {
            type: 'array',
            description: 'The IDs of the contacts to perform the action on.',
            items: {
              type: 'number'
            }
          }
        },
        required: ['contact_ids']
      },
    categories: ['write'],
  },
  {
    name: 'createNote',
    description: 'Create a note for a contact. Only use this when the user explicitly asks to create, add, or save a note.',
    inputSchema: {
        type: 'object',
        properties: {
          contact_id: {
            type: 'number',
            description: 'The ID of the contact to add the note to.'
          },
          content: {
            type: 'string',
            description: 'The content of the note. You may reference and link to other contacts in the note using the following format: [contact:{contact_id}:contact name], example: [contact:123:John Doe]'
          },
          reminder_date: {
            type: 'string',
            description: 'If the user wants to set a reminder for the note. This should be a a ISO 8601 date in the following format: YYYY-MM-DDTHH:MM[:SS[.sss]]Z'
          }
        },
        required: ['contact_id', 'content']
      },
    categories: ['write'],
  },
  {
    name: 'getGroups',
    description: 'Get all groups or lists for the user.',
    inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'The maximum number of groups to return.'
          }
        }
      },
    categories: ['read'],
  },
  {
    name: 'createGroup',
    description: 'Create a group or list for the user. If a group with the same name already exists, it will not create a duplicate unless explicitly requested to ignore the check.',
    inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The name of the group to create.'
          }
        },
        required: ['title']
      },
    categories: ['write'],
  },
  {
    name: 'updateGroup',
    description: 'Update a group or list. Use this to update the group title and/or modify its members. When adding or removing contacts, provide ALL contact IDs to add/remove in a single call - do not make multiple...',
    inputSchema: {
        type: 'object',
        properties: {
          group_id: {
            type: 'number',
            description: 'The ID of the group or list to update.'
          },
          title: {
            type: 'string',
            description: 'The new name of the group if the user wants to rename it.'
          },
          add_contact_ids: {
            type: 'array',
            description: 'A list of contact IDs that should be added to this group. Each ID should be a number representing an existing contact in your network. You can provide multiple IDs to add several contacts at once.',
            items: {
              type: 'number'
            }
          },
          remove_contact_ids: {
            type: 'array',
            description: 'A list of contact IDs that should be removed from this group. Each ID should be a number representing an existing contact in your network. You can provide multiple IDs to remove several contacts at...',
            items: {
              type: 'number'
            }
          }
        },
        required: ['group_id']
      },
    categories: ['write'],
  },
  {
    name: 'getNotes',
    description: 'Use ONLY when the user explicitly mentions "note" or "notes" to retrieve notes between two dates (e.g. "what notes from last week?"). Returns notes by creation date only - does NOT search note cont...',
    inputSchema: {
        type: 'object',
        properties: {
          start: {
            type: 'string'
          },
          end: {
            type: 'string'
          },
          contact_ids: {
            type: 'array',
            description: 'The contacts to filter the moments for.',
            items: {
              type: 'number'
            }
          }
        },
        required: ['start', 'end']
      },
    categories: ['read'],
  },
  {
    name: 'getEvents',
    description: 'Use this tool ONLY to fetch meetings/events in a date range (e.g. "what meetings next week?", "show calendar for tomorrow"). DO NOT use for counting meetings, analyzing patterns, or finding frequen...',
    inputSchema: {
        type: 'object',
        properties: {
          start: {
            type: 'string'
          },
          end: {
            type: 'string'
          },
          contact_ids: {
            type: 'array',
            description: 'The contacts to filter the moments for.',
            items: {
              type: 'number'
            }
          }
        },
        required: ['start', 'end']
      },
    categories: ['read'],
  },
  {
    name: 'getUpcomingEvents',
    description: 'Use this tool ONLY to fetch upcoming/next meetings/events when the user does not explicitly mention a range, and asks for upcoming or next meetings/events.',
    inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number'
          },
          page: {
            type: 'number'
          },
          contact_ids: {
            type: 'array',
            description: 'The contacts to filter the moments for.',
            items: {
              type: 'number'
            }
          }
        }
      },
    categories: ['read'],
  },
  {
    name: 'getEmails',
    description: 'Use this tool ONLY to fetch emails in a date range (e.g. "what emails did I recieve last week?", "show emails from yesterday")',
    inputSchema: {
        type: 'object',
        properties: {
          start: {
            type: 'string'
          },
          end: {
            type: 'string'
          },
          contact_ids: {
            type: 'array',
            description: 'The contacts to filter the moments for.',
            items: {
              type: 'number'
            }
          }
        },
        required: ['start', 'end']
      },
    categories: ['read'],
  },
  {
    name: 'getRecentEmails',
    description: 'Use this tool ONLY to fetch recent email interactions when the user does not explicitly mention a range, and asks for past email interactions.',
    inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number'
          },
          page: {
            type: 'number'
          },
          contact_ids: {
            type: 'array',
            description: 'The contacts to filter the moments for.',
            items: {
              type: 'number'
            }
          }
        }
      },
    categories: ['read'],
  },
  {
    name: 'getRecentReminders',
    description: 'Use this tool to find recent reminders that have already occured. This tool is strictly prohibited from being used unless "reminder" or "reminders" are explicitly mentioned in the query.',
    inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number'
          },
          page: {
            type: 'number'
          },
          contact_ids: {
            type: 'array',
            description: 'The contacts to filter the moments for.',
            items: {
              type: 'number'
            }
          }
        }
      },
    categories: ['read'],
  },
  {
    name: 'getUpcomingReminders',
    description: 'Use this tool to find recent reminders that have already occured. This tool is strictly prohibited from being used unless "reminder" or "reminders" are explicitly mentioned in the query.',
    inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number'
          },
          page: {
            type: 'number'
          },
          contact_ids: {
            type: 'array',
            description: 'The contacts to filter the moments for.',
            items: {
              type: 'number'
            }
          }
        }
      },
    categories: ['read'],
  },
  {
    name: 'find_duplicates',
    description: 'Find potential duplicate contacts.',
    inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number'
          },
          page: {
            type: 'number'
          }
        }
      },
    categories: ['read'],
  },
  {
    name: 'merge_contacts',
    description: 'Merge all contact ids into one contact, this is a destructive action and can not be undone. Only run one contact group at a time and only with the users explicit permission.',
    inputSchema: {
        type: 'object',
        properties: {
          contact_ids: {
            type: 'array',
            items: {
              type: 'number'
            }
          }
        },
        required: ['contact_ids']
      },
    categories: ['write', 'destructive'],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// REGISTRY
// ═════════════════════════════════════════════════════════════════════════════

// Elicit — AI research assistant. Native sidecar over Elicit's REST API.
// Reports + systematic reviews are asynchronous (create returns an id + status
// 'processing'; poll get_report / get_systematic_review until 'completed').
// Nothing is destructive; entityType routes each tool in ElicitClient.
const ELICIT_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'search_papers',
    description: 'Semantic or keyword search over Elicit\'s corpus of 138M+ academic papers. Returns titles, authors, abstracts, publication years, DOIs, and citation counts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language research question or keyword query (1–2000 chars)' },
        searchMode: { type: 'string', enum: ['semantic', 'keyword'], description: 'How to interpret the query. "semantic" (default) runs Elicit\'s neural search; "keyword" does exact matching.' },
        maxResults: { type: 'integer', description: 'Maximum number of results to return (1–10000, default 10)' },
        corpus: { type: 'string', enum: ['elicit', 'pubmed'], description: 'Paper corpus to search. "elicit" (default) is the full corpus; "pubmed" restricts to PubMed-indexed papers.' },
        filters: {
          type: 'object',
          description: 'Optional filters to narrow results.',
          properties: {
            minYear: { type: 'integer', description: 'Minimum publication year' },
            maxYear: { type: 'integer', description: 'Maximum publication year' },
            maxQuartile: { type: 'integer', description: 'Maximum journal quartile (1 = top 25% of journals, 4 = all)' },
            typeTags: { type: 'array', items: { type: 'string' }, description: 'Filter by study type: "Review", "Meta-Analysis", "Systematic Review", "RCT", "Longitudinal"' },
            includeKeywords: { type: 'array', items: { type: 'string' }, description: 'Keywords that must appear in the paper' },
            excludeKeywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to exclude from results' },
            hasPdf: { type: 'boolean', description: 'Only include papers with an available PDF' },
            pubmedOnly: { type: 'boolean', description: 'Only include PubMed-indexed papers' },
            retracted: { type: 'string', enum: ['exclude_retracted', 'include_retracted', 'only_retracted'], description: 'How to handle retracted papers (default exclude_retracted)' },
          },
        },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'papers',
  },
  {
    name: 'search_clinical_trials',
    description: 'Search clinical trials (from ClinicalTrials.gov) semantically or by keyword. Returns matching trials with phase, recruitment status, and results availability.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query for clinical trials (1–2000 chars)' },
        searchMode: { type: 'string', enum: ['semantic', 'keyword'], description: 'How to interpret the query. "semantic" (default) or "keyword".' },
        maxResults: { type: 'integer', description: 'Maximum number of results to return (1–10000, default 10)' },
        trialFilters: {
          type: 'object',
          description: 'Optional filters to narrow trials.',
          properties: {
            phase: { type: 'array', items: { type: 'string' }, description: 'Clinical trial phases to include (e.g. "Phase 1", "Phase 2", "Phase 3")' },
            recruitmentStatus: { type: 'array', items: { type: 'string' }, description: 'Recruitment statuses to include (e.g. "Recruiting", "Completed")' },
            hasResults: { type: 'boolean', description: 'Only include trials that have posted results' },
          },
        },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'trials',
  },
  {
    name: 'create_report',
    description: 'Start an asynchronous AI literature-review report for a research question. Elicit searches, screens, extracts, and synthesizes the literature. Returns a reportId with status "processing"; poll get_report until "completed" (typically 5–15 minutes).',
    inputSchema: {
      type: 'object',
      properties: {
        researchQuestion: { type: 'string', description: 'The research question to investigate (1–2000 chars)' },
        title: { type: 'string', description: 'Optional title for the report' },
        maxSearchPapers: { type: 'integer', description: 'Maximum papers to retrieve during the search phase (1–5000, default 50)' },
        maxExtractPapers: { type: 'integer', description: 'Maximum papers to include in the final extraction table (1–500, default 10)' },
        isPublic: { type: 'boolean', description: 'Whether the report is publicly accessible via its URL without authentication (default false)' },
      },
      required: ['researchQuestion'],
    },
    categories: ['write', 'outbound'],
    entityType: 'report',
  },
  {
    name: 'get_report',
    description: 'Fetch a report by ID — its status, executionStage, auto-generated title, summary, and (optionally) the full markdown body and download links. Poll this until status is "completed".',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: { type: 'string', description: 'The report\'s UUID (returned by create_report)' },
        include: { type: 'string', description: 'Optional comma-separated extras to include in the response, e.g. "reportBody,abstract"' },
      },
      required: ['reportId'],
    },
    categories: ['read'],
    entityType: 'report',
  },
  {
    name: 'list_reports',
    description: 'List the authenticated user\'s reports, most recent first. Cursor-paginated; filter by source or status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Results per page (1–100, default 20)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
        source: { type: 'string', enum: ['api', 'user'], description: 'Filter by how the report was created' },
        status: { type: 'string', enum: ['processing', 'completed', 'failed', 'unknown'], description: 'Filter by report status' },
      },
    },
    categories: ['read'],
    entityType: 'reports',
  },
  {
    name: 'create_systematic_review',
    description: 'Start an asynchronous systematic review pipeline (search → abstract screening → fulltext screening → extraction → optional report). Returns a reviewId with status "processing"; poll get_systematic_review until "completed". Omit the staged config to let Elicit run sensible defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        researchQuestion: { type: 'string', description: 'The research question the review is investigating' },
        title: { type: 'string', description: 'Optional title for the review' },
        protocolDetails: { type: 'string', description: 'Free-form context (PICO, methodology, inclusion/exclusion rationale) used across the pipeline' },
        searches: { type: 'array', items: { type: 'object' }, description: 'Optional explicit searches that feed the review. If omitted, Elicit runs default searches from the research question.' },
        abstractScreening: { type: 'object', description: 'Optional abstract-stage screening. Provide { criteria: string[], generate: boolean } to screen abstracts against criteria.' },
        fulltextScreening: { type: 'object', description: 'Optional fulltext-stage screening. Provide { criteria: string[], reuseAbstractCriteria: boolean }.' },
        extraction: { type: 'object', description: 'Optional extraction stage. Provide { questions: string[], generate: boolean } to extract structured data. Omit to skip extraction.' },
        generateReport: { type: 'boolean', description: 'Generate a full report at the end of the review (requires extraction)' },
        isPublic: { type: 'boolean', description: 'Whether the review is publicly accessible via its URL without authentication (default false)' },
      },
      required: ['researchQuestion'],
    },
    categories: ['write', 'outbound'],
    entityType: 'systematic_review',
  },
  {
    name: 'get_systematic_review',
    description: 'Fetch a systematic review by ID — its status, current stage, and (when completed) the screening results, extraction table, and exports. Poll this until status is "completed".',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: { type: 'string', description: 'The review\'s UUID (returned by create_systematic_review)' },
        include: { type: 'string', description: 'Optional comma-separated extras to include in the response' },
      },
      required: ['reviewId'],
    },
    categories: ['read'],
    entityType: 'systematic_review',
  },
  {
    name: 'list_systematic_reviews',
    description: 'List the authenticated user\'s systematic reviews, most recent first. Cursor-paginated; filter by source or status.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Results per page (1–100, default 20)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
        source: { type: 'string', enum: ['api', 'user'], description: 'Filter by how the review was created' },
        status: { type: 'string', enum: ['processing', 'completed', 'failed', 'unknown'], description: 'Filter by review status' },
      },
    },
    categories: ['read'],
    entityType: 'systematic_reviews',
  },
];

/**
 * Maps connector_type → function definitions.
 * Every connector with a CompensationClient MUST have an entry here.
 * MCP connectors (stripe) are self-describing and excluded.
 * hubspot uses an MCP client; HUBSPOT_FUNCTIONS covers both MCP reads and REST writes.
 * databricks now has a PINNED read surface (plan §3B) instead of trusting
 * dynamic tools/list — DATABRICKS_FUNCTIONS below; the client resolves the
 * underlying workspace-specific SQL MCP tool at call time.
 */
// ─── Databricks (SQL MCP raw read + Genie semantic; pinned surface — plan §3B) ─
const DATABRICKS_FUNCTIONS: ConnectorFunction[] = [
  {
    // Read-only query surface — statement validated read-only + row-capped
    // centrally via sqlGuard (plan §2) before the Databricks SQL MCP tool runs
    // it. Dialect 'hive' — Databricks SQL is Spark/Hive-family.
    name: 'run_query',
    description:
      'Run a read-only SQL SELECT query against the Databricks warehouse and return rows. Only SELECT is permitted; the statement is validated read-only and row-capped before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'A single read-only SQL SELECT statement' },
      },
      required: ['statement'],
    },
    categories: ['read'],
    entityType: 'sql_result',
    sqlGuard: { sqlParam: 'statement', dialect: 'hive' },
  },
  {
    // Write surface (plan §14, gated by categories:['write'] → risk/authorize).
    // NO sqlGuard — data-modifying SQL is intentional; routes to the client
    // create() path.
    name: 'run_write_sql',
    description:
      'Execute a data-modifying SQL statement (INSERT/UPDATE/DELETE/MERGE) against the Databricks warehouse. Requires write authorization; use run_query for reads.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'SQL DML statement to execute' },
      },
      required: ['statement'],
    },
    categories: ['write'],
    entityType: 'sql_result',
  },
  {
    name: 'list_tables',
    description: 'List tables in a Databricks schema (SHOW TABLES).',
    inputSchema: {
      type: 'object',
      properties: {
        schema_name: { type: 'string', description: 'Schema in catalog.schema form' },
      },
      required: ['schema_name'],
    },
    categories: ['read'],
    entityType: 'tables',
  },
  {
    name: 'get_table_schema',
    description: 'Get column definitions for a Databricks table (DESCRIBE TABLE).',
    inputSchema: {
      type: 'object',
      properties: {
        table_name: { type: 'string', description: 'Fully-qualified catalog.schema.table' },
      },
      required: ['table_name'],
    },
    categories: ['read'],
    entityType: 'table_schema',
  },
  {
    // Graceful semantic surface (plan §3B/§6): Genie (NL→SQL, UC-RLS enforced)
    // when a Genie space is configured, otherwise an honest not-configured
    // notice that steers the agent to run_query.
    name: 'semantic_query',
    description:
      'Ask a natural-language question answered by a Databricks Genie space, if one is configured. Returns the generated answer, or a not-configured notice.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language business question' },
      },
      required: ['question'],
    },
    categories: ['read'],
    entityType: 'semantic',
  },
];

// ─── BigQuery (native REST client; read surface — plan §3C) ──────────────────
const BIGQUERY_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'list_dataset_ids',
    description: 'List dataset IDs in the connected BigQuery project',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
    entityType: 'datasets',
  },
  {
    name: 'list_table_ids',
    description: 'List table IDs in a BigQuery dataset',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset ID (defaults to the connector-configured dataset)' },
      },
    },
    categories: ['read'],
    entityType: 'tables',
  },
  {
    name: 'get_table_schema',
    description: 'Get column definitions (name, type, mode) for a BigQuery table',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset ID (defaults to the connector-configured dataset)' },
        tableId: { type: 'string', description: 'Table ID' },
      },
      required: ['tableId'],
    },
    categories: ['read'],
    entityType: 'table_schema',
  },
  {
    name: 'run_query',
    description:
      'Run a read-only SQL SELECT against BigQuery (Standard SQL). Writes/DDL are rejected; results are row-capped and cost-capped.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A single read-only SELECT statement (Standard SQL)' },
      },
      required: ['query'],
    },
    categories: ['read'],
    entityType: 'sql_result',
    sqlGuard: { sqlParam: 'query', dialect: 'bigquery' },
  },
  {
    // Write/DDL surface (plan §14, gated by categories:['write'] → risk/authorize).
    // NO sqlGuard — DML/DDL is intentional here; still cost-capped
    // (maximumBytesBilled) by the client.
    name: 'run_write_sql',
    description:
      'Execute a data-modifying BigQuery statement (INSERT/UPDATE/DELETE/MERGE, or DDL). Requires write authorization; use run_query for reads.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'A DML/DDL statement (Standard SQL)' },
      },
      required: ['statement'],
    },
    categories: ['write'],
    entityType: 'sql_result',
  },
];

const CONNECTOR_FUNCTIONS: Record<string, ConnectorFunction[]> = {
  // ── Capability-absorption data vendors ────────────────────────
  // tikhub and strale are GENERATED from the vendors' own OpenAPI specs
  // (scripts/generate-registry); the other four are fallback-authored pending
  // a machine-readable source — see each file's provenance header.
  tikhub: TIKHUB_FUNCTIONS,
  strale: STRALE_FUNCTIONS,
  crunchbase: CRUNCHBASE_FUNCTIONS,
  contactout: CONTACTOUT_FUNCTIONS,
  gloria: GLORIA_FUNCTIONS,
  saperly: SAPERLY_FUNCTIONS,
  hunterio: HUNTER_FUNCTIONS,
  pdl: PDL_FUNCTIONS,
  defillama: DEFILLAMA_FUNCTIONS,
  nasdaq: NASDAQ_FUNCTIONS,
  ycombinator: YCOMBINATOR_FUNCTIONS,
  apify: APIFY_FUNCTIONS,
  // x402 pay-per-call vendors — fallback-authored from each vendor's own
  // machine-readable index (see the generated files' provenance headers).
  google_trends: GOOGLE_TRENDS_FUNCTIONS,
  browserbase_x402: BROWSERBASE_X402_FUNCTIONS,
  kadec0: KADEC0_FUNCTIONS,
  locus: [...LOCUS_FUNCTIONS, ...LOCUS_PARSE_FUNCTIONS],
  vaaya: VAAYA_FUNCTIONS,
  minimax: MINIMAX_FUNCTIONS,
  bytedance: BYTEDANCE_FUNCTIONS,
  alibaba: ALIBABA_FUNCTIONS,
  google_ads: GOOGLE_ADS_FUNCTIONS,
  google_mail: GOOGLE_MAIL_FUNCTIONS,
  google_calendar: GOOGLE_CALENDAR_FUNCTIONS,
  youtube: GOOGLE_YOUTUBE_FUNCTIONS,
  google_docs: GOOGLE_DOCS_FUNCTIONS,
  google_drive: GOOGLE_DRIVE_FUNCTIONS,
  google_sheets: GOOGLE_SHEETS_FUNCTIONS,
  google_slides: GOOGLE_SLIDES_FUNCTIONS,
  slack: SLACK_FUNCTIONS,
  // github: removed — Phase 3.1, migrated to official MCP server
  salesforce: SALESFORCE_FUNCTIONS,
  microsoft_outlook_mail: MICROSOFT_OUTLOOK_MAIL_FUNCTIONS,
  microsoft_outlook_calendar: MICROSOFT_OUTLOOK_CALENDAR_FUNCTIONS,
  microsoft_teams: MICROSOFT_TEAMS_FUNCTIONS,
  microsoft_todo: MICROSOFT_TODO_FUNCTIONS,
  microsoft_contacts: MICROSOFT_CONTACTS_FUNCTIONS,
  microsoft_onenote: MICROSOFT_ONENOTE_FUNCTIONS,
  microsoft_sharepoint: MICROSOFT_SHAREPOINT_FUNCTIONS,
  microsoft_planner: MICROSOFT_PLANNER_FUNCTIONS,
  microsoft_onedrive: MICROSOFT_ONEDRIVE_FUNCTIONS,
  dropbox: DROPBOX_FUNCTIONS,
  box: BOX_FUNCTIONS,
  bamboohr: BAMBOOHR_FUNCTIONS,
  linear: LINEAR_FUNCTIONS,
  gitlab: GITLAB_FUNCTIONS,
  docusign: DOCUSIGN_FUNCTIONS,
  plaid: PLAID_FUNCTIONS,
  mailchimp: MAILCHIMP_FUNCTIONS,
  atlassian_jira: JIRA_FUNCTIONS,
  atlassian_confluence: CONFLUENCE_FUNCTIONS,
  // HRIS connectors (gusto/rippling/workday/namely/oracle_hcm/sap_successfactors +
  // the enterprise batch) get their tool set from NATIVE_HRIS_FUNCTIONS via the native
  // override in the boot block below, so no static assignment is needed here. zenefits
  // is coming_soon (no tool set until its native integration ships).
  hubspot: HUBSPOT_FUNCTIONS,
  zendesk: ZENDESK_FUNCTIONS,
  trello: TRELLO_FUNCTIONS,
  asana: ASANA_FUNCTIONS,
  pipedrive: PIPEDRIVE_FUNCTIONS,
  sendgrid: SENDGRID_FUNCTIONS,
  square: SQUARE_FUNCTIONS,
  paypal: PAYPAL_FUNCTIONS,
  calendly: CALENDLY_FUNCTIONS,
  cal_com: CAL_COM_FUNCTIONS,
  woocommerce: WOOCOMMERCE_FUNCTIONS,
  quickbooks: QUICKBOOKS_FUNCTIONS,
  xero: XERO_FUNCTIONS,
  attio: ATTIO_FUNCTIONS,
  clay: CLAY_FUNCTIONS,
  mesh: MESH_FUNCTIONS,
  snowflake: SNOWFLAKE_FUNCTIONS,
  databricks: DATABRICKS_FUNCTIONS,
  google_bigquery: BIGQUERY_FUNCTIONS,
  intercom: INTERCOM_FUNCTIONS,
  notion: NOTION_FUNCTIONS,
  elicit: ELICIT_FUNCTIONS,
};

/**
 * Auto-generate history-reading tools from a connector's historyReads catalog config.
 * Called by getConnectorFunctions — do not call directly.
 */
function buildHistoryTools(connectorType: string): ConnectorFunction[] {
  const def = CONNECTORS[connectorType];
  if (!def?.historyReads?.length) return [];

  return def.historyReads.map((h: ConnectorHistoryConfig) => ({
    name: `read_${h.entityType}`,
    description: h.description,
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string' as const, description: h.idDescription } },
      required: ['id'],
    },
    categories: ['read'] as ConnectorFunction['categories'],
    entityType: h.entityType,
  }));
}

// ── Composio cutover-completion (C3) — boot-time merge of overlays ─────
//
// For every composio_managed connector type, build merged ConnectorFunction
// entries by joining the vendor schemas (from @liftoffos/composio-overlays
// schemas/) with the hand-authored overlays (from overlays/). Stable name
// (overlay.stableName) becomes ConnectorFunction.name; vendor original is
// preserved on vendorToolName; definitionSource='composio' so the runtime
// router dispatches via composio.tools.execute().
//
// MUST run before getConnectorFunctions is called by anything (and before
// the validateWorkPairs call at the bottom of this file). Function
// declarations are hoisted, but the for-loop below is the run-time
// mutation that has to happen during module load — placing it here, just
// before the public accessors, is the plan's specified location.
//
// Source-override branches (C8):
//   - COMPOSIO_DISABLED_CONNECTORS=t → switchover composio_managed → native
//     fallback. Native CONNECTOR_FUNCTIONS already exists (the pre-cutover
//     *_FUNCTIONS arrays remain). Stamp definitionSource='native'.
//   - FORCE_COMPOSIO_FOR_CONNECTOR_TYPES=t → force a native type onto
//     Composio. Requires an overlay to exist for the toolkit.

function buildComposioFunctions(connectorType: string): ConnectorFunction[] {
  const def = CONNECTORS[connectorType];
  const toolkit = def?.mcp?.kind === 'composio_managed' ? def.mcp.toolkitSlug : null;
  // FORCE_COMPOSIO direction: connectorType is NOT composio_managed in
  // CONNECTORS but the env override is on. In that case the overlay file
  // must have a key matching connectorType (one-to-one assumption — operator
  // documents the mapping in the overlay file when forcing).
  const effectiveToolkit = toolkit ?? connectorType;
  if (!effectiveToolkit) return [];

  const schemas = COMPOSIO_TOOL_SCHEMAS[effectiveToolkit] ?? [];
  const overlays = COMPOSIO_TOOL_OVERLAYS[effectiveToolkit] ?? {};

  const out: ConnectorFunction[] = schemas.map((s) => {
    const overlay = overlays[s.slug];
    if (!overlay) {
      throw new Error(
        `composio_overlay_missing: toolkit='${effectiveToolkit}' tool='${s.slug}'. ` +
        `Add an entry to @liftoffos/composio-overlays overlays/${effectiveToolkit}.ts ` +
        `or remove the tool from schemas/${effectiveToolkit}.ts.`,
      );
    }
    // The category axis, at the point where a composio tool acquires one.
    //
    // The registry-wide assertion at the bottom of this file would catch this
    // too, but only as "connectorType.stable_name declares nothing". Here we
    // still know the toolkit, the vendor slug and which of the two sources was
    // empty, so the message names the file to edit.
    const categories = overlay.categoryOverrides ?? s.categories;
    if (!categories || categories.length === 0) {
      throw new Error(
        `composio_categories_missing: toolkit='${effectiveToolkit}' tool='${s.slug}' ` +
        `(stable name '${overlay.stableName}'). The vendor schema carries no categories ` +
        `and the overlay sets no categoryOverrides, so nothing declares whether this tool ` +
        `reads or writes. Add categoryOverrides to @liftoffos/composio-overlays ` +
        `overlays/${effectiveToolkit}.ts.`,
      );
    }
    return {
      name: overlay.stableName,
      // Overlay's `descriptionSuffix` lets us add LLM-facing guidance the
      // vendor description can't carry — e.g. "pick ONE of reply_to_thread
      // vs send_email per response" to stop the LLM from emitting both for
      // a single reply and producing duplicate drafts. Falsy ⇒ omitted
      // entirely.
      description: overlay.descriptionSuffix
        ? `${s.description}${overlay.descriptionSuffix}`
        : s.description,
      // The AGENT-FACING schema, not the vendor's. The overlay's
      // translateInput sits between the model and the vendor tool, supplying
      // some arguments itself (Gmail's user_id is always 'me') and reading
      // others under different names, so the contract a model is held to is
      // the vendor schema MINUS what the overlay owns, with the descriptions
      // the vendor left bare filled in. Publishing the vendor schema verbatim
      // advertised user_id as required on every Gmail tool, and the
      // platform's distiller -- which validates against what this service
      // publishes -- refused calls the runtime would have dispatched without
      // trouble. The package owns the derivation and tests every translator
      // against it in both directions; the cast is for the richer property
      // shapes only.
      inputSchema: agentFacingInputSchema(s.inputSchema, overlay) as unknown as ConnectorFunction['inputSchema'],
      categories,
      draftVariant: overlay.draftVariant,
      workRole: overlay.workRole,
      paired_ack: overlay.paired_ack,
      acknowledges: overlay.acknowledges,
      workItemKind: overlay.workItemKind,
      metricReadable: overlay.metricReadable,
      // Write-provenance declarations, in CANONICAL shape. The overlay states
      // them in the names the AGENT uses — what translateInput receives and
      // what translateOutput emits — because those are the only names the
      // runtime ever sees. A vendor-shape declaration would compile here,
      // match nothing at runtime, and read as "declares nothing", which is
      // indistinguishable from a tool nobody covered.
      idArgs: overlay.idArgs,
      returnsIds: overlay.returnsIds,
      egressOnly: overlay.egressOnly,
      writeRole: overlay.writeRole,
      paired_apply: overlay.paired_apply,
      definitionSource: 'composio' as const,
      vendorToolName: s.slug,
    };
  });

  // History-tool mappings: emit one synthesized ConnectorFunction per
  // historyReads entry on the CONNECTORS definition. Hard-fail if any
  // historyReads entry has no mapping — preserves history-tool parity
  // with native connectors.
  const historyReads = def?.historyReads ?? [];
  const historyMappings = COMPOSIO_HISTORY_MAPPINGS[connectorType] ?? [];
  for (const h of historyReads) {
    const mapping = historyMappings.find((m) => m.entityType === h.entityType);
    if (!mapping) {
      throw new Error(
        `composio_history_mapping_missing: toolkit='${effectiveToolkit}' ` +
        `connectorType='${connectorType}' entityType='${h.entityType}'. ` +
        `Add a HistoryToolMapping to @liftoffos/composio-overlays ` +
        `overlays/${effectiveToolkit}.ts or remove the historyReads entry from connectors.ts.`,
      );
    }
    out.push({
      name: mapping.stableName,
      description: h.description,
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'string', description: h.idDescription } },
        required: ['id'],
      },
      categories: ['read'] as ConnectorFunction['categories'],
      entityType: h.entityType,
      // A history read is the archetypal provenance source — it is how a run
      // learns which records exist — so what it hands back is exactly the set
      // most likely to be acted on next. `id` is this tool's only argument by
      // construction (see the schema above), and it is a read, so it names no
      // idArgs: a read does not vouch for the identifier it was given.
      returnsIds: mapping.returnsIds,
      definitionSource: 'composio' as const,
      vendorToolName: mapping.vendorToolName,
    });
  }

  return out;
}

// Load the (large) generated native HRIS tool sets. Kept as a lazy require (not an
// eager import) because it pulls ~13MB of generated tools (Oracle 8037, Workday WWS 936)
// — the require defers that until the boot block below actually consumes it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeHrisFns: Record<string, ConnectorFunction[]> = (require('./native-hris-functions.js') as { NATIVE_HRIS_FUNCTIONS: Record<string, ConnectorFunction[]> }).NATIVE_HRIS_FUNCTIONS;

// Mutate CONNECTOR_FUNCTIONS at module load — single-pass, no race.
for (const [t, def] of Object.entries(CONNECTORS)) {
  const isComposioManaged = def.mcp?.kind === 'composio_managed';
  const switchoverToNative = isComposioManaged && shouldSwitchoverComposioToNative(t);
  const forceComposio = !isComposioManaged && shouldForceComposio(t);

  if (isNativeHrisConnector(t)) {
    // HRIS connectors expose their generated native tool set.
    const native = nativeHrisFns[t] ?? [];
    if (native.length === 0) {
      throw new Error(
        `native_hris_no_tools: connectorType='${t}' is a native HRIS connector but ` +
        `NATIVE_HRIS_FUNCTIONS['${t}'] is empty. Restore its tool set.`,
      );
    }
    CONNECTOR_FUNCTIONS[t] = native.map((f) => ({
      ...f,
      definitionSource: 'native' as const,
      vendorToolName: f.name,
    }));
    continue;
  }

  if (isComposioManaged && !switchoverToNative) {
    // Default: composio source.
    CONNECTOR_FUNCTIONS[t] = buildComposioFunctions(t);
  } else if (switchoverToNative) {
    // Composio → native fallback (existing COMPOSIO_DISABLED_CONNECTORS path).
    // Keep whatever native *_FUNCTIONS already lives in CONNECTOR_FUNCTIONS[t]
    // (most composio-managed types retained their native fallback at cutover)
    // and stamp definitionSource='native'. Reject if no native fallback exists
    // — operator either restores natives or removes the env override.
    const native = CONNECTOR_FUNCTIONS[t] ?? [];
    if (native.length === 0) {
      throw new Error(
        `composio_switchover_no_native_fallback: connectorType='${t}' is in ` +
        `COMPOSIO_DISABLED_CONNECTORS but has no native fallback in *_FUNCTIONS. ` +
        `Either restore the native functions or remove the type from the env var.`,
      );
    }
    CONNECTOR_FUNCTIONS[t] = native.map((f) => ({
      ...f,
      definitionSource: 'native' as const,
      vendorToolName: f.name,
    }));
  } else if (forceComposio) {
    // Native → composio override. Requires overlays + schemas to exist for
    // the corresponding toolkit. buildComposioFunctions throws
    // composio_overlay_missing or composio_history_mapping_missing on gaps.
    const merged = buildComposioFunctions(t);
    if (merged.length === 0) {
      throw new Error(
        `force_composio_no_overlay: connectorType='${t}' has FORCE_COMPOSIO ` +
        `set but no entries in COMPOSIO_TOOL_OVERLAYS or COMPOSIO_TOOL_SCHEMAS. ` +
        `Run npm run composio:bootstrap-toolkit and author overlays first.`,
      );
    }
    CONNECTOR_FUNCTIONS[t] = merged;
  }
  // else: leave native types alone — no override.
}

// ── SQL read-only guard attach (plan §2 / §3D Supabase path b) ────────────
// For composio warehouse connectors whose read query tool is defined in the
// overlay package, attach the read-only sqlGuard HERE — the safety config
// lives with query-guardrails.ts + the dispatcher gate, not in the overlay
// package's type contract. Applied post-merge so it rides on whatever the
// overlay produced; a no-op if the named function is absent (e.g. before the
// enriched Supabase overlay ships). This makes the SAME verified fail-closed
// gate (query-guardrails, 23 tests) the read-only guard for Supabase, enforced
// in both dispatch paths — satisfying §13's "real parser, fail-closed" bar.
const SQL_GUARD_OVERRIDES: Record<string, Record<string, NonNullable<ConnectorFunction['sqlGuard']>>> = {
  // Supabase is Postgres; the Composio run-query tool takes its statement in
  // `query`. Confirm the param name against schemas/supabase.ts when the
  // overlay lands (adjust here if the vendor slug names it `sql`).
  supabase: { run_query: { sqlParam: 'query', dialect: 'postgresql' } },
};
for (const [t, byFn] of Object.entries(SQL_GUARD_OVERRIDES)) {
  const fns = CONNECTOR_FUNCTIONS[t];
  if (!fns) continue;
  for (const fn of fns) {
    const guard = byFn[fn.name];
    if (guard) fn.sqlGuard = guard;
  }
}

/**
 * Get function definitions for a connector type.
 * Merges hand-written tools with auto-generated history tools from the catalog.
 * Returns empty array for unknown connectors with no definitions.
 *
 * Composio cutover-completion (C3): composio_managed connectors are NOT
 * filtered out — their tools (sourced from @liftoffos/composio-overlays)
 * have been merged into CONNECTOR_FUNCTIONS by the boot block above.
 * The merge stamps definitionSource='composio' and vendorToolName so
 * tenant-runtime's stable-name router knows to dispatch via
 * composio.tools.execute() instead of the native REST executor.
 */
export function getConnectorFunctions(connectorType: string): ConnectorFunction[] {
  const manual = CONNECTOR_FUNCTIONS[connectorType] ?? [];
  // Composio cutover-completion (C5): for composio_managed connectors,
  // buildComposioFunctions has already synthesized history-tool entries
  // from COMPOSIO_HISTORY_MAPPINGS and stored them in CONNECTOR_FUNCTIONS.
  // Skipping the native buildHistoryTools auto-gen here prevents duplicate
  // read_<entityType> entries (one with definitionSource='composio', one
  // without).
  const isComposioManaged = CONNECTORS[connectorType]?.mcp?.kind === 'composio_managed';
  const history = isComposioManaged ? [] : buildHistoryTools(connectorType);
  // The reviewed generated declarations, on the writes that declare nothing
  // of their own. See reviewed-id-args.ts for why they are applied here rather
  // than written into this file.
  return applyReviewedIdArgs(connectorType, [...manual, ...history]);
}

/** All connector types that have registered functions (manual or auto-generated). */
export function getRegisteredConnectorTypes(): string[] {
  const manual = new Set(Object.keys(CONNECTOR_FUNCTIONS));
  const withHistory = Object.entries(CONNECTORS)
    .filter(([, def]) => def.historyReads?.length)
    .map(([type]) => type);
  return [...new Set([...manual, ...withHistory])];
}

/**
 * Resolve the API-native entity type for a connector function.
 *
 * The tool gateway receives function names (e.g., "read_spreadsheet", "send_email")
 * as the entity type, but connector clients expect API-native types (e.g., "spreadsheet",
 * "message"). This function looks up the correct entity type from the registry.
 *
 * Returns the registry entityType if found, otherwise falls back to the provided value.
 */
export function resolveEntityType(connectorAlias: string, functionName: string): string {
  const functions = _resolveFunctions(connectorAlias);
  if (!functions) return functionName;
  const fn = functions.find(f => f.name === functionName);
  return fn?.entityType || functionName;
}

function _resolveFunctions(connectorAlias: string): ConnectorFunction[] | undefined {
  // Try direct lookup first (exact connector_type like "google_sheets")
  let fns = getConnectorFunctions(connectorAlias);
  if (fns.length) return fns;

  // Try alias→type conversion.
  // Manifests use aliases (e.g. "sheets", "google-mail") but the registry
  // uses connector_type keys (e.g. "google_sheets", "google_mail").
  const withGoogle = `google_${connectorAlias}`;
  fns = getConnectorFunctions(withGoogle);
  if (fns.length) return fns;

  const normalized = connectorAlias.replace(/-/g, '_');
  fns = getConnectorFunctions(normalized);
  if (fns.length) return fns;

  const withMicrosoft = `microsoft_${connectorAlias.replace(/-/g, '_')}`;
  fns = getConnectorFunctions(withMicrosoft);
  if (fns.length) return fns;

  return undefined;
}


// ── W1.2 — work-pair validation at module load ──────────────────────────
// Walks CONNECTOR_FUNCTIONS the moment the module is evaluated and refuses
// to start the process if any work_inbox / work_ack pair is internally
// inconsistent. See src/catalog/work-pair-validator.ts for the violation
// kinds.
//
// Inline rather than deferred-via-startup-hook so a broken registry fails
// at boot, before any HTTP route accepts traffic. NOTE: the composio merge
// block above MUST run first so the validator sees the merged registry
// (composio entries carry their own work_inbox/ack tags).
import { validateWorkPairs, assertNoViolations } from './work-pair-validator.js';
assertNoViolations(validateWorkPairs(CONNECTOR_FUNCTIONS));

// ── Category axis validation at module load ──────────────────────────────
// Same posture as the work-pair check above and for the same reason: the
// read/write axis is what the runtime oversight filter and the distiller decide
// from, so a function that declares nothing sends both to a name heuristic. The
// axis is either complete or it is not a fact, and asserting here is what keeps
// it complete.
//
// Walks the PUBLIC view rather than CONNECTOR_FUNCTIONS. History tools are
// synthesized per connector inside getConnectorFunctions and never enter the
// map, so validating the map alone would pass a registry whose synthesized
// reads declare nothing.
// ── Staged-write pairing at module load ──────────────────────────────────
// A stage whose apply does not resolve leaves work prepared and never
// committed; an apply nothing stages for commits what nobody approved. Neither
// errors at run time — the runtime just does not find the other half, and "no
// pair" is indistinguishable from "not opted in", so a broken pair reads as a
// feature that is switched off.
import { validateWritePairs, assertNoWritePairViolations } from './write-pair-validator.js';
assertNoWritePairViolations(
  validateWritePairs(
    Object.fromEntries(
      getRegisteredConnectorTypes().map((t) => [t, getConnectorFunctions(t)]),
    ),
  ),
);

import { validateCategories, assertNoCategoryViolations } from './category-validator.js';
assertNoCategoryViolations(
  validateCategories(
    Object.fromEntries(
      getRegisteredConnectorTypes().map((t) => [t, getConnectorFunctions(t)]),
    ),
  ),
);
