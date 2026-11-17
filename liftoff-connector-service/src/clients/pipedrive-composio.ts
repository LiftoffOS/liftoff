// Pipedrive reactive-polling client (Composio-backed).
//
// Pipedrive is a composio_managed connector (api_key: user's API token +
// company domain). Composio ships purpose-built list actions, so reactive
// polling runs through the structured `PIPEDRIVE_GET_RECENTS` action — a single
// incremental delta endpoint that returns every recent change (creates AND
// updates) after `since_timestamp`, across multiple item types. This is the
// Datadog pattern (DATADOG_LIST_EVENTS over a time window), not the Intercom
// proxy pattern.
//
// MULTI-ENTITY: the scheduler calls list('Deal') and list('Contact') separately
// and publishes each batch under the requested entityType (scheduler uses the
// loop entityType, not record.entityType). So each list() call scopes the
// GET_RECENTS `items` param to just that entityType's item ('deal' | 'person')
// — no wasted cross-type fetch — and stamps a `__entity` discriminator so
// PipedriveNormalizer emits the correct data shape (deal → Deal, person →
// Contact), mirroring how AttioClient.list('Contact') queries only the people
// object. A defensive filter guards against the API echoing other item types.
//
// Composio holds the api_key + domain, so we pass only the connectedAccountId
// and Composio signs the upstream request.

import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult,
  ListFilters, ListResult,
} from './types.js';
import { getComposio } from '../oauth/composio-client.js';
import { logger } from '../infra/logging.js';

export interface PipedriveComposioClientConfig {
  tenantId: string;
  // Composio connected-account id (from connector.config.composioConnectedAccountId).
  connectedAccountId: string;
}

const GET_RECENTS_TOOL = 'PIPEDRIVE_GET_RECENTS';

// Catalog entityType → Pipedrive /recents item type.
const ITEM_BY_ENTITY: Record<string, string> = {
  Deal: 'deal',
  Contact: 'person',
};

// A Pipedrive /recents entry: { item, id, data:{...full object}, timestamp? }.
// `data` is normally a single object, but the /recents endpoint has historically
// returned it grouped as an array for some item types — so the type (and the
// mapping below) tolerate both to avoid silently dropping records.
interface RecentEntry {
  item?: string;
  id?: number | string;
  data?: Record<string, unknown> | Array<Record<string, unknown>>;
  timestamp?: string;
}

// Composio wraps the Pipedrive response in resp.data. The Pipedrive /recents
// shape is { success, data:[...], additional_data }, so the entries live at
// respData.data (fallback to respData when already an array).
function extractRecents(respData: unknown): RecentEntry[] {
  if (Array.isArray(respData)) return respData as RecentEntry[];
  if (respData && typeof respData === 'object') {
    const inner = (respData as { data?: unknown }).data;
    if (Array.isArray(inner)) return inner as RecentEntry[];
  }
  return [];
}

// Pipedrive GET_RECENTS since_timestamp format: 'YYYY-MM-DD HH:MM:SS' (UTC).
function toPipedriveTimestamp(since: Date): string {
  return since.toISOString().slice(0, 19).replace('T', ' ');
}

export class PipedriveComposioClient implements CompensationClient {
  readonly connector = 'pipedrive';
  private readonly tenantId: string;
  private readonly connectedAccountId: string;

  constructor(config: PipedriveComposioClientConfig) {
    this.tenantId = config.tenantId;
    this.connectedAccountId = config.connectedAccountId;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const wantItem = ITEM_BY_ENTITY[entityType];
    if (!wantItem) return { records: [], hasMore: false, unsupported: true };

    const sinceMs = filters?.since instanceof Date
      ? filters.since.getTime()
      : Date.now() - 24 * 60 * 60 * 1000;
    const since_timestamp = toPipedriveTimestamp(new Date(sinceMs));

    try {
      const resp = await getComposio().tools.execute(GET_RECENTS_TOOL, {
        userId: this.tenantId,
        connectedAccountId: this.connectedAccountId,
        arguments: { since_timestamp, items: wantItem, limit: 100, start: 0 },
        dangerouslySkipVersionCheck: true,
      });
      if (resp.successful === false) {
        throw new Error(resp.error || `${GET_RECENTS_TOOL} returned successful=false`);
      }
      const entries = extractRecents(resp.data).filter((e) => e.item === wantItem);
      const records: ExternalRecord[] = entries.flatMap((e) => {
        // Tolerate entry.data as a single object OR a grouped array; either way
        // emit one ExternalRecord per underlying object so none are dropped.
        const objs = Array.isArray(e.data) ? e.data : [e.data];
        return objs
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o))
          .map((o) => {
            // Raw Pipedrive id — the same externalId PipedriveNormalizer derives,
            // so the no-normalizer fallback path and the normalizer path agree
            // (matches how HubSpot/Salesforce/Attio use the raw vendor id).
            const id = String(o.id ?? e.id ?? '');
            return { id, data: { ...o, __entity: wantItem } };
          });
      });
      // GET_RECENTS is since-filtered server-side. NOTE: a single page (limit 100)
      // per cycle — if >100 records of one type change within a poll interval, the
      // overflow is not fetched (see the scheduler-driven pagination follow-up).
      return { records, hasMore: false };
    } catch (err) {
      logger.warn('Pipedrive Composio list failed', {
        entityType, tenantId: this.tenantId, error: (err as Error).message,
      });
      throw err;
    }
  }

  async read(): Promise<ExternalRecord> {
    throw new Error('PipedriveComposioClient supports list() only (reactive polling)');
  }
  async create(): Promise<CreateResult> {
    return { success: false, id: '', error: 'pipedrive read-only via polling' };
  }
  async update(): Promise<UpdateResult> {
    return { success: false, error: 'pipedrive read-only via polling' };
  }
  async delete(): Promise<DeleteResult> {
    return { success: false, error: 'pipedrive read-only via polling' };
  }
  async restore(): Promise<UpdateResult> {
    return { success: false, error: 'not supported' };
  }
  async semanticInverse(): Promise<DeleteResult> {
    return { success: false, data: { error: 'not supported' } } as DeleteResult;
  }
}
