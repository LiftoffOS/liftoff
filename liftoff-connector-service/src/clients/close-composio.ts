// Close reactive-polling client (Composio-backed, PROXY path).
//
// Close is a composio_managed connector (api_key), but Composio's Close toolkit
// exposes only 6 actions (CREATE_*, DELETE_CALL, GET_NOTE) — none list leads or
// contacts. So reactive polling can't use the structured-action path (as
// Apollo/Pipedrive/Folk do); instead it goes through the Composio HTTP PROXY
// (raw GET /api/v1/lead/), the same mechanism IntercomComposioClient uses for
// conversations. Composio holds the api_key + signs the upstream Basic-auth
// request; we pass only the connectedAccountId.
//
// MULTI-ENTITY: a Close lead embeds its contacts. list('Lead') returns the lead
// objects; list('Contact') returns the embedded contacts. Each list() is scoped
// to the requested entityType (the scheduler publishes under the loop
// entityType), stamping a `__entity` discriminator for CloseNormalizer.
//
// INCREMENTALITY: per Close's docs, GET /api/v1/lead/ supports only _limit,
// _skip and _fields — there is NO server-side sort or updated-since filter (an
// earlier `_order_by=-date_updated` was a no-op Close silently ignores). So a
// single page could return any 100 leads and miss recent updates. Instead we
// page through leads via _skip (driven by the scheduler's pageToken loop, keyed
// on the response `has_more`) and client-side filter by date_updated, bounded by
// MAX_SCAN_LEADS so a huge lead set can't stall a cycle. Contact updates surface
// because Close embeds each lead's contacts (with their own date_updated) in the
// lead payload we already scan.

import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult,
  ListFilters, ListResult,
} from './types.js';
import { composioProxyRequest } from '../oauth/composio-client.js';
import { logger } from '../infra/logging.js';

export interface CloseComposioClientConfig {
  tenantId: string;
  // Composio connected-account id (from connector.config.composioConnectedAccountId).
  connectedAccountId: string;
}

const LEADS_PER_PAGE = 100;
// Hard cap on how many leads we page through in one cycle (unsorted list → no
// early stop). At 100/page this is 20 proxy calls; anything beyond is deferred
// to the next cycle and logged rather than stalling the poll.
const MAX_SCAN_LEADS = 2000;

interface CloseContact { id?: unknown; date_updated?: unknown; [k: string]: unknown }
interface CloseLead {
  id?: unknown;
  date_updated?: unknown;
  display_name?: unknown;
  contacts?: CloseContact[];
  [k: string]: unknown;
}

// Close GET /api/v1/lead/ returns { has_more, data:[ lead,... ] }; fall back to
// an array or a { data:[...] } wrapper.
function extractLeads(respData: unknown): CloseLead[] {
  if (Array.isArray(respData)) return respData as CloseLead[];
  if (respData && typeof respData === 'object') {
    const inner = (respData as { data?: unknown }).data;
    if (Array.isArray(inner)) return inner as CloseLead[];
  }
  return [];
}

function extractHasMore(respData: unknown): boolean {
  if (respData && typeof respData === 'object') {
    const h = (respData as { has_more?: unknown }).has_more;
    if (typeof h === 'boolean') return h;
  }
  return false;
}

function skipFromToken(pageToken: string | undefined): number {
  const n = Number(pageToken);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function timeMs(v: unknown): number {
  if (typeof v === 'string') {
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

export class CloseComposioClient implements CompensationClient {
  readonly connector = 'close';
  private readonly tenantId: string;
  private readonly connectedAccountId: string;

  constructor(config: CloseComposioClientConfig) {
    this.tenantId = config.tenantId;
    this.connectedAccountId = config.connectedAccountId;
  }

  private async fetchLeadPage(skip: number): Promise<{ leads: CloseLead[]; hasMore: boolean }> {
    const data = await composioProxyRequest<unknown>({
      connectedAccountId: this.connectedAccountId,
      method: 'GET',
      endpoint: '/api/v1/lead/',
      queryParams: { _limit: LEADS_PER_PAGE, _skip: skip },
    });
    return { leads: extractLeads(data), hasMore: extractHasMore(data) };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Lead' && entityType !== 'Contact') return { records: [], hasMore: false, unsupported: true };

    const sinceMs = filters?.since instanceof Date ? filters.since.getTime() : 0;
    const skip = skipFromToken(filters?.pageToken);

    try {
      const { leads, hasMore } = await this.fetchLeadPage(skip);

      const records: ExternalRecord[] =
        entityType === 'Lead'
          ? leads
              .filter((l) => { const t = timeMs(l.date_updated); return !sinceMs || t === 0 || t >= sinceMs; })
              .map((l) => ({ id: String(l.id ?? ''), data: { ...l, __entity: 'lead' } }))
          // Contact: flatten each lead's embedded contacts, gating on the
          // contact's own date_updated when present, else the lead's.
          : leads.flatMap((l) => {
              const contacts = Array.isArray(l.contacts) ? l.contacts : [];
              return contacts
                .filter((c) => { const t = timeMs(c.date_updated) || timeMs(l.date_updated); return !(sinceMs && t !== 0 && t < sinceMs); })
                .map((c) => ({
                  id: String(c.id ?? ''),
                  data: { ...c, __entity: 'contact', leadId: String(l.id ?? ''), leadName: l.display_name },
                }));
            });

      // Continue paging (via the scheduler's pageToken loop) while Close reports
      // more leads and we're under the per-cycle scan cap. Unsorted list → we
      // can't early-stop on `since`, so we scan the whole (capped) set.
      const nextSkip = skip + LEADS_PER_PAGE;
      const capped = hasMore && nextSkip >= MAX_SCAN_LEADS;
      if (capped) {
        logger.warn(
          { tenantId: this.tenantId, connectorType: 'close', scanned: nextSkip },
          'close lead scan hit MAX_SCAN_LEADS cap — remaining leads deferred to next cycle',
        );
      }
      const nextPageToken = hasMore && !capped ? String(nextSkip) : undefined;
      return { records, hasMore: Boolean(nextPageToken), nextPageToken };
    } catch (err) {
      logger.warn('Close Composio list failed', {
        entityType, tenantId: this.tenantId, error: (err as Error).message,
      });
      throw err;
    }
  }

  async read(): Promise<ExternalRecord> {
    throw new Error('CloseComposioClient supports list() only (reactive polling)');
  }
  async create(): Promise<CreateResult> {
    return { success: false, id: '', error: 'close read-only via polling' };
  }
  async update(): Promise<UpdateResult> {
    return { success: false, error: 'close read-only via polling' };
  }
  async delete(): Promise<DeleteResult> {
    return { success: false, error: 'close read-only via polling' };
  }
  async restore(): Promise<UpdateResult> {
    return { success: false, error: 'not supported' };
  }
  async semanticInverse(): Promise<DeleteResult> {
    return { success: false, data: { error: 'not supported' } } as DeleteResult;
  }
}
