// External State Fetcher — Phase 2c
//
// Conflict detection (src/tool-gateway/service.ts::capturePreActionSnapshot)
// needs a read-side snapshot of an external entity before the tool-gateway
// issues a write. Before Phase 2c this was a set of per-connector fetchers
// that hit vendor APIs directly using tenant OAuth credentials.
//
// With the Phase 2c cutover the tenant-runtime no longer holds vendor
// credentials — connector-service owns them. Each fetcher therefore turns
// into a read-only ConnectorService.Execute RPC call; tenant-runtime only
// chooses the right function name and forwards the request.
//
// The ExternalStateFetcherRegistry interface is preserved so
// capturePreActionSnapshot() compiles unchanged.

import { ExternalState } from './types';
import { logger } from '../infrastructure/logging';
import { getConnectorServiceClient } from '../connectors/connector-service-client';

// Function-name convention shared with connector-service. Each read-only
// entry below translates an (entityType) into the canonical Execute
// functionName that connector-service will route to the appropriate
// vendor read call. Keeping the mapping in code (not config) so it
// changes in lockstep with the connector-service implementation.
interface FunctionMap {
  [entityType: string]: string;
}

const CONNECTOR_READ_FUNCTIONS: Record<string, FunctionMap> = {
  salesforce: {
    // Canonical "fetch the record" function; connector-service dispatches
    // based on entityType in the input payload.
    '*': 'read_record',
  },
  hubspot: {
    Contact: 'read_contact',
    Company: 'read_company',
    Deal: 'read_deal',
    Ticket: 'read_ticket',
    '*': 'read_record',
  },
  atlassian_jira: {
    Issue: 'read_issue',
    Project: 'read_project',
    '*': 'read_record',
  },
  slack: {
    Message: 'read_message',
    Channel: 'read_channel',
    User: 'read_user',
  },
  'google-calendar': {
    Event: 'read_event',
    Calendar: 'read_calendar',
  },
  github: {
    Repository: 'read_repository',
    Issue: 'read_issue',
    PullRequest: 'read_pull_request',
    User: 'read_user',
  },
  zoom: {
    Meeting: 'read_meeting',
    User: 'read_user',
    Webinar: 'read_webinar',
  },
  atlassian_confluence: {
    Page: 'read_page',
    Space: 'read_space',
  },
};

function resolveFunctionName(connector: string, entityType: string): string | null {
  const map = CONNECTOR_READ_FUNCTIONS[connector];
  if (!map) return null;
  return map[entityType] ?? map['*'] ?? null;
}

// Preserved for back-compat with the existing tool-gateway wiring. The
// credentialProvider is now unused — credentials live inside the connector-
// service — but callers still pass one, so keep the signature stable.
type CredentialProvider = () => Promise<{ accessToken: string; [key: string]: unknown }>;

interface StateFetcher {
  fetch(
    credentialProvider: CredentialProvider,
    entityType: string,
    entityId: string,
  ): Promise<ExternalState>;
}

// ── RPC-backed fetcher ─────────────────────────────────────────────────

class RpcStateFetcher implements StateFetcher {
  constructor(private readonly connectorType: string) {}

  async fetch(
    _credentialProvider: CredentialProvider,
    entityType: string,
    entityId: string,
  ): Promise<ExternalState> {
    const functionName = resolveFunctionName(this.connectorType, entityType);
    if (!functionName) {
      throw new Error(
        `No read function registered for ${this.connectorType}/${entityType}`,
      );
    }

    const client = getConnectorServiceClient();
    const resp = await client.execute({
      tenantContext: { tenantId: '' },
      connectorId: this.connectorType,
      functionName,
      input: { entityType, entityId } as never,
      idempotencyKey: `state-fetch-${this.connectorType}-${entityType}-${entityId}-${Date.now()}`,
      traceId: `state-fetch-${this.connectorType}-${entityType}-${entityId}`,
    });

    if (!resp.success) {
      throw new Error(
        `State fetch via connector-service failed: ${resp.error || 'unknown error'}`,
      );
    }

    // connector-service returns the raw vendor payload as `result`. The
    // version/etag extraction used to be per-vendor; now we surface the
    // common fields when connector-service hands them back and otherwise
    // fall through to `versionToken` being undefined, which the caller
    // treats as "no optimistic-concurrency signal available".
    const raw = resp.result as Record<string, unknown> | null | undefined;
    const meta = (raw && typeof raw === 'object' && 'meta' in raw
      ? (raw.meta as Record<string, unknown>)
      : undefined) ?? undefined;
    const versionToken = (meta?.versionToken as string | undefined)
      ?? (raw?.SystemModstamp as string | undefined)
      ?? (raw?.updated_at as string | undefined)
      ?? (raw?.updated as string | undefined)
      ?? undefined;
    const etag = (meta?.etag as string | undefined)
      ?? (raw?.etag as string | undefined)
      ?? undefined;

    return {
      data: (raw ?? {}) as Record<string, unknown>,
      fetchedAt: new Date(),
      versionToken,
      etag,
    };
  }
}

// ── Registry ───────────────────────────────────────────────────────────

export class ExternalStateFetcherRegistry {
  private fetchers: Map<string, StateFetcher> = new Map();

  constructor() {
    for (const connectorType of Object.keys(CONNECTOR_READ_FUNCTIONS)) {
      this.fetchers.set(connectorType, new RpcStateFetcher(connectorType));
    }
  }

  register(connector: string, fetcher: StateFetcher): void {
    this.fetchers.set(connector, fetcher);
  }

  get(connector: string): StateFetcher | undefined {
    return this.fetchers.get(connector);
  }

  async fetchState(
    connector: string,
    credentialProvider: CredentialProvider,
    entityType: string,
    entityId: string,
  ): Promise<ExternalState> {
    const fetcher = this.fetchers.get(connector);
    if (!fetcher) {
      throw new Error(`No state fetcher registered for connector: ${connector}`);
    }

    logger.info('Fetching external state via connector-service', {
      connector,
      entityType,
      entityId,
    });

    const state = await fetcher.fetch(credentialProvider, entityType, entityId);

    logger.info('External state fetched', {
      connector,
      entityType,
      entityId,
      hasVersionToken: !!state.versionToken,
      hasEtag: !!state.etag,
    });

    return state;
  }
}

// Singleton instance
export const stateFetcherRegistry = new ExternalStateFetcherRegistry();
