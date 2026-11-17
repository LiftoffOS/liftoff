// Salesforce reactive-polling client (Composio-backed).
//
// Salesforce is composio_managed: Composio's managed OAuth
// app holds the credential, so this service never sees a Salesforce token and
// the native SalesforceClient's credentialProvider has nothing to hand it. We
// pass only the connectedAccountId and Composio signs the upstream request —
// the Pipedrive pattern, using each object's purpose-built Composio list action
// rather than a raw HTTP proxy.
//
// The records this returns are RAW Salesforce SObjects, exactly as the Query API
// emits them (PascalCase fields, `attributes.type`), because that is what
// SalesforceNormalizer already parses — its extractEntityType reads
// `attributes.type` and its declared-field mapping reads `Id`, `SystemModstamp`,
// `StageName` and the rest. Keeping the vendor shape means the normalizer,
// its published entity schemas and every reactive predicate written against them
// are untouched by the source flip.
//
// Incremental by SystemModstamp, which is the field the normalizer also uses as
// the record version. SOQL has no `SELECT *`, so each entity enumerates exactly
// the fields the normalizer declares — a field missing here is silently
// undefined downstream rather than an error, so the two lists have to be read
// together.

import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult,
  ListFilters, ListResult,
} from './types.js';
import { getComposio } from '../oauth/composio-client.js';
import { logger } from '../infra/logging.js';

export interface SalesforceComposioClientConfig {
  tenantId: string;
  /** From connector.config.composioConnectedAccountId. */
  connectedAccountId: string;
}

/** Fields every entity needs: the normalizer's SalesforceBase plus the version
 *  field. `attributes` is returned by the Query API without being selected. */
const BASE_FIELDS = ['Id', 'Name', 'CreatedDate', 'LastModifiedDate', 'OwnerId', 'SystemModstamp'];

interface EntitySpec {
  /** Composio's purpose-built list action for this object. */
  tool: string;
  /** SOQL FROM target. */
  sobject: string;
  /** Entity-specific fields SalesforceNormalizer declares for this type. */
  fields: string[];
}

// Keyed by the catalog's polling[].entityType. Only the three entities
// CONNECTORS.salesforce.polling declares are enumerable; anything else reports
// `unsupported` rather than an empty page, so the scheduler can tell "this
// client cannot list that" from "there were none".
const ENTITY_SPECS: Record<string, EntitySpec> = {
  Lead: {
    tool: 'SALESFORCE_LIST_LEADS',
    sobject: 'Lead',
    fields: ['Email', 'Company', 'Status', 'IsConverted'],
  },
  Contact: {
    tool: 'SALESFORCE_LIST_CONTACTS',
    sobject: 'Contact',
    fields: ['Email', 'Phone', 'AccountId', 'Title'],
  },
  Opportunity: {
    tool: 'SALESFORCE_LIST_OPPORTUNITIES',
    sobject: 'Opportunity',
    fields: ['Amount', 'StageName', 'CloseDate', 'AccountId'],
  },
};

const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** A Salesforce SObject as the Query API returns it. */
interface SObjectRecord {
  Id?: string;
  SystemModstamp?: string;
  LastModifiedDate?: string;
  attributes?: { type?: string };
  [key: string]: unknown;
}

/** Composio declares this tool's output as
 *  `{ data: { response_data: <raw Salesforce query response> } }`, and the
 *  Salesforce Query API's response is `{ totalSize, done, records, … }`. Both
 *  wrappers are tolerated as absent so a vendor that starts returning the inner
 *  object directly degrades to "no records" rather than throwing. */
function extractQueryResponse(respData: unknown): { records: SObjectRecord[]; done: boolean | undefined } {
  const outer = (respData && typeof respData === 'object')
    ? ((respData as { response_data?: unknown }).response_data ?? respData)
    : undefined;
  if (!outer || typeof outer !== 'object') return { records: [], done: undefined };
  const { records, done } = outer as { records?: unknown; done?: unknown };
  return {
    records: Array.isArray(records) ? (records as SObjectRecord[]) : [],
    done: typeof done === 'boolean' ? done : undefined,
  };
}

