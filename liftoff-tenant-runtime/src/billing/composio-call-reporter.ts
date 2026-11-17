// Composio per-tool-call cost reporter.
//
// Every tool call routed to a Composio-managed MCP server costs us
// $0.000299 (Ridiculously Cheap tier marginal rate). Platform-backend
// owns the price; tenant-runtime is just a faithful counter that fires
// one POST per Composio call to /api/internal/platform-tools/composio-
// tool-calls. Platform-backend's endpoint debounces duplicates via the
// (source, source_id, event_type, occurred_at) unique index, so a
// retry storm can't double-charge.
//
// Fire-and-forget — failures are logged and dropped. We'd rather
// under-attribute cost than fail an agent turn over a billing event.

import { ServiceClient } from '@liftoffos/service-client';
import { logger } from '../infrastructure/logging';
import { getPlatformCallbackClient } from '../platform-callback/client';

// Composio-managed connector types — duplicated from platform-backend's
// endpoint validator on purpose: each side enforces the contract
// independently so a stale build of either can't be tricked into
// attributing cost to the wrong source. MUST stay in sync with
// `kind: 'composio_managed'` entries in liftoff-connector-service
// src/catalog/connectors.ts. __tests__/composio-call-reporter.test.ts
// pins the exact set so drift can't ship silently.
export const COMPOSIO_MANAGED_TYPES = new Set([
  'airtable', 'apollo', 'ashby', 'atlassian_confluence', 'atlassian_jira', 'bitbucket',
  'browseai', 'cal_com', 'canva', 'clickup', 'close', 'coda',
  'datadog', 'discord', 'documint', 'dropbox', 'facebook', 'fathom',
  'figma', 'fireflies', 'freshbooks', 'freshdesk', 'gong', 'google_ads',
  'google_calendar', 'google_docs', 'google_drive', 'google_mail', 'google_sheets', 'google_slides',
  'greenhouse', 'gumroad', 'instagram', 'instantly', 'intercom', 'lever', 'linkedin',
  'mailchimp', 'microsoft_dynamics', 'microsoft_excel', 'microsoft_onedrive', 'microsoft_outlook_mail', 'missive', 'mixpanel', 'pagerduty',
  // 'slack' is absent: it runs on our own Slack app + native sidecar dispatch.
  // Slack calls do not route through Composio and must not be attributed to
  // the composio_mcp cost source.
  'pipedrive', 'posthog', 'quickbooks', 'reddit',
  // 'salesforce' runs on Composio's managed OAuth app, so its tool calls are Composio cost like any other
  // composio_managed connector and must be attributed.
  'salesforce', 'shopify',
  'square', 'todoist', 'trello', 'typeform', 'whatsapp', 'workable',
  'youtube',
  // Net-new Composio-managed batch
  // 'apify' is absent: a native api-key connector (connector-service
  // src/clients/apify.ts); its calls are not Composio's.
  'activecampaign', 'baserow', 'brevo', 'buildkite', 'codacy',
  'dovetail', 'elevenlabs', 'fibery', 'fillout', 'folk', 'follow_up_boss',
  'heygen', 'imgbb', 'incident_io', 'jotform', 'lemlist', 'lemon_squeezy',
  'loops', 'mailerlite', 'mailersend', 'mem', 'new_relic', 'northflank',
  'paperform', 'scrapingbee', 'supabase', 'tally', 'telegram', 'toggl',
  'clicksend', 'ticktick', 'monday', 'dialpad', 'harvest', 'google_meet',
  // Zoho suite. All seven are `kind: 'composio_managed'`, so all
  // seven are listed — including the four that ship coming_soon because
  // Composio serves them no tools. A type listed here that is never called
  // costs nothing; a type MISSING here the day someone flips coming_soon →
  // available silently drops that connector's OU cost.
  'zoho', 'zoho_bigin', 'zoho_books', 'zoho_desk', 'zoho_inventory', 'zoho_invoice', 'zoho_mail',
  // Capability-absorption composio batch. Must stay in lockstep
  // with COMPOSIO_MANAGED_CONNECTOR_TYPES in platform-backend.
  'pdl', 'hunterio', 'saperly',
  // Marketing composio batch: GA4, Search Console, Reddit Ads,
  // Plausible and DataForSEO ride Composio-managed MCP servers.
  'dataforseo', 'google_analytics', 'google_search_console', 'plausible', 'reddit_ads',
]);

// Composio cutover-completion (C5): the connector-type → toolkit-slug map
// previously duplicated here has moved to @liftoffos/composio-overlays as
// COMPOSIO_TOOLKIT_SLUG_BY_TYPE / getToolkitSlugForConnectorType. Single
// source of truth, pinned by the overlay package's toolkit-slugs.test.ts.

/**
 * mcp-server.ts builds each Composio MCP entry with key
 * `${integration.type}-${shortId}` (shortId is the first 8 chars of the
 * dashless connector UUID). The SDK reports tool calls with names of
 * the form `mcp__<key>__<toolName>`. parseComposioToolName recovers the
 * connectorType from the key.
 *
 * Returns null when the tool name is NOT a Composio-managed tool call.
 */
export function parseComposioToolName(
  rawToolName: string,
): { connectorType: string; serverKey: string } | null {
  if (!rawToolName.startsWith('mcp__')) return null;
  // Format: mcp__<connectorType>-<shortId>__<toolName>
  // We split on `__` and take the segment between `mcp__` and the
  // trailing `__<toolName>`.
  const afterPrefix = rawToolName.slice('mcp__'.length);
  const serverKeyEnd = afterPrefix.indexOf('__');
  if (serverKeyEnd <= 0) return null;
  const serverKey = afterPrefix.slice(0, serverKeyEnd);

  // Connector types CAN contain underscores (microsoft_dynamics,
  // cal_com, google_ads). Split on the LAST '-' to get connectorType
  // vs shortId, then verify the connectorType is one we own.
  const dashIdx = serverKey.lastIndexOf('-');
  if (dashIdx <= 0) return null;
  const connectorType = serverKey.slice(0, dashIdx);
  if (!COMPOSIO_MANAGED_TYPES.has(connectorType)) return null;
  return { connectorType, serverKey };
}

interface ReportArgs {
  tenantId: string;
  agentId: string | null;
  invocationId?: string | null;
  callId: string;
  connectorType: string;
  toolName: string;
  occurredAt: Date;
}

/**
 * Fire-and-forget POST to platform-backend. Callers wrap in `.catch()`
 * because we don't want a billing-event failure to abort a tool call.
 */
export async function reportComposioToolCall(args: ReportArgs): Promise<void> {
  const client = getPlatformCallbackClient();
  if (!client) return; // dev / offline mode — silently skip

  try {
    await postOne(client, args);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, connectorType: args.connectorType, callId: args.callId },
      'composio_call_reporter_failed',
    );
  }
}

async function postOne(client: ServiceClient, args: ReportArgs): Promise<void> {
  // No explicit Content-Type — ServiceClient.buildHeaders defaults to
  // application/json. Passing it here as 'Content-Type' (Capitalized) coexists
  // with the lowercase 'content-type' after `new Headers()` normalisation,
  // causing node's fetch to emit a comma-joined header value
  // ("application/json, application/json") that express.json refuses to
  // parse — leaving req.body empty and the endpoint returning
  // `400 calls[] required` on EVERY report, which silently drops all
  // Composio cost attribution.
  // See the postSkillFeedback comment in platform-callback/client.ts for the
  // same failure mode.
  const resp = await client.fetch('platform', '/api/internal/platform-tools/composio-tool-calls', {
    method: 'POST',
    body: JSON.stringify({
      calls: [
        {
          tenantId:     args.tenantId,
          agentId:      args.agentId,
          invocationId: args.invocationId ?? null,
          callId:       args.callId,
          connectorType: args.connectorType,
          toolName:     args.toolName,
          occurredAt:   args.occurredAt.toISOString(),
        },
      ],
    }),
    breakerKey: 'platform:composio-tool-calls',
  });
  if (!resp.ok) {
    // Include the response body: a bare "HTTP 400" left this failure
    // undiagnosable from logs (the validator names the failing field only in
    // the body it returns).
    const bodyText = typeof resp.text === 'function'
      ? await resp.text().catch(() => '')
      : '';
    throw new Error(`HTTP ${resp.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`);
  }
}