/** SOQL datetime literals are unquoted ISO 8601 with a zone. */
function toSoqlDateTime(when: Date): string {
  return when.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class SalesforceComposioClient implements CompensationClient {
  readonly connector = 'salesforce';
  private readonly tenantId: string;
  private readonly connectedAccountId: string;

  constructor(config: SalesforceComposioClientConfig) {
    this.tenantId = config.tenantId;
    this.connectedAccountId = config.connectedAccountId;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const spec = ENTITY_SPECS[entityType];
    if (!spec) return { records: [], hasMore: false, unsupported: true };

    const since = filters?.since instanceof Date
      ? filters.since
      : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
    const limit = Math.max(1, Math.min(filters?.limit ?? DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_LIMIT));

    // ORDER BY SystemModstamp ASC so a truncated page leaves the UNSEEN records
    // after the ones already emitted: the next cycle's `since` advances to the
    // newest record returned and picks up where this left off. Newest-first
    // would make an overflowing page drop the oldest changes permanently.
    const query =
      `SELECT ${[...BASE_FIELDS, ...spec.fields].join(', ')} ` +
      `FROM ${spec.sobject} ` +
      `WHERE SystemModstamp > ${toSoqlDateTime(since)} ` +
      `ORDER BY SystemModstamp ASC ` +
      `LIMIT ${limit}`;

    try {
      const resp = await getComposio().tools.execute(spec.tool, {
        userId: this.tenantId,
        connectedAccountId: this.connectedAccountId,
        arguments: { query },
        dangerouslySkipVersionCheck: true,
      });
      if (resp.successful === false) {
        throw new Error(resp.error || `${spec.tool} returned successful=false`);
      }

      const { records: rows, done } = extractQueryResponse(resp.data);
      const records: ExternalRecord[] = rows
        .filter((r) => typeof r?.Id === 'string' && r.Id.length > 0)
        .map((r) => {
          const modstamp = typeof r.SystemModstamp === 'string' ? r.SystemModstamp : undefined;
          const lastModified = modstamp ?? (typeof r.LastModifiedDate === 'string' ? r.LastModifiedDate : undefined);
          return {
            id: r.Id as string,
            // Raw SObject, unflattened — SalesforceNormalizer's contract.
            data: r as Record<string, unknown>,
            versionToken: modstamp,
            ...(lastModified ? { lastModified: new Date(lastModified) } : {}),
          };
        });

      // `done: false` means Salesforce itself paged. A full page is also treated
      // as more-to-come: the ASC ordering makes the next cycle resume correctly
      // from the newest SystemModstamp it saw.
      const hasMore = done === false || records.length >= limit;
      return { records, hasMore };
    } catch (err) {
      logger.warn('Salesforce Composio list failed', {
        entityType, tenantId: this.tenantId, error: (err as Error).message,
      });
      throw err;
    }
  }

  // Tool dispatch for a composio_managed connector goes through Composio, not
  // this client — it exists for reactive polling only. The native
  // SalesforceClient stays registered in clients/index.ts as the
  // COMPOSIO_DISABLED_CONNECTORS fallback and still serves writes there.
  //
  // Every signature below is declared in full even though nothing here reads the
  // arguments. r5-local/client-method-arity exists because a 0-parameter method
  // silently swallows what adapter.ts passes it, and the sibling Composio polling
  // clients answer it by sitting in eslint-rules/client-arity-baseline.json.
  // Spelling the parameters out refuses the args explicitly rather than dropping
  // them, and keeps that baseline from growing.
  async read(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    throw new Error(
      `SalesforceComposioClient supports list() only (reactive polling); read('${entityType}') ` +
      'is served by Composio tool dispatch',
    );
  }
  async create(entityType: string, _data: Record<string, unknown>): Promise<CreateResult> {
    return { success: false, id: '', error: `salesforce polling client cannot create ${entityType}` };
  }
  async update(
    entityType: string,
    _entityId: string | undefined,
    _data: Record<string, unknown>,
  ): Promise<UpdateResult> {
    return { success: false, error: `salesforce polling client cannot update ${entityType}` };
  }
  async delete(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<DeleteResult> {
    return { success: false, error: `salesforce polling client cannot delete ${entityType}` };
  }
  async restore(
    entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, unknown>,
  ): Promise<UpdateResult> {
    return { success: false, error: `salesforce polling client cannot restore ${entityType}` };
  }
  async semanticInverse(): Promise<DeleteResult> {
    return { success: false, data: { error: 'not supported' } } as DeleteResult;
  }
}
